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
    href: "https://search.google.com/search-console/inspect?resource_id=site&id=https%3A%2F%2Fold.example%2F",
    search: "?resource_id=site&id=https%3A%2F%2Fold.example%2F"
  };
  const context = vm.createContext({
    clearTimeout,
    console,
    document: {
      body: {},
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

  const wait = vm.runInContext(`waitForInspectionStart("https://new.example/", {
    href: location.href,
    inspectedUrl: "https://old.example/",
    status: "requested"
  })`, context);

  await assert.rejects(wait, /GSC 没有开始检查该 URL/);
});

test("新 URL 进入加载态后只读取该 URL 的新结果", async () => {
  const { context, location } = loadContentScript();
  setInspectionStatus(context, "已请求编入索引", "requested");

  const waitForStart = vm.runInContext(`waitForInspectionStart("https://new.example/", {
    href: location.href,
    inspectedUrl: "https://old.example/",
    status: "requested"
  })`, context);

  setTimeout(() => {
    location.href = "https://search.google.com/search-console/inspect?resource_id=site&id=https%3A%2F%2Fnew.example%2F";
    location.search = "?resource_id=site&id=https%3A%2F%2Fnew.example%2F";
  }, 2);
  setTimeout(() => {
    context.pageText = "正在从 google 索引中检索数据 已请求编入索引";
  }, 5);

  await waitForStart;

  const waitForResult = vm.runInContext("waitForInspectionResult('https://new.example/')", context);
  setTimeout(() => {
    context.pageText = "网址不在 Google 上";
    context.inspectionStatus = "not-indexed";
  }, 8);

  assert.equal(await waitForResult, "not-indexed");
});

test("当前检查 URL 不匹配时不能继续请求索引", async () => {
  const { context } = loadContentScript();
  setInspectionStatus(context, "已请求编入索引", "requested");

  const wait = vm.runInContext("waitForInspectionResult('https://new.example/')", context);

  await assert.rejects(wait, /当前检查的网址与目标 URL 不一致/);
});
