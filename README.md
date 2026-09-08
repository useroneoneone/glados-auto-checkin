# GLaDOS 多账号自动签到

使用 Cookie 管理多个 GLaDOS 账号，支持定时签到、独立 Webhook、Cookie 到期预警和浏览器插件导入。

- 手动签到、定时签到和登录检测统一排队，重叠执行不会启动多个浏览器争抢资源。
- 常规签到直接请求接口；临时网络错误有限重试，结果不明的签到提交不会自动重放。
- 每个账号独立配置签到时间、时区、Webhook 和到期预警。
- 后台有账号密码鉴权，Cookie 和 Webhook Secret 加密保存，数据存放在 `data/`。
- GitHub 自动测试并构建 Docker 镜像，服务器只需拉取和启动，无需现场构建。

## 服务器部署

需要已安装 Docker 和 Docker Compose 的 **Linux x86_64 / amd64** 服务器。

镜像：`ghcr.io/useroneoneone/glados-auto-checkin:latest`

### 1. 下载两个配置文件

以下命令用于**全新目录**；已有部署请看下面的“从旧版迁移”，不要覆盖原来的 `.env`。

```bash
mkdir -p ~/glados-auto-checkin
cd ~/glados-auto-checkin
curl -fL https://raw.githubusercontent.com/useroneoneone/glados-auto-checkin/main/docker-compose.prod.yml -o compose.yaml
curl -fL https://raw.githubusercontent.com/useroneoneone/glados-auto-checkin/main/.env.example -o .env
```

### 2. 设置管理员与密钥

```bash
nano .env
```

修改 `ADMIN_USER`、`ADMIN_PASSWORD`、`APP_SECRET`、`SESSION_SECRET`。后两个密钥分别使用 `openssl rand -hex 32` 生成，不要保留示例值。

**后续更新保留 `.env`，尤其不要更换 `APP_SECRET`，否则旧 Cookie 无法解密。**

### 3. 启动

```bash
docker compose pull
docker compose up -d
```

访问 `http://服务器IP:3000`，用刚才设置的管理员账号登录。

使用 Lucky 反代时，将上游指向服务器的 `3000` 端口，并传递 `Host`、`X-Forwarded-For`、`X-Forwarded-Proto`。后台和 Cookie 传输建议使用 HTTPS。

### 日常更新

在部署目录执行：

```bash
docker compose pull
docker compose up -d
```

更新前等待当前任务结束。原有 `.env`、账号、签到历史和预警记录会保留。

常用命令：

```bash
docker compose logs --tail 100
docker compose stop
docker compose start
```

### 从旧版迁移

在原有项目目录中执行，**不要重新创建 `.env` 或复制其他数据库覆盖 `data/`**：

```bash
curl -fL https://raw.githubusercontent.com/useroneoneone/glados-auto-checkin/main/docker-compose.prod.yml -o docker-compose.prod.yml
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

以后更新仍使用最后两条命令。这份配置保留原服务名、容器名和 `./data:/app/data` 挂载；数据库字段会自动升级。

更改访问端口：在 `.env` 添加 `HOST_PORT=3001`，再执行启动命令。容器内端口保持 `3000`。

## 添加账号

1. 在后台点击“添加 Cookie”。
2. 填入 `koa:sess` 和 `koa:sess.sig` 的**值**，不要包含 Cookie 名称或整段请求头。
3. 设置 Cookie 过期时间、每日签到时间、时区和该账号的 Webhook。
4. 保存后可以点击“检测”或“签到”；Webhook 地址旁的“测试”按钮可单独验证推送。

手动获取 Cookie：登录 `https://glados-facility.com/console/checkin`，按 F12，在 **Application / 应用 → Cookies** 中找到 `glados-facility.com` 下的两个值及过期时间。

### 浏览器插件导入

1. 在账号窗口点击“下载读取 Cookie 插件”，解压 ZIP。
2. 打开 `chrome://extensions/` 或 `edge://extensions/`，开启开发者模式，加载解压后的文件夹。
3. 在同一浏览器中登录 GLaDOS，再打开签到管理后台。
4. 点击插件图标，选择“永久授权当前网站”，随后回到后台点击“一键读取浏览器 Cookie”。
5. 确认名称、Cookie 和到期时间后保存。

更换后台域名时，在新网站上点击插件图标重新授权即可，不需要修改代码。插件没有使用 `activeTab` 临时权限。本机 `http://127.0.0.1:3000` 和 `http://localhost:3000` 为内置允许地址。

<details>
<summary>插件安装截图</summary>

<img width="768" height="466" alt="打开扩展管理页面" src="https://github.com/user-attachments/assets/3a6146e2-980c-408e-b10b-adfbbcec1854" />

<img width="783" height="483" alt="加载解压后的插件" src="https://github.com/user-attachments/assets/37583528-cd50-4d7c-88a9-8345385afbc5" />

<img width="1225" height="861" alt="授权后台并导入 Cookie" src="https://github.com/user-attachments/assets/9afb1284-8c98-44e0-9ff5-9b9cc10d5c40" />

</details>

## Cookie 到期预警

账号编辑窗口提供“Cookie 到期预警”开关与“提前天数”，默认开启，提前 **3 天**，可设置 **1–30 天**。

