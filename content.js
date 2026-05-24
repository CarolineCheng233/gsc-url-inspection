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
    "请求索引",
    "再次提交请求"
  ],
  requested: [
    "indexing requested",
    "已请求编入索引",
    "已请求索引",
    "request submitted",
    "已将网址添加到优先抓取队列中"
  ],
  requesting: [
    "正在测试实际网址可否编入索引",
    "这可能需要花费",
    "testing if live url can be indexed",
    "submitting request"
  ],
  requestFailed: [
    "已达到配额",
    "已超今日配额",
    "今日配额",
    "每日配额",
    "配额",
    "quota",
    "daily quota",
    "无法请求",
    "请求失败",
    "出了点问题"
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
  suggestion: 8000,
  inspectionStart: 20000,
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
  return location.hostname === "search.google.com" && location.pathname.startsWith("/search-console/");
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

  log(`任务开始，共 ${state.total} 个 URL。`);
  broadcastState();
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
  broadcastState();
}

async function processQueue(options) {
  for (let index = 0; index < state.queue.length; index += 1) {
    if (state.stopped) {
      break;
    }

    const url = state.queue[index];
    state.currentIndex = index + 1;
    state.currentUrl = url;
    broadcastState();

    try {
      await processUrl(url, options);
    } catch (error) {
      log(`失败：${url} - ${error.message || error}`);
      if (state.stopped) {
        break;
      }
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

  if (result === "requested") {
    if (options.skipSubmitted) {
      log(`已请求过，已按设置跳过：${url}`);
      return;
    }

    log(`已请求过，准备再次提交请求：${url}`);
    await requestIndexing();
    log(`已再次提交请求：${url}`);
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
  log("已找到网址检查输入框，正在填写 URL。");
  await focusAndSetValue(input, url);
  await sleep(500);

  const suggestion = await waitForOptionalElement(() => findUrlSuggestion(url), WAIT.suggestion);
  if (suggestion) {
    log("已找到 GSC 候选项，正在点击进入检查。");
    await trustedClickElement(suggestion);
  } else {
    const searchButton = findSearchButton(input);
    if (!searchButton) {
      log("未找到候选项和搜索按钮，尝试用回车提交检查。");
      pressEnter(input);
    } else {
      log("未找到候选项，正在点击 GSC 搜索按钮提交检查。");
      await trustedClickElement(searchButton);
    }
  }

  await waitForInspectionStart(url);
  log("GSC 已开始检查当前 URL。");
}

async function waitForInspectionResult() {
  const startedAt = Date.now();

  while (Date.now() - startedAt < WAIT.result) {
    throwIfStopped();

    const visibleStatus = getVisibleInspectionStatus();
    if (visibleStatus) {
      return visibleStatus;
    }

    await sleep(WAIT.poll);
  }

  return "unknown";
}

async function requestIndexing() {
  const button = await waitForElement(findRequestIndexingButton, WAIT.requestButton, "没有找到“请求编入索引”按钮。");
  log("已找到“请求编入索引”按钮，正在点击。");
  await trustedClickElement(button);
  await sleep(1000);
  if (!containsAny(getGscPageText(), [...TEXT.requesting, ...TEXT.requested, ...TEXT.requestFailed])) {
    log("点击后 GSC 未响应，正在基于同一按钮 DOM 重试。");
    await clickElement(button);
  }
  log("已点击“请求编入索引”，等待 GSC 响应。");

  let sawRequesting = false;
  await waitForCondition(() => {
    const pageText = getGscPageText();
    if (containsAny(pageText, TEXT.requestFailed)) {
      state.stopped = true;
      throw new Error("GSC 请求编入索引失败或达到配额。");
    }
    if (!sawRequesting && containsAny(pageText, TEXT.requesting)) {
      sawRequesting = true;
      log("GSC 正在测试实际网址可否编入索引。");
    }
    return containsAny(pageText, TEXT.requested);
  }, WAIT.requested, "请求编入索引后没有等到成功提示。");
  log("GSC 已显示请求成功，正在关闭提示。");
  await closeRequestResultDialog();
}

function findInspectionInput() {
  const candidates = [
    ...document.querySelectorAll("input[type='text'], input[type='search'], input:not([type]), textarea, [contenteditable='true']")
  ].filter((element) => isVisible(element) && !isDisabled(element) && !isReadOnly(element) && !isInHelperPanel(element));

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

function findSearchButton(input) {
  const form = input.closest("form");
  const candidates = [
    ...(form ? form.querySelectorAll("button, [role='button']") : []),
    ...document.querySelectorAll("button, [role='button']")
  ].filter((element) => isVisible(element) && !isDisabled(element) && !isInHelperPanel(element));

  return candidates.find((element) => {
    const text = normalizedText([
      element.innerText,
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("title")
    ].join(" "));
    return text === "搜索" || text === "search";
  }) || null;
}

function findUrlSuggestion(url) {
  const urlText = normalizedText(url);
  const shortUrlText = normalizedText(url.replace(/^https?:\/\//i, ""));
  const candidates = [
    ...document.querySelectorAll("[role='option'], [role='menuitem'], [role='button'], a, li, div[tabindex]")
  ].filter((element) => isVisible(element) && !isDisabled(element) && !isInHelperPanel(element));

  return candidates.find((element) => {
    const text = normalizedText([
      element.innerText,
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("title")
    ].join(" "));
    return text.includes(urlText) || text.includes(shortUrlText);
  }) || null;
}

function findRequestIndexingButton() {
  const candidates = [
    ...document.querySelectorAll("button, [role='button']")
  ].filter((element) => isVisible(element) && !isDisabled(element) && !isInHelperPanel(element));

  return candidates.find((element) => {
    const visibleText = normalizedText(element.innerText || element.textContent || "");
    const labelText = normalizedText([
      element.getAttribute("aria-label"),
      element.getAttribute("title")
    ].join(" "));
    return visibleText === "请求编入索引"
      || visibleText === "再次提交请求"
      || visibleText === "request indexing"
      || containsAny(labelText, TEXT.requestButton);
  }) || null;
}

function findDialogCloseButton() {
  const dialog = findRequestResultDialog();
  const root = dialog || document;
  const candidates = [
    ...root.querySelectorAll("button, [role='button']")
  ].filter((element) => isVisible(element) && !isDisabled(element) && !isInHelperPanel(element));

  return candidates.find((element) => {
    const visibleText = normalizedText(element.innerText || element.textContent || "");
    const labelText = normalizedText([
      element.getAttribute("aria-label"),
      element.getAttribute("title")
    ].join(" "));
    return visibleText === "关闭"
      || visibleText === "close"
      || labelText === "关闭"
      || labelText === "close";
  }) || null;
}

function findRequestResultDialog() {
  const candidates = [
    ...document.querySelectorAll("[role='dialog'], [role='alertdialog'], div, section")
  ].filter((element) => isVisible(element) && !isInHelperPanel(element));

  return candidates.find((element) => {
    const text = getVisibleText(element);
    return containsAny(text, TEXT.requested)
      && (text.includes("关闭") || text.includes("close"));
  }) || null;
}

async function focusAndSetValue(element, value) {
  element.scrollIntoView({ block: "center", inline: "center" });
  await trustedClickElement(element);
  element.focus();

  if (element.isContentEditable) {
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    return;
  }

  const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!valueSetter) {
    throw new Error("找到的元素不是可写入的输入框。");
  }

  valueSetter?.call(element, "");
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
  valueSetter?.call(element, value);
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function pressEnter(element) {
  element.focus();
  element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  element.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  element.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
}

async function clickElement(element) {
  element.scrollIntoView({ block: "center", inline: "center" });
  await sleep(100);
  const rect = element.getBoundingClientRect();
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);
  const eventTarget = document.elementFromPoint(x, y) || element;

  dispatchPointerLikeEvent(eventTarget, "pointerover", x, y);
  dispatchPointerLikeEvent(eventTarget, "mouseover", x, y);
  dispatchPointerLikeEvent(eventTarget, "mousemove", x, y);
  dispatchPointerLikeEvent(eventTarget, "pointerdown", x, y);
  dispatchPointerLikeEvent(eventTarget, "mousedown", x, y);
  dispatchPointerLikeEvent(eventTarget, "pointerup", x, y);
  dispatchPointerLikeEvent(eventTarget, "mouseup", x, y);
  dispatchPointerLikeEvent(eventTarget, "click", x, y);
  element.click();
}

function dispatchPointerLikeEvent(element, type, x, y) {
  const eventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    detail: type === "click" ? 1 : 0,
    screenX: window.screenX + x,
    screenY: window.screenY + y,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: type.endsWith("down") ? 1 : 0
  };

  if (type.startsWith("pointer") && typeof PointerEvent === "function") {
    element.dispatchEvent(new PointerEvent(type, {
      ...eventInit,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true
    }));
    return;
  }

  element.dispatchEvent(new MouseEvent(type, eventInit));
}

async function trustedClickElement(element) {
  element.scrollIntoView({ block: "center", inline: "center" });
  await sleep(100);

  const rect = element.getBoundingClientRect();
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);

  try {
    const response = await chrome.runtime.sendMessage({
      type: "GSC_HELPER_CDP_CLICK",
      x,
      y
    });

    if (response?.ok === false) {
      throw new Error(response.error || "CDP 点击失败。");
    }
  } catch (error) {
    log(`真实鼠标点击失败，改用 DOM 点击：${error.message || error}`);
    await clickElement(element);
  }
}

async function closeRequestResultDialog() {
  const closeButton = await waitForElement(findDialogCloseButton, 15000, "请求成功后没有找到提示框关闭按钮。");
  log("已找到请求成功提示的关闭按钮，正在点击。");
  await clickElement(closeButton);
  await sleep(1000);
  if (containsAny(getGscPageText(), ["已将网址添加到优先抓取队列中"])) {
    log("首次关闭点击后提示仍存在，正在重试关闭。");
    await clickElement(closeButton);
  }
  await waitForCondition(() => !containsAny(getGscPageText(), ["已将网址添加到优先抓取队列中"]), 15000, "点击关闭后成功提示仍未消失。");
  log("已关闭请求成功提示。");
}

async function waitForInspectionStart(url) {
  const startHref = location.href;
  const startUrlParam = new URLSearchParams(location.search).get("id");

  return waitForCondition(() => {
    const pageText = getGscPageText();
    const currentUrlParam = new URLSearchParams(location.search).get("id");
    return (location.pathname.startsWith("/search-console/inspect") && currentUrlParam && currentUrlParam !== startUrlParam)
      || location.href !== startHref
      || containsAny(pageText, TEXT.checking)
      || containsAny(pageText, TEXT.indexed)
      || containsAny(pageText, TEXT.notIndexed)
      || containsAny(pageText, TEXT.requested);
  }, WAIT.inspectionStart, "GSC 没有开始检查该 URL，请确认顶部输入框是否可用。");
}

function waitForElement(getElement, timeout, message) {
  return waitForCondition(() => {
    const element = getElement();
    return element || false;
  }, timeout, message);
}

async function waitForOptionalElement(getElement, timeout) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    throwIfStopped();
    const element = getElement();
    if (element) {
      return element;
    }
    await sleep(WAIT.poll);
  }

  return null;
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
}

function log(message) {
  const time = new Date().toLocaleTimeString();
  const line = `[${time}] ${message}`;
  state.logs.push(line);
  state.logs = state.logs.slice(-200);
  chrome.runtime.sendMessage({
    type: "GSC_HELPER_LOG",
    message: line,
    state: publicState()
  }).catch(() => {});
}

function broadcastState() {
  chrome.runtime.sendMessage({
    type: "GSC_HELPER_STATE",
    state: publicState()
  }).catch(() => {});
}

function normalizedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function getVisibleInspectionStatus() {
  const statusCard = findInspectionStatusCard();
  const statusText = statusCard ? getVisibleText(statusCard) : getGscPageText();

  if (containsAny(statusText, TEXT.requested)) {
    return "requested";
  }
  if (containsAny(statusText, TEXT.notIndexed)) {
    return "not-indexed";
  }
  if (containsAny(statusText, TEXT.indexed)) {
    return "indexed";
  }

  return "";
}

function findInspectionStatusCard() {
  const elements = [
    ...document.querySelectorAll("[role='main'] div, main div, section, article")
  ].filter((element) => isVisible(element) && !isInHelperPanel(element));

  return elements.find((element) => {
    const text = getVisibleText(element);
    return containsAny(text, TEXT.indexed)
      || containsAny(text, TEXT.notIndexed)
      || containsAny(text, TEXT.requested);
  }) || null;
}

function getGscPageText() {
  return getVisibleText(document.body);
}

function getVisibleText(root) {
  const textParts = [];
  collectVisibleText(root, textParts);
  return normalizedText(textParts.join(" "));
}

function collectVisibleText(node, textParts) {
  if (node.nodeType === Node.TEXT_NODE) {
    const parent = node.parentElement;
    if (parent && !parent.closest("#gsc-helper-panel") && isVisibleTextNodeParent(parent)) {
      textParts.push(node.textContent);
    }
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE) {
    return;
  }

  if (node.nodeType === Node.ELEMENT_NODE && node.closest("#gsc-helper-panel")) {
    return;
  }

  for (const child of Array.from(node.childNodes)) {
    collectVisibleText(child, textParts);
  }
}

function isVisibleTextNodeParent(element) {
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
    return false;
  }

  return Boolean(element.getClientRects().length);
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

function isReadOnly(element) {
  return element.readOnly || element.getAttribute("readonly") !== null;
}

function isInHelperPanel(element) {
  return false;
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
