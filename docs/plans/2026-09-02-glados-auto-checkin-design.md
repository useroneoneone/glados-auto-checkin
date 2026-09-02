# GLaDOS 多账号自动签到设计

## 目标

提供一个 Docker 化服务，自动读取邮箱验证码登录 GLaDOS，复用会话完成签到，并提供带管理员鉴权的后台页面。每个邮箱账号独立保存 IMAP 配置、浏览器会话与 Webhook。

## 方案

- Node.js + Express：HTTP API、Session 鉴权与静态前端。
- SQLite：账号、签到结果、管理员信息的轻量持久化。
- Playwright Chromium：验证码登录、会话保存与“积分 → 签到”页面兜底。
- ImapFlow + mailparser：轮询 INBOX，提取 GLaDOS 邮件中的 6 位验证码。
- node-cron：按 `CHECKIN_CRON` 和 `CHECKIN_TIMEZONE` 定时执行启用账号。
- AES-256-GCM：使用 `APP_SECRET` 加密 IMAP 密码、Webhook Secret、storageState。

## 数据流

1. 管理员登录后台。
2. 添加账号，服务加密保存敏感字段。
3. 登录操作先检查 `/api/user/status`；未登录时填写邮箱并点击验证码按钮。
4. IMAP 从请求时间点开始轮询最新邮件，提取 6 位验证码并回填。
5. 登录成功后保存 Playwright storageState。
6. 签到优先调用站点接口；接口不可用时点击页面菜单“积分”和“签到”。
7. 写入历史记录并向该账号自己的 Webhook 推送结果。

## 错误处理

- IMAP 连接、验证码超时、选择器变化都会写入 `login_failed` 或 `failed` 历史。
- 会话失效记录 `login_required`，不会自动重复消耗验证码。
- Webhook 失败只记录 `webhookError`，不覆盖签到主结果。
- 同一账号使用进程内互斥，避免定时任务与手动操作并发。

## 测试重点

- 管理员登录/退出与未授权 API 返回 401。
- 账号新增、编辑、删除与敏感字段不回显。
- 已登录会话跳过验证码；过期会话能正确记录 `login_required`。
- 成功、重复签到、接口失败、Webhook 失败均有历史记录。
- Docker 启动后数据目录重启保持不变。
