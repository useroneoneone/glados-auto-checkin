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

安装后，在同一个浏览器用户配置中登录 `https://glados-facility.com`，然后打开签到管理后台。首次在某个后台域名使用时，点击浏览器工具栏中的插件图标，再点击“永久授权当前网站”。授权完成后即可在添加或编辑账号时点击“一键读取浏览器 Cookie”。

以下本机控制台地址无需额外授权：

- `http://127.0.0.1:3000`
- `http://localhost:3000`

正式后台域名通过插件弹窗单独申请永久权限，不需要再修改 `manifest.json`。权限只授予当前打开的网站，并会一直保留，直到在插件弹窗或浏览器扩展设置中主动取消。

插件没有使用 `activeTab` 临时权限。为了识别当前后台地址，插件使用 `tabs` 权限读取当前标签页 URL；Cookie 权限仍只覆盖 `glados-facility.com`。

普通网页不能静默安装 Chrome/Edge 扩展。开发阶段需要按上面的步骤加载已解压扩展；发布到 Chrome Web Store 或 Microsoft Edge Add-ons 后，可以在控制台放置商店链接，但安装仍会由浏览器显示确认界面。
