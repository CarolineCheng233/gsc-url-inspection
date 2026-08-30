"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadContentScript() {
  const source = fs.readFileSync(path.join(__dirname, "content.js"), "utf8");
  const location = {
    hostname: "search.google.com",
    pathname: "/search-console/inspect",
    href: "https://search.google.com/search-console/inspect?resource_id=site&id=old-inspection",
    search: "?resource_id=site&id=old-inspection"
  };
  const context = vm.createContext({
    clearTimeout,
    console,
    document: {
      body: {},
      querySelector: () => null,
      querySelectorAll: () => []
    },
    chrome: {
      runtime: {
        onMessage: { addListener: () => {} },
        sendMessage: async () => ({ ok: true })
      }
    },
    location,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1, DOCUMENT_NODE: 9 },
    setTimeout,
    URL,
    URLSearchParams
  });

  vm.runInContext(source, context);
  vm.runInContext("WAIT.poll = 1; WAIT.inspectionStart = 20; WAIT.result = 40;", context);

  return { context, location };
}

function setInspectionStatus(context, pageText, status) {
  context.pageText = pageText;
  context.inspectionStatus = status;
  vm.runInContext(`
    getGscPageText = () => pageText;
    getVisibleInspectionStatus = () => inspectionStatus;
  `, context);
}

test("上一条已请求状态不能被当作下一条检查已开始", async () => {
  const { context } = loadContentScript();
  setInspectionStatus(context, "已请求编入索引", "requested");

  const wait = vm.runInContext(`waitForInspectionStart({
    href: location.href,
    inspectionId: "old-inspection",
    status: "requested"
  })`, context);

  await assert.rejects(wait, /GSC 没有开始检查该 URL/);
});

test("新 URL 进入加载态后只读取该 URL 的新结果", async () => {
  const { context, location } = loadContentScript();
  setInspectionStatus(context, "已请求编入索引", "requested");

  const waitForStart = vm.runInContext(`waitForInspectionStart({
    href: location.href,
    inspectionId: "old-inspection",
    status: "requested"
  })`, context);

  setTimeout(() => {
    location.href = "https://search.google.com/search-console/inspect?resource_id=site&id=new-inspection";
    location.search = "?resource_id=site&id=new-inspection";
  }, 2);
  setTimeout(() => {
    context.pageText = "正在从 google 索引中检索数据 已请求编入索引";
  }, 5);

  await waitForStart;

  const inspectionId = await waitForStart;
  const waitForResult = vm.runInContext(`waitForInspectionResult(${JSON.stringify(inspectionId)})`, context);
  setTimeout(() => {
    context.pageText = "网址不在 Google 上";
    context.inspectionStatus = "not-indexed";
  }, 8);

  assert.equal(await waitForResult, "not-indexed");
});

test("当前检查 URL 不匹配时不能继续请求索引", async () => {
  const { context } = loadContentScript();
  setInspectionStatus(context, "已请求编入索引", "requested");

  const wait = vm.runInContext("waitForInspectionResult('new-inspection')", context);

  await assert.rejects(wait, /当前检查页面已切换/);
});

test("识别 GSC 当前的未收录文案", () => {
  const { context } = loadContentScript();

  assert.equal(
    vm.runInContext('containsAny(normalizedText("网址尚未收录到 Google"), TEXT.notIndexed)', context),
    true
  );
});

test("缺少 GSC 检查标识时使用当前地址跟踪页面", () => {
  const { context, location } = loadContentScript();
  location.href = "https://search.google.com/search-console/inspect?resource_id=site";
  location.search = "?resource_id=site";

  assert.equal(
    vm.runInContext("getInspectionId()", context),
    location.href
  );
});

test("使用实际 GSC 元素选择器", () => {
  const { context } = loadContentScript();

  assert.deepEqual(
    JSON.parse(vm.runInContext("JSON.stringify(GSC_SELECTORS)", context)),
    {
      inspectionInput: 'input[role="combobox"][jsname="dSO9oc"]',
      requestIndexing: 'div[role="button"][aria-label][aria-disabled="false"]:has(> .ZFr60d.CeoRYc)',
      dialogClose: 'button[data-mdc-dialog-action="ok"]'
    }
  );
});

test("检查 URL 时使用真实回车，不点击不精确的候选项", async () => {
  const { context } = loadContentScript();

  vm.runInContext(`
    let enterCount = 0;
    waitForElement = async () => ({ focus: () => {} });
    getInspectionSnapshot = () => ({ href: location.href, inspectionId: "old", status: "indexed" });
    focusAndSetValue = async () => {};
    pressEnter = async () => { enterCount += 1; };
    waitForInspectionStart = async () => "new";
    log = () => {};
  `, context);

  assert.equal(
    await vm.runInContext('submitInspectionUrl("https://example.com/page")', context),
    "new"
  );
  assert.equal(vm.runInContext("enterCount", context), 1);
});

test("请求索引时只选择可见的结构化按钮", () => {
  const { context } = loadContentScript();

  vm.runInContext(`
    const hiddenButton = { id: "hidden" };
    const visibleButton = { id: "visible" };
    document.querySelectorAll = () => [hiddenButton, visibleButton];
    isVisible = (element) => element === visibleButton;
    isDisabled = () => false;
  `, context);

  assert.equal(vm.runInContext("findRequestIndexingButton().id", context), "visible");
});

test("状态响应携带内容脚本版本", () => {
  const { context } = loadContentScript();

  assert.equal(
    vm.runInContext("publicState().contentScriptVersion", context),
    "2026-08-30.9"
  );
});

test("检查状态未知时不能请求索引", async () => {
  const { context } = loadContentScript();

  vm.runInContext(`
    let requestCount = 0;
    submitInspectionUrl = async () => {};
    waitForInspectionResult = async () => "unknown";
    requestIndexing = async () => { requestCount += 1; };
    log = () => {};
  `, context);

  await vm.runInContext(`processUrl("https://new.example/", {
    requestIndexing: true,
    skipSubmitted: false
  })`, context);

  assert.equal(vm.runInContext("requestCount", context), 0);
});
