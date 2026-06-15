-- Market Timeline Schema
-- 盘口时间线快照表，记录比赛盘口随时间的变化

-- 盘口快照表
CREATE TABLE IF NOT EXISTS market_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,  -- ISO 8601 timestamp
  fetch_time INTEGER,          -- Unix timestamp ms
  phase TEXT,                  -- 比赛阶段：early/approaching/live/finished
  phase_label TEXT,            -- 阶段标签
  minutes_to_kickoff INTEGER,  -- 距离开球分钟数
  
  -- 亚盘数据
  asian_line TEXT,             -- 盘口线，如 '主让0.5'
  asian_line_value REAL,       -- 盘口数值
  asian_home_water REAL,       -- 主队水位
  asian_away_water REAL,       -- 客队水位
  
  -- 大小球数据
  ou_line TEXT,                -- 大小球线，如 '2.5'
  ou_line_value REAL,          -- 大小球数值
  ou_over_water REAL,          -- 大球水位
  ou_under_water REAL,         -- 小球水位
  
  -- 欧赔数据
  euro_win REAL,               -- 主胜赔率
  euro_draw REAL,              -- 平局赔率
  euro_loss REAL,              -- 客胜赔率
  euro_favorite_side TEXT,     -- 热门方：home/away/balanced/unknown
  
  -- 数据质量
  completeness_score REAL,     -- 数据完整度评分
  
  -- 元数据
  created_at TEXT DEFAULT (datetime('now')),
  source_json TEXT,            -- 原始快照数据 JSON
  
  -- 索引约束
  UNIQUE(match_id, captured_at) ON CONFLICT REPLACE
);

CREATE INDEX IF NOT EXISTS idx_market_snapshots_match ON market_snapshots(match_id);
CREATE INDEX IF NOT EXISTS idx_market_snapshots_captured ON market_snapshots(captured_at);
CREATE INDEX IF NOT EXISTS idx_market_snapshots_phase ON market_snapshots(phase);

-- 盘口时间线分析结果表
CREATE TABLE IF NOT EXISTS market_timeline_analysis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL UNIQUE,
  
  -- 快照统计
  sample_count INTEGER DEFAULT 0,
  first_captured_at TEXT,
  last_captured_at TEXT,
  
  -- 亚盘变化
  asian_line_delta REAL,        -- 亚盘盘口变化
  asian_water_trend TEXT,        -- 亚盘水位趋势
  asian_home_water_delta REAL,  -- 主队水位变化
  asian_away_water_delta REAL,  -- 客队水位变化
  
  -- 大小球变化
  ou_line_delta REAL,            -- 大小球盘口变化
  ou_water_trend TEXT,           -- 大小球水位趋势
  ou_over_water_delta REAL,      -- 大球水位变化
  ou_under_water_delta REAL,     -- 小球水位变化
  
  -- 欧赔变化
  euro_favorite_trend TEXT,      -- 欧赔趋势
  euro_win_delta REAL,           -- 主胜赔率变化
  euro_loss_delta REAL,          -- 客胜赔率变化
  
  -- 关键信号
  late_reverse INTEGER DEFAULT 0,          -- 临场反向标志
  euro_asian_divergence INTEGER DEFAULT 0, -- 欧亚背离标志
  volatility_score REAL DEFAULT 0,         -- 波动性评分
  
  -- 时间线信号
  signal_code TEXT,              -- 信号代码
  signal_label TEXT,             -- 信号标签
  signal_severity TEXT,          -- 信号严重度：low/medium/high
  signal_plain TEXT,             -- 信号描述
  
  -- 元数据
  version TEXT DEFAULT 'market-timeline-v1',
  updated_at TEXT DEFAULT (datetime('now')),
  analysis_json TEXT,            -- 完整分析结果 JSON
  
  FOREIGN KEY (match_id) REFERENCES matches(match_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_timeline_analysis_signal ON market_timeline_analysis(signal_code);
CREATE INDEX IF NOT EXISTS idx_timeline_analysis_late_reverse ON market_timeline_analysis(late_reverse);
CREATE INDEX IF NOT EXISTS idx_timeline_analysis_divergence ON market_timeline_analysis(euro_asian_divergence);
