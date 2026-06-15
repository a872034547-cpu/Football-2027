/**
 * walkForwardBacktest.js
 * 离线 walk-forward 回测：对已保存的 analysis_reports 做按时间排序的预测质量评估。
 *
 * 设计原则：
 * - 只评估"当时 server 实际输出的预测"，不重放历史采集。
 * - 按 business_date 升序（walk-forward），不随机切分。
 * - 对每条记录单独计算 Brier / LogLoss / RPS，汇总 ECE 和 reliability curve。
 * - 分段统计：按候选层级、风险等级、联赛分组。
 * - 不计算虚假 ROI，只统计概率指标和命中率。
 */

import {
  brierScore1x2,
  logLoss1x2,
  normalizeOutcomeSide,
  normalizeProb1x2,
  rps1x2,
  summarizeOutcomeMetrics,
} from '../metrics/probabilityMetrics.js';

const VERSION = 'backtest-v1';

export function runWalkForwardBacktest(predictionOutcomes = [], options = {}) {
  const { label = null, dateFrom = null, dateTo = null } = options;

  const rows = predictionOutcomes
    .filter((row) => row && row.match_id)
    .sort((a, b) => {
      const da = String(a.business_date ?? '');
      const db = String(b.business_date ?? '');
      return da < db ? -1 : da > db ? 1 : 0;
    });

  const filtered = rows.filter((row) => {
    if (dateFrom && String(row.business_date ?? '') < dateFrom) return false;
    if (dateTo && String(row.business_date ?? '') > dateTo) return false;
    return true;
  });

  const settled = filtered.filter((row) => row.settled_result || row.is_hit !== null);

  const global = buildSegmentSummary(settled, 'global');

  const byTier = groupBy(settled, (row) => row.candidate_tier ?? 'unknown');
  const byRisk = groupBy(settled, (row) => row.risk_level ?? 'unknown');
  const byLeague = groupBy(settled, (row) => row.league ?? 'unknown');

  const tierSegments = Object.entries(byTier).map(([key, items]) =>
    buildSegmentSummary(items, `tier:${key}`, { tierKey: key }),
  );

  const riskSegments = Object.entries(byRisk).map(([key, items]) =>
    buildSegmentSummary(items, `risk:${key}`, { riskKey: key }),
  );

  const leagueSegments = Object.entries(byLeague)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 20)
    .map(([key, items]) =>
      buildSegmentSummary(items, `league:${key}`, { leagueKey: key }),
    );

  const timeline = buildTimeline(settled);

  return {
    version: VERSION,
    runAt: new Date().toISOString(),
    label,
    dateFrom: settled.length > 0 ? settled[0].business_date : null,
    dateTo: settled.length > 0 ? settled[settled.length - 1].business_date : null,
    sampleCount: settled.length,
    totalCount: rows.length,
    filterCount: filtered.length,
    global,
    segments: {
      byTier: tierSegments,
      byRisk: riskSegments,
      byLeague: leagueSegments,
    },
    timeline,
  };
}

export function scoreOutcome(outcome = {}) {
  const actualSide = normalizeOutcomeSide(
    outcome.settled_result
      ?? outcome.settledResult
      ?? outcome.result_1x2
      ?? outcome.actual_side,
  );

  if (!actualSide) return { ok: false, reason: 'missing_actual' };

  const probabilities = normalizeProb1x2(
    outcome.probabilities_json
      ?? outcome.probabilities
      ?? {},
  );

  return {
    ok: true,
    brier: brierScore1x2(probabilities, actualSide),
    logLoss: logLoss1x2(probabilities, actualSide),
    rps: rps1x2(probabilities, actualSide),
    actualSide,
    probabilities,
  };
}

function buildSegmentSummary(rows = [], segmentKey = '', extra = {}) {
  const valid = rows.filter((row) => row.is_hit !== null && row.is_hit !== undefined);

  const metricsItems = valid.map((row) => ({
    probability: toNumber(row.predicted_prob),
    hit: Number(row.is_hit) === 1,
    brier: toNumber(row.brier),
    log_loss: toNumber(row.log_loss),
    rps: toNumber(row.rps),
  }));

  const summary = summarizeOutcomeMetrics(metricsItems, { bucketSize: 0.1 });

  return {
    segment: segmentKey,
    ...extra,
    ...summary,
  };
}

function buildTimeline(rows = []) {
  const byDate = new Map();

  for (const row of rows) {
    const date = String(row.business_date ?? '').slice(0, 10);
    if (!date) continue;

    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(row);
  }

  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, items]) => {
      const validItems = items.filter((row) => row.is_hit !== null && row.is_hit !== undefined);
      const hits = validItems.filter((row) => Number(row.is_hit) === 1).length;
      const avgBrier = average(validItems.map((row) => toNumber(row.brier)));
      const avgRps = average(validItems.map((row) => toNumber(row.rps)));

      return {
        date,
        total: items.length,
        settled: validItems.length,
        hits,
        hitRate: validItems.length > 0 ? round(hits / validItems.length, 4) : null,
        avgBrier,
        avgRps,
      };
    });
}

function groupBy(rows, keyFn) {
  const result = {};
  for (const row of rows) {
    const key = keyFn(row) ?? 'unknown';
    if (!result[key]) result[key] = [];
    result[key].push(row);
  }
  return result;
}

function average(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (!nums.length) return null;
  return round(nums.reduce((acc, v) => acc + v, 0) / nums.length, 6);
}

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const base = 10 ** digits;
  return Math.round(n * base) / base;
}

export default { runWalkForwardBacktest, scoreOutcome };
