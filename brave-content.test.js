"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadBraveContentScript() {
  const source = fs.readFileSync(path.join(__dirname, "brave-content.js"), "utf8");
  const context = vm.createContext({
    console,
    document: {
      body: { innerText: "Insert the URL to be re-fetched Submit" },
      querySelector: () => null,
      querySelectorAll: () => []
    },
    chrome: {
      runtime: {
        onMessage: { addListener: () => {} },
        sendMessage: async () => ({ ok: true })
      }
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    location: {
      hostname: "search.brave.com",
      pathname: "/submit-url"
    },
    setTimeout,
    URL
  });

  vm.runInContext(source, context);
  vm.runInContext(`
    BRAVE_WAIT.poll = 1;
    BRAVE_WAIT.input = 20;
    BRAVE_WAIT.submitButton = 20;
    BRAVE_WAIT.result = 50;
  `, context);

  return context;
}

function stubSubmissionUi(context) {
  context.inputElement = {};
  context.submitButton = {
    disabled: false,
    getAttribute: () => null
  };
  context.writtenValue = "";
  context.clicked = false;
  vm.runInContext(`
    findUrlInput = () => inputElement;
    findSubmitButton = () => submitButton;
    focusAndSetValue = async (_element, value) => { writtenValue = value; };
    trustedClickElement = async () => { clicked = true; };
  `, context);
}

test("Brave URL 成功提示出现后完成单条提交", async () => {
  const context = loadBraveContentScript();
  stubSubmissionUi(context);

  const submission = vm.runInContext(
    "submitBraveUrl('https://example.com/page#section')",
    context
  );
  setTimeout(() => {
    context.document.body.innerText = "Success Thank you for your submission.";
  }, 5);

  await submission;
  assert.equal(context.writtenValue, "https://example.com/page");
  assert.equal(context.clicked, true);
});

test("Brave 验证码错误会终止当前提交", async () => {
  const context = loadBraveContentScript();
  stubSubmissionUi(context);

  const submission = vm.runInContext(
    "submitBraveUrl('https://example.com/page')",
    context
  );
  setTimeout(() => {
    context.document.body.innerText = "Error Error solving captcha.";
  }, 5);

  await assert.rejects(submission, /error solving captcha/i);
});

test("Brave 已成功页面要求刷新后才能处理下一条", async () => {
  const context = loadBraveContentScript();
  context.document.body.innerText = "Success Thank you for your submission.";

  await assert.rejects(
    vm.runInContext("submitBraveUrl('https://example.com/page')", context),
    /需要刷新后继续/
  );
});
