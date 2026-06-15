# ⚽ 足球预测自动化 — Hermes Studio 上线运营部署指南

本指南面向**小白用户和上线运营负责人**，目标是把 Football Auto 足球预测能力服务与 Hermes Studio 可视化控制台一起部署起来，做到：采集、分析、排序、报告、推送、复盘、问答和运维自检都能按固定流程执行。

> 重要口径：生产采集失败时系统不会自动伪造样例数据。真实上线必须依赖真实采集结果；离线链路验证请使用 `npm run smoke:local`，该脚本只使用内置样例验证程序链路，不作为投注依据。

---

## 1. 软件全功能介绍

### 1.1 Football Auto 能做什么

Football Auto 是本项目的足球预测能力服务，默认端口 `3000`，主要能力包括：

- **当天赛事全量采集**：从 Titan007/球探采集当天比赛列表。
- **单场详情采集**：采集基本面、欧赔、亚盘、大小球等数据。
- **竞彩/投票偏差接入**：支持竞彩或投票相关字段进入分析链。
- **量化概率预测**：基于欧赔、亚盘、大小球、近期状态等生成 1X2 概率。
- **专业盘口增强层**：识别欧亚缺口、盘口诱导、大小球联动、市场异动等信号。
- **风险与冷门识别**：输出风险等级、冷门候选、回避项和失效条件。
- **Market Timeline**：记录盘口快照，分析赛前变化趋势。
- **CLV 推荐价与收盘价结算**：记录推荐时价格，赛果同步后计算收盘价价值表现。
- **Elo Rating**：赛果同步后更新球队评分，为后续预测提供先验。
- **日报组合方案**：按概率、置信度、风险、数据完整度和盘口一致性排序，输出稳健/平衡/进取组合。
- **AI 问答**：通过 `/api/qa` 结合当天报告回答用户问题。
- **多通道推送**：支持飞书、企业微信、QQ OneBot/NapCat。
- **定时任务**：内置每日采集分析和每日赛果同步 Cron。
- **运营自检**：提供 doctor、smoke、本地测试和 Docker healthcheck。

### 1.2 Hermes Studio 在系统中的作用

Hermes Studio / Hermes Web UI 默认端口 `6060`，主要作为：

- 小白可视化控制台。
- AI Provider / 模型 / Profile 管理入口。
- Agent 问答入口。
- Web Terminal 运维入口。
- 定时任务管理入口。
- 多渠道消息平台配置入口。

推荐架构是：**Hermes 负责交互和 Agent 编排，Football Auto 负责足球数据采集、分析和持久化。**

---

## 2. 服务器要求

| 项目 | 最低要求 | 推荐配置 |
|------|---------|---------|
| CPU | 2 核 | 4 核以上 |
| 内存 | 4 GB | 8 GB 以上 |
| 磁盘 | 20 GB | 40 GB 以上 |
| 系统 | Ubuntu 22.04 / Windows 10 | Ubuntu 24.04 / Windows 11 |
| Docker | 24+ | 最新稳定版 |
| Docker Compose | V2，即 `docker compose` | 最新稳定版 |

Playwright 浏览器自动化比较吃内存，生产运营不建议低于 4 GB。

---

## 3. 最快安装方式

### 3.1 Linux / VPS 一键安装

在服务器上进入项目根目录后执行：

```bash
bash server/scripts/install-linux.sh
```

脚本会自动完成：

1. 检查 Docker 和 Docker Compose。
2. 如果 [`server/.env`](.env:1) 不存在，复制 [`server/.env.hermes.example`](.env.hermes.example:1)。
3. 创建 `data/`、`hermes_data/`、`logs/`。
4. 构建 `football-auto` 镜像。
5. 启动 Hermes + Football Auto。
6. 等待 `/health` 通过。
7. 如果本机安装了 npm，额外运行 doctor 和本地 smoke。

常用访问地址：

| 服务 | 地址 |
|------|------|
| Hermes Studio | `http://服务器IP:6060` |
| Football Auto 健康检查 | `http://服务器IP:3000/health` |
| 任务状态 | `http://服务器IP:3000/api/jobs/status` |

