"use strict";

const BRAVE_TEXT = {
  success: ["thank you for your submission."],
  verifying: [
    "verifying you're a human being",
    "verifying you’re a human being"
  ],
  errors: [
    "please insert a valid url.",
    "error solving captcha.",
    "error loading captcha.",
    "an error occurred."
  ]
};

const BRAVE_WAIT = {
  input: 15000,
  submitButton: 15000,
  result: 120000,
  poll: 250
};

const braveState = {
  running: false,
  stopped: false
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: error.message || String(error) });
  });
  return true;
});

async function handleMessage(message) {
  if (message?.type === "BRAVE_HELPER_GET_STATE") {
    return { ok: true, supported: isSupportedPage(), ...getBravePageState() };
  }

  if (message?.type === "BRAVE_HELPER_STOP") {
    braveState.stopped = true;
    return { ok: true, running: braveState.running };
  }

  if (message?.type === "BRAVE_HELPER_SUBMIT_URL") {
    if (!isSupportedPage()) {
      throw new Error("当前页面不是 Brave Search URL 提交页面。");
    }
    await submitBraveUrl(message.url);
    return { ok: true, status: "submitted" };
  }

  return { ok: false, error: "未知消息类型。" };
}

function isSupportedPage() {
  return location.hostname === "search.brave.com"
    && location.pathname === "/submit-url";
}

function getBravePageState() {
  const error = getSubmissionError();
  const submitted = isSubmissionSuccessful();
  const verifying = containsAny(getPageText(), BRAVE_TEXT.verifying);
  const input = findUrlInput();
  const button = findSubmitButton();

  return {
    running: braveState.running,
    submitted,
    verifying,
    error,
    ready: Boolean(input && button && !submitted && !verifying && !error)
  };
}

async function submitBraveUrl(value) {
  if (braveState.running) {
    throw new Error("Brave 已有 URL 正在提交。");
  }

  const url = normalizeBraveUrl(value);
  if (!url) {
    throw new Error("Brave 仅支持标准 HTTP/HTTPS URL。");
  }
  if (isSubmissionSuccessful()) {
    throw new Error("Brave 页面已提交过 URL，需要刷新后继续。");
  }

  braveState.running = true;
  braveState.stopped = false;

  try {
    const input = await waitForElement(
      findUrlInput,
      BRAVE_WAIT.input,
      "没有找到 Brave URL 输入框。"
    );
    await focusAndSetValue(input, url);

    const button = await waitForElement(
      () => {
        const candidate = findSubmitButton();
        return candidate && !isDisabled(candidate) ? candidate : null;
      },
      BRAVE_WAIT.submitButton,
      "Brave 提交按钮没有进入可点击状态。"
    );

    await trustedClickElement(button);
    await waitForSubmissionResult();
  } finally {
    braveState.running = false;
  }
}

function findUrlInput() {
  const direct = document.querySelector("#url[autocomplete='url']");
  if (direct && isVisible(direct) && !isDisabled(direct)) {
    return direct;
  }

  return Array.from(document.querySelectorAll("input[type='text'], input[type='url']"))
    .find((element) => {
      const text = normalizedText([
        element.getAttribute("placeholder"),
        element.getAttribute("aria-label"),
        element.getAttribute("autocomplete")
      ].join(" "));
      return isVisible(element) && !isDisabled(element)
        && (text.includes("valid url") || text.includes("url"));
    }) || null;
}

function findSubmitButton() {
  const direct = document.querySelector("button[name='captcha-button']");
  if (direct && isVisible(direct)) {
    return direct;
  }

  return Array.from(document.querySelectorAll("button[type='submit'], button"))
    .find((element) => {
      const text = normalizedText(element.innerText || element.textContent);
      return isVisible(element) && (text === "submit" || text === "submitted");
    }) || null;
}

async function focusAndSetValue(element, value) {
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus();

  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  if (!valueSetter) {
    throw new Error("Brave URL 输入框不可写入。");
  }

  valueSetter.call(element, value);
  element.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertText",
    data: value
  }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

async function trustedClickElement(element) {
  element.scrollIntoView({ block: "center", inline: "center" });
  await sleep(100);

  const rect = element.getBoundingClientRect();
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);

  try {
    const response = await chrome.runtime.sendMessage({
      type: "BRAVE_HELPER_CDP_CLICK",
      x,
      y
    });
    if (response?.ok === false) {
      throw new Error(response.error || "CDP 点击失败。");
    }
  } catch {
    element.click();
  }
}

async function waitForSubmissionResult() {
  const startedAt = Date.now();

  while (Date.now() - startedAt < BRAVE_WAIT.result) {
    throwIfStopped();

    const error = getSubmissionError();
    if (error) {
      throw new Error(`Brave 提交失败：${error}`);
    }
    if (isSubmissionSuccessful()) {
      return;
    }

    await sleep(BRAVE_WAIT.poll);
  }

  throw new Error("Brave 提交后没有等到成功提示。");
}

function isSubmissionSuccessful() {
  return containsAny(getPageText(), BRAVE_TEXT.success);
}

function getSubmissionError() {
  const pageText = getPageText();
  return BRAVE_TEXT.errors.find((message) => pageText.includes(message)) || "";
}

function normalizeBraveUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (
      !["http:", "https:"].includes(url.protocol)
      || url.username
      || url.password
      || !["", "80", "443"].includes(url.port)
    ) {
      return "";
    }
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function getPageText() {
  return normalizedText(document.body?.innerText || "");
}

function containsAny(text, needles) {
  return needles.some((needle) => text.includes(needle));
}

function normalizedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0
    && rect.height > 0
    && style.visibility !== "hidden"
    && style.display !== "none";
}

function isDisabled(element) {
  return element.disabled || element.getAttribute("aria-disabled") === "true";
}

function waitForElement(getElement, timeout, message) {
  return waitForCondition(() => getElement() || false, timeout, message);
}

async function waitForCondition(check, timeout, message) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    throwIfStopped();
    const result = check();
    if (result) {
      return result;
    }
    await sleep(BRAVE_WAIT.poll);
  }

  throw new Error(message);
}

function throwIfStopped() {
  if (braveState.stopped) {
    throw new Error("任务已停止。");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
