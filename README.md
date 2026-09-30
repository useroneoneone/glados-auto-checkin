# GLaDOS 多账号自动签到

使用 Cookie 管理多个 GLaDOS 账号，支持定时签到、独立 Webhook、Cookie 到期预警和浏览器插件导入。

- 手动签到、定时签到和登录检测统一排队，只使用 Node 原生 HTTP 客户端，不启动浏览器。
- GET 临时网络错误有限重试，结果不明的签到提交不会自动重放。
- 每个账号独立配置随机入队时间段、时区、Webhook 和到期预警。
- 浏览器插件从登录中的 Chrome/Edge 导入完整 Cookie；服务端只保存加密后的会话数据。
- 后台有账号密码鉴权，Cookie 和 Webhook Secret 加密保存，数据存放在 `data/`。
- GitHub 自动测试并构建 Docker 镜像，服务器只需拉取和启动，无需现场构建。

## 三步部署

适用于已安装 **Docker 和 Docker Compose 的 Linux x86_64 / amd64 服务器**。在服务器终端执行以下命令，无需安装 Node.js 或下载项目源码。

先运行以下两条命令，确认都能显示版本。如果提示命令不存在，请先参考 [Docker 官方安装说明](https://docs.docker.com/engine/install/) 安装 Docker 和 Compose 插件。

```bash
docker --version
docker compose version
```

### 1. 准备配置

整段复制到服务器终端执行。命令会下载启动配置、自动生成两份独立密钥；已有的配置文件会保留。

```bash
mkdir -p ~/glados-auto-checkin
cd ~/glados-auto-checkin
(
  set -eu
  umask 077
  if [ ! -f compose.yaml ]; then
    curl -fL https://raw.githubusercontent.com/useroneoneone/glados-auto-checkin/main/docker-compose.prod.yml -o compose.yaml.download
    mv compose.yaml.download compose.yaml
  fi
  if [ ! -f .env ]; then
    app_key=$(openssl rand -hex 32)
    session_key=$(openssl rand -hex 32)
    printf '%s\n' 'ADMIN_USER=admin' 'ADMIN_PASSWORD=change-this-password' \
      "APP_SECRET=$app_key" "SESSION_SECRET=$session_key" \
      'TZ=Asia/Shanghai' 'HOST_PORT=3000' > .env
  fi
)
```

### 2. 设置登录密码

```bash
nano .env
```

将 `ADMIN_PASSWORD=change-this-password` 等号后的内容换成自己的长密码（建议使用字母和数字）。管理员用户名默认为 `admin`，也可以修改。其他配置保持不变即可。

按 **Ctrl + O → 回车** 保存，再按 **Ctrl + X** 退出。若服务器没有 nano，可使用服务器面板的文件编辑器编辑此目录下的 `.env`。

| 配置 | 作用 | 是否需要修改 |
| --- | --- | --- |
| `ADMIN_USER` / `ADMIN_PASSWORD` | 后台登录账号和密码 | 首次启动前设置密码 |
| `APP_SECRET` | 加密保存 Cookie 和 Webhook 密钥 | 已自动生成，更新时保留；更换后已有数据不能解密 |
| `SESSION_SECRET` | 签名后台登录会话 | 已自动生成；更换后需要重新登录后台 |
| `HOST_PORT` | 浏览器访问端口 | 默认 3000，端口被占用时再修改 |

### 3. 启动并访问

```bash
docker compose pull
docker compose up -d
docker compose ps
```

看到服务状态为 `Up` 后，在浏览器打开 **http://服务器公网IP:3000**，使用刚才设置的账号密码登录。

如果打不开，先检查云服务器安全组和系统防火墙是否允许 TCP 3000（若改了端口，以新端口为准）。使用域名反向代理时，上游填写服务器的 3000 端口，建议启用 HTTPS，并传递 `Host`、`X-Forwarded-For`、`X-Forwarded-Proto`。

## 首次使用

1. 点击 **添加账号**。
2. 在“登录信息”中读取浏览器 Cookie，或展开“手动填写 Cookie”。
3. 设置每日签到开始和结束时间，默认北京时间 **07:15–09:15**。
4. 需要通知时展开“通知与到期提醒”，填写 Webhook；暂时不需要可以跳过。
5. 点击 **保存账号**，回到账号卡片点击 **检测登录**；检测通过后可点击 **立即签到** 验证。

## 更新、日志与备份

日常更新只需在部署目录执行以下命令，保留 `.env` 和 `data/`，不必重新生成密钥或添加账号：

```bash
cd ~/glados-auto-checkin
docker compose pull
docker compose up -d
```

如果设置过 `GLADOS_IMAGE` 固定版本，需先将它改为目标版本或 `ghcr.io/useroneoneone/glados-auto-checkin:latest`。更新前等待正在执行的任务结束。

| 操作 | 命令 |
| --- | --- |
| 查看服务状态 | `docker compose ps` |
| 查看最近日志 | `docker compose logs --tail 100` |
| 暂停服务 | `docker compose stop` |
| 恢复服务 | `docker compose start` |

备份时等待任务结束，先停止服务，再将 **整个 `data/` 文件夹与 `.env` 一起备份**，然后启动服务。两者需要配套恢复；不要将它们上传到公开仓库。

拉取镜像遇到 `EOF`、超时等错误时，先检查服务器到 GHCR 的网络连接；服务日志可用于排查启动和签到问题。

## 轻量运行方式

容器不再内置 Chromium、Xvfb、VNC 或 noVNC，也不暴露 6080 端口。签到请求从服务器的原生 HTTP 客户端发出，带有真实浏览器导入的完整 Cookie、来源页和常用浏览器请求头；每次只在随机时间窗内完成一次状态检查和一次签到提交。

新版插件以 `gld:sess`、`gld:sess.sig` 为必需登录态；若浏览器同时保存 `koa:sess`、`koa:sess.sig`，会将四项一并导入。服务端将导入内容加密后作为 Cookie 请求头发送。

站点仍可能依据服务器 IP、TLS 指纹或其他服务端规则拒绝 HTTP 请求；出现 `Automated check-in detected` 时，记录会保留原提示且不会自动重放 POST。重新登录并重新导入完整 Cookie 后再测试即可。

签到接口使用站点域名作为 token（默认 `glados-facility.com`），通常无需配置。积分展示包含流水余额与本次奖励。

账号编辑页可以设置随机入队开始和结束时间（精度为分钟，含两端）。每天为每个账号独立抽取时间并保存到 SQLite，服务重启沿用计划。在窗口内启动且当天尚无计划时，仅从剩余时间抽取；已有计划错过后会在窗口内补入队，窗口结束后不补签到。跨午夜窗口归属于开始日期，例如 23:00–01:00。实际执行时间受串行队列影响，可能晚于窗口结束。

开始与结束相同表示固定时间。修改设置不会清除当天已入队标记，避免同一调度日重复提交。新账号表单默认时间段为 07:15–09:15。

运行时使用 Node 原生 `fetch`，没有 Playwright 或浏览器运行时依赖。

1. 在后台点击“添加账号”。
2. 优先点击“读取浏览器 Cookie”。导入至少包含同一次登录的 `gld:sess`、`gld:sess.sig`；若存在 `koa:sess`、`koa:sess.sig` 会同时保存。手动填写时 koa 两项可选，但两项必须成对填写。
3. 设置 Cookie 过期时间、每日签到时间、时区和该账号的 Webhook。
4. 保存后可以点击“检测登录”或“立即签到”；Webhook 地址旁的“测试”按钮可单独验证推送。

手动获取 Cookie：登录 `https://glados-facility.com/console/checkin`，按 F12，在 **Application / 应用 → Cookies** 中找到 `glados-facility.com` 下的 `gld:sess`、`gld:sess.sig` 及过期时间；若同时存在 koa 两项，也可一起填写。

### 浏览器插件导入

1. 在账号窗口点击“下载插件”，下载 1.7.0 并解压 ZIP。
2. 打开 `chrome://extensions/` 或 `edge://extensions/`，开启开发者模式，加载解压后的文件夹。
3. 在同一浏览器中登录 GLaDOS，再打开签到管理后台。
4. 点击插件图标，选择“永久授权当前网站”，随后回到后台点击“读取浏览器 Cookie”。
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
- 推送失败会显示在对应账号卡片中，一小时后再次尝试，不修改签到结果。
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

向 `main` 推送后，GitHub Actions 会构建镜像，在镜像内运行自动化回归测试，**全部通过才发布**：

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

测试使用本地模拟接口和内存 SQLite，不读取真实账号或访问真实签到、Webhook 服务。

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

毫秒参数单位均为 ms。

### 运行与备份

签到请求从部署服务器发出，而不是访问后台的浏览器。队列与重试可以降低并发压力，但服务器仍需正常访问 GLaDOS 和推送平台。

签到任务队列目前为单进程内存队列，请只运行一个实例；容器重启不会自动恢复未完成的签到任务，停机期间错过的签到也不会自动补签。预警去重记录则会保留在数据库中。

备份时等待任务结束，停止容器后同时备份 `data/` 和 `.env`，再启动容器。不要将真实数据库、Cookie、Webhook 地址和密钥公开上传到仓库，镜像中也不包含运行数据库或 `.env`。