### 3.2 Windows 一键安装

先安装 Docker Desktop 并启动，然后在项目根目录用 PowerShell 执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\server\scripts\install-windows.ps1
```

如果你已经构建过镜像，只想快速重启：

```powershell
powershell -ExecutionPolicy Bypass -File .\server\scripts\install-windows.ps1 -SkipDockerBuild
```

---

## 4. 手动安装方式

### 4.1 安装 Docker

Ubuntu 示例：

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
```

验证：

```bash
docker --version
docker compose version
```

### 4.2 准备配置

进入服务目录：

```bash
cd server
cp .env.hermes.example .env
```

Windows PowerShell：

```powershell
Set-Location server
Copy-Item .env.hermes.example .env
```

至少修改这些配置：

```env
PUBLIC_REPORT_BASE_URL=http://你的服务器IP:3000/reports
AI_CUSTOM_ENDPOINT=https://api.openai.com/v1
AI_API_KEY=sk-你的密钥
AI_MODEL=gpt-4o-mini
FEISHU_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/你的webhook
AUTO_PUSH_CHANNELS=feishu
```

生产建议保持：

```env
ALLOW_SAMPLE_FALLBACK=0
RESULT_SYNC_CRON=0 23 * * *
```

### 4.3 启动完整模式

```bash
docker compose -f docker-compose.hermes.yml up -d --build
```

查看状态：

```bash
docker compose -f docker-compose.hermes.yml ps
```

查看日志：

```bash
docker compose -f docker-compose.hermes.yml logs -f football-auto
docker compose -f docker-compose.hermes.yml logs -f hermes-webui
```

### 4.4 只启动足球服务

如果暂时不需要 Hermes：

```bash
docker compose up -d --build
```

---

## 5. 本地全流程验收标准

上线前必须至少完成以下检查。

### 5.1 代码静态检查

```bash
cd server
npm run check
```

### 5.2 核心测试

```bash
npm test
```

### 5.3 完整测试

```bash
npm run test:full
```

`test:full` 会额外覆盖赛果同步和 Elo 逻辑。`test:optional:elo-api` 需要先启动服务，因此不放在默认完整测试里。

### 5.4 环境自检 Doctor

```bash
npm run doctor
```

如果服务已经启动，可以检查 HTTP 健康状态：

```bash
npm run doctor -- --url=http://127.0.0.1:3000
```

### 5.5 离线完整链路 Smoke

```bash
npm run smoke:local
```

该脚本会使用独立 SQLite 数据库 `server/data/__smoke_local__.sqlite`，验证：

1. 初始化数据库。
2. 写入样例比赛。
3. 写入样例快照。
4. 执行真实分析链。
5. 写入日报组合。
6. 注入 mock 赛果。
7. 执行赛果同步、预测结算、Elo/CLV 相关链路。

注意：这是离线链路验证，不代表真实采集成功，也不能作为投注依据。

### 5.6 服务健康检查

启动后访问：

```bash
curl http://127.0.0.1:3000/health
```

正常示例：

```json
{
  "ok": true,
  "service": "football-auto",
  "time": "2026-06-15T08:00:00.000Z"
}
```

---

## 6. 常用 API

| 用途 | 方法 | 地址 |
|------|------|------|
| 健康检查 | GET | `/health` |
| 配置快照 | GET | `/api/config` |
| 任务状态 | GET | `/api/jobs/status` |
| 今日流水线 | POST | `/api/jobs/daily/run` |
| 赛果同步 | POST | `/api/results/sync` |
| 每日报告 | GET | `/api/reports/daily?date=YYYY-MM-DD` |
| 单场报告 | GET | `/api/reports/:matchId` |
| AI 问答 | POST | `/api/qa` |
| 推送日报 | POST | `/api/push/daily` |
| 推送单场 | POST | `/api/push/:matchId` |
| 推送日志 | GET | `/api/push/logs?limit=20` |

手动触发今日完整流水线：

```bash
curl -X POST http://127.0.0.1:3000/api/jobs/daily/run
```

查看推送日志：

```bash
curl "http://127.0.0.1:3000/api/push/logs?limit=20"
```

