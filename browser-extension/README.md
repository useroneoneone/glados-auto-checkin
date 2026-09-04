# GLaDOS Cookie Helper

该扩展用于把当前 Chrome/Edge 用户配置中的 GLaDOS 登录信息填入签到控制台。

## 安装

### Chrome

1. 打开 `chrome://extensions/`
2. 开启右上角“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择本项目的 `browser-extension` 文件夹

### Edge

1. 打开 `edge://extensions/`
2. 开启“开发人员模式”
3. 点击“加载解压缩的扩展”
4. 选择本项目的 `browser-extension` 文件夹

安装后，在同一个浏览器用户配置中登录 `https://glados-facility.com`，刷新签到控制台，然后在添加或编辑账号时点击“一键读取浏览器 Cookie”。

扩展只允许以下控制台地址发起读取：

- `http://127.0.0.1:3000`
- `http://localhost:3000`

如果更换了正式后台域名，需要在 `manifest.json` 的 `content_scripts.matches` 和 `service-worker.js` 的 `CONSOLE_ORIGINS` 中加入新地址，然后在扩展管理页点击重新加载。

普通网页不能静默安装 Chrome/Edge 扩展。开发阶段需要按上面的步骤加载已解压扩展；发布到 Chrome Web Store 或 Microsoft Edge Add-ons 后，可以在控制台放置商店链接，但安装仍会由浏览器显示确认界面。
