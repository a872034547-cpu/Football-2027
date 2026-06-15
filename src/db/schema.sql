PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL UNIQUE,
    business_date TEXT NOT NULL,
    league TEXT,
    home TEXT NOT NULL,
    away TEXT NOT NULL,
    match_time TEXT,
    status TEXT NOT NULL DEFAULT 'scheduled',
    source_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS match_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL,
    snapshot_type TEXT NOT NULL,
    data_json TEXT NOT NULL,
    completeness_score REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (match_id) REFERENCES matches(match_id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS analysis_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL UNIQUE,
    business_date TEXT NOT NULL,
    rank_score REAL,
    confidence REAL,
    risk_level TEXT,
    probabilities_json TEXT,
    trusted_plans_json TEXT,
    avoid_plans_json TEXT,
    audit_report_md TEXT,
    workflow_report_md TEXT,
    agent_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (match_id) REFERENCES matches(match_id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS daily_portfolios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_date TEXT NOT NULL UNIQUE,
    summary_md TEXT,
    ranked_json TEXT,
    combos_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS push_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    target TEXT,
    business_date TEXT,
    match_id TEXT,
    payload_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (match_id) REFERENCES matches(match_id) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS learning_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_key TEXT NOT NULL UNIQUE,
    profile_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_key TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    message TEXT,
    meta_json TEXT
);

-- P0: 赛果与结算表

CREATE TABLE IF NOT EXISTS match_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL UNIQUE,
    business_date TEXT,
    league TEXT,
    home TEXT,
    away TEXT,
    kickoff_time TEXT,
    home_score INTEGER,
    away_score INTEGER,
    result_1x2 TEXT,
    total_goals INTEGER,
    asian_result_json TEXT,
    overunder_result_json TEXT,
    source TEXT,
    source_json TEXT,
    confirmed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prediction_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    outcome_key TEXT UNIQUE,
    match_id TEXT NOT NULL,
    analysis_report_id INTEGER,
    business_date TEXT,
    predicted_side TEXT,
    predicted_prob REAL,
    candidate_tier TEXT,
    rank_score REAL,
    enhanced_rank_score REAL,
    risk_level TEXT,
    settled_result TEXT,
    is_hit INTEGER,
    brier REAL,
    log_loss REAL,
    rps REAL,
    meta_json TEXT,
    settled_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- P0: 回测与校准表

CREATE TABLE IF NOT EXISTS backtest_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL UNIQUE,
    label TEXT,
    started_at TEXT,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    date_from TEXT,
    date_to TEXT,
    sample_count INTEGER,
    metrics_json TEXT,
    segments_json TEXT,
    timeline_json TEXT,
    config_json TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS calibration_buckets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT,
    segment_key TEXT NOT NULL,
    bucket_min REAL,
    bucket_max REAL,
    bucket_key TEXT,
    predicted_avg REAL,
    actual_rate REAL,
    sample_count INTEGER,
    metrics_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 原始索引

CREATE INDEX IF NOT EXISTS idx_matches_business_date ON matches(business_date);
CREATE INDEX IF NOT EXISTS idx_matches_match_time ON matches(match_time);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
CREATE INDEX IF NOT EXISTS idx_matches_league_business_date ON matches(league, business_date);

CREATE INDEX IF NOT EXISTS idx_match_snapshots_match_id ON match_snapshots(match_id);
CREATE INDEX IF NOT EXISTS idx_match_snapshots_type_created ON match_snapshots(snapshot_type, created_at);
CREATE INDEX IF NOT EXISTS idx_match_snapshots_match_type_created ON match_snapshots(match_id, snapshot_type, created_at);

CREATE INDEX IF NOT EXISTS idx_analysis_reports_business_date ON analysis_reports(business_date);
CREATE INDEX IF NOT EXISTS idx_analysis_reports_rank_score ON analysis_reports(rank_score DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_reports_risk_level ON analysis_reports(risk_level);

CREATE INDEX IF NOT EXISTS idx_daily_portfolios_business_date ON daily_portfolios(business_date);

CREATE INDEX IF NOT EXISTS idx_push_logs_business_date ON push_logs(business_date);
CREATE INDEX IF NOT EXISTS idx_push_logs_match_id ON push_logs(match_id);
CREATE INDEX IF NOT EXISTS idx_push_logs_status_created ON push_logs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_push_logs_channel_target_created ON push_logs(channel, target, created_at);

CREATE INDEX IF NOT EXISTS idx_learning_profiles_profile_key ON learning_profiles(profile_key);

CREATE INDEX IF NOT EXISTS idx_job_runs_job_key_started ON job_runs(job_key, started_at);
CREATE INDEX IF NOT EXISTS idx_job_runs_status ON job_runs(status);
CREATE INDEX IF NOT EXISTS idx_job_runs_finished_at ON job_runs(finished_at);

-- P0 索引

CREATE INDEX IF NOT EXISTS idx_match_results_match_id ON match_results(match_id);
CREATE INDEX IF NOT EXISTS idx_match_results_business_date ON match_results(business_date);
CREATE INDEX IF NOT EXISTS idx_prediction_outcomes_match_id ON prediction_outcomes(match_id);
CREATE INDEX IF NOT EXISTS idx_prediction_outcomes_business_date ON prediction_outcomes(business_date);
CREATE INDEX IF NOT EXISTS idx_prediction_outcomes_candidate_tier ON prediction_outcomes(candidate_tier);
CREATE INDEX IF NOT EXISTS idx_prediction_outcomes_is_hit ON prediction_outcomes(is_hit);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_run_id ON backtest_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_calibration_buckets_run_id ON calibration_buckets(run_id);
CREATE INDEX IF NOT EXISTS idx_calibration_buckets_segment_key ON calibration_buckets(segment_key);
