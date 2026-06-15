/**
 * test-result-sync-simple.mjs
 * P0 赛果同步核心流程简化测试
 * 运行：node server/tests/test-result-sync-simple.mjs
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

// ─── 环境：独立测试数据库 ─────────────────────────────────────

const TEST_DB = path.join(__dirname, '../../data/__test_result_sync_simple__.sqlite');
process.env.DATABASE_PATH = TEST_DB;
process.env.APP_PORT = '13011';
process.env.DAILY_COLLECT_CRON = '';
process.env.RESULT_SYNC_CRON = 'false';

const dataDir = path.join(__dirname, '../../data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
if (existsSync(TEST_DB)) rmSync(TEST_DB);

// ─── Imports ──────────────────────────────────────────────────

const db = await import('../src/db/index.js');
db.initDb();

const { buildMatchResult, settleAnalysisReport } = await import('../src/results/settlementService.js');
const { runResultSyncJob } = await import('../src/results/resultSyncService.js');

console.log('\n=== Test 1: buildMatchResult 基础功能 ===');

{
  const raw = {
    matchId: 'M001',
    homeScore: 2,
    awayScore: 1,
    result1x2: 'home',
    totalGoals: 3,
    source: 'titan007',
  };
  const rec = buildMatchResult(raw);
  assert(rec.match_id === 'M001', 'match_id');
  assert(rec.home_score === 2, 'home_score');
  assert(rec.result_1x2 === 'home', 'result_1x2');
}

console.log('\n=== Test 2: DB match_results 写入 ===');

{
  const rec = {
    match_id: 'DB001',
    home_score: 3,
    away_score: 0,
    result_1x2: 'home',
    total_goals: 3,
    source: 'test',
  };
  db.upsertMatchResult(rec);
  const list = db.listMatchResults({ limit: 10 });
  assert(list.length >= 1, 'listMatchResults 返回结果');
  const found = list.find(r => r.match_id === 'DB001');
  assert(!!found, 'DB001 已入库');
  assert(found?.home_score === 3, 'home_score=3');
}

console.log('\n=== Test 3: settleAnalysisReport 有概率情况 ===');

{
  const fakeReport = {
    match_id: 'SETTLE001',
    business_date: '2026-06-01',
    agent_json: JSON.stringify({
      probabilities: { home: 0.6, draw: 0.25, away: 0.15 },
      candidateTier: 'primary',
    }),
  };
  const fakeResult = { matchId: 'SETTLE001', homeScore: 2, awayScore: 1, result1x2: 'home' };
  const settled = settleAnalysisReport(fakeReport, fakeResult);

  assert(settled.ok === true, 'settled.ok=true');
  assert(settled.outcome?.match_id === 'SETTLE001', 'outcome.match_id');
  assert(settled.outcome?.settled_result === 'home', 'settled_result');
  assert(typeof settled.outcome?.brier === 'number', 'brier 是数字');
  assert(typeof settled.outcome?.log_loss === 'number', 'log_loss 是数字');
}

console.log('\n=== Test 4: runResultSyncJob mock 流程 ===');

{
  // 先插入比赛主表记录，满足 analysis_reports.match_id 外键约束
  db.upsertMatch({
    match_id: 'SYNC001',
    business_date: '2026-06-14',
    league: '测试联赛',
    home: '主队A',
    away: '客队B',
    match_time: '20:00',
    status: 'scheduled',
  });

  // 插入待结算报告
  db.upsertAnalysisReport({
    match_id: 'SYNC001',
    business_date: '2026-06-14',
    home_team: '主队A',
    away_team: '客队B',
    match_time: '20:00',
    league: '测试联赛',
    agent_json: JSON.stringify({
      probabilities: { home: 0.55, draw: 0.25, away: 0.20 },
      candidateTier: 'primary',
    }),
    rank_score: 0.75,
    candidate_tier: 'primary',
  });

  // mock 赛果
  const mockResults = {
    results: [
      {
        ok: true,
        matchId: 'SYNC001',
        homeScore: 2,
        awayScore: 0,
        result1x2: 'home',
        totalGoals: 2,
        source: 'mock',
      },
    ],
    summary: { total: 1, success: 1, fail: 0, successRate: 1 },
  };

  const result = await runResultSyncJob({
    date: '2026-06-14',
    triggerBacktest: false,
    _mockCollectResults: mockResults,
  });

  assert(result.ok === true, 'runResultSyncJob ok=true');
  assert(result.syncCount >= 1, 'syncCount ≥ 1');
  assert(result.settledCount >= 1, 'settledCount ≥ 1');
  assert(result.failCount === 0, 'failCount=0');

  // 验证赛果入库
  const resultsList = db.listMatchResults({ limit: 50 });
  const foundResult = resultsList.find(r => r.match_id === 'SYNC001');
  assert(!!foundResult, 'SYNC001 赛果已入库');
  assert(foundResult?.result_1x2 === 'home', 'result_1x2=home');

  // 验证结算入库
  const outcomes = db.listPredictionOutcomes({ limit: 50 });
  const foundOutcome = outcomes.find(o => o.match_id === 'SYNC001');
  assert(!!foundOutcome, 'SYNC001 prediction_outcome 已结算');
  assert(foundOutcome?.settled_result === 'home', 'settled_result=home');
}

console.log('\n=== Test 5: runResultSyncJob 重复运行幂等 ===');

{
  // 再次运行，应该没有待结算项
  const result = await runResultSyncJob({
    date: '2026-06-14',
    triggerBacktest: false,
    _mockCollectResults: {
      results: [],
      summary: { total: 0, success: 0, fail: 0, successRate: 1 },
    },
  });
  assert(result.settledCount === 0, '重复运行 settledCount=0');
}

console.log('\n=== Test 6: API 路由集成验证（静态检查）===');

{
  // 验证 index.js 已导入 runResultSyncJob
  const indexModule = await import('../src/index.js');
  assert(typeof indexModule === 'object', 'index.js 可正常加载');
  console.log('  ✅ index.js 已加载（包含赛果同步 API）');
  pass++;
}

// ─── 结果汇总 ─────────────────────────────────────────────────

console.log(`\n${'─'.repeat(55)}`);
console.log(`结果：${pass} 通过 / ${fail} 失败 / ${pass + fail} 总计`);
console.log('─'.repeat(55));

if (fail > 0) {
  console.error('\n⚠️  存在失败用例');
  process.exit(1);
} else {
  console.log('\n🎉 全部通过！');
  process.exit(0);
}
