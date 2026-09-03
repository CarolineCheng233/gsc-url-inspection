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

async function loadSidePanel({ useDefaultBraveDelay = false } = {}) {
  const source = fs.readFileSync(path.join(__dirname, "sidepanel.js"), "utf8");
  const elements = new Map();
  const submittedUrls = [];
  const sentMessages = [];
  const injectedScripts = [];
  let reloadCount = 0;
  let failNextSend = false;
  let gscContentScriptVersion = "2026-09-03.1";
  let activeTab = {
    id: 7,
    status: "complete",
    url: "https://search.brave.com/submit-url"
  };

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
      scripting: {
        executeScript: async (details) => {
          injectedScripts.push(details);
        }
      },
      tabs: {
        get: async () => activeTab,
        query: async () => [activeTab],
        reload: async () => {
          reloadCount += 1;
          gscContentScriptVersion = "2026-09-03.1";
        },
        sendMessage: async (tabId, message) => {
          if (failNextSend) {
            failNextSend = false;
            throw new Error("Could not establish connection. Receiving end does not exist.");
          }
          sentMessages.push({ tabId, message });
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
          if (message.type === "GSC_HELPER_GET_STATE") {
            return {
              ok: true,
              supported: true,
              running: false,
              contentScriptVersion: gscContentScriptVersion
            };
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
    if (!${useDefaultBraveDelay}) {
      BRAVE_WAIT.betweenUrls = 1;
    }
    BRAVE_WAIT.tabLoad = 20;
    BRAVE_WAIT.contentReady = 20;
  `, context);
  await new Promise((resolve) => setImmediate(resolve));

  return {
    context,
    elements,
    getReloadCount: () => reloadCount,
    injectedScripts,
    failNextSend: () => {
      failNextSend = true;
    },
    sentMessages,
    setActiveTab: (tab) => {
      activeTab = tab;
    },
    setGscContentScriptVersion: (version) => {
      gscContentScriptVersion = version;
    },
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

test("Brave 在上一条提交完成后至少等待 3 秒再提交下一条", async () => {
  const harness = await loadSidePanel({ useDefaultBraveDelay: true });
  const submittedAt = [];
  const originalPush = harness.submittedUrls.push.bind(harness.submittedUrls);
  harness.submittedUrls.push = (url) => {
    submittedAt.push(Date.now());
    return originalPush(url);
  };

  await vm.runInContext(
    "startBraveQueue(['https://a.example/', 'https://b.example/'])",
    harness.context
  );

  assert.equal(submittedAt.length, 2);
  assert.ok(
    submittedAt[1] - submittedAt[0] >= 3000,
    `第二条在 ${submittedAt[1] - submittedAt[0]}ms 后提交，未达到 3 秒间隔。`
  );
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

test("开始前重新识别活动标签，避免将 GSC 队列发到旧 Brave 标签", async () => {
  const harness = await loadSidePanel();
  harness.setActiveTab({
    id: 8,
    status: "complete",
    url: "https://search.google.com/search-console/performance/search-analytics"
  });
  harness.elements.get("#urlList").value = "https://new.example/";

  await vm.runInContext("startQueue()", harness.context);

  const startMessage = harness.sentMessages.find(({ message }) => (
    message.type === "GSC_HELPER_START_QUEUE"
  ));
  assert.equal(startMessage.tabId, 8);
  assert.equal(
    harness.sentMessages.some(({ message }) => message.type === "BRAVE_HELPER_SUBMIT_URL"),
    false
  );
});

test("页面脚本未注入时自动注入后重试", async () => {
  const harness = await loadSidePanel();
  harness.setActiveTab({
    id: 8,
    status: "complete",
    url: "https://search.google.com/search-console/performance/search-analytics"
  });
  harness.failNextSend();

  await vm.runInContext("inspectActiveTab()", harness.context);

  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.injectedScripts)),
    [{ target: { tabId: 8 }, files: ["content.js"] }]
  );
  assert.equal(harness.elements.get("#pageStatus").textContent, "已连接到 Search Console 页面。");
});

test("旧 GSC 内容脚本仍可响应时会刷新页面加载当前版本", async () => {
  const harness = await loadSidePanel();
  harness.setActiveTab({
    id: 8,
    status: "complete",
    url: "https://search.google.com/search-console/performance/search-analytics"
  });
  harness.setGscContentScriptVersion("legacy-version");

  const reloadsBeforeInspection = harness.getReloadCount();
  await vm.runInContext("inspectActiveTab()", harness.context);

  assert.equal(harness.getReloadCount(), reloadsBeforeInspection + 1);
  assert.equal(harness.elements.get("#pageStatus").textContent, "已连接到 Search Console 页面。");
});
