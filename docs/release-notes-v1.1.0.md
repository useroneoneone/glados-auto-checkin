# GLaDOS v1.1.0

- 登录页与原始 React 登录 UI 对齐：逐角色身体倾斜、单眼径向跟随、800ms 聚焦互看、密码显隐视线、随机眨眼和紫色偷看。
- 统一桌面双栏、表单间距、输入框高度和密码图标居中；保留深浅主题与移动端布局。
- 登录失败后保留输入，不销毁动画实例。
- 新增确定性动画回归测试和发布包校验测试。
- 提供 Linux x86_64/amd64 预构建 GHCR 镜像，以及固定提交版本的 Compose 部署包和 SHA256SUMS。

下载部署包与 SHA256SUMS，执行 `sha256sum -c SHA256SUMS`，解压后运行 `bash install.sh ~/glados-auto-checkin`。详细步骤见包内 `INSTALL.zh-CN.md`。

已有服务保留 `.env` 和 `data/`，运行 `docker compose pull && docker compose up -d`；固定版本用户先更新 `GLADOS_IMAGE`。请等待正在执行的签到任务结束并备份后再更新。

部署包不包含真实账号、Cookie、密钥或运行数据库。发布不会自动重启云服务器。
