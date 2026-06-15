/**
 * Market Timeline Database Functions
 * 盘口时间线数据库操作
 */

import { getDb, prepareRow, executeUpsert, firstAvailableColumns, getOneByColumns, buildOrderBy, normalizeLimit, parseJsonColumns } from './index.js';

export function insertMarketSnapshot(snapshot) {
  const data = prepareRow('market_snapshots', {
    match_id: snapshot.matchId,
    captured_at: snapshot.capturedAt,
    fetch_time: snapshot.fetchTime,
    phase: snapshot.phase,
    phase_label: snapshot.phaseLabel,
    minutes_to_kickoff: snapshot.minutesToKickoff,
    asian_line: snapshot.asian?.line,
    asian_line_value: snapshot.asian?.lineValue,
    asian_home_water: snapshot.asian?.homeWater,
    asian_away_water: snapshot.asian?.awayWater,
    ou_line: snapshot.overunder?.line,
    ou_line_value: snapshot.overunder?.lineValue,
    ou_over_water: snapshot.overunder?.overWater,
    ou_under_water: snapshot.overunder?.underWater,
    euro_win: snapshot.euro?.win,
    euro_draw: snapshot.euro?.draw,
    euro_loss: snapshot.euro?.loss,
    euro_favorite_side: snapshot.euro?.favoriteSide,
    completeness_score: snapshot.completenessScore,
    source_json: snapshot
  }, {
    source_json: {}
  });
  
  const conflictColumns = firstAvailableColumns('market_snapshots', [
    ['match_id', 'captured_at']
  ]);
  
  return executeUpsert(getDb(), 'market_snapshots', data, conflictColumns);
}

export function listMarketSnapshots(matchId, limit = 100) {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT * FROM market_snapshots
    WHERE match_id = ?
    ORDER BY captured_at DESC
    LIMIT ?
  `);
  return stmt.all(matchId, limit).map(parseJsonColumns);
}

export function upsertMarketTimelineAnalysis(matchId, analysis) {
  const data = prepareRow('market_timeline_analysis', {
    match_id: matchId,
    sample_count: analysis.sampleCount,
    first_captured_at: analysis.firstCapturedAt,
    last_captured_at: analysis.lastCapturedAt,
    asian_line_delta: analysis.asianLineDelta,
    asian_water_trend: analysis.asianWaterTrend,
    asian_home_water_delta: analysis.asianHomeWaterDelta,
    asian_away_water_delta: analysis.asianAwayWaterDelta,
    ou_line_delta: analysis.ouLineDelta,
    ou_water_trend: analysis.ouWaterTrend,
    ou_over_water_delta: analysis.ouOverWaterDelta,
    ou_under_water_delta: analysis.ouUnderWaterDelta,
    euro_favorite_trend: analysis.euroFavoriteTrend,
    euro_win_delta: analysis.euroWinDelta,
    euro_loss_delta: analysis.euroLossDelta,
    late_reverse: analysis.lateReverse ? 1 : 0,
    euro_asian_divergence: analysis.euroAsianDivergence ? 1 : 0,
    volatility_score: analysis.volatilityScore,
    signal_code: analysis.timelineSignal?.code,
    signal_label: analysis.timelineSignal?.label,
    signal_severity: analysis.timelineSignal?.severity,
    signal_plain: analysis.timelineSignal?.plain,
    analysis_json: analysis
  }, {
    analysis_json: {}
  });
  
  const conflictColumns = firstAvailableColumns('market_timeline_analysis', [
    ['match_id']
  ]);
  
  return executeUpsert(getDb(), 'market_timeline_analysis', data, conflictColumns);
}

export function getMarketTimelineAnalysis(matchId) {
  return getOneByColumns('market_timeline_analysis', [
    ['match_id', matchId]
  ]);
}

export default {
  insertMarketSnapshot,
  listMarketSnapshots,
  upsertMarketTimelineAnalysis,
  getMarketTimelineAnalysis
};
