"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function createElement() {
  return {
    addEventListener: () => {},
    checked: false,
    classList: { toggle: () => {} },
    disabled: false,
    hidden: false,
    scrollHeight: 0,
    scrollTop: 0,
    textContent: "",
    value: ""
  };
}

async function loadSidePanel() {
  const source = fs.readFileSync(path.join(__dirname, "sidepanel.js"), "utf8");
  const elements = new Map();
  const submittedUrls = [];
  let reloadCount = 0;

  const context = vm.createContext({
    chrome: {
      runtime: {
        onMessage: { addListener: () => {} },
        sendMessage: async () => ({ ok: true })
      },
      storage: {
        local: {
          get: async (defaults) => defaults,
          set: async () => {}
        }
      },
      tabs: {
        get: async () => ({
          id: 7,
          status: "complete",
          url: "https://search.brave.com/submit-url"
        }),
        query: async () => [{
          id: 7,
          status: "complete",
          url: "https://search.brave.com/submit-url"
        }],
        reload: async () => {
          reloadCount += 1;
        },
        sendMessage: async (_tabId, message) => {
          if (message.type === "BRAVE_HELPER_GET_STATE") {
            return {
              ok: true,
              supported: true,
              ready: true,
              running: false,
              submitted: false,
              verifying: false,
              error: ""
            };
          }
          if (message.type === "BRAVE_HELPER_SUBMIT_URL") {
            submittedUrls.push(message.url);
            return { ok: true, status: "submitted" };
          }
          return { ok: true };
        }
      }
    },
    console,
    document: {
      querySelector: (selector) => {
        if (!elements.has(selector)) {
          elements.set(selector, createElement());
        }
        return elements.get(selector);
      }
    },
    DOMParser: class {},
    fetch: async () => {
      throw new Error("本测试不应请求网络");
    },
    setTimeout,
    URL,
    window: {
      addEventListener: () => {},
      close: () => {}
    }
  });

  vm.runInContext(source, context);
  vm.runInContext(`
    BRAVE_WAIT.poll = 1;
    BRAVE_WAIT.betweenUrls = 1;
    BRAVE_WAIT.tabLoad = 20;
    BRAVE_WAIT.contentReady = 20;
  `, context);
  await new Promise((resolve) => setImmediate(resolve));

  return {
    context,
    elements,
    getReloadCount: () => reloadCount,
    submittedUrls
  };
}

test("Brave 队列逐条提交并在两条之间刷新页面", async () => {
  const harness = await loadSidePanel();

  await vm.runInContext(
    "startBraveQueue(['https://a.example/', 'https://b.example/'])",
    harness.context
  );

  assert.deepEqual(Array.from(harness.submittedUrls), [
    "https://a.example/",
    "https://b.example/"
  ]);
  assert.equal(harness.getReloadCount(), 1);
  assert.equal(harness.elements.get("#runState").textContent, "空闲");
  assert.equal(harness.elements.get("#pageStatus").textContent, "Brave 提交任务完成。");
});

test("侧边栏只在 Brave 官方提交页启用 Brave 模式", async () => {
  const harness = await loadSidePanel();

  assert.equal(
    vm.runInContext("getPageEngine('https://search.brave.com/submit-url')", harness.context),
    "brave"
  );
  assert.equal(
    vm.runInContext("getPageEngine('https://search.brave.com/search?q=test')", harness.context),
    null
  );
});