---

## 7. Hermes 初次使用

1. 打开 `http://服务器IP:6060`。
2. 默认账号通常是 `admin / 123456`，首次登录后必须立即修改密码。
3. 如果需要 token，可查看：

```bash
cat ./hermes_data/hermes-web-ui/.token
```

4. 在 Hermes 中配置 Provider、模型和 Profile。
5. 创建 Profile：`足球预测助手`。

建议系统提示词：

```text
你是足球预测系统的控制 Agent。你不直接编造比赛数据，必须优先调用
football-auto 服务的报告、排序、复盘和问答接口。对于没有采集到的数据，
必须明确说明缺失，不得伪造盘口、赔率、伤停或赛果。输出时优先给出
概率排序、风险等级、可信组合、回避项和失效条件。不得承诺收益。
```

Hermes 内网调用地址：

```text
http://football-auto:3000
```

---

## 8. 定时任务配置

### 8.1 内置 Cron

[`server/.env.hermes.example`](.env.hermes.example:1) 默认：

```env
DAILY_COLLECT_CRON=0 8 * * *
RESULT_SYNC_CRON=0 23 * * *
```

含义：

- 每天 08:00 自动采集并分析当天赛事。
- 每天 23:00 自动同步赛果、结算预测、更新 Elo/CLV。

关闭方式：

```env
DAILY_COLLECT_CRON=false
RESULT_SYNC_CRON=false
```

### 8.2 Hermes 定时任务

也可以在 Hermes Studio 里创建 HTTP 任务：

```text
POST http://football-auto:3000/api/jobs/daily/run
POST http://football-auto:3000/api/results/sync
```

---

## 9. 推送配置

### 9.1 飞书

```env
FEISHU_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
FEISHU_SECRET=
AUTO_PUSH_CHANNELS=feishu
```

测试：

```bash
curl -X POST http://127.0.0.1:3000/api/push/daily
```

### 9.2 企业微信

```env
WECOM_WEBHOOK=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
AUTO_PUSH_CHANNELS=feishu,wecom
```

### 9.3 QQ / OneBot / NapCat

1. 在 [`server/docker-compose.hermes.yml`](docker-compose.hermes.yml:75) 中按注释启用 `napcat` 服务。
2. 配置：

```env
ONEBOT_BASE_URL=http://napcat:3001
ONEBOT_TARGET_TYPE=group
ONEBOT_TARGET_ID=你的群号
AUTO_PUSH_CHANNELS=feishu,wecom,onebot
```

3. 重启：

```bash
docker compose -f docker-compose.hermes.yml up -d
```

---

## 10. 目录结构说明

```text
server/
├── Dockerfile                    # 足球服务镜像构建文件
├── docker-compose.yml            # 基础模式：只启动 football-auto
├── docker-compose.hermes.yml     # 完整模式：Hermes + football-auto
├── .dockerignore                 # Docker 构建忽略规则
├── .env.example                  # 基础配置模板
├── .env.hermes.example           # Hermes 完整部署配置模板
├── README-HERMES.md              # 本指南
├── package.json                  # npm 脚本和依赖
├── data/                         # SQLite 数据库和运行数据
├── hermes_data/                  # Hermes 持久化数据
├── logs/                         # 容器/脚本日志挂载目录
├── scripts/
│   ├── doctor.mjs                # 环境自检
│   ├── smoke-local.mjs           # 离线全链路 smoke
│   ├── install-linux.sh          # Linux 一键安装
│   └── install-windows.ps1       # Windows 一键安装
└── src/
    ├── config.js                 # 配置读取
    ├── index.js                  # Express 主入口 / API / Cron
    ├── collectors/               # Titan007、竞彩、赛果采集
    ├── analysis/                 # 分析引擎、归一化、增强层
    ├── clv/                      # CLV 推荐价与结算
    ├── db/                       # SQLite 数据库层
    ├── metrics/                  # 概率指标与校准
    ├── push/                     # 飞书 / 企微 / OneBot 推送
    ├── ratings/                  # Elo Rating
    ├── results/                  # 赛果同步、预测结算、回测
    └── timeline/                 # Market Timeline
```

