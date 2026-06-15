/**
 * 端到端 DB 集成测试
 * 验证：schema 初始化、各表 CRUD、服务器启动+健康检查
 * 运行：node server/tests/test-db-e2e.mjs
 */

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { setTimeout as sleep } from 'timers/promises';

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

// ─── 环境：使用临时测试数据库 ────────────────────────────────

const TEST_DB = path.join(__dirname, '../../data/__test_e2e__.sqlite');
process.env.DATABASE_PATH = TEST_DB;
process.env.APP_PORT = '13001';
process.env.DAILY_COLLECT_CRON = ''; // 不启动 cron

// 确保 data 目录存在
const dataDir = path.join(__dirname, '../../data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

// 清理旧测试数据库
if (existsSync(TEST_DB)) rmSync(TEST_DB);

// ─── Test 1: DB 初始化 ────────────────────────────────────────

console.log('\n=== Test 1: DB 初始化 ===');

const dbMod = await import('../src/db/index.js');
const db = dbMod;

db.initDb();
assert(true, 'initDb() 调用成功（无异常）');
assert(existsSync(TEST_DB), `SQLite 文件已创建 (${TEST_DB})`);

// ─── Test 2: matches 表 ───────────────────────────────────────

console.log('\n=== Test 2: upsertMatch / listMatches ===');

const match1 = {
  match_id: 'test-001',
  business_date: '2026-06-15',
  league: '英超',
  home: '曼城',
  away: '阿森纳',
  match_time: '2026-06-15 19:30',
  status: 'pre_match',
};

db.upsertMatch(match1);
assert(true, 'upsertMatch 成功');

const matches = db.listMatches({ date: '2026-06-15', limit: 10 });
assert(Array.isArray(matches), 'listMatches 返回数组');
assert(matches.length >= 1, `listMatches 返回至少 1 条 (${matches.length})`);
const found = matches.find(m => m.match_id === 'test-001');
assert(found !== undefined, 'match_id=test-001 可查询到');
assert(found?.home === '曼城', `home 正确 (${found?.home})`);
assert(found?.league === '英超', `league 正确 (${found?.league})`);

// 重复 upsert（测试 conflict 处理）
db.upsertMatch({ ...match1, status: 'live' });
const matches2 = db.listMatches({ date: '2026-06-15', limit: 10 });
const updated = matches2.find(m => m.match_id === 'test-001');
assert(updated?.status === 'live', `upsert 更新 status 为 live (${updated?.status})`);

// ─── Test 3: match_snapshots 表 ──────────────────────────────

console.log('\n=== Test 3: insertSnapshot ===');

const snapshot = {
  match_id: 'test-001',
  snapshot_type: 'full',
  completeness_score: 0.85,
  snapshot_json: { analysis: { text: '测试快照' }, asian: {}, overunder: {} },
};

db.insertSnapshot(snapshot);
assert(true, 'insertSnapshot 成功');

// ─── Test 4: analysis_reports 表 ────────────────────────────

console.log('\n=== Test 4: upsertAnalysisReport / getAnalysisReport ===');

const report = {
  match_id: 'test-001',
  business_date: '2026-06-15',
  rank_score: 75,
  confidence: 0.85,
  risk_level: 'medium',
  probabilities_json: { home: 0.49, draw: 0.26, away: 0.25 },
  trusted_plans_json: [{ direction: '主胜', reason: '盘口支持' }],
  avoid_plans_json: [],
  audit_report_md: '## 审计报告\n测试内容',
  workflow_report_md: '## 工作流报告\n测试内容',
  agent_json: { riskProfile: { score: 50 } },
};

db.upsertAnalysisReport(report);
assert(true, 'upsertAnalysisReport 成功');

const fetchedReport = db.getAnalysisReport('test-001');
assert(fetchedReport !== null, 'getAnalysisReport 返回非空');
assert(fetchedReport?.match_id === 'test-001', 'match_id 正确');
assert(fetchedReport?.rank_score === 75, `rank_score 正确 (${fetchedReport?.rank_score})`);
assert(fetchedReport?.risk_level === 'medium', `risk_level 正确 (${fetchedReport?.risk_level})`);

// JSON 字段应被正确解析
const probs = fetchedReport?.probabilities_json;
assert(probs !== null, 'probabilities_json 已解析');
const probsObj = typeof probs === 'string' ? JSON.parse(probs) : probs;
assert(probsObj?.home === 0.49, `probabilities.home 正确 (${probsObj?.home})`);

// ─── Test 5: daily_portfolios 表 ─────────────────────────────

console.log('\n=== Test 5: upsertDailyPortfolio / getDailyPortfolio ===');

const portfolio = {
  date: '2026-06-15',
  business_date: '2026-06-15',
  totalMatches: 10,
  rankedMatches: [{ matchId: 'test-001', rankScore: 75 }],
  stable: [],
  balanced: [],
  payload_json: { date: '2026-06-15', analysisNote: '测试' },
};

db.upsertDailyPortfolio(portfolio);
assert(true, 'upsertDailyPortfolio 成功');

const fetchedPortfolio = db.getDailyPortfolio('2026-06-15');
assert(fetchedPortfolio !== null, 'getDailyPortfolio 返回非空');

// ─── Test 6: push_logs 表 ────────────────────────────────────

console.log('\n=== Test 6: insertPushLog ===');

const pushLog = {
  channel: 'feishu',
  status: 'success',
  message: '推送成功',
  match_id: null,
  payload_json: { date: '2026-06-15', type: 'daily' },
};

db.insertPushLog(pushLog);
assert(true, 'insertPushLog 成功');

// ─── Test 7: learning_profiles 表 ───────────────────────────

console.log('\n=== Test 7: upsertLearningProfile / getLearningProfile ===');

db.upsertLearningProfile('test_profile', {
  accuracy: 0.72,
  calibration: 'good',
  updated_at: new Date().toISOString(),
});
assert(true, 'upsertLearningProfile 成功');

const profile = db.getLearningProfile('test_profile');
assert(profile !== null, 'getLearningProfile 返回非空');

// ─── Test 8: job_runs 表 ─────────────────────────────────────

console.log('\n=== Test 8: startJobRun / finishJobRun / getLatestJobRuns ===');

const jobId = db.startJobRun('test_job', { date: '2026-06-15' });
assert(typeof jobId === 'number' && jobId > 0, `startJobRun 返回 ID (${jobId})`);

db.finishJobRun(jobId, 'success', '测试任务完成', { count: 10 });
assert(true, 'finishJobRun 成功');

const runs = db.getLatestJobRuns(5);
assert(Array.isArray(runs), 'getLatestJobRuns 返回数组');
assert(runs.length >= 1, `getLatestJobRuns 至少 1 条 (${runs.length})`);

// ─── Test 9: 服务器启动测试 ──────────────────────────────────

console.log('\n=== Test 9: 服务器启动 + /health 检查 ===');

// 关闭当前测试数据库连接（让服务器重新初始化）
try { db.closeDb(); } catch (_) {}

// 启动服务器子进程
const { spawn } = await import('child_process');
const server = spawn('node', ['server/src/index.js'], {
  cwd: path.join(__dirname, '../..'),
  env: {
    ...process.env,
    DATABASE_PATH: TEST_DB,
    APP_PORT: '13001',
    DAILY_COLLECT_CRON: '',
    TIMEZONE: 'Asia/Shanghai',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverReady = false;
let serverOutput = '';

server.stdout.on('data', d => {
  serverOutput += d.toString();
  if (serverOutput.includes('listening on port')) serverReady = true;
});
server.stderr.on('data', d => { serverOutput += d.toString(); });

// 等待服务器启动（最多 10 秒）
for (let i = 0; i < 20; i++) {
  await sleep(500);
  if (serverReady) break;
}

assert(serverReady, `服务器在 10 秒内启动成功 (output: ${serverOutput.slice(-200)})`);

if (serverReady) {
  // 测试 /health
  try {
    const resp = await fetch('http://localhost:13001/health');
    const json = await resp.json();
    assert(resp.ok, `/health HTTP 200 (status=${resp.status})`);
    assert(json.ok === true, `/health ok=true`);
    assert(json.service === 'football-auto', `service 字段正确 (${json.service})`);
    assert(typeof json.jsModules === 'object', 'jsModules 字段存在');
    console.log(`  ℹ️ jsModules: ${JSON.stringify(json.jsModules)}`);
  } catch (e) {
    assert(false, `/health 请求失败: ${e.message}`);
  }

  // 测试 /api/jobs/status
  try {
    const resp2 = await fetch('http://localhost:13001/api/jobs/status');
    const json2 = await resp2.json();
    assert(resp2.ok, `/api/jobs/status HTTP 200`);
    assert(json2.ok === true, '/api/jobs/status ok=true');
    assert(Array.isArray(json2.job_runs), 'job_runs 是数组');
  } catch (e) {
    assert(false, `/api/jobs/status 请求失败: ${e.message}`);
  }

  // 测试 /api/matches
  try {
    const resp3 = await fetch('http://localhost:13001/api/matches?date=2026-06-15');
    const json3 = await resp3.json();
    assert(resp3.ok, `/api/matches HTTP 200`);
    assert(json3.ok === true, '/api/matches ok=true');
    assert(Array.isArray(json3.matches), 'matches 是数组');
  } catch (e) {
    assert(false, `/api/matches 请求失败: ${e.message}`);
  }

  // 测试 /api/reports/daily
  try {
    const resp4 = await fetch('http://localhost:13001/api/reports/daily?date=2026-06-15');
    const json4 = await resp4.json();
    assert(resp4.ok, `/api/reports/daily HTTP 200`);
    assert(json4.ok === true, '/api/reports/daily ok=true');
  } catch (e) {
    assert(false, `/api/reports/daily 请求失败: ${e.message}`);
  }
}

// 关闭服务器
server.kill('SIGTERM');
await sleep(1000);

// 清理测试数据库
try { if (existsSync(TEST_DB)) rmSync(TEST_DB); } catch (_) {}

// ─── 汇总 ────────────────────────────────────────────────────

console.log(`\n=== 端到端测试完成：✅ ${pass} 通过  ❌ ${fail} 失败 ===`);

if (fail > 0) process.exit(1);
