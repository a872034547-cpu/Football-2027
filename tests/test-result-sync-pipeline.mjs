/**
 * test-result-sync-pipeline.mjs
 * P0 赛果同步流水线测试
 *   - resultCollector：比分解析逻辑（离线，不启动 Playwright）
 *   - resultSyncService：离线编排（用 mock collector 替代网络采集）
 *   - DB：match_results / prediction_outcomes / backtest_runs CRUD
 *   - runBacktestIfReady：样本不足跳过 + 样本足够触发
 *
 * 运行：node server/tests/test-result-sync-pipeline.mjs
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
    console.error(`  ❌ ${label}${actual !== undefined ? ` (actual: ${JSON.stringify(actual)?.slice(0, 160)})` : ''}`);
    fail++;
  }
}

function assertThrows(fn, label) {
  try { fn(); console.error(`  ❌ ${label} (未抛出异常)`); fail++; }
  catch { console.log(`  ✅ ${label}`); pass++; }
}

// ─── 环境：独立测试数据库 ─────────────────────────────────────

const TEST_DB = path.join(__dirname, '../../data/__test_result_sync__.sqlite');
process.env.DATABASE_PATH = TEST_DB;
process.env.APP_PORT = '13010';
process.env.DAILY_COLLECT_CRON = '';
process.env.RESULT_SYNC_CRON = 'false';

const dataDir = path.join(__dirname, '../../data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
if (existsSync(TEST_DB)) rmSync(TEST_DB);

// ─── Imports ──────────────────────────────────────────────────

const db = await import('../src/db/index.js');
db.initDb();

const { buildMatchResult, settleAnalysisReport } = await import('../src/results/settlementService.js');
const { runWalkForwardBacktest } = await import('../src/backtest/walkForwardBacktest.js');
const { runResultSyncJob, runBacktestIfReady } = await import('../src/results/resultSyncService.js');
const clvDb = await import('../src/clv/clvDb.js');
const marketTimelineDb = await import('../src/db/marketTimelineDb.js');

// ─── Test 1: buildMatchResult ─────────────────────────────────

console.log('\n=== Test 1: buildMatchResult 构建赛果记录 ===');

{
  const raw = {
    matchId: 'M001',
    homeScore: 2,
    awayScore: 1,
    result1x2: 'home',
    totalGoals: 3,
    source: 'titan007',
    fetchedAt: new Date().toISOString(),
  };
  const rec = buildMatchResult(raw);
  assert(rec.match_id === 'M001', 'match_id 正确');
  assert(rec.home_score === 2, 'home_score=2');
  assert(rec.away_score === 1, 'away_score=1');
  assert(rec.result_1x2 === 'home', 'result_1x2=home');
  assert(rec.total_goals === 3, 'total_goals=3');
  assert(rec.source === 'titan007', 'source=titan007');
}

{
  const raw = { matchId: 'M002', homeScore: 0, awayScore: 0, result1x2: 'draw', totalGoals: 0, source: 'titan007' };
  const rec = buildMatchResult(raw);
  assert(rec.result_1x2 === 'draw', '平局 result_1x2=draw');
  assert(rec.total_goals === 0, '0-0 总进球=0');
}

// ─── Test 2: settleAnalysisReport ────────────────────────────

console.log('\n=== Test 2: settleAnalysisReport 预测结算 ===');

{
  // 构造一个模拟 report（带 agent_json.probabilities）
  const fakeReport = {
    match_id: 'M001',
    business_date: '2026-06-01',
    probabilities_json: { home: 0.6, draw: 0.25, away: 0.15 },
    agent_json: JSON.stringify({
      probabilities: { home: 0.6, draw: 0.25, away: 0.15 },
      candidateTier: 'primary',
    }),
  };
  const fakeResult = { matchId: 'M001', homeScore: 2, awayScore: 1, result1x2: 'home' };
  const settled = settleAnalysisReport(fakeReport, fakeResult);

  assert(settled.ok === true, 'settled.ok=true');
  assert(settled.outcome?.match_id === 'M001', 'outcome.match_id');
  assert(settled.outcome?.settled_result === 'home', 'settled_result=home');
  assert(typeof settled.outcome?.brier === 'number', 'brier 是数字', settled.outcome?.brier);
  assert(typeof settled.outcome?.log_loss === 'number', 'log_loss 是数字');
  assert(typeof settled.outcome?.rps === 'number', 'rps 是数字');
}

{
  // 没有概率 → 应返回 ok=false 而不抛
  const fakeReport = {
    match_id: 'M099',
    business_date: '2026-06-01',
    probabilities_json: null,
    agent_json: JSON.stringify({ probabilities: null }),
  };
  const fakeResult = { matchId: 'M099', homeScore: 1, awayScore: 0, result1x2: 'home' };
  const settled = settleAnalysisReport(fakeReport, fakeResult);
  assert(settled.ok === true, '无显式概率时使用均匀概率兜底，不中断结算', settled);
  assert(Math.abs((settled.outcome?.predicted_prob ?? 0) - 1 / 3) < 0.001, '兜底 predicted_prob≈1/3', settled.outcome?.predicted_prob);
}

// ─── Test 3: DB - match_results CRUD ──────────────────────────

console.log('\n=== Test 3: DB match_results CRUD ===');

{
  const rec = {
    match_id: 'CRUD001',
    home_score: 3,
    away_score: 2,
    result_1x2: 'home',
    total_goals: 5,
    source: 'test',
    fetched_at: new Date().toISOString(),
  };
  db.upsertMatchResult(rec);
  const list = db.listMatchResults({ limit: 10 });
  const found = list.find(r => r.match_id === 'CRUD001');
  assert(!!found, 'upsertMatchResult 后可查到');
  assert(found?.home_score === 3, 'home_score=3');

  // 更新（upsert 覆写）
  db.upsertMatchResult({ ...rec, home_score: 4 });
  const list2 = db.listMatchResults({ limit: 10 });
  const found2 = list2.find(r => r.match_id === 'CRUD001');
  assert(found2?.home_score === 4, 'upsert 覆写 home_score=4');
}

// ─── Test 4: DB - prediction_outcomes CRUD ───────────────────

console.log('\n=== Test 4: DB prediction_outcomes CRUD ===');

{
  const outcome = {
    outcome_key: 'O001:latest',
    match_id: 'O001',
    business_date: '2026-06-01',
    predicted_side: 'home',
    predicted_prob: 0.6,
    settled_result: 'home',
    is_hit: 1,
    brier: 0.18,
    log_loss: 0.51,
    rps: 0.12,
    candidate_tier: 'primary',
    meta_json: {
      probabilities: { home: 0.6, draw: 0.25, away: 0.15 },
    },
  };
  db.upsertPredictionOutcome(outcome);
  const list = db.listPredictionOutcomes({ limit: 10 });
  const found = list.find(r => r.match_id === 'O001');
  assert(!!found, 'upsertPredictionOutcome 后可查到');
  assert(Math.abs((found?.predicted_prob ?? 0) - 0.6) < 0.001, 'predicted_prob=0.6');
  assert(Math.abs((found?.brier ?? -1) - 0.18) < 0.001, 'brier=0.18');
}

// ─── Test 5: runBacktestIfReady - 样本不足 ────────────────────

console.log('\n=== Test 5: runBacktestIfReady 样本不足跳过 ===');

{
  // 当前 DB 只有 1 条 outcome，不足 10 条
  const result = await runBacktestIfReady({ label: 'test_insufficient' });
  assert(result === null, '不足 10 条时 runBacktestIfReady 返回 null');
}

// ─── Test 6: runBacktestIfReady - 足够样本触发 ───────────────

console.log('\n=== Test 6: runBacktestIfReady 足够样本触发 ===');

{
  // 插入 12 条已结算 outcome
  const outcomes = Array.from({ length: 12 }, (_, i) => {
    const settledResult = ['home', 'draw', 'away'][i % 3];
    const predictedSide = i % 2 === 0 ? settledResult : ['away', 'home', 'draw'][i % 3];
    return {
      outcome_key: `BT${String(i).padStart(3, '0')}:latest`,
      match_id: `BT${String(i).padStart(3, '0')}`,
      business_date: `2026-06-${String(i + 1).padStart(2, '0')}`,
      predicted_side: predictedSide,
      predicted_prob: 0.5 + (i % 3) * 0.1,
      settled_result: settledResult,
      is_hit: predictedSide === settledResult ? 1 : 0,
      brier: 0.2 + i * 0.01,
      log_loss: 0.5 + i * 0.02,
      rps: 0.15 + i * 0.01,
      candidate_tier: i % 2 === 0 ? 'primary' : 'secondary',
      meta_json: {
        probabilities: { home: 0.5 + (i % 3) * 0.1, draw: 0.25, away: 0.25 - (i % 3) * 0.1 },
      },
    };
  });
  for (const o of outcomes) db.upsertPredictionOutcome(o);

  const result = await runBacktestIfReady({ label: 'test_with_enough_samples' });
  assert(result !== null, '≥10 条时 runBacktestIfReady 不为 null');
  assert(typeof result?.runId === 'string', 'runId 是字符串', result?.runId);

  // 回测运行记录应已写入 DB
  const runs = db.getLatestBacktestRuns(5);
  assert(runs.length >= 1, '回测运行已入库', runs.length);
  const latest = runs[0];
  assert(latest?.run_id === result.runId, '最新 run_id 匹配');
}

// ─── Test 7: runResultSyncJob - mock collector ────────────────

console.log('\n=== Test 7: runResultSyncJob 离线编排（mock collector）===');

{
  // 先插入 2 条 matches + analysis_report，作为"待结算"的候选
  const makeMatch = (id, date) => ({
    match_id: id,
    business_date: date,
    home: '球队A',
    away: '球队B',
    match_time: '20:00',
    league: '测试联赛',
    status: 'scheduled',
  });
  const makeReport = (id, date) => ({
    match_id: id,
    business_date: date,
    probabilities_json: { home: 0.55, draw: 0.25, away: 0.20 },
    agent_json: JSON.stringify({
      probabilities: { home: 0.55, draw: 0.25, away: 0.20 },
      candidateTier: 'primary',
    }),
    rank_score: 0.75,
    candidate_tier: 'primary',
  });
  db.upsertMatch(makeMatch('SYNC001', '2026-06-10'));
  db.upsertMatch(makeMatch('SYNC002', '2026-06-10'));
  db.upsertAnalysisReport(makeReport('SYNC001', '2026-06-10'));
  db.upsertAnalysisReport(makeReport('SYNC002', '2026-06-10'));

  // mock collectMatchResults：直接返回已知比分
  const mockResults = {
    results: [
      { ok: true, matchId: 'SYNC001', homeScore: 2, awayScore: 0, result1x2: 'home', totalGoals: 2, source: 'mock', fetchedAt: new Date().toISOString() },
      { ok: true, matchId: 'SYNC002', homeScore: 1, awayScore: 1, result1x2: 'draw', totalGoals: 2, source: 'mock', fetchedAt: new Date().toISOString() },
    ],
    summary: { total: 2, success: 2, fail: 0, successRate: 1 },
  };

  // 使用 _mockCollectResults 注入点（在 runResultSyncJob 中通过 options 传入）
  const result = await runResultSyncJob({
    date: '2026-06-10',
    triggerBacktest: false, // 测试时跳过回测
    _mockCollectResults: mockResults,
  });

  assert(result.ok === true, 'runResultSyncJob ok=true', result);
  assert(result.syncCount >= 2, `syncCount>=2 (${result.syncCount})`);
  assert(result.settledCount >= 2, `settledCount>=2 (${result.settledCount})`);
  assert(result.failCount === 0, 'failCount=0');

  // 验证 DB 中已有这两条赛果
  const resultsList = db.listMatchResults({ limit: 50 });
  const s1 = resultsList.find(r => r.match_id === 'SYNC001');
  const s2 = resultsList.find(r => r.match_id === 'SYNC002');
  assert(!!s1, 'SYNC001 赛果已入库');
  assert(!!s2, 'SYNC002 赛果已入库');
  assert(s1?.result_1x2 === 'home', 'SYNC001 result_1x2=home');

  // 验证 DB 中已有这两条结算结果
  const outcomes = db.listPredictionOutcomes({ limit: 50 });
  const o1 = outcomes.find(o => o.match_id === 'SYNC001');
  const o2 = outcomes.find(o => o.match_id === 'SYNC002');
  assert(!!o1, 'SYNC001 prediction_outcome 已结算');
  assert(!!o2, 'SYNC002 prediction_outcome 已结算');
  assert(o1?.settled_result === 'home', 'SYNC001 settled_result=home');
  assert(o2?.settled_result === 'draw', 'SYNC002 settled_result=draw');
}

// ─── Test 8: runResultSyncJob - CLV 推荐价/收盘价结算 smoke ───

console.log('\n=== Test 8: runResultSyncJob CLV 收盘价结算 smoke ===');

{
  const matchId = 'CLV001';
  const recommendationId = `${matchId}:wdw:home`;

  db.upsertMatch({
    match_id: matchId,
    business_date: '2026-06-11',
    home: 'CLV主队',
    away: 'CLV客队',
    match_time: '21:00',
    league: 'CLV测试联赛',
    status: 'scheduled',
  });

  db.upsertAnalysisReport({
    match_id: matchId,
    business_date: '2026-06-11',
    probabilities_json: { home: 0.58, draw: 0.24, away: 0.18 },
    agent_json: JSON.stringify({
      probabilities: { home: 0.58, draw: 0.24, away: 0.18 },
      candidateTier: 'primary',
    }),
    rank_score: 0.82,
    candidate_tier: 'primary',
  });

  clvDb.upsertClvSnapshot({
    matchId,
    recommendationId,
    recommendAt: '2026-06-11T10:00:00.000Z',
    recommendPhase: 'approaching',
    recommendMinutesToKickoff: 180,
    recommendBetKind: 'wdw',
    recommendSelectionSide: 'home',
    recommendOdds: 2.05,
    recommendImpliedProb: 48.78,
    predictionProb: 58,
    predictionConfidence: 0.72,
    riskLevel: 'medium',
    tier: 'primary',
  });

  marketTimelineDb.insertMarketSnapshot({
    matchId,
    capturedAt: '2026-06-11T12:00:00.000Z',
    fetchTime: Date.parse('2026-06-11T12:00:00.000Z'),
    phase: 'closing',
    phaseLabel: '临场',
    minutesToKickoff: 15,
    asian: { line: '主让0.5', lineValue: -0.5, homeWater: 0.92, awayWater: 0.98 },
    overunder: { line: '2.5', lineValue: 2.5, overWater: 0.94, underWater: 0.96 },
    euro: { win: 1.92, draw: 3.30, loss: 3.80, favoriteSide: 'home' },
    completenessScore: 0.9,
  });

  const result = await runResultSyncJob({
    date: '2026-06-11',
    triggerBacktest: false,
    _mockCollectResults: {
      results: [
        { ok: true, matchId, homeScore: 2, awayScore: 0, result1x2: 'home', totalGoals: 2, source: 'mock', fetchedAt: new Date().toISOString() },
      ],
      summary: { total: 1, success: 1, fail: 0, successRate: 1 },
    },
  });

  assert(result.ok === true, 'CLV smoke runResultSyncJob ok=true', result);
  assert(result.clvSettledCount >= 1, `CLV smoke clvSettledCount>=1 (${result.clvSettledCount})`);
  assert(result.clvFailCount === 0, 'CLV smoke clvFailCount=0', result.clvFailCount);

  const settledClv = clvDb.getClvSnapshot(matchId, recommendationId);
  assert(settledClv?.closing_at === '2026-06-11T12:00:00.000Z', 'CLV closing_at 已从盘口时间线写回', settledClv?.closing_at);
  assert(['positive', 'neutral', 'negative'].includes(settledClv?.clv_status), 'CLV clv_status 已计算', settledClv?.clv_status);
  assert(settledClv?.match_settled === 1, 'CLV match_settled=1', settledClv?.match_settled);
  assert(settledClv?.bet_outcome === 'win', 'CLV bet_outcome=win', settledClv?.bet_outcome);
  assert(settledClv?.match_result_home_score === 2 && settledClv?.match_result_away_score === 0, 'CLV 比分已写回');
}

// ─── Test 9: runResultSyncJob - 重复运行幂等 ─────────────────

console.log('\n=== Test 9: runResultSyncJob 重复运行幂等 ===');

{
  // SYNC001/SYNC002 已结算，再次运行应该 syncCount=0（没有新的待结算）
  const mockResults = {
    results: [],
    summary: { total: 0, success: 0, fail: 0, successRate: 1 },
  };
  const result = await runResultSyncJob({
    date: '2026-06-10',
    triggerBacktest: false,
    _mockCollectResults: mockResults,
  });
  // ok 可能是 false（无待处理），但不能抛异常
  assert(typeof result.ok === 'boolean', '重复运行不抛异常，返回 ok');
  assert(result.settledCount === 0, '重复运行 settledCount=0', result.settledCount);
}

// ─── 结果汇总 ─────────────────────────────────────────────────

console.log(`\n${'─'.repeat(55)}`);
console.log(`结果：${pass} 通过 / ${fail} 失败 / ${pass + fail} 总计`);
console.log('─'.repeat(55));

if (fail > 0) {
  console.error('\n⚠️  存在失败用例，请检查以上 ❌ 项');
  process.exit(1);
} else {
  console.log('\n🎉 全部通过！');
  process.exit(0);
}
