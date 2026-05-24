"use strict";

const TEXT = {
  inspectInput: [
    "inspect any url",
    "检查任何网址",
    "检查任意网址",
    "网址检查",
    "url inspection"
  ],
  indexed: [
    "url is on google",
    "网址已在 google 上",
    "网页已编入索引",
    "已编入索引"
  ],
  notIndexed: [
    "url is not on google",
    "网址不在 google 上",
    "未编入索引",
    "不在 google 上"
  ],
  requestButton: [
    "request indexing",
    "请求编入索引",
    "请求索引"
  ],
  requested: [
    "indexing requested",
    "已请求编入索引",
    "已请求索引",
    "request submitted"
  ],
  checking: [
    "retrieving data",
    "正在从 google 索引中检索数据",
    "正在检索数据",
    "正在测试实时网址",
    "testing live url"
  ]
};

const WAIT = {
  input: 30000,
  result: 120000,
  requestButton: 45000,
  requested: 120000,
  betweenUrls: 2500,
  poll: 500
};

const state = {
  running: false,
  stopped: false,
  queue: [],
  currentIndex: 0,
  currentUrl: "",
  total: 0,
  logs: []
};

let panel = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: error.message || String(error) });
  });
  return true;
});

async function handleMessage(message) {
  if (message?.type === "GSC_HELPER_GET_STATE") {
    return { ok: true, supported: isSupportedPage(), ...publicState() };
  }

  if (message?.type === "GSC_HELPER_STOP_QUEUE") {
    stopQueue();
    return { ok: true, ...publicState() };
  }

  if (message?.type === "GSC_HELPER_START_QUEUE") {
    if (!isSupportedPage()) {
      throw new Error("当前页面不是 Google Search Console 页面。");
    }
    startQueue(message.urls || [], message.options || {});
    return { ok: true, ...publicState() };
  }

  return { ok: false, error: "未知消息类型。" };
}

function publicState() {
  return {
    running: state.running,
    currentIndex: state.currentIndex,
    total: state.total,
    currentUrl: state.currentUrl,
    logs: state.logs.slice(-20)
  };
}

function isSupportedPage() {
  return location.hostname === "search.google.com" && location.pathname.startsWith("/search-console/inspect");
}

function startQueue(urls, options) {
  if (state.running) {
    throw new Error("已有任务正在运行。");
  }

  const normalizedUrls = mergeUrls(urls);
  if (normalizedUrls.length === 0) {
    throw new Error("没有可处理的 URL。");
  }

  state.running = true;
  state.stopped = false;
  state.queue = normalizedUrls;
  state.currentIndex = 0;
  state.currentUrl = "";
  state.total = normalizedUrls.length;
  state.logs = [];

  ensurePanel();
  log(`任务开始，共 ${state.total} 个 URL。`);
  processQueue(options).catch((error) => {
    log(`任务异常：${error.message || error}`);
    finishQueue();
  });
}

function stopQueue() {
  if (!state.running) {
    return;
  }

  state.stopped = true;
  log("已收到停止指令，当前 URL 处理结束后停止。");
  updatePanel();
}

async function processQueue(options) {
  for (let index = 0; index < state.queue.length; index += 1) {
    if (state.stopped) {
      break;
    }

    const url = state.queue[index];
    state.currentIndex = index + 1;
    state.currentUrl = url;
    updatePanel();

    try {
      await processUrl(url, options);
    } catch (error) {
      log(`失败：${url} - ${error.message || error}`);
    }

    await sleep(WAIT.betweenUrls);
  }

  finishQueue();
}

async function processUrl(url, options) {
  log(`检查：${url}`);
  await submitInspectionUrl(url);
  const result = await waitForInspectionResult();

  if (result === "indexed") {
    log(`已收录：${url}`);
    return;
  }

  if (result === "requested" && options.skipSubmitted) {
    log(`已请求过：${url}`);
    return;
  }

  if (result !== "not-indexed" && result !== "unknown") {
    log(`跳过：${url}，当前状态 ${result}。`);
    return;
  }

  if (!options.requestIndexing) {
    log(`未收录：${url}，未启用自动请求。`);
    return;
  }

  log(`未收录，准备请求编入索引：${url}`);
  await requestIndexing();
  log(`已请求编入索引：${url}`);
}

async function submitInspectionUrl(url) {
  const input = await waitForElement(findInspectionInput, WAIT.input, "没有找到 GSC 网址检查输入框。");
  focusAndSetValue(input, url);
  await sleep(200);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
  await sleep(1000);
}

