# Football-2027 功能详细文档

> 版本：1.0.0 | 更新时间：2026-06-15

---

## 目录

1. [系统架构](#1-系统架构)
2. [全自动比赛采集](#2-全自动比赛采集)
3. [AI 深度分析预测](#3-ai-深度分析预测)
4. [Elo 动态评分系统](#4-elo-动态评分系统)
5. [市场时间线追踪](#5-市场时间线追踪)
6. [CLV 准入引擎](#6-clv-准入引擎)
7. [概率排序与组合方案](#7-概率排序与组合方案)
8. [赛果自动同步与回测](#8-赛果自动同步与回测)
9. [多渠道推送](#9-多渠道推送)
10. [HTTP API 接口](#10-http-api-接口)
11. [定时任务系统](#11-定时任务系统)
12. [数据库结构](#12-数据库结构)

---

## 1. 系统架构

```
┌─────────────────────────────────────────────────────────┐
│                     定时任务层 (node-cron)               │
│  08:00 每日采集    23:00 赛果同步    自定义 Cron         │
└──────────────┬──────────────────────┬────────────────────┘
               ▼                      ▼
┌──────────────────────┐  ┌───────────────────────────────┐
│   数据采集层          │  │      赛果同步 & 回测层         │
│  Titan007 今日赛事    │  │  ResultCollector → Backtest   │
│  Titan007 单场详情    │  │  Elo 自动更新                 │
│  竞彩/竞足数据        │  └───────────────────────────────┘
└──────────┬───────────┘
           ▼
┌──────────────────────────────────────────────────────────┐
│                      分析增强层                           │
│  Elo评分注入 → 市场时间线 → CLV过滤 → AI深度分析          │
│  盘口增强 → 竞彩偏差 → 欧亚缺口 → 量化预测               │
└──────────────────────┬───────────────────────────────────┘
                       ▼
┌──────────────────────────────────────────────────────────┐
│                    组合输出层                             │
│  概率排序 → 风险分层 → 稳健/平衡/进取方案 → 报告生成      │
└──────────────────────┬───────────────────────────────────┘
                       ▼
┌──────────────────────────────────────────────────────────┐
│                    推送层                                 │
│  飞书 Webhook    企业微信 Webhook    QQ OneBot            │
└──────────────────────────────────────────────────────────┘
```

---

## 2. 全自动比赛采集

### 功能说明

系统每天 08:00（默认，可通过 `DAILY_COLLECT_CRON` 调整）自动抓取 Titan007 今日全量赛事，并对每场比赛采集完整数据。

### 采集内容

| 数据类型 | 来源 | 说明 |
|---------|------|------|
| 今日赛事列表 | Titan007 | 比赛ID、主客队、联赛、开赛时间 |
| 欧洲赔率 | Titan007 | 主胜/平/客赔率及变化 |
| 亚洲盘口 | Titan007 | 让球数值及上下盘赔率 |
| 大小球 | Titan007 | 进球数预测与赔率 |
| 竞彩数据 | 体彩竞足 | 投票分布、销售量 |

### 配置项

```dotenv
TITAN_BASE_URL=https://live.titan007.com  # 数据源地址
COLLECT_CONCURRENCY=4                      # 并发采集数量
DAILY_COLLECT_CRON=0 8 * * *              # 采集时间（每天08:00）
ALLOW_SAMPLE_FALLBACK=0                    # 生产环境禁用样例降级
```

### 手动触发

```bash
curl -X POST http://localhost:3000/api/collect/today
```

---

## 3. AI 深度分析预测

### 功能说明

对每场采集到的比赛，调用 OpenAI-compatible AI 接口进行多维度深度分析，输出结构化预测结果。

### 分析维度

1. **基本面分析** — 主客队近期状态、历史交锋
2. **盘口分析** — 欧赔/亚盘/大小球综合研判
3. **赔率异动** — 开盘到即时的变化幅度和方向
4. **竞彩偏差** — 市场投票方向与赔率的背离程度
5. **欧亚缺口** — 欧洲盘与亚洲盘预测差异
6. **Elo 差值** — 两队动态战力评分之差
7. **主场优势** — 主场胜率历史校准值

### 输出结构

```json
{
  "matchId": "12345",
  "prediction": {
    "result": "主胜",
    "probability": 0.68,
    "confidence": "高",
    "riskLevel": "中",
    "reasoning": "主队近5场4胜，亚盘受水明显，欧赔支持主胜..."
  },
  "scores": {
    "elo_advantage": 120,
    "market_consensus": 0.72,
    "clv_score": 0.85
  }
}
```

### 配置项

```dotenv
AI_CUSTOM_ENDPOINT=https://api.openai.com/v1
AI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxx
AI_MODEL=gpt-4o-mini
AI_TIMEOUT_MS=180000                        # 超时180秒
AI_MAX_DAILY_MATCHES_FULL_REPORT=8          # 每天最多完整报告场次
```

> **成本控制**：超过 `AI_MAX_DAILY_MATCHES_FULL_REPORT` 的比赛走短摘要，避免过度消耗 Token。

---

## 4. Elo 动态评分系统

### 功能说明

基于历史赛果持续更新球队 Elo 评分，赛前自动注入分析链，提供动态战力参考。

### Elo 参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| K 因子 | 32 | 每场比赛更新幅度 |
| 初始评分 | 1500 | 新球队默认分值 |
| 主场加成 | +100 | 主场方的预期分优势 |

### API 接口

```bash
# 获取 Elo 排行榜
GET /api/elo/standings?league=英超&limit=20

# 获取某球队历史评分
GET /api/elo/team?name=曼城

# 获取某场比赛的 Elo 预测
GET /api/elo/predict?homeTeam=曼城&awayTeam=利物浦
```

### 配置项

```dotenv
ELO_K_FACTOR=32          # K 因子
ELO_HOME_ADVANTAGE=100   # 主场优势加成
ELO_INITIAL_RATING=1500  # 初始评分
```

---

## 5. 市场时间线追踪

### 功能说明

记录赔率从开盘到即时的完整时序变化，识别大资金介入信号和临场异动。

### 追踪指标

- **欧赔变化幅度** — 主胜/平/客赔率的绝对变化和方向
- **亚盘飘移** — 让球数值的变化（升盘/降盘）
- **受水方向** — 上盘/下盘水位变化
- **时间节点** — 开盘、12小时前、6小时前、3小时前、1小时前

### 数据存储

市场时间线数据存储在 `schema-market-timeline.sql` 定义的表中，支持按比赛 ID 查询完整赔率历史。

### API 接口

```bash
# 获取某场比赛的赔率时间线
GET /api/timeline/match?matchId=12345

# 获取今日异动比赛列表
GET /api/timeline/anomalies?date=2026-06-15
```

---

## 6. CLV 准入引擎

### 功能说明

CLV（Closing Line Value，闭盘价值）是衡量投注价值的核心指标。引擎对每场比赛计算预测赔率与实际闭盘赔率的对比，过滤低价值机会。

### 工作流程

```
预测赔率 → 与闭盘赔率对比 → 计算 CLV 分数 → 门控过滤 → 进入组合
```

### 门控规则

- CLV 分数 < 0：低于闭盘价值，默认拒绝进入高风险组合
- CLV 分数 0~0.5：边际价值，进入平衡组合需额外置信度
- CLV 分数 > 0.5：正向价值，优先纳入所有组合档次

### 配置项

```dotenv
CLV_MIN_SCORE=0.0        # 最低 CLV 分数门控
CLV_LOOKBACK_DAYS=30     # 回看历史天数
```

---

## 7. 概率排序与组合方案

### 功能说明

对当天所有分析完毕的比赛，按多维度评分进行排序，自动生成三档投注组合方案。

### 排序维度

1. 预测概率（权重 40%）
2. AI 置信度（权重 25%）
3. CLV 分数（权重 20%）
4. 数据完整度（权重 10%）
5. 盘口一致性（权重 5%）

### 三档组合方案

| 档次 | 特点 | 比赛筛选 | 适用人群 |
|------|------|---------|---------|
| 🛡️ 稳健 | 低风险、高置信度 | 综合评分 Top 3，概率 > 65% | 保守型 |
| ⚖️ 平衡 | 风险适中 | 综合评分 Top 5，概率 > 58% | 均衡型 |
| ⚡ 进取 | 潜在高回报 | 综合评分 Top 8，包含冷门 | 激进型 |

### API 接口

```bash
# 获取今日组合方案
GET /api/portfolio?date=2026-06-15

# 获取某档方案详情
GET /api/portfolio?date=2026-06-15&tier=stable
```

### 响应示例

```json
{
  "date": "2026-06-15",
  "tiers": {
    "stable": {
      "matches": [
        {"matchId": "001", "prediction": "主胜", "probability": 0.72, "odds": 1.85}
      ],
      "expectedReturn": 1.24,
      "maxLoss": "本金"
    },
    "balanced": { "..." : "..." },
    "aggressive": { "..." : "..." }
  }
}
```

---

## 8. 赛果自动同步与回测

### 功能说明

每天 23:00 自动同步当天赛果，触发自动回测，更新 Elo 评分和校准规则。

### 同步流程

```
23:00 Cron 触发
  → 抓取 Titan007 赛果
  → 写入数据库 match_results 表
  → 计算当日预测准确率
  → 触发 Walk-Forward 回测
  → 更新 Elo 评分
  → 更新规则校准参数
  → 生成复盘报告（可选推送）
```

### 回测类型

- **日级回测**：每天自动执行，校验当日预测
- **Walk-Forward 回测**：滚动窗口回测，验证规则泛化能力

### 配置项

```dotenv
RESULT_SYNC_CRON=0 23 * * *   # 赛果同步时间（填 false 可关闭）
```

### 手动触发

```bash
# 手动触发赛果同步
curl -X POST http://localhost:3000/api/results/sync

# 手动触发回测
curl -X POST http://localhost:3000/api/backtest/run
```

---

## 9. 多渠道推送

### 飞书机器人

支持文本消息和加签验签，消息格式包含比赛详情、预测结果、概率和组合方案。

```dotenv
FEISHU_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
FEISHU_SECRET=your_sign_secret   # 可选，加签安全模式
```

### 企业微信机器人

```dotenv
WECOM_WEBHOOK=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
```

### QQ OneBot（go-cqhttp / LLOneBot）

```dotenv
ONEBOT_BASE_URL=http://127.0.0.1:5700
ONEBOT_ACCESS_TOKEN=your_token
ONEBOT_TARGET_TYPE=group          # group 或 private
ONEBOT_TARGET_ID=123456789        # 群号或 QQ 号
```

### 推送渠道配置

```dotenv
# 多渠道同时推送，逗号分隔
AUTO_PUSH_CHANNELS=feishu,wecom
```

### 手动推送

```bash
# 推送今日报告
curl -X POST http://localhost:3000/api/push/daily-report

# 推送测试消息
curl -X POST http://localhost:3000/api/push/test
```

---

## 10. HTTP API 接口

### 健康检查

```
GET /health
```

响应：
```json
{"status": "ok", "time": "2026-06-15T08:00:00.000Z", "db": "ok"}
```

### 比赛查询

```
GET /api/matches?date=2026-06-15&limit=50
GET /api/matches/:matchId
```

### 分析报告

```
GET /api/daily-report?date=2026-06-15
GET /api/portfolio?date=2026-06-15&tier=stable|balanced|aggressive
```

### Elo 评分

```
GET /api/elo/standings?league=英超&limit=20
GET /api/elo/team?name=曼城
GET /api/elo/predict?homeTeam=曼城&awayTeam=利物浦
```

### 操作控制

```
POST /api/collect/today          # 手动触发采集
POST /api/results/sync           # 手动触发赛果同步
POST /api/backtest/run           # 手动触发回测
POST /api/push/daily-report      # 手动推送报告
POST /api/push/test              # 推送测试消息
```

---

## 11. 定时任务系统

基于 `node-cron` 管理所有自动化任务：

| 任务 | 默认时间 | 环境变量 |
|------|---------|---------|
| 每日采集 | 08:00 | `DAILY_COLLECT_CRON` |
| 赛果同步 | 23:00 | `RESULT_SYNC_CRON` |

Cron 表达式格式：`分 时 日 月 周`，例如：
- `0 8 * * *` = 每天 08:00
- `0 */6 * * *` = 每 6 小时
- `false` = 关闭该任务

---

## 12. 数据库结构

使用 SQLite，数据文件默认存储在 `./data/app.sqlite`：

| 表名 | 说明 |
|------|------|
| `matches` | 比赛基本信息 |
| `match_odds` | 赔率数据 |
| `match_predictions` | AI 预测结果 |
| `match_results` | 赛果数据 |
| `elo_ratings` | Elo 评分历史 |
| `market_timeline` | 赔率时序数据 |
| `clv_records` | CLV 追踪记录 |
| `backtest_results` | 回测结果 |

数据文件位于 `data/app.sqlite`，可通过 SQLite Browser 等工具直接查看。
