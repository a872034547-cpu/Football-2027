# ⚽ Football-2027 — 全自动足球预测服务

![Node.js](https://img.shields.io/badge/Node.js-18%2B-green) ![License](https://img.shields.io/badge/license-MIT-blue) ![Docker](https://img.shields.io/badge/Docker-Compose-blue)

> **无需懂代码，部署即用。** 全自动采集今日赛事，AI 深度分析预测，自动推送飞书/企业微信/QQ，每天零运维。

---

## ✨ 核心功能

| 功能 | 说明 |
|------|------|
| 🕐 全自动采集 | 每天 08:00 自动抓取 Titan007 今日全量赛事 |
| 🤖 AI 深度分析 | 接入 OpenAI-compatible 接口，多维度预测 |
| 📊 Elo 评分系统 | 动态球队战力评分，赛前注入分析链 |
| 📈 市场时间线 | 赔率时序追踪，识别异动信号 |
| 💰 CLV 追踪 | 闭盘价值分析，过滤低价值投注 |
| 🏆 组合方案 | 自动输出稳健/平衡/进取三档方案 |
| 🔄 赛果同步 | 每天 23:00 自动同步赛果并回测 |
| 📬 多渠道推送 | 飞书、企业微信、QQ OneBot |
| 🩺 健康检查 | `/health` 端点，Docker 自动重启 |

---

## 🚀 快速部署（5 分钟上线）

### 方法一：Linux VPS 一键安装（推荐）

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/a872034547-cpu/Football-2027/main/scripts/install.sh)
```

脚本会自动安装 Docker、拉取代码、配置环境、启动服务。

### 方法二：手动 Docker Compose

```bash
git clone https://github.com/a872034547-cpu/Football-2027.git
cd Football-2027
cp .env.example .env
# 编辑 .env，至少填写 AI_API_KEY
nano .env
docker compose up -d --build
```

### 方法三：Windows 本地部署

```powershell
# 在 PowerShell 中执行
irm https://raw.githubusercontent.com/a872034547-cpu/Football-2027/main/scripts/install-windows-new.ps1 | iex
```

---

## ⚙️ 关键配置

编辑 `.env` 文件，以下配置**必填**：

```dotenv
# AI 接口（必填）
AI_CUSTOM_ENDPOINT=https://api.openai.com/v1   # 支持任意 OpenAI 兼容接口
AI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxx
AI_MODEL=gpt-4o-mini

# 推送渠道（至少填一个）
FEISHU_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
AUTO_PUSH_CHANNELS=feishu
```

完整配置说明见 [docs/DEPLOY.md](docs/DEPLOY.md)。

---

## 📡 API 接口

服务启动后访问 `http://服务器IP:3000`：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/api/matches?date=2026-06-15` | 查询某天比赛 |
| GET | `/api/daily-report?date=2026-06-15` | 获取日报 |
| GET | `/api/portfolio?date=2026-06-15` | 获取组合方案 |
| GET | `/api/elo/standings` | Elo 排行榜 |
| POST | `/api/push/test` | 手动触发推送测试 |
| POST | `/api/collect/today` | 手动触发今日采集 |
| POST | `/api/results/sync` | 手动触发赛果同步 |

---

## 📁 目录结构

```
Football-2027/
├── src/
│   ├── index.js              # 主服务入口
│   ├── collectors/           # 数据采集模块
│   ├── analysis/             # AI 分析模块
│   ├── ratings/              # Elo 评分
│   ├── timeline/             # 市场时间线
│   ├── clv/                  # CLV 引擎
│   ├── results/              # 赛果同步 & 回测
│   ├── push/                 # 推送模块
│   └── db/                   # 数据库
├── scripts/
│   ├── install.sh            # Linux 一键安装
│   ├── install-windows-new.ps1 # Windows 安装
│   └── doctor.mjs            # 环境诊断
├── docs/
│   ├── FEATURES.md           # 功能详细文档
│   └── DEPLOY.md             # 小白部署教程
├── .env.example              # 配置模板
├── docker-compose.yml        # Docker 编排
└── Dockerfile
```

---

## 🔧 常用命令

```bash
# 查看服务状态
docker compose ps

# 查看日志
docker compose logs -f football-auto

# 手动触发采集
curl -X POST http://localhost:3000/api/collect/today

# 手动触发推送
curl -X POST http://localhost:3000/api/push/test

# 重启服务
docker compose restart football-auto

# 更新到最新版
git pull && docker compose up -d --build
```

---

## 📬 推送渠道配置

### 飞书机器人
1. 飞书群 → 设置 → 机器人 → 添加自定义机器人
2. 复制 Webhook 地址填入 `FEISHU_WEBHOOK`
3. 如启用签名校验，同时填入 `FEISHU_SECRET`

### 企业微信机器人
1. 企业微信群 → 添加群机器人 → 复制 Webhook
2. 填入 `WECOM_WEBHOOK`

### QQ（OneBot）
1. 部署 go-cqhttp 或 LLOneBot
2. 填入 `ONEBOT_BASE_URL`、`ONEBOT_ACCESS_TOKEN`、`ONEBOT_TARGET_ID`

---

## 📚 文档

- [📖 功能详细文档](docs/FEATURES.md)
- [🚀 小白部署教程](docs/DEPLOY.md)

---

## 📄 License

MIT © 2026 Football-2027 Contributors
