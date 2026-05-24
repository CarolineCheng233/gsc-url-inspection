"use strict";

chrome.runtime.onInstalled.addListener(() => {
  setupSidePanelBehavior();
});

chrome.runtime.onStartup.addListener(() => {
  setupSidePanelBehavior();
});

if (chrome.sidePanel?.onClosed) {
  chrome.sidePanel.onClosed.addListener(() => {
    stopAllGscQueues();
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GSC_HELPER_CDP_CLICK") {
    dispatchClick(sender.tab?.id, message.x, message.y)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "GSC_HELPER_PANEL_CLOSED") {
    stopAllGscQueues()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  return false;
});

function setupSidePanelBehavior() {
  if (!chrome.sidePanel?.setPanelBehavior) {
    return;
  }

  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

async function stopAllGscQueues() {
  const tabs = await chrome.tabs.query({ url: "https://search.google.com/search-console/*" });
  await Promise.all(tabs.map((tab) => sendStopMessage(tab.id)));
}

async function sendStopMessage(tabId) {
  if (!tabId) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabId, { type: "GSC_HELPER_STOP_QUEUE" });
  } catch {
    // The content script may not be injected on every matching tab.
  }
}

async function dispatchClick(tabId, x, y) {
  if (!tabId) {
    throw new Error("无法获取当前标签页 ID。");
  }

  const target = { tabId };
  await attachDebugger(target);

  try {
    await sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none"
    });
    await sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1
    });
    await sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1
    });
  } finally {
    await detachDebugger(target);
  }
}

function attachDebugger(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, "1.3", () => {
      const error = chrome.runtime.lastError;
      if (error && !error.message.includes("Another debugger is already attached")) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function detachDebugger(target) {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => {
      resolve();
    });
  });
}

function sendCommand(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}