async function waitForInspectionResult() {
  const startedAt = Date.now();

  while (Date.now() - startedAt < WAIT.result) {
    throwIfStopped();

    const pageText = normalizedText(document.body.innerText);
    if (containsAny(pageText, TEXT.requested)) {
      return "requested";
    }
    if (containsAny(pageText, TEXT.notIndexed)) {
      return "not-indexed";
    }
    if (containsAny(pageText, TEXT.indexed)) {
      return "indexed";
    }

    await sleep(WAIT.poll);
  }

  return "unknown";
}

async function requestIndexing() {
  const button = await waitForElement(findRequestIndexingButton, WAIT.requestButton, "没有找到“请求编入索引”按钮。");
  clickElement(button);

  await waitForCondition(() => {
    const pageText = normalizedText(document.body.innerText);
    return containsAny(pageText, TEXT.requested);
  }, WAIT.requested, "请求编入索引后没有等到成功提示。");
}

function findInspectionInput() {
  const candidates = [
    ...document.querySelectorAll("input[type='text'], input[type='search'], input:not([type]), textarea, [contenteditable='true']")
  ].filter(isVisible);

  return candidates.find((element) => {
    const text = normalizedText([
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
      element.getAttribute("title"),
      closestText(element)
    ].join(" "));
    return containsAny(text, TEXT.inspectInput);
  }) || candidates[0] || null;
}

function findRequestIndexingButton() {
  const candidates = [
    ...document.querySelectorAll("button, [role='button']")
  ].filter((element) => isVisible(element) && !isDisabled(element));

  return candidates.find((element) => {
    const text = normalizedText([
      element.innerText,
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("title")
    ].join(" "));
    return containsAny(text, TEXT.requestButton);
  }) || null;
}

function focusAndSetValue(element, value) {
  element.focus();
  element.click();

  if (element.isContentEditable) {
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    return;
  }

  const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  valueSetter?.call(element, "");
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
  valueSetter?.call(element, value);
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function clickElement(element) {
  element.scrollIntoView({ block: "center", inline: "center" });
  element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  element.click();
}

function waitForElement(getElement, timeout, message) {
  return waitForCondition(() => {
    const element = getElement();
    return element || false;
  }, timeout, message);
}

async function waitForCondition(check, timeout, message) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    throwIfStopped();
    const result = check();
    if (result) {
      return result;
    }
    await sleep(WAIT.poll);
  }

  throw new Error(message);
}

function throwIfStopped() {
  if (state.stopped) {
    throw new Error("任务已停止。");
  }
}

function finishQueue() {
  state.running = false;
  state.currentUrl = "";
  log(state.stopped ? "任务已停止。" : "任务完成。");
  updatePanel();
}

function ensurePanel() {
  if (panel) {
    panel.hidden = false;
    updatePanel();
    return;
  }

  panel = document.createElement("aside");
  panel.id = "gsc-helper-panel";
  panel.innerHTML = `
    <div class="gsc-helper-header">
      <h2 class="gsc-helper-title">GSC URL Inspection Helper</h2>
      <button class="gsc-helper-stop" type="button">停止</button>
    </div>
    <div class="gsc-helper-body">
      <div class="gsc-helper-progress">
        <span data-role="progress">0 / 0</span>
        <span data-role="state">空闲</span>
      </div>
      <div class="gsc-helper-current" data-role="current"></div>
    </div>
    <pre class="gsc-helper-log" data-role="log"></pre>
  `;

  panel.querySelector(".gsc-helper-stop").addEventListener("click", stopQueue);
  document.documentElement.appendChild(panel);
  updatePanel();
}

function updatePanel() {
  if (!panel) {
    return;
  }

  panel.hidden = false;
  panel.querySelector("[data-role='progress']").textContent = `${state.currentIndex} / ${state.total}`;
  panel.querySelector("[data-role='state']").textContent = state.running ? "运行中" : "空闲";
  panel.querySelector("[data-role='current']").textContent = state.currentUrl || "";
  panel.querySelector("[data-role='log']").textContent = state.logs.slice(-80).join("\n");
}

function log(message) {
  const time = new Date().toLocaleTimeString();
  state.logs.push(`[${time}] ${message}`);
  updatePanel();
}

function normalizedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function containsAny(text, needles) {
  return needles.some((needle) => text.includes(needle));
}

function closestText(element) {
  const container = element.closest("[role='search'], header, form, div");
  return container?.innerText || "";
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function isDisabled(element) {
  return element.disabled || element.getAttribute("aria-disabled") === "true";
}

function mergeUrls(urls) {
  const seen = new Set();
  const result = [];

  for (const url of urls) {
    const normalized = normalizeUrl(url);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function normalizeUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