- 仅检查启用的账号，且必须填写过期时间和 Webhook；关闭账号的定时启用开关也会暂停预警。
- 启动时和每分钟检查一次，进入预警期后按**账号时区每天最多成功提醒一次**。
- Cookie 过期后另发一次提醒，不会每天重复发送过期提醒。
- 提醒记录存入 SQLite，重启后继续去重；更新过期时间后按新的到期时间重新计算。
- 推送失败会显示在账号列表下方，一小时后再次尝试，不修改签到结果。
- 提醒只包含账号名称、到期时间等信息，不包含 Cookie 值。它根据保存的日期预警，不能预测服务端提前撤销登录态。

提醒使用该账号已有的 Webhook 和 Secret，无需额外配置推送渠道。

## Webhook

支持企业微信、飞书、钉钉机器人以及通用 JSON 接口，自动根据 URL 选择格式。测试和正式通知使用相同的发送逻辑。

事件类型：

| 事件 | 用途 |
| --- | --- |
| `glados.checkin` | 签到结果 |
| `glados.cookie.expiry` | Cookie 即将到期或已经过期 |
| `glados.webhook.test` | 测试通知 |

通用 JSON 包含 `event`、`deliveryId`、`account`、`result`；到期提醒的 `result.status` 为 `cookie_expiring` 或 `cookie_expired`，并包含 `remainingDays`、`cookieExpiresAt`。

设置 Secret 后，请求携带 `x-glados-signature: HMAC-SHA256(secret, raw_body)`。每次通知的重试沿用同一 `x-glados-delivery-id` 和 `Idempotency-Key`；自建接收端可按 ID 去重。机器人平台可能不支持去重，响应超时后的重试可能产生重复通知。

推送与签到使用独立队列。超时、连接中断、HTTP 408/429/5xx 默认最多尝试 3 次；其他 HTTP 错误和机器人业务拒绝不立即重试。推送失败不会把成功签到改成失败。

## 镜像自动发布

向 `main` 推送后，GitHub Actions 会构建镜像，在镜像内运行回归测试和浏览器测试，**全部通过才发布**：

- `latest`：最近一次通过验证的 `main` 构建。
- `sha-<12位提交号>`：固定版本，便于回滚。
- `v*` Git 标签：发布同名镜像标签，不改变 `latest`。

Pull Request 只构建和测试，不推送镜像。也可以在 GitHub 的 **Actions → Build and publish Docker image → Run workflow** 手动构建。镜像发布不会自动重启你的服务器，更新时仍需执行 `pull` 和 `up -d`。

**首次发布的可见性：** 如果镜像拉取提示 `denied`，仓库所有者需要在 GitHub **Packages → glados-auto-checkin → Package settings → Change visibility** 中设为 **Public**，之后服务器可免登录拉取。工作流使用仓库自带的 `GITHUB_TOKEN`，无需添加 Docker Hub 密钥。

回滚时在服务器 `.env` 中添加下面这行，再执行更新命令：

```dotenv
GLADOS_IMAGE=ghcr.io/useroneoneone/glados-auto-checkin:sha-实际的12位提交号
```

## 本地开发

本地仍支持源码构建，和服务器的镜像部署配置分开：

```bash
cp .env.example .env
# 修改管理员密码和密钥；已有 .env 时跳过复制
docker compose -f docker-compose.yml up -d --build
```

访问 `http://127.0.0.1:3000`。Node.js 本机开发可运行 `npm ci`、`npm test`；直接 `npm start` 时，把 `.env` 中的 `DATABASE_PATH` 改为 `./data/glados.sqlite`。

测试使用本地模拟接口和内存 SQLite，不读取真实账号或访问真实签到、Webhook 服务。`node test/browser.smoke.js` 额外验证浏览器流程，需要与 Playwright `1.55.0` 匹配的 Chromium；自动构建流程已在 Docker 镜像中执行此项。

## 进阶配置

以下变量均可放在 `.env` 中，修改后重新启动容器：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `TZ` | `Asia/Shanghai` | 容器时区；签到和预警日期使用账号时区 |
| `HOST_PORT` | `3000` | 镜像部署对外端口 |
| `GLADOS_IMAGE` | `ghcr.io/useroneoneone/glados-auto-checkin:latest` | 镜像版本 |
| `CHECKIN_INTERVAL_MS` | `1000` | 串行签到任务间隔 |
| `GLADOS_REQUEST_TIMEOUT_MS` | `30000` | 单次 GLaDOS API 请求超时 |
| `GLADOS_REQUEST_ATTEMPTS` | `3` | 读请求最大尝试次数，含首次；不自动重放签到 POST |
| `RETRY_DELAY_MS` | `1000` | 重试初始退避间隔，后续指数增加 |
| `WEBHOOK_TIMEOUT_MS` | `20000` | 单次推送及响应体读取超时 |
| `WEBHOOK_ATTEMPTS` | `3` | 推送最大尝试次数，含首次 |

毫秒参数单位均为 ms。Playwright 包和基础镜像固定为 `1.55.0`，升级时需要保持一致。

### 运行与备份

签到请求从部署服务器发出，而不是访问后台的浏览器。队列与重试可以降低并发压力，但服务器仍需正常访问 GLaDOS 和推送平台。

签到任务队列目前为单进程内存队列，请只运行一个实例；容器重启不会自动恢复未完成的签到任务，停机期间错过的签到也不会自动补签。预警去重记录则会保留在数据库中。

备份时等待任务结束，停止容器后同时备份 `data/` 和 `.env`，再启动容器。不要将真实数据库、Cookie、Webhook 地址和密钥公开上传到仓库，镜像中也不包含运行数据库或 `.env`。
