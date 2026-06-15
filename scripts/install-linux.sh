#!/usr/bin/env bash
set -Eeuo pipefail

# =============================================================
# Football Auto + Hermes Linux 一键启动脚本
# 说明：
#   - 本脚本不会自动安装 Docker，只会在缺失时给出 Ubuntu/Debian 安装提示。
#   - 请在 Linux 服务器上执行：bash server/scripts/install-linux.sh
# =============================================================

log() {
  printf '\n[INFO] %s\n' "$*"
}

warn() {
  printf '\n[WARN] %s\n' "$*" >&2
}

err() {
  printf '\n[ERROR] %s\n' "$*" >&2
}

print_docker_install_hint() {
  cat >&2 <<'EOF'

未检测到可用的 Docker 或 Docker Compose。
请先在 Ubuntu/Debian 服务器上安装 Docker Engine 与 Compose 插件，然后重新执行本脚本。

参考命令（请根据你的服务器环境自行确认后执行）：

  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
    sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

如果你使用 Debian，请将上面的 docker.com/linux/ubuntu 改为 docker.com/linux/debian，或参考 Docker 官方文档。
安装后可执行以下命令验证：

  docker --version
  docker compose version

EOF
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

# 自动定位脚本所在目录，并切换到 server 根目录。
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SERVER_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
cd "${SERVER_ROOT}"

log "当前 server 根目录：${SERVER_ROOT}"

# 检查 Docker 与 Docker Compose 插件。
if ! command_exists docker; then
  err "未检测到 docker 命令。"
  print_docker_install_hint
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  err "未检测到 docker compose 插件。"
  print_docker_install_hint
  exit 1
fi

# 如果 .env 不存在，优先从 .env.hermes.example 复制。
if [[ ! -f .env ]]; then
  if [[ -f .env.hermes.example ]]; then
    cp .env.hermes.example .env
    log "已从 .env.hermes.example 复制生成 .env。请按需编辑 AI、推送、公网地址等配置。"
  else
    err ".env 不存在，且未找到 .env.hermes.example，无法继续。"
    exit 1
  fi
else
  log "检测到已有 .env，跳过配置模板复制。"
fi

# 创建运行所需目录。
mkdir -p data hermes_data logs
log "已确保 data、hermes_data、logs 目录存在。"

# 读取 .env 中的端口配置；未配置则使用默认端口。
APP_PORT="${APP_PORT:-3000}"
HERMES_PORT="${HERMES_PORT:-6060}"
if [[ -f .env ]]; then
  ENV_APP_PORT="$(grep -E '^APP_PORT=' .env 2>/dev/null | tail -n 1 | cut -d '=' -f 2- || true)"
  ENV_HERMES_PORT="$(grep -E '^HERMES_PORT=' .env 2>/dev/null | tail -n 1 | cut -d '=' -f 2- || true)"
  APP_PORT="${ENV_APP_PORT:-${APP_PORT}}"
  HERMES_PORT="${ENV_HERMES_PORT:-${HERMES_PORT}}"
fi

# 构建 Football Auto 镜像。
log "开始构建 football-auto 镜像。"
docker compose -f docker-compose.hermes.yml build football-auto

# 启动 Hermes + Football Auto。
log "开始启动 Docker Compose 服务。"
docker compose -f docker-compose.hermes.yml up -d

HEALTH_URL="http://127.0.0.1:${APP_PORT}/health"
log "等待 Football Auto 健康检查通过：${HEALTH_URL}（最多 90 秒）"

check_health_with_curl() {
  curl -fsS "${HEALTH_URL}" >/dev/null 2>&1
}

check_health_with_python() {
  python3 - "${HEALTH_URL}" <<'PY' >/dev/null 2>&1
import sys
import urllib.request

url = sys.argv[1]
try:
    with urllib.request.urlopen(url, timeout=5) as response:
        sys.exit(0 if 200 <= response.status < 300 else 1)
except Exception:
    sys.exit(1)
PY
}

check_health_with_node() {
  node -e "fetch(process.argv[1]).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" "${HEALTH_URL}" >/dev/null 2>&1
}

health_ok=0
for second in $(seq 1 90); do
  if command_exists curl; then
    if check_health_with_curl; then
      health_ok=1
      break
    fi
  elif command_exists python3; then
    if check_health_with_python; then
      health_ok=1
      break
    fi
  elif command_exists node; then
    if check_health_with_node; then
      health_ok=1
      break
    fi
  else
    warn "未检测到 curl、python3 或 node，无法从宿主机主动检查健康接口。"
    break
  fi

  sleep 1
  if (( second % 10 == 0 )); then
    log "仍在等待服务就绪... ${second}/90 秒"
  fi
done

if [[ "${health_ok}" == "1" ]]; then
  log "Football Auto 健康检查已通过。"
else
  warn "Football Auto 健康检查在 90 秒内未通过；Docker 服务已尝试启动，请查看日志确认原因。"
fi

# 如果本机有 npm，执行本地诊断与 smoke；失败只提示，不阻断 Docker 已启动。
if command_exists npm; then
  if npm run | grep -qE '(^|[[:space:]])doctor($|[[:space:]:])'; then
    log "检测到 npm，开始执行 npm run doctor。"
    if ! npm run doctor; then
      warn "npm run doctor 执行失败；Docker 服务已启动，请根据上方输出排查。"
    fi
  else
    warn "package.json 未定义 doctor 脚本，跳过 npm run doctor。"
  fi

  if npm run | grep -qE '(^|[[:space:]])smoke:local($|[[:space:]:])'; then
    log "检测到 npm，开始执行 npm run smoke:local。"
    if ! npm run smoke:local; then
      warn "npm run smoke:local 执行失败；Docker 服务已启动，请根据上方输出排查。"
    fi
  else
    warn "package.json 未定义 smoke:local 脚本，跳过 npm run smoke:local。"
  fi
else
  warn "本机未检测到 npm，跳过 npm run doctor 和 npm run smoke:local；Docker 服务不受影响。"
fi

cat <<EOF

============================================================
部署流程已执行完成
============================================================

访问地址：
  Football Auto 健康检查：http://127.0.0.1:${APP_PORT}/health
  Football Auto 服务入口：http://服务器IP:${APP_PORT}
  Hermes Web UI 控制台：http://服务器IP:${HERMES_PORT}

常用维护命令（请在 server/ 目录执行）：
  查看服务状态：docker compose -f docker-compose.hermes.yml ps
  查看全部日志：docker compose -f docker-compose.hermes.yml logs -f
  查看足球服务日志：docker compose -f docker-compose.hermes.yml logs -f football-auto
  查看 Hermes 日志：docker compose -f docker-compose.hermes.yml logs -f hermes-webui
  重启全部服务：docker compose -f docker-compose.hermes.yml restart
  停止全部服务：docker compose -f docker-compose.hermes.yml down
  更新并重建足球服务：docker compose -f docker-compose.hermes.yml build football-auto && docker compose -f docker-compose.hermes.yml up -d

配置文件：
  server/.env

数据目录：
  server/data
  server/hermes_data
  server/logs

提示：
  - 首次部署后建议编辑 server/.env，填写 AI Key、推送 Webhook、公网报告地址等配置。
  - Hermes 默认账号如仍为 admin / 123456，请登录后立即修改密码。
  - 如健康检查未通过，可先执行：docker compose -f docker-compose.hermes.yml logs -f football-auto

EOF
