#!/usr/bin/env bash
# =============================================================
# Football-2027 Linux 全自动安装脚本
# 用法：bash <(curl -fsSL https://raw.githubusercontent.com/a872034547-cpu/Football-2027/main/scripts/install.sh)
# =============================================================
set -Eeuo pipefail

# ── 颜色 ─────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
RESET='\033[0m'

log()  { printf "${GREEN}[INFO]${RESET}  %s\n" "$*"; }
warn() { printf "${YELLOW}[WARN]${RESET}  %s\n" "$*" >&2; }
err()  { printf "${RED}[ERROR]${RESET} %s\n" "$*" >&2; }
step() { printf "\n${CYAN}▶ %s${RESET}\n" "$*"; }

# ── 参数解析 ─────────────────────────────────────────────────
NO_HERMES=0
for arg in "$@"; do
  case "$arg" in
    --no-hermes) NO_HERMES=1 ;;
    --help|-h)
      echo "用法: bash install.sh [--no-hermes]"
      echo "  --no-hermes   只启动 football-auto 服务，不启动 Hermes Web UI"
      exit 0
      ;;
  esac
done

REPO_URL="https://github.com/a872034547-cpu/Football-2027.git"
INSTALL_DIR="${HOME}/Football-2027"
COMPOSE_FILE="docker-compose.yml"

# ── 工具函数 ─────────────────────────────────────────────────
command_exists() { command -v "$1" >/dev/null 2>&1; }

is_interactive() { [[ -t 0 && -t 1 ]]; }

prompt_input() {
  local label="$1"
  local default="${2:-}"
  local value=""
  if is_interactive; then
    if [[ -n "$default" ]]; then
      printf "${CYAN}%s${RESET}（默认：%s，回车跳过）: " "$label" "$default"
    else
      printf "${CYAN}%s${RESET}（可选，回车跳过）: " "$label"
    fi
    read -r value
  fi
  echo "${value:-$default}"
}

