# 预构建部署包安装说明

适用于 **Linux x86_64 / amd64** 轻量云服务器。需要已安装并运行 Docker Engine、Docker Compose 插件；首次安装还需要 Bash 和 OpenSSL。服务器无需安装 Node.js、npm 或现场编译应用。

部署包包含 `compose.yaml`、`install.sh`、`.env.example`、本说明和 `release.json`；**不包含真实数据库、Cookie、运行配置或密钥**。Compose 默认固定到此次提交的 `sha-*` 镜像；可以在 `.env` 中使用 `GLADOS_IMAGE` 显式覆盖。

## 首次安装

从 [GitHub Releases](https://github.com/useroneoneone/glados-auto-checkin/releases/latest) 下载部署包和 `SHA256SUMS`，例如：

```bash
mkdir -p ~/glados-download
cd ~/glados-download
curl -fLO https://github.com/useroneoneone/glados-auto-checkin/releases/latest/download/glados-auto-checkin-v1.1.0-deploy.tar.gz
curl -fLO https://github.com/useroneoneone/glados-auto-checkin/releases/latest/download/SHA256SUMS
sha256sum -c SHA256SUMS
tar -xzf glados-auto-checkin-v1.1.0-deploy.tar.gz
cd glados-auto-checkin-v1.1.0-deploy
bash install.sh ~/glados-auto-checkin
```

`latest` 示例文件名对应 v1.1.0；以后从 Release 页使用目标版本的确切链接与文件名。安装脚本会隐藏密码输入，要求设置至少 12 位管理员密码，自动生成两份独立随机密钥，再拉取已测试的镜像并启动。默认管理员账号 `admin`、对外端口 `3000`。

如需其他端口，可执行 `GLADOS_HOST_PORT=3080 bash install.sh ~/glados-auto-checkin`。密码字符允许字母、数字和 `. _ @ % + = : -`；高级字符可由用户手动编辑 `.env` 配置。脚本不会打印密码或密钥。

启动后访问 `http://服务器公网IP:3000`，并在云安全组和防火墙中放行 TCP 3000。若修改端口，以实际映射端口为准；公网登录推荐使用 HTTPS 反向代理。

## 已有部署更新

**请保留原部署目录的 `.env` 和整个 `data/` 文件夹，尤其是 `APP_SECRET`。** 更新前等待正在执行的签到任务结束并做好备份。

若原来部署使用 `latest`，直接执行：

```bash
cd ~/glados-auto-checkin
docker compose pull
docker compose up -d
docker compose ps
```

若原来固定了镜像版本，在原 `.env` 中将 `GLADOS_IMAGE` 改成新部署包 `release.json` 中的镜像地址，再执行以上命令。不要重建 `.env` 或替换加密密钥，否则已有 Cookie 将不能解密。

安装脚本遇到现有 `.env` 或 `compose.yaml` 会保留它们，因此不会自动覆盖已有固定版本和自定义配置。不要在新的目录启动第二份服务并误认为是原服务的数据升级。

## 日志、回滚和数据备份

```bash
cd ~/glados-auto-checkin
docker compose logs --tail 100
```

回滚：在 `.env` 中设置旧版 `GLADOS_IMAGE=ghcr.io/useroneoneone/glados-auto-checkin:sha-旧提交前12位`，执行 `docker compose pull` 和 `docker compose up -d`。

备份时先等待任务结束、停止容器，然后同时备份 `.env` 和整个 `data/`；恢复时必须配套使用。GHCR 拉取失败时检查服务器到 `ghcr.io` 的网络连通性。安装脚本只操作本机 Docker，不安装系统软件或自动修改防火墙。
