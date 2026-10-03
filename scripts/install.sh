#!/usr/bin/env bash
set -euo pipefail
umask 077

bundle_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
target_dir="${1:-$PWD}"
command -v docker >/dev/null || { echo '请先安装 Docker Engine。' >&2; exit 1; }
docker compose version >/dev/null || { echo '请先安装 Docker Compose 插件。' >&2; exit 1; }
docker info >/dev/null || { echo '请先启动 Docker，并确保当前用户有访问权限。' >&2; exit 1; }
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) echo '本部署包面向 Linux x86_64/amd64。' >&2; exit 1 ;;
esac

mkdir -p -- "$target_dir"
target_dir="$(cd -- "$target_dir" && pwd)"
if [[ ! -f "$target_dir/compose.yaml" ]]; then
  cp -- "$bundle_dir/compose.yaml" "$target_dir/compose.yaml"
else
  echo '保留已有 compose.yaml；其镜像版本选择继续有效。'
fi

if [[ ! -f "$target_dir/.env" ]]; then
  command -v openssl >/dev/null || { echo '首次安装需要 openssl 生成随机密钥。' >&2; exit 1; }
  admin_user="${GLADOS_ADMIN_USER:-admin}"
  admin_password="${GLADOS_ADMIN_PASSWORD:-}"
  host_port="${GLADOS_HOST_PORT:-3000}"
  if [[ -z "$admin_password" ]]; then
    if [[ ! -t 0 ]]; then
      echo '请在交互终端运行安装脚本，或设置 GLADOS_ADMIN_PASSWORD。' >&2
      exit 1
    fi
    read -r -s -p '设置管理员密码（至少 12 位字母/数字或 . _ @ % + = : -）：' admin_password
    printf '\n'
    read -r -s -p '再次输入管理员密码：' confirmation
    printf '\n'
    [[ "$admin_password" == "$confirmation" ]] || { echo '两次密码输入不一致。' >&2; exit 1; }
  fi
  [[ "$admin_user" =~ ^[a-zA-Z0-9._@-]+$ ]] || { echo '管理员用户名格式错误。' >&2; exit 1; }
  [[ ${#admin_password} -ge 12 && "$admin_password" =~ ^[a-zA-Z0-9._@%+=:-]+$ && "$admin_password" != 'change-this-password' ]] || {
    echo '请使用至少 12 位密码，字符限字母、数字和 . _ @ % + = : -。' >&2; exit 1;
  }
  [[ "$host_port" =~ ^[0-9]{1,5}$ ]] && (( 10#$host_port >= 1 && 10#$host_port <= 65535 )) || {
    echo 'GLADOS_HOST_PORT 应为 1–65535。' >&2; exit 1;
  }
  app_key="$(openssl rand -hex 32)"
  session_key="$(openssl rand -hex 32)"
  env_temp="$(mktemp "$target_dir/.env.XXXXXX")"
  trap '[[ ! -f "$env_temp" ]] || rm -- "$env_temp"' EXIT
  printf '%s\n' "ADMIN_USER=$admin_user" "ADMIN_PASSWORD=$admin_password" \
    "APP_SECRET=$app_key" "SESSION_SECRET=$session_key" \
    'TZ=Asia/Shanghai' "HOST_PORT=$host_port" > "$env_temp"
  # A concurrent installer must not replace an already-created configuration.
  mv -n -- "$env_temp" "$target_dir/.env"
else
  echo '保留已有 .env（管理员密码、加密密钥和会话密钥均不变）。'
fi

mkdir -p -- "$target_dir/data"
cd -- "$target_dir"
docker compose -f compose.yaml config --quiet
docker compose -f compose.yaml pull
docker compose -f compose.yaml up -d
docker compose -f compose.yaml ps
echo '部署命令执行完成。请检查上面的容器状态；访问地址为 http://服务器公网IP:映射端口。'
echo '端口映射：'
docker compose -f compose.yaml port glados-checkin 3000
echo '请在云安全组/防火墙放行对应端口，公网使用建议配置 HTTPS。'
