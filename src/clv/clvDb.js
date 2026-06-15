/**
 * CLV 数据库操作
 */

import { getDb, executeInsert, executeUpsert, prepareRow, firstAvailableColumns } from '../db/index.js';

/**
 * 插入或更新 CLV 快照
 * @param {object} snapshot - CLV 快照数据
 * @returns {number} - row id
 */
export function upsertClvSnapshot(snapshot) {
  const data = prepareRow('clv_snapshots', {
    match_id: snapshot.matchId,
    recommendation_id: snapshot.recommendationId,
    recommend_at: snapshot.recommendAt,
    recommend_phase: snapshot.recommendPhase,
    recommend_minutes_to_kickoff: snapshot.recommendMinutesToKickoff,
    recommend_bet_kind: snapshot.recommendBetKind,
    recommend_selection_side: snapshot.recommendSelectionSide,
    recommend_line: snapshot.recommendLine,
    recommend_line_value: snapshot.recommendLineValue,
    recommend_odds: snapshot.recommendOdds,
    recommend_water: snapshot.recommendWater,
    recommend_implied_prob: snapshot.recommendImpliedProb,
    closing_at: snapshot.closingAt,
    closing_phase: snapshot.closingPhase,
    closing_minutes_to_kickoff: snapshot.closingMinutesToKickoff,
    closing_line: snapshot.closingLine,
    closing_line_value: snapshot.closingLineValue,
    closing_odds: snapshot.closingOdds,
    closing_water: snapshot.closingWater,
    closing_implied_prob: snapshot.closingImpliedProb,
    clv_price_delta: snapshot.clvPriceDelta,
    clv_prob_delta: snapshot.clvProbDelta,
    clv_percent: snapshot.clvPercent,
    clv_status: snapshot.clvStatus,
    clv_grade: snapshot.clvGrade,
    line_movement: snapshot.lineMovement,
    water_movement: snapshot.waterMovement,
    match_result_home_score: snapshot.matchResultHomeScore,
    match_result_away_score: snapshot.matchResultAwayScore,
    match_settled: snapshot.matchSettled,
    bet_outcome: snapshot.betOutcome,
    bet_profit: snapshot.betProfit,
    prediction_prob: snapshot.predictionProb,
    prediction_confidence: snapshot.predictionConfidence,
    risk_level: snapshot.riskLevel,
    tier: snapshot.tier,
    source_json: snapshot
  }, {
    source_json: {}
  });
  
  const conflictColumns = firstAvailableColumns('clv_snapshots', [
    ['match_id', 'recommendation_id']
  ]);
  
  return executeUpsert(getDb(), 'clv_snapshots', data, conflictColumns);
}

/**
 * 查询单个 CLV 快照
 * @param {string} matchId
 * @param {string} recommendationId
 * @returns {object|null}
 */
export function getClvSnapshot(matchId, recommendationId) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM clv_snapshots
    WHERE match_id = ? AND recommendation_id = ?
  `);
  const row = stmt.get(matchId, recommendationId);
  return row ? parseJsonColumns(row) : null;
}

/**
 * 查询比赛的所有 CLV 快照
 * @param {string} matchId
 * @returns {Array}
 */
export function listClvSnapshotsByMatch(matchId) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM clv_snapshots
    WHERE match_id = ?
    ORDER BY recommend_at DESC
  `);
  return stmt.all(matchId).map(parseJsonColumns);
}

/**
 * 查询日期范围内的 CLV 快照
 * @param {string} dateFrom - YYYY-MM-DD
 * @param {string} dateTo - YYYY-MM-DD
 * @param {object} filters - { tier, clvStatus, matchSettled }
 * @returns {Array}
 */
export function listClvSnapshotsByDateRange(dateFrom, dateTo, filters = {}) {
  const db = getDb();
  const conditions = ['recommend_at >= ? AND recommend_at < ?'];
  const params = [dateFrom, `${dateTo}T23:59:59`];
  
  if (filters.tier) {
    conditions.push('tier = ?');
    params.push(filters.tier);
  }
  if (filters.clvStatus) {
    conditions.push('clv_status = ?');
    params.push(filters.clvStatus);
  }
  if (filters.matchSettled !== undefined) {
    conditions.push('match_settled = ?');
    params.push(filters.matchSettled ? 1 : 0);
  }
  
  const sql = `
    SELECT * FROM clv_snapshots
    WHERE ${conditions.join(' AND ')}
    ORDER BY recommend_at DESC
  `;
  
  const stmt = db.prepare(sql);
  return stmt.all(...params).map(parseJsonColumns);
}

/**
 * 批量更新 CLV 快照的结算结果
 * @param {Array} updates - [{ matchId, recommendationId, matchSettled, betOutcome, betProfit, homeScore, awayScore }]
 * @returns {number} - updated count
 */
