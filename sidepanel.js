"use strict";

const elements = {
  pageStatus: document.querySelector("#pageStatus"),
  closePanel: document.querySelector("#closePanel"),
  sitemapUrl: document.querySelector("#sitemapUrl"),
  loadSitemap: document.querySelector("#loadSitemap"),
  sitemapStatus: document.querySelector("#sitemapStatus"),
  urlList: document.querySelector("#urlList"),
  urlCount: document.querySelector("#urlCount"),
  clearUrls: document.querySelector("#clearUrls"),
  requestIndexing: document.querySelector("#requestIndexing"),
  skipSubmitted: document.querySelector("#skipSubmitted"),
  startQueue: document.querySelector("#startQueue"),
  stopQueue: document.querySelector("#stopQueue"),
  progressText: document.querySelector("#progressText"),
  runState: document.querySelector("#runState"),
  currentUrl: document.querySelector("#currentUrl"),
  runLog: document.querySelector("#runLog")
};

const SITEMAP_LIMIT = 10000;
const SITEMAP_DEPTH_LIMIT = 4;

let activeTabId = null;
let isSupportedPage = false;
let isRunning = false;
let closing = false;
let logs = [];

init();

async function init() {
  bindEvents();
  await restoreDraft();
  await inspectActiveTab();
  updateUrlCount();
}

function bindEvents() {
  elements.urlList.addEventListener("input", () => {
    updateUrlCount();
    saveDraft();
  });

  elements.sitemapUrl.addEventListener("input", saveDraft);
  elements.requestIndexing.addEventListener("change", saveDraft);
  elements.skipSubmitted.addEventListener("change", saveDraft);

  elements.clearUrls.addEventListener("click", () => {
    elements.urlList.value = "";
    updateUrlCount();
    saveDraft();
  });

  elements.loadSitemap.addEventListener("click", loadSitemap);
  elements.startQueue.addEventListener("click", startQueue);
  elements.stopQueue.addEventListener("click", stopQueue);
  elements.closePanel.addEventListener("click", closeSidePanel);

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "GSC_HELPER_STATE") {
      updateRunState(message.state || {});
    }
    if (message?.type === "GSC_HELPER_LOG") {
      addLog(message.message);
      updateRunState(message.state || {});
    }
  });

  window.addEventListener("pagehide", () => {
    if (!closing) {
      chrome.runtime.sendMessage({ type: "GSC_HELPER_PANEL_CLOSED" });
    }
  });
}

async function restoreDraft() {
  const data = await chrome.storage.local.get({
    sitemapUrl: "",
    urlList: "",
    requestIndexing: true,
    skipSubmitted: true
  });

  elements.sitemapUrl.value = data.sitemapUrl;
  elements.urlList.value = data.urlList;
  elements.requestIndexing.checked = data.requestIndexing;
  elements.skipSubmitted.checked = data.skipSubmitted;
}

function saveDraft() {
  chrome.storage.local.set({
    sitemapUrl: elements.sitemapUrl.value,
    urlList: elements.urlList.value,
    requestIndexing: elements.requestIndexing.checked,
    skipSubmitted: elements.skipSubmitted.checked
  });
}

async function inspectActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;

  if (!activeTabId || !isGscUrl(tab.url)) {
    isSupportedPage = false;
    setPageStatus("请先打开 Google Search Console 页面。", true);
    updateStartState();
    return;
  }

  try {
    const state = await sendToContent({ type: "GSC_HELPER_GET_STATE" });
    isSupportedPage = Boolean(state?.supported);
    updateRunState(state || {});
    setPageStatus(isSupportedPage ? "已连接到 Search Console 页面。" : "当前页面不是可操作的 Search Console 页面。", !isSupportedPage);
  } catch {
    isSupportedPage = false;
    setPageStatus("扩展脚本尚未就绪，请刷新 GSC 页面后重试。", true);
  }

  updateStartState();
}

function isGscUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "search.google.com" && parsed.pathname.startsWith("/search-console/");
  } catch {
    return false;
  }
}

function setPageStatus(message, isError = false) {
  elements.pageStatus.textContent = message;
  elements.pageStatus.classList.toggle("error", isError);
}

function setSitemapStatus(message, isError = false) {
  elements.sitemapStatus.textContent = message;
  elements.sitemapStatus.classList.toggle("error", isError);
}

function updateUrlCount() {
  const count = getUrlsFromTextarea().length;
  elements.urlCount.textContent = `${count} 个 URL`;
  updateStartState();
}

function updateStartState() {
  elements.startQueue.disabled = !isSupportedPage || isRunning || getUrlsFromTextarea().length === 0;
  elements.stopQueue.disabled = !isSupportedPage || !isRunning;
}

function updateRunState(nextState) {
  isRunning = Boolean(nextState.running);
  elements.progressText.textContent = `${nextState.currentIndex || 0} / ${nextState.total || 0}`;
  elements.runState.textContent = isRunning ? "运行中" : "空闲";
  elements.currentUrl.textContent = nextState.currentUrl || "";

  if (Array.isArray(nextState.logs) && nextState.logs.length > logs.length) {
    logs = nextState.logs.slice(-200);
    renderLogs();
  }

  updateStartState();
}

