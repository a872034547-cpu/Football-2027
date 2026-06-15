-- Elo Rating System Tables
-- 为 P1 实施新增的 Elo 评分系统表

-- 球队评分表：保存当前评分状态
CREATE TABLE IF NOT EXISTS team_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL DEFAULT 'global',
  team_key TEXT NOT NULL,
  team_name TEXT,
  league TEXT,
  rating REAL NOT NULL DEFAULT 1500,
  matches_played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  goals_for INTEGER NOT NULL DEFAULT 0,
  goals_against INTEGER NOT NULL DEFAULT 0,
  aliases_json TEXT,
  last_match_id TEXT,
  last_played_at TEXT,
  config_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(namespace, team_key)
);

CREATE INDEX IF NOT EXISTS idx_team_ratings_namespace_rating ON team_ratings(namespace, rating DESC);
CREATE INDEX IF NOT EXISTS idx_team_ratings_league ON team_ratings(league);
CREATE INDEX IF NOT EXISTS idx_team_ratings_last_played ON team_ratings(last_played_at);

-- Elo 评分变化事件表：保存每场比赛的评分更新，保证可回放、可审计
CREATE TABLE IF NOT EXISTS elo_rating_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  namespace TEXT NOT NULL DEFAULT 'global',
  match_id TEXT NOT NULL,
  business_date TEXT,
  league TEXT,
  home_team_key TEXT NOT NULL,
  away_team_key TEXT NOT NULL,
  home_team_name TEXT,
  away_team_name TEXT,
  home_score INTEGER,
  away_score INTEGER,
  actual_home REAL,
  expected_home REAL,
  home_rating_before REAL,
  away_rating_before REAL,
  home_rating_after REAL,
  away_rating_after REAL,
  delta REAL,
  k_factor REAL,
  competition_weight REAL,
  margin_multiplier REAL,
  home_advantage REAL,
  config_json TEXT,
  source_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_elo_events_match_id ON elo_rating_events(match_id);
CREATE INDEX IF NOT EXISTS idx_elo_events_namespace_date ON elo_rating_events(namespace, business_date DESC);
CREATE INDEX IF NOT EXISTS idx_elo_events_team ON elo_rating_events(home_team_key, away_team_key);
CREATE INDEX IF NOT EXISTS idx_elo_events_created ON elo_rating_events(created_at DESC);