export function batchUpdateSettlement(updates = []) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE clv_snapshots
    SET match_settled = ?,
        bet_outcome = ?,
        bet_profit = ?,
        match_result_home_score = ?,
        match_result_away_score = ?,
        updated_at = datetime('now')
    WHERE match_id = ? AND recommendation_id = ?
  `);
  
  let count = 0;
  for (const update of updates) {
    const result = stmt.run(
      update.matchSettled ? 1 : 0,
      update.betOutcome,
      update.betProfit,
      update.homeScore,
      update.awayScore,
      update.matchId,
      update.recommendationId
    );
    count += result.changes;
  }
  
  return count;
}

/**
 * 插入或更新 CLV 回测汇总
 * @param {object} summary - 回测汇总数据
 * @returns {number}
 */
export function upsertClvBacktestSummary(summary) {
  const data = prepareRow('clv_backtest_summary', {
    date_from: summary.dateFrom,
    date_to: summary.dateTo,
    total_predictions: summary.totalPredictions,
    total_settled: summary.totalSettled,
    clv_positive_count: summary.clvPositiveCount,
    clv_positive_rate: summary.clvPositiveRate,
    clv_avg_percent: summary.clvAvgPercent,
    clv_median_percent: summary.clvMedianPercent,
    tier_clv_stats: summary.tierClvStats,
    clv_grade_distribution: summary.clvGradeDistribution,
    total_bets: summary.totalBets,
    total_wins: summary.totalWins,
    total_losses: summary.totalLosses,
    total_pushes: summary.totalPushes,
    win_rate: summary.winRate,
    roi: summary.roi,
    total_profit: summary.totalProfit,
    clv_profit_correlation: summary.clvProfitCorrelation,
    positive_clv_win_rate: summary.positiveClvWinRate,
    negative_clv_win_rate: summary.negativeClvWinRate,
    backtest_version: summary.backtestVersion || 'clv-v1',
    params_json: summary.params
  }, {
    tier_clv_stats: {},
    clv_grade_distribution: {},
    params_json: {}
  });
  
  const conflictColumns = firstAvailableColumns('clv_backtest_summary', [
    ['date_from', 'date_to', 'backtest_version']
  ]);
  
  return executeUpsert(getDb(), 'clv_backtest_summary', data, conflictColumns);
}

/**
 * 查询 CLV 回测汇总
 * @param {string} dateFrom
 * @param {string} dateTo
 * @returns {object|null}
 */
export function getClvBacktestSummary(dateFrom, dateTo) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM clv_backtest_summary
    WHERE date_from = ? AND date_to = ?
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const row = stmt.get(dateFrom, dateTo);
  return row ? parseJsonColumns(row) : null;
}

/**
 * 插入分层性能记录
 * @param {number} backtestSummaryId
 * @param {Array} tierPerformances - [{ tier, totalCount, ... }]
 * @returns {number} - inserted count
 */
export function insertClvTierPerformances(backtestSummaryId, tierPerformances = []) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO clv_tier_performance (
      backtest_summary_id, tier, total_count, settled_count,
      clv_positive_count, clv_positive_rate, clv_avg_percent, clv_median_percent,
      win_count, loss_count, push_count, win_rate, roi, total_profit,
      clv_grade_performance
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  let count = 0;
  for (const perf of tierPerformances) {
    const result = stmt.run(
      backtestSummaryId,
      perf.tier,
      perf.totalCount || 0,
      perf.settledCount || 0,
      perf.clvPositiveCount || 0,
      perf.clvPositiveRate || 0,
      perf.clvAvgPercent || 0,
      perf.clvMedianPercent || 0,
      perf.winCount || 0,
      perf.lossCount || 0,
      perf.pushCount || 0,
      perf.winRate || 0,
      perf.roi || 0,
      perf.totalProfit || 0,
      perf.clvGradePerformance ? JSON.stringify(perf.clvGradePerformance) : null
    );
    count += result.changes;
  }
  
  return count;
}

/**
 * 查询分层性能
 * @param {number} backtestSummaryId
 * @returns {Array}
 */
export function getClvTierPerformances(backtestSummaryId) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM clv_tier_performance
    WHERE backtest_summary_id = ?
    ORDER BY tier
  `);
  return stmt.all(backtestSummaryId).map(parseJsonColumns);
}

function parseJsonColumns(row) {
  if (!row) return row;
  const jsonFields = ['source_json', 'tier_clv_stats', 'clv_grade_distribution', 'params_json', 'clv_grade_performance'];
  for (const field of jsonFields) {
    if (row[field] && typeof row[field] === 'string') {
      try {
        row[field] = JSON.parse(row[field]);
      } catch {
        // keep as string
      }
    }
  }
  return row;
}

export default {
  upsertClvSnapshot,
  getClvSnapshot,
  listClvSnapshotsByMatch,
  listClvSnapshotsByDateRange,
  batchUpdateSettlement,
  upsertClvBacktestSummary,
  getClvBacktestSummary,
  insertClvTierPerformances,
  getClvTierPerformances
};