---

## 11. 常用维护命令

```bash
# 查看所有服务状态
docker compose -f docker-compose.hermes.yml ps

# 查看实时日志
docker compose -f docker-compose.hermes.yml logs -f

# 只看足球服务日志
docker compose -f docker-compose.hermes.yml logs -f football-auto

# 修改 .env 后重启足球服务
docker compose -f docker-compose.hermes.yml restart football-auto

# 更新代码后重建
docker compose -f docker-compose.hermes.yml up -d --build

# 停止全部服务
docker compose -f docker-compose.hermes.yml down

# 查看数据目录大小
du -sh ./data ./hermes_data ./logs

# 备份数据库
mkdir -p ./backups
cp ./data/app.sqlite ./backups/app-$(date +%Y%m%d-%H%M%S).sqlite
```

Windows PowerShell 备份示例：

```powershell
New-Item -ItemType Directory -Force .\server\backups
Copy-Item .\server\data\app.sqlite ".\server\backups\app-$(Get-Date -Format yyyyMMdd-HHmmss).sqlite"
```

---

## 12. 常见问题

### Q：Hermes 控制台打不开？

检查容器和端口：

```bash
docker compose -f docker-compose.hermes.yml ps
docker compose -f docker-compose.hermes.yml logs hermes-webui
```

如果是云服务器，还要开放安全组或防火墙端口 `6060`。

### Q：足球服务 `/health` 失败？

```bash
docker compose -f docker-compose.hermes.yml logs football-auto
npm run doctor -- --url=http://127.0.0.1:3000
```

### Q：采集失败，能不能自动用样例数据？

不能。上线运营必须真实采集，失败时应查看日志、网络、页面结构和数据源状态。离线验证请使用：

```bash
npm run smoke:local
```

### Q：飞书推送没收到？

检查：

- `FEISHU_WEBHOOK` 是否正确。
- `AUTO_PUSH_CHANNELS` 是否包含 `feishu`。
- 群机器人是否启用安全签名，若启用需填写 `FEISHU_SECRET`。
- 查看真实推送日志：

```bash
curl "http://127.0.0.1:3000/api/push/logs?limit=20"
```

### Q：AI 成本太高？

降低完整长报告数量：

```env
AI_MAX_DAILY_MATCHES_FULL_REPORT=3
```

也可以换更便宜的 OpenAI-compatible 模型。

### Q：默认密码安全吗？

不安全。Hermes 首次登录后必须修改默认密码；不要把 `.env`、数据库和 `hermes_data/` 发给别人。

---

## 13. 上线运营风险清单

上线前必须确认：

- [ ] [`server/.env`](.env:1) 已按真实服务器 IP/域名配置 `PUBLIC_REPORT_BASE_URL`。
- [ ] `AI_API_KEY` 可用，`AI_CUSTOM_ENDPOINT` 与模型匹配。
- [ ] `ALLOW_SAMPLE_FALLBACK=0`，没有把样例当真实采集结果。
- [ ] `npm run check` 通过。
- [ ] `npm test` 通过。
- [ ] `npm run test:full` 通过。
- [ ] `npm run doctor` 通过或仅有可接受警告。
- [ ] `npm run smoke:local` 通过。
- [ ] Docker `/health` 为 healthy。
- [ ] 飞书/企微/QQ 至少一个推送通道完成实测。
- [ ] 数据库已配置备份策略。
- [ ] 云服务器防火墙只开放必要端口。
- [ ] Hermes 默认密码已修改。
- [ ] 已阅读免责声明：系统输出是概率分析和风控建议，不保证命中率或收益。

---

## 14. 参考文档

- [完整方案文档](../tocodex-docs/2026-06-14_Hermes全自动足球预测服务端细化方案.md)
- [Hermes Web UI 官方文档](https://github.com/EKKOLearnAI/hermes-web-ui)
- [Hermes Studio 官方文档](https://github.com/EKKOLearnAI/hermes-studio)
- [NapCatQQ 文档](https://github.com/NapNeko/NapCatQQ)
- [OneBot 11 协议](https://github.com/botuniverse/onebot-11)
