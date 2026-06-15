-- CLV (Closing Line Value) 推荐价与收盘价结算表
-- 用于追踪预测建议时的赔率（推荐价）与临场收盘赔率的对比
-- 核心指标：CLV 是验证预测质量的关键指标，即使短期输赢有波动，长期正 CLV 表示预测有 edge

CREATE TABLE IF NOT EXISTS clv_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL,
  recommendation_id TEXT,
  
  -- 推荐时刻（第一次分析/生成报告时）
  recommend_at TEXT NOT NULL,  -- ISO 8601 timestamp
  recommend_phase TEXT,
  recommend_minutes_to_kickoff INTEGER,
  
  -- 推荐价：推荐时刻的赔率
  recommend_bet_kind TEXT,  -- 'asian', 'ou', 'wdw', 'draw', etc.
  recommend_selection_side TEXT,  -- 'home', 'away', 'over', 'under', 'draw'
  recommend_line TEXT,  -- 盘口值，如 '主队-0.5', '大2.5'
  recommend_line_value REAL,  -- 数值化盘口，如 -0.5, 2.5
  recommend_odds REAL NOT NULL,  -- 推荐时的赔率（欧赔 decimal odds）
  recommend_water REAL,  -- 亚盘水位（如 0.925）
  recommend_implied_prob REAL,  -- 隐含概率
  
  -- 收盘时刻（最后一次快照，临近开球）
  closing_at TEXT,  -- ISO 8601 timestamp
  closing_phase TEXT,
  closing_minutes_to_kickoff INTEGER,
  
  -- 收盘价：收盘时刻的赔率
  closing_line TEXT,
  closing_line_value REAL,
  closing_odds REAL,
  closing_water REAL,
  closing_implied_prob REAL,
  
  -- CLV 计算结果
  clv_price_delta REAL,  -- 赔率差值（decimal）
  clv_prob_delta REAL,  -- 概率差值（百分点）
  clv_percent REAL,  -- CLV 百分比：(closing_prob - recommend_prob) / recommend_prob * 100
  clv_status TEXT,  -- 'positive', 'negative', 'neutral', 'unavailable'
  clv_grade TEXT,  -- 'excellent', 'good', 'fair', 'poor', 'negative'
  
  -- 水位/盘口变化（仅适用于亚盘/大小球）
  line_movement TEXT,  -- 'deeper', 'shallower', 'unchanged'
  water_movement TEXT,  -- 'higher', 'lower', 'unchanged'
  
  -- 实际赛果结算
  match_result_home_score INTEGER,
  match_result_away_score INTEGER,
  match_settled INTEGER DEFAULT 0,  -- 0=未结算, 1=已结算
  bet_outcome TEXT,  -- 'win', 'loss', 'push', 'void', 'pending'
  bet_profit REAL,  -- 假设单位投注的盈亏
  
  -- 元数据
  prediction_prob REAL,  -- 预测概率（来自模型）
  prediction_confidence REAL,  -- 置信度
  risk_level TEXT,  -- 风险等级
  tier TEXT,  -- 候选分层：'core', 'balanced', 'aggressive'
  
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  source_json TEXT,  -- 完整上下文 JSON
  
  UNIQUE(match_id, recommendation_id) ON CONFLICT REPLACE,
  FOREIGN KEY (match_id) REFERENCES matches(match_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_clv_snapshots_match ON clv_snapshots(match_id);
CREATE INDEX IF NOT EXISTS idx_clv_snapshots_recommend_at ON clv_snapshots(recommend_at);
CREATE INDEX IF NOT EXISTS idx_clv_snapshots_status ON clv_snapshots(clv_status);
CREATE INDEX IF NOT EXISTS idx_clv_snapshots_settled ON clv_snapshots(match_settled);
CREATE INDEX IF NOT EXISTS idx_clv_snapshots_tier ON clv_snapshots(tier);

-- CLV 回测结果汇总表（按日期、分层、CLV 等级分组统计）
CREATE TABLE IF NOT EXISTS clv_backtest_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  -- 回测范围
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  total_predictions INTEGER DEFAULT 0,
  total_settled INTEGER DEFAULT 0,
  
  -- 整体 CLV 指标
  clv_positive_count INTEGER DEFAULT 0,
  clv_positive_rate REAL DEFAULT 0,  -- 正 CLV 命中率（%）
  clv_avg_percent REAL DEFAULT 0,  -- 平均 CLV%
  clv_median_percent REAL DEFAULT 0,
  
  -- 分层 CLV 性能（JSON 存储）
  tier_clv_stats TEXT,  -- { "core": {...}, "balanced": {...}, "aggressive": {...} }
  
  -- CLV 等级分布
  clv_grade_distribution TEXT,  -- { "excellent": 10, "good": 20, "fair": 15, ... }
  
  -- 实战结算表现
  total_bets INTEGER DEFAULT 0,
  total_wins INTEGER DEFAULT 0,
  total_losses INTEGER DEFAULT 0,
  total_pushes INTEGER DEFAULT 0,
  win_rate REAL DEFAULT 0,
  roi REAL DEFAULT 0,  -- Return on Investment
  total_profit REAL DEFAULT 0,
  
  -- CLV vs 实际盈利的相关性
  clv_profit_correlation REAL,  -- Pearson 相关系数
  positive_clv_win_rate REAL,  -- 正 CLV 的胜率
  negative_clv_win_rate REAL,  -- 负 CLV 的胜率
  
  -- 元数据
  backtest_version TEXT DEFAULT 'clv-v1',
  created_at TEXT DEFAULT (datetime('now')),
  params_json TEXT,  -- 回测参数
  
  UNIQUE(date_from, date_to, backtest_version)
);

CREATE INDEX IF NOT EXISTS idx_clv_backtest_date ON clv_backtest_summary(date_from, date_to);

-- CLV 分层性能表（细化到每个分层的详细指标）
CREATE TABLE IF NOT EXISTS clv_tier_performance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  backtest_summary_id INTEGER NOT NULL,
  
  tier TEXT NOT NULL,  -- 'core', 'balanced', 'aggressive'
  
  -- 数量统计
  total_count INTEGER DEFAULT 0,
  settled_count INTEGER DEFAULT 0,
  
  -- CLV 指标
  clv_positive_count INTEGER DEFAULT 0,
  clv_positive_rate REAL DEFAULT 0,
  clv_avg_percent REAL DEFAULT 0,
  clv_median_percent REAL DEFAULT 0,
  
  -- 实战表现
  win_count INTEGER DEFAULT 0,
  loss_count INTEGER DEFAULT 0,
  push_count INTEGER DEFAULT 0,
  win_rate REAL DEFAULT 0,
  roi REAL DEFAULT 0,
  total_profit REAL DEFAULT 0,
  
  -- CLV 分段表现（JSON）
  clv_grade_performance TEXT,  -- { "excellent": { "count": 5, "win_rate": 0.80, ... }, ... }
  
  created_at TEXT DEFAULT (datetime('now')),
  
  FOREIGN KEY (backtest_summary_id) REFERENCES clv_backtest_summary(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_clv_tier_perf_backtest ON clv_tier_performance(backtest_summary_id);
CREATE INDEX IF NOT EXISTS idx_clv_tier_perf_tier ON clv_tier_performance(tier);
