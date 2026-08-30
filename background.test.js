"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadBackground() {
  const source = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
  let messageListener;
  const commands = [];

  const context = vm.createContext({
    chrome: {
      debugger: {
        attach: (_target, _version, callback) => callback(),
        detach: (_target, callback) => callback(),
        sendCommand: (_target, method, params, callback) => {
          commands.push({ method, params });
          callback({});
        }
      },
      runtime: {
        get lastError() {
          return null;
        },
        onInstalled: { addListener: () => {} },
        onMessage: {
          addListener: (listener) => {
            messageListener = listener;
          }
        },
        onStartup: { addListener: () => {} }
      },
      sidePanel: { onClosed: { addListener: () => {} }, setPanelBehavior: async () => {} },
      tabs: { query: async () => [] }
    }
  });

  vm.runInContext(source, context);
  return { commands, messageListener };
}

test("GSC 真实回车使用 CDP 发送 keyDown 和 keyUp", async () => {
  const { commands, messageListener } = loadBackground();
  let response;

  assert.equal(
    messageListener({ type: "GSC_HELPER_CDP_KEY", key: "Enter" }, { tab: { id: 7 } }, (value) => {
      response = value;
    }),
    true
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(response)), { ok: true });
  assert.deepEqual(JSON.parse(JSON.stringify(commands)), [
    {
      method: "Input.dispatchKeyEvent",
      params: {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        text: "\r",
        unmodifiedText: "\r",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13
      }
    },
    {
      method: "Input.dispatchKeyEvent",
      params: {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13
      }
    }
  ]);
});