async function loadSitemap() {
  const sitemapUrl = normalizeUrl(elements.sitemapUrl.value);
  if (!sitemapUrl) {
    setSitemapStatus("请输入 sitemap URL。", true);
    return;
  }

  elements.loadSitemap.disabled = true;
  setSitemapStatus("正在解析 sitemap...");

  try {
    const urls = await collectSitemapUrls(sitemapUrl);
    if (urls.length === 0) {
      setSitemapStatus("没有从 sitemap 中解析到页面 URL。", true);
      return;
    }

    const merged = mergeUrls(getUrlsFromTextarea(), urls);
    elements.urlList.value = merged.join("\n");
    updateUrlCount();
    saveDraft();
    setSitemapStatus(`解析完成，已加入 ${urls.length} 个 URL，去重后共 ${merged.length} 个。`);
  } catch (error) {
    setSitemapStatus(error.message || "解析 sitemap 失败。", true);
  } finally {
    elements.loadSitemap.disabled = false;
  }
}

async function collectSitemapUrls(rootUrl) {
  const seenSitemaps = new Set();
  const pageUrls = [];

  async function visit(sitemapUrl, depth) {
    if (depth > SITEMAP_DEPTH_LIMIT) {
      return;
    }

    const normalizedSitemapUrl = normalizeUrl(sitemapUrl);
    if (!normalizedSitemapUrl || seenSitemaps.has(normalizedSitemapUrl) || pageUrls.length >= SITEMAP_LIMIT) {
      return;
    }

    seenSitemaps.add(normalizedSitemapUrl);
    const xmlText = await fetchText(normalizedSitemapUrl);
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");
    if (doc.querySelector("parsererror")) {
      throw new Error(`Sitemap XML 解析失败：${normalizedSitemapUrl}`);
    }

    const sitemapNodes = getChildLocValues(doc.documentElement, "sitemap");
    if (sitemapNodes.length > 0) {
      for (const childSitemapUrl of sitemapNodes) {
        await visit(childSitemapUrl, depth + 1);
      }
      return;
    }

    for (const loc of getChildLocValues(doc.documentElement, "url")) {
      const pageUrl = normalizeUrl(loc);
      if (pageUrl) {
        pageUrls.push(pageUrl);
      }
      if (pageUrls.length >= SITEMAP_LIMIT) {
        break;
      }
    }
  }

  await visit(rootUrl, 0);
  return mergeUrls([], pageUrls);
}

function getChildLocValues(root, itemLocalName) {
  if (!root) {
    return [];
  }

  return Array.from(root.children)
    .filter((item) => item.localName === itemLocalName)
    .map((item) => Array.from(item.children).find((child) => child.localName === "loc")?.textContent?.trim() || "")
    .filter(Boolean);
}

async function fetchText(url) {
  const response = await fetch(url, {
    credentials: "omit",
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`请求 sitemap 失败：HTTP ${response.status}`);
  }

  return response.text();
}

async function startQueue() {
  const urls = getUrlsFromTextarea();
  if (urls.length === 0) {
    setPageStatus("请先输入 URL。", true);
    return;
  }

  logs = [];
  renderLogs();
  saveDraft();

  try {
    updateRunState({ running: true, currentIndex: 0, total: urls.length, currentUrl: "" });
    await sendToContent({
      type: "GSC_HELPER_START_QUEUE",
      urls,
      options: {
        requestIndexing: elements.requestIndexing.checked,
        skipSubmitted: elements.skipSubmitted.checked
      }
    });
    setPageStatus("任务已开始。");
  } catch (error) {
    updateRunState({ running: false, currentIndex: 0, total: urls.length, currentUrl: "" });
    setPageStatus(error.message || "启动任务失败。", true);
  }
}

async function stopQueue() {
  await sendToContent({ type: "GSC_HELPER_STOP_QUEUE" });
  updateRunState({ running: false });
}

async function closeSidePanel() {
  closing = true;
  await chrome.runtime.sendMessage({ type: "GSC_HELPER_PANEL_CLOSED" });
  window.close();
}

function addLog(message) {
  if (!message) {
    return;
  }

  logs.push(message);
  logs = logs.slice(-200);
  renderLogs();
}

function renderLogs() {
  elements.runLog.textContent = logs.join("\n");
  elements.runLog.scrollTop = elements.runLog.scrollHeight;
}

function getUrlsFromTextarea() {
  return mergeUrls([], elements.urlList.value.split(/\r?\n/).map(normalizeUrl).filter(Boolean));
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

function mergeUrls(existingUrls, nextUrls) {
  const seen = new Set();
  const result = [];

  for (const url of [...existingUrls, ...nextUrls]) {
    const normalized = normalizeUrl(url);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function sendToContent(message) {
  if (!activeTabId) {
    return Promise.reject(new Error("没有可用的活动标签页。"));
  }

  return chrome.tabs.sendMessage(activeTabId, message).then((response) => {
    if (response?.ok === false) {
      throw new Error(response.error || "GSC 页面脚本返回失败。");
    }
    return response;
  });
}
