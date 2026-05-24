# GSC URL Inspection Helper

一个 Manifest V3 Chrome Extension，用于在 Google Search Console 页面批量执行网址检查，并在页面未被收录时请求编入索引。

## 使用方式

1. 打开 Chrome 的 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目目录。
5. 打开任意 Google Search Console 页面。
6. 点击扩展图标打开 Chrome 原生侧边栏，输入 sitemap URL 并解析，或手动粘贴 URL 列表。
7. 点击“开始处理”。

## 功能

- 支持解析 sitemap urlset。
- 支持递归解析 sitemap index。
- 支持手动粘贴 URL，每行一个。
- 自动去重。
- 仅在 `https://search.google.com/search-console/*` 页面允许启动任务。
- 在 Chrome 原生侧边栏显示处理进度和日志。
- 可停止队列；关闭侧边栏也会停止当前任务。

## 注意事项

- 扩展需要 `http://*/*` 和 `https://*/*` host permissions 来从侧边栏里抓取任意站点的 sitemap。
- 扩展使用 `debugger` 权限在当前 GSC 标签页发送真实鼠标点击事件，用于点击 GSC 的搜索和请求编入索引按钮。
- GSC 是动态页面，按钮文案或 DOM 结构变化后，可能需要调整 `content.js` 中的文本匹配规则。
- Google 对请求编入索引有配额和频率限制，本扩展不会绕过这些限制。
