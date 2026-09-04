# GLaDOS 多账号自动签到

一个使用 Node.js、Playwright、SQLite 和 Docker 构建的 GLaDOS机场 自动签到管理控制台。

## 功能

- 管理多个 GLaDOS 账号，每个账号独立保存 Cookie、定时设置和 Webhook
- 分别填写 `koa:sess` 与 `koa:sess.sig`，敏感字段加密存储
- 安装配套 Chrome/Edge 扩展后，可一键读取当前浏览器的 Cookie、账号名称和过期时间
- 检测 Cookie 登录状态，手动执行签到
- 检测和签到使用后台异步任务，避免 Lucky、Nginx 等反向代理等待超时
- 每个账号可在管理页面设置每日执行时间、时区和启用状态
- 查看签到历史、积分、状态和错误信息
- 支持 Webhook 测试以及企业微信、飞书、钉钉机器人格式
- 通用 Webhook 可使用 HMAC-SHA256 签名
- SQLite 数据持久化，重建 Docker 容器不会丢失账号和历史记录

## Cookie 获取

在 https://glados-facility.com/console/checkin 地址登录 GLaDOS 后，在浏览器中按F12在开发者工具中打开 **Application / 应用** → **Cookies** → `https://glados-facility.com`，分别复制：

- `koa:sess` 的值
- `koa:sess.sig` 的值

只填写 Cookie 的值，不要把 `koa:sess=`、`koa:sess.sig=` 或完整 Cookie 请求头一起粘贴进去。

## 一键读取浏览器 Cookie

由于 GLaDOS Cookie 属于另一个域名且可能带有 `HttpOnly`，管理页面需要配套浏览器扩展才能读取。

Chrome 安装步骤：

1. 打开 `chrome://extensions/`
2. 开启右上角“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择项目中的 `browser-extension` 文件夹

Edge 用户可以打开 `edge://extensions/`，开启开发人员模式并加载同一个文件夹。

也可以在签到控制台打开“添加 Cookie”或“编辑 Cookie”，点击“下载读取 Cookie 插件”获得插件压缩包。解压后按上面的步骤加载插件文件夹。

安装后，在同一个浏览器用户配置中登录 GLaDOS，再打开签到控制台。首次使用某个后台域名时，点击浏览器工具栏中的插件图标，选择“永久授权当前网站”。授权成功后打开“添加 Cookie”或“编辑 Cookie”，点击“一键读取浏览器 Cookie”。检查自动填入的账号名称、两个 Cookie 值和过期时间后再保存。

以下本机控制台地址无需额外授权：

- `http://127.0.0.1:3000`
- `http://localhost:3000`

更换后台域名时不再需要修改插件文件。打开新的后台网站，点击插件图标并永久授权当前网站即可。每个后台域名单独授权，权限会持续保留，直到主动取消。

浏览器不允许普通网页静默安装本地扩展。开发阶段需加载 `browser-extension` 文件夹；如果以后发布到 Chrome Web Store 或 Microsoft Edge Add-ons，控制台可以链接到商店安装页，但用户仍需在浏览器确认安装。

## 本地启动

1. 创建配置文件：

```powershell
Copy-Item .env.example .env
```

2. 修改 `.env` 中的管理员密码和密钥。可使用以下命令生成随机密钥：

```powershell
[Convert]::ToHexString((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

3. 构建并启动：

```powershell
docker compose up -d --build
```

4. 打开 `http://127.0.0.1:3000`，使用 `.env` 中的 `ADMIN_USER` 和 `ADMIN_PASSWORD` 登录。

查看状态和日志：

```powershell
docker ps --filter name=glados-auto-checkin
docker logs --tail 100 glados-auto-checkin
```

停止服务：

```powershell
docker compose down
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | Web 服务端口 |
| `TZ` | `Asia/Shanghai` | 容器时区 |
| `DATABASE_PATH` | `/app/data/glados.sqlite` | SQLite 数据库路径 |
| `APP_SECRET` | 无安全默认值 | Cookie 和 Webhook Secret 加密密钥 |
| `SESSION_SECRET` | 无安全默认值 | 管理后台 Session 密钥 |
| `ADMIN_USER` | `admin` | 管理员账号 |
| `ADMIN_PASSWORD` | `change-this-password` | 管理员密码 |
| `GLADOS_ORIGIN` | `https://glados-facility.com` | GLaDOS 地址 |
| `GLADOS_CHECKIN_TOKEN` | `glados.cloud` | GLaDOS 签到接口 Token |

定时时间和时区不再由 `.env` 控制，而是在后台为每个账号单独设置。修改执行时间、时区或重新启用账号时，当天调度标记会自动重置。

## Webhook

账号编辑页面提供 Webhook 测试按钮。程序会根据 URL 自动选择消息格式：

- 企业微信：`qyapi.weixin.qq.com/cgi-bin/webhook/send`
- 飞书：`open.feishu.cn/open-apis/bot/...`
- 钉钉：包含 `/robot/send` 的钉钉机器人地址
- 其他地址：发送通用 JSON

通用 Webhook 示例：

```json
{
  "event": "glados.checkin",
  "account": {
    "id": 1,
    "label": "主账号",
    "email": "name@example.com",
    "cookieExpiresAt": "2027-01-01T00:00:00.000Z"
  },
  "result": {
    "status": "success",
    "message": "签到成功",
    "points": "1234",
    "pointsChange": "1",
    "checkedAt": "2026-09-02T07:15:00.000Z"
  }
}
```

配置 Webhook Secret 后，通用 Webhook 请求会携带：

```text
x-glados-signature: HMAC-SHA256(secret, raw_body)
```

如果平台返回非成功状态或业务错误码，错误会显示在账号状态、签到历史和容器日志中。

## 异步任务

点击“检测”或“签到”时，接口会立即创建后台任务，前端随后轮询任务状态。Playwright 在 Docker 容器中运行，对 GLaDOS 的请求从部署服务器发出，不是从访问管理页面的浏览器发出。

因此使用 Lucky 或其他反向代理时，不需要让一个 HTTP 请求持续等待 Playwright 完成。只需确保普通 API 请求可以正常转发，并正确传递 `Host`、`X-Forwarded-For` 和 `X-Forwarded-Proto`。

## 服务器部署

将项目上传到服务器后执行：

```bash
cd /root/glados-auto-checkin
cp .env.example .env
# 修改 .env
docker compose up -d --build
docker logs --tail 100 glados-auto-checkin
```

数据保存在项目的 `data/` 目录中。升级代码前建议备份：

```bash
cp -a data "data-backup-$(date +%Y%m%d-%H%M%S)"
```

## 升级说明

- 数据库字段在启动时自动迁移，不需要手工修改 SQLite。
- Playwright 包版本必须与 Docker 基础镜像版本一致。本项目固定使用 Playwright `1.55.0`。
