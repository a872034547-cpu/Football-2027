/**
 * test-p0-closedloop.mjs
 * P0 可信闭环测试：概率指标、赛果结算、离线回测、数据库 P0 表 CRUD
 * 运行：node server/tests/test-p0-closedloop.mjs
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, rmSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let pass = 0, fail = 0;

function assert(condition, label, actual) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.error(`  ❌ ${label}${actual !== undefined ? ` (actual: ${JSON.stringify(actual)?.slice(0, 120)})` : ''}`);
    fail++;
  }
}

// ─── 环境：使用临时测试数据库 ─────────────────────────────────

const TEST_DB = path.join(__dirname, '../../data/__test_p0__.sqlite');
process.env.DATABASE_PATH = TEST_DB;
process.env.APP_PORT = '13009';
process.env.DAILY_COLLECT_CRON = '';

const dataDir = path.join(__dirname, '../../data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
if (existsSync(TEST_DB)) rmSync(TEST_DB);

// ─── Import modules ──────────────────────────────────────────

const {
  normalizeOutcomeSide,
  actualOutcomeFromScore,
  normalizeProb1x2,
  brierScore1x2,
  logLoss1x2,
  rps1x2,
  metricsFor1x2,
  reliabilityCurve,
  expectedCalibrationError,
  summarizeOutcomeMetrics,
} = await import('../src/metrics/probabilityMetrics.js');

const { buildMatchResult, settleAnalysisReport } = await import('../src/results/settlementService.js');
const { runWalkForwardBacktest, scoreOutcome } = await import('../src/backtest/walkForwardBacktest.js');
const db = await import('../src/db/index.js');

// ─── Test 1: probabilityMetrics ──────────────────────────────

console.log('\n=== Test 1: probabilityMetrics - normalizeOutcomeSide ===');

assert(normalizeOutcomeSide('home') === 'home', 'home');
assert(normalizeOutcomeSide('主胜') === 'home', '主胜');
assert(normalizeOutcomeSide('1') === 'home', '1');
assert(normalizeOutcomeSide('draw') === 'draw', 'draw');
assert(normalizeOutcomeSide('平局') === 'draw', '平局');
assert(normalizeOutcomeSide('away') === 'away', 'away');
assert(normalizeOutcomeSide('客胜') === 'away', '客胜');
assert(normalizeOutcomeSide('invalid') === null, 'invalid → null');

console.log('\n=== Test 2: probabilityMetrics - actualOutcomeFromScore ===');

assert(actualOutcomeFromScore(2, 1) === 'home', '2-1 → home');
assert(actualOutcomeFromScore(0, 0) === 'draw', '0-0 → draw');
assert(actualOutcomeFromScore(1, 3) === 'away', '1-3 → away');
assert(actualOutcomeFromScore(null, 1) === null, 'null,1 → null');

console.log('\n=== Test 3: probabilityMetrics - normalizeProb1x2 ===');

const probs1 = normalizeProb1x2({ home: 0.5, draw: 0.25, away: 0.25 });
assert(Math.abs(probs1.home + probs1.draw + probs1.away - 1) < 0.001, '概率之和=1', probs1);

const probs2 = normalizeProb1x2({ win: 60, tie: 20, loss: 20 });
assert(Math.abs(probs2.home - 0.6) < 0.01, '百分比转换 home=0.6', probs2.home);

const probs3 = normalizeProb1x2({});
assert(probs3.source === 'fallback_equal', '空概率 → fallback_equal', probs3.source);

console.log('\n=== Test 4: probabilityMetrics - 指标计算 ===');

const probsA = { home: 0.6, draw: 0.25, away: 0.15 };
const brier = brierScore1x2(probsA, 'home');
assert(typeof brier === 'number' && brier >= 0 && brier <= 2, `Brier 在合法范围 (${brier})`);

const logLossVal = logLoss1x2(probsA, 'home');
assert(typeof logLossVal === 'number' && logLossVal > 0, `LogLoss > 0 (${logLossVal})`);

const rpsVal = rps1x2(probsA, 'home');
assert(typeof rpsVal === 'number' && rpsVal >= 0, `RPS >= 0 (${rpsVal})`);

const rpsWrong = rps1x2(probsA, 'away');
assert(rpsVal < rpsWrong, 'RPS 正确预测 < 错误预测', { rpsVal, rpsWrong });

const metrics = metricsFor1x2(probsA, 'home');
assert(metrics.ok === true, 'metricsFor1x2 ok=true');
assert(metrics.isHit === true, 'isHit=true (主胜)');
assert(metrics.predictedSide === 'home', '预测侧=home');

const metricsWrong = metricsFor1x2(probsA, 'away');
assert(metricsWrong.isHit === false, 'isHit=false (客胜实际但预测主)');

const metricsMissing = metricsFor1x2(probsA, null);
assert(metricsMissing.ok === false, 'missing actual → ok=false');

console.log('\n=== Test 5: probabilityMetrics - reliability curve & ECE ===');

const items = [
  { probability: 0.7, hit: true },
  { probability: 0.7, hit: false },
  { probability: 0.5, hit: true },
  { probability: 0.3, hit: false },
  { probability: 0.8, hit: true },
  { probability: 0.6, hit: true },
];

const curve = reliabilityCurve(items, { bucketSize: 0.2 });
assert(Array.isArray(curve) && curve.length > 0, `reliability curve 有桶 (${curve.length})`);
curve.forEach((row) => {
  assert(typeof row.sampleCount === 'number', `桶 ${row.bucket} sampleCount 存在`);
  assert(typeof row.actualRate === 'number', `桶 ${row.bucket} actualRate 存在`);
});

const ece = expectedCalibrationError(items, { bucketSize: 0.2 });
assert(typeof ece === 'number' && ece >= 0 && ece <= 1, `ECE 合法 (${ece})`);

const outcomes = [
  { predicted_prob: 0.6, is_hit: 1, brier: 0.32, log_loss: 0.51, rps: 0.18 },
  { predicted_prob: 0.7, is_hit: 1, brier: 0.18, log_loss: 0.36, rps: 0.10 },
  { predicted_prob: 0.6, is_hit: 0, brier: 1.16, log_loss: 0.92, rps: 0.50 },
];
const summary = summarizeOutcomeMetrics(outcomes);
assert(summary.sampleCount === 3, `summarize sampleCount=3`);
assert(typeof summary.hitRate === 'number', `hitRate 存在 (${summary.hitRate})`);
assert(typeof summary.avgBrier === 'number', `avgBrier 存在 (${summary.avgBrier})`);
assert(typeof summary.avgRps === 'number', `avgRps 存在 (${summary.avgRps})`);

// ─── Test 6: settlementService ────────────────────────────────

console.log('\n=== Test 6: settlementService - buildMatchResult ===');

const result1 = buildMatchResult({
  match_id: 'test-r1',
  business_date: '2026-06-15',
  home: '曼城',
  away: '阿森纳',
  home_score: 2,
  away_score: 1,
});
assert(result1.match_id === 'test-r1', 'match_id');
assert(result1.home_score === 2, 'home_score=2');
assert(result1.away_score === 1, 'away_score=1');
assert(result1.result_1x2 === 'home', 'result_1x2=home (2-1)');
assert(result1.total_goals === 3, 'total_goals=3');

const result2 = buildMatchResult({ home_score: 1, away_score: 1 });
assert(result2.result_1x2 === 'draw', 'draw (1-1)');

const result3 = buildMatchResult({ result_1x2: '客胜' });
assert(result3.result_1x2 === 'away', 'explicit 客胜 → away');

console.log('\n=== Test 7: settlementService - settleAnalysisReport ===');

const mockReport = {
  match_id: 'test-r1',
  business_date: '2026-06-15',
  probabilities_json: { home: 0.55, draw: 0.25, away: 0.20 },
  rank_score: 72,
  risk_level: 'medium',
  agent_json: {
    enhancedCandidateTier: 'balanced_candidate',
    serverEnhancement: { decision: { enhancedScore: 68 } },
  },
};

const settled = settleAnalysisReport(mockReport, {
  home_score: 2,
  away_score: 1,
});
assert(settled.ok === true, 'settleAnalysisReport ok=true');
assert(settled.outcome.settled_result === 'home', 'settled_result=home');
assert(settled.outcome.is_hit === 1, 'is_hit=1 (主胜)');
assert(typeof settled.outcome.brier === 'number', 'brier 存在');
assert(typeof settled.outcome.rps === 'number', 'rps 存在');
assert(settled.outcome.candidate_tier === 'balanced_candidate', 'candidate_tier 正确');

const settledMiss = settleAnalysisReport(mockReport, { home_score: 0, away_score: 1 });
assert(settledMiss.ok === true, 'miss settle ok=true');
assert(settledMiss.outcome.is_hit === 0, 'is_hit=0 (客胜，但预测主胜)');

const settledNoResult = settleAnalysisReport(mockReport, {});
assert(settledNoResult.ok === false, 'missing result → ok=false');

// ─── Test 8: walkForwardBacktest ──────────────────────────────

console.log('\n=== Test 8: walkForwardBacktest ===');

const mockOutcomes = [
  {
    match_id: 'a1', business_date: '2026-06-01', candidate_tier: 'stable', risk_level: 'low',
    predicted_side: 'home', predicted_prob: 0.65, settled_result: 'home', is_hit: 1,
    brier: 0.2, log_loss: 0.43, rps: 0.12, probabilities_json: { home: 0.65, draw: 0.20, away: 0.15 },
  },
  {
    match_id: 'a2', business_date: '2026-06-01', candidate_tier: 'balanced', risk_level: 'medium',
    predicted_side: 'home', predicted_prob: 0.55, settled_result: 'away', is_hit: 0,
    brier: 1.2, log_loss: 0.80, rps: 0.48, probabilities_json: { home: 0.55, draw: 0.25, away: 0.20 },
  },
  {
    match_id: 'a3', business_date: '2026-06-02', candidate_tier: 'stable', risk_level: 'low',
    predicted_side: 'draw', predicted_prob: 0.40, settled_result: 'draw', is_hit: 1,
    brier: 0.52, log_loss: 0.92, rps: 0.20, probabilities_json: { home: 0.30, draw: 0.40, away: 0.30 },
  },
];

const backtestResult = runWalkForwardBacktest(mockOutcomes);
assert(backtestResult.sampleCount === 3, `sampleCount=3`);
assert(typeof backtestResult.global === 'object', 'global 结果存在');
assert(typeof backtestResult.global.hitRate === 'number', `global hitRate 存在 (${backtestResult.global.hitRate})`);
assert(Math.abs(backtestResult.global.hitRate - 2 / 3) < 0.01, `global hitRate=2/3 (${backtestResult.global.hitRate})`);
assert(Array.isArray(backtestResult.segments.byTier), 'byTier 分段存在');
assert(Array.isArray(backtestResult.segments.byRisk), 'byRisk 分段存在');
assert(Array.isArray(backtestResult.timeline), 'timeline 存在');
assert(backtestResult.timeline.length === 2, `timeline 2 天 (${backtestResult.timeline.length})`);

const scored = scoreOutcome({
  settled_result: 'home',
  probabilities_json: { home: 0.6, draw: 0.25, away: 0.15 },
});
assert(scored.ok === true, 'scoreOutcome ok=true');
assert(typeof scored.brier === 'number', 'brier 存在');

// ─── Test 9: DB P0 表 CRUD ───────────────────────────────────

console.log('\n=== Test 9: DB P0 表 CRUD ===');

db.initDb();
assert(true, 'initDb() 含 P0 表成功');

// match_results
db.upsertMatchResult({
  match_id: 'test-r1',
  business_date: '2026-06-15',
  home: '曼城',
  away: '阿森纳',
  home_score: 2,
  away_score: 1,
  result_1x2: 'home',
  total_goals: 3,
  source: 'manual',
});
assert(true, 'upsertMatchResult 成功');

const fetchedResult = db.getMatchResult('test-r1');
assert(fetchedResult !== null, 'getMatchResult 返回非空');
assert(fetchedResult.match_id === 'test-r1', 'match_id 正确');
assert(fetchedResult.result_1x2 === 'home', 'result_1x2=home');
assert(fetchedResult.home_score === 2, 'home_score=2');

const results = db.listMatchResults({ date: '2026-06-15' });
assert(Array.isArray(results) && results.length >= 1, `listMatchResults >= 1 条 (${results.length})`);

// prediction_outcomes
db.upsertPredictionOutcome({
  outcome_key: 'test-r1:1',
  match_id: 'test-r1',
  business_date: '2026-06-15',
  predicted_side: 'home',
  predicted_prob: 0.55,
  candidate_tier: 'balanced_candidate',
  rank_score: 72,
  enhanced_rank_score: 68,
  risk_level: 'medium',
  settled_result: 'home',
  is_hit: 1,
  brier: 0.2,
  log_loss: 0.6,
  rps: 0.12,
  settled_at: new Date().toISOString(),
});
assert(true, 'upsertPredictionOutcome 成功');

const fetchedOutcome = db.getPredictionOutcome('test-r1');
assert(fetchedOutcome !== null, 'getPredictionOutcome 返回非空');
assert(fetchedOutcome.is_hit === 1, 'is_hit=1');
assert(fetchedOutcome.candidate_tier === 'balanced_candidate', 'candidate_tier 正确');

const outcomes2 = db.listPredictionOutcomes({ date: '2026-06-15' });
assert(Array.isArray(outcomes2) && outcomes2.length >= 1, `listPredictionOutcomes >= 1 条`);

// backtest_runs
const runId = `test-run-${Date.now()}`;
db.upsertBacktestRun({
  run_id: runId,
  label: 'test',
  started_at: new Date().toISOString(),
  finished_at: new Date().toISOString(),
  status: 'done',
  sample_count: 3,
  metrics_json: { hitRate: 0.66, avgBrier: 0.5 },
  segments_json: [],
  timeline_json: [],
  config_json: { bucketSize: 0.1 },
});
assert(true, 'upsertBacktestRun 成功');

const fetchedRun = db.getBacktestRun(runId);
assert(fetchedRun !== null, 'getBacktestRun 返回非空');
assert(fetchedRun.run_id === runId, 'run_id 正确');
assert(fetchedRun.status === 'done', 'status=done');

const latestRuns = db.getLatestBacktestRuns(5);
assert(Array.isArray(latestRuns) && latestRuns.length >= 1, `getLatestBacktestRuns >= 1 条`);

// calibration_buckets
db.insertCalibrationBuckets(runId, [
  { segment: 'global', bucket: '0.50-0.60', bucketMin: 0.5, bucketMax: 0.6, predictedAvg: 0.55, actualRate: 0.60, sampleCount: 10 },
  { segment: 'global', bucket: '0.60-0.70', bucketMin: 0.6, bucketMax: 0.7, predictedAvg: 0.65, actualRate: 0.62, sampleCount: 8 },
]);
assert(true, 'insertCalibrationBuckets 成功');

const buckets = db.getCalibrationBuckets(runId);
assert(Array.isArray(buckets) && buckets.length === 2, `getCalibrationBuckets 2 桶 (${buckets.length})`);
assert(buckets[0].sample_count === 10, `bucket sampleCount=10 (${buckets[0].sample_count})`);

// ─── 清理 ────────────────────────────────────────────────────

try { db.closeDb(); } catch (_) {}
try { if (existsSync(TEST_DB)) rmSync(TEST_DB); } catch (_) {}

// ─── 汇总 ────────────────────────────────────────────────────

console.log(`\n=== P0 可信闭环测试完成：✅ ${pass} 通过  ❌ ${fail} 失败 ===`);
if (fail > 0) process.exit(1);