# ── 检查并安装 Docker ─────────────────────────────────────────
install_docker_ubuntu_debian() {
  log "尝试自动安装 Docker（Ubuntu/Debian）..."
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg lsb-release
  install -m 0755 -d /etc/apt/keyrings
  local distro
  distro="$(. /etc/os-release && echo "$ID")"
  curl -fsSL "https://download.docker.com/linux/${distro}/gpg" \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/${distro} $(lsb_release -cs) stable" \
    | tee /etc/apt/sources.list.d/docker.list > /dev/null
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

install_docker_centos() {
  log "尝试自动安装 Docker（CentOS/RHEL）..."
  yum install -y -q yum-utils
  yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
  yum install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

ensure_docker() {
  step "检查 Docker 环境"
  if command_exists docker && docker compose version >/dev/null 2>&1; then
    log "Docker 已安装：$(docker --version)"
    return 0
  fi

  warn "未检测到 Docker，尝试自动安装..."

  if [[ $EUID -ne 0 ]]; then
    err "自动安装 Docker 需要 root 权限。请先执行 sudo -s 切换到 root，或手动安装 Docker 后重试。"
    err "手动安装参考：https://docs.docker.com/engine/install/"
    exit 1
  fi

  if command_exists apt-get; then
    install_docker_ubuntu_debian
  elif command_exists yum; then
    install_docker_centos
  else
    err "不支持的发行版，请手动安装 Docker：https://docs.docker.com/engine/install/"
    exit 1
  fi

  if ! command_exists docker; then
    err "Docker 安装失败，请手动安装后重试。"
    exit 1
  fi
  log "Docker 安装成功：$(docker --version)"
}

# ── 克隆或更新代码 ────────────────────────────────────────────
setup_repo() {
  step "获取最新代码"
  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    log "检测到已有仓库，执行 git pull..."
    git -C "${INSTALL_DIR}" pull --rebase --autostash
  else
    log "克隆仓库到 ${INSTALL_DIR}..."
    git clone "${REPO_URL}" "${INSTALL_DIR}"
  fi
  cd "${INSTALL_DIR}"
  log "当前目录：$(pwd)"
}

# ── 配置 .env ─────────────────────────────────────────────────
setup_env() {
  step "配置环境变量"
  if [[ -f .env ]]; then
    log "检测到已有 .env，跳过模板复制。"
    return 0
  fi

  if [[ ! -f .env.example ]]; then
    err "找不到 .env.example，请检查仓库完整性。"
    exit 1
  fi

  cp .env.example .env
  log "已从 .env.example 创建 .env。"

  if ! is_interactive; then
    warn "非交互式终端，跳过配置引导。请手动编辑 ${INSTALL_DIR}/.env 后重启服务。"
    return 0
  fi

  echo ""
  log "开始交互式配置（按回车跳过可选项）："

  local ai_key
  ai_key="$(prompt_input 'AI API Key（必填）')"
  if [[ -n "$ai_key" ]]; then
    sed -i "s|^AI_API_KEY=.*|AI_API_KEY=${ai_key}|" .env
    log "已设置 AI_API_KEY"
  else
    warn "AI_API_KEY 未填写，AI 分析功能将不可用。"
  fi

  local ai_endpoint
  ai_endpoint="$(prompt_input 'AI 接口地址' 'https://api.openai.com/v1')"
  [[ -n "$ai_endpoint" ]] && sed -i "s|^AI_CUSTOM_ENDPOINT=.*|AI_CUSTOM_ENDPOINT=${ai_endpoint}|" .env

  local ai_model
  ai_model="$(prompt_input 'AI 模型名称' 'gpt-4o-mini')"
  [[ -n "$ai_model" ]] && sed -i "s|^AI_MODEL=.*|AI_MODEL=${ai_model}|" .env

  local feishu_webhook
  feishu_webhook="$(prompt_input '飞书 Webhook 地址')"
  if [[ -n "$feishu_webhook" ]]; then
    sed -i "s|^FEISHU_WEBHOOK=.*|FEISHU_WEBHOOK=${feishu_webhook}|" .env
    # 自动启用飞书推送
    local current_channels
    current_channels="$(grep '^AUTO_PUSH_CHANNELS=' .env | cut -d= -f2- || echo '')"
    if [[ -z "$current_channels" ]]; then
      sed -i "s|^AUTO_PUSH_CHANNELS=.*|AUTO_PUSH_CHANNELS=feishu|" .env
    fi
    log "已设置 FEISHU_WEBHOOK，并启用飞书推送渠道。"
  fi
}

# ── 创建目录 ─────────────────────────────────────────────────
setup_dirs() {
  step "创建运行目录"
  mkdir -p data logs hermes_data
  log "已创建：data/ logs/ hermes_data/"
}

# ── 启动服务 ─────────────────────────────────────────────────
start_services() {
  step "构建并启动 Docker 服务"

  local compose_args=()
  if [[ $NO_HERMES -eq 1 ]]; then
    log "仅启动 football-auto（--no-hermes 模式）"
    compose_args=("football-auto")
  fi

  docker compose -f "${COMPOSE_FILE}" pull 2>/dev/null || true
  docker compose -f "${COMPOSE_FILE}" build football-auto
  docker compose -f "${COMPOSE_FILE}" up -d "${compose_args[@]}"
}

# ── 健康检查 ─────────────────────────────────────────────────
wait_healthy() {
  step "等待服务启动"
  local app_port
  app_port="$(grep '^APP_PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]' || echo '3000')"
  app_port="${app_port:-3000}"
  local health_url="http://127.0.0.1:${app_port}/health"
  local max_wait=120
  local elapsed=0

  log "健康检查地址：${health_url}（最多等待 ${max_wait} 秒）"

  while [[ $elapsed -lt $max_wait ]]; do
    if curl -fsS "${health_url}" >/dev/null 2>&1; then
      log "服务已就绪 ✅"
      return 0
    fi
    printf "."
    sleep 5
    elapsed=$((elapsed + 5))
  done
  echo ""

  warn "健康检查超时，服务可能仍在启动中。查看日志："
  warn "  docker compose logs football-auto"
  return 1
}

# ── 打印完成信息 ──────────────────────────────────────────────
print_summary() {
  local app_port
  app_port="$(grep '^APP_PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]' || echo '3000')"
  app_port="${app_port:-3000}"

  local server_ip
  server_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || echo '你的服务器IP')"

  echo ""
  printf "${GREEN}============================================================${RESET}\n"
  printf "${GREEN}  ✅ Football-2027 安装完成！${RESET}\n"
  printf "${GREEN}============================================================${RESET}\n"
  echo ""
  printf "📌 服务地址：\n"
  printf "  足球预测 API：  ${CYAN}http://${server_ip}:${app_port}${RESET}\n"
  printf "  健康检查：      ${CYAN}http://${server_ip}:${app_port}/health${RESET}\n"
  echo ""
  printf "📁 项目目录：${INSTALL_DIR}\n"
  printf "⚙️  配置文件：${INSTALL_DIR}/.env\n"
  echo ""
  printf "🔧 常用命令：\n"
  printf "  查看日志：    ${CYAN}cd ${INSTALL_DIR} && docker compose logs -f football-auto${RESET}\n"
  printf "  重启服务：    ${CYAN}cd ${INSTALL_DIR} && docker compose restart football-auto${RESET}\n"
  printf "  手动采集：    ${CYAN}curl -X POST http://localhost:${app_port}/api/collect/today${RESET}\n"
  printf "  测试推送：    ${CYAN}curl -X POST http://localhost:${app_port}/api/push/test${RESET}\n"
  printf "  升级版本：    ${CYAN}cd ${INSTALL_DIR} && git pull && docker compose up -d --build${RESET}\n"
  echo ""
  printf "📚 文档：\n"
  printf "  功能文档：${INSTALL_DIR}/docs/FEATURES.md\n"
  printf "  部署文档：${INSTALL_DIR}/docs/DEPLOY.md\n"
  echo ""
  if [[ -f .env ]]; then
    local ai_key
    ai_key="$(grep '^AI_API_KEY=' .env | cut -d= -f2 | tr -d '[:space:]')"
    if [[ "$ai_key" == "your_ai_api_key_here" || -z "$ai_key" ]]; then
      printf "${YELLOW}⚠️  提醒：AI_API_KEY 尚未配置，请编辑 .env 后重启服务！${RESET}\n"
    fi
  fi
}

# ── 主流程 ────────────────────────────────────────────────────
main() {
  echo ""
  printf "${CYAN}============================================================${RESET}\n"
  printf "${CYAN}  ⚽ Football-2027 一键安装脚本${RESET}\n"
  printf "${CYAN}  GitHub: https://github.com/a872034547-cpu/Football-2027${RESET}\n"
  printf "${CYAN}============================================================${RESET}\n"
  echo ""

  ensure_docker
  setup_repo
  setup_env
  setup_dirs
  start_services
  wait_healthy || true
  print_summary
}

main "$@"
