/**
 * acceptance-full.mjs
 * 全功能运营验收脚本（离线 + 在线可选）
 *
 * 验收口径：
 *  A. 离线链路（默认）：用 sampleData 驱动全分析链，验证 API 结构、betAdvice、beginnerSummary、portfolio
 *  B. 在线链路（--live）：真实采集今日赛事 + 单场详情 + 日报流水线
 *
 * 用法：
 *   node scripts/acceptance-full.mjs          # 离线，快速
 *   node scripts/acceptance-full.mjs --live   # 在线，需要网络和 Playwright
 *   node scripts/acceptance-full.mjs --port=3100   # 指定已启动服务端口
 */

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const portArg = args.find(a => a.startsWith('--port='));
const SERVER_PORT = portArg ? parseInt(portArg.split('=')[1]) : 3000;
const BASE_URL = `http://localhost:${SERVER_PORT}`;

// ────────────────────────────────────────────────────────────────────────────
// 工具
// ────────────────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function ok(label, value, message) {
  if (value) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}${message ? ` — ${message}` : ''}`);
    failed++;
    failures.push(`${label}${message ? ': ' + message : ''}`);
  }
}

function section(title) {
  console.log(`\n┌─ ${title}`);
}

function printSummary() {
  console.log('\n' + '═'.repeat(60));
  console.log(`验收结果：通过 ${passed}，失败 ${failed}`);
  if (failures.length) {
    console.log('\n失败项：');
    failures.forEach(f => console.log(`  ❌ ${f}`));
  }
  console.log('═'.repeat(60));
  process.exit(failed > 0 ? 1 : 0);
}

async function httpGet(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} GET ${path}`);
  return res.json();
}

async function httpPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} POST ${path}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

// ────────────────────────────────────────────────────────────────────────────
// A. 离线分析链验收
// ────────────────────────────────────────────────────────────────────────────
async function runOfflineAnalysis() {
  section('A. 离线分析链验收（不访问外网）');

  // 动态加载分析模块
  const { getSampleMatchSnapshot } = await import('../src/collectors/sampleData.js');
  const { analyzeMatch, buildDailyPortfolio } = await import('../src/analysis/matchAnalyzer.js');

  const today = new Date().toISOString().slice(0, 10);
  const sampleSnapshot = getSampleMatchSnapshot('SAMPLE001', today);
  const sampleTodayMatch = {
    matchId: 'SAMPLE001',
    businessDate: today,
    home: '曼城',
    away: '阿森纳',
    league: '英超',
    matchTime: `${today}T20:00:00+08:00`,
    source: 'sample',
    lotteryNo: '001',
  };

  let result;
  try {
    result = await analyzeMatch(sampleSnapshot, sampleTodayMatch, {});
  } catch (err) {
    ok('analyzeMatch 执行成功', false, err.message);
    return;
  }

  ok('analyzeMatch 执行成功', !!result);
  ok('result.matchId 存在', !!result.matchId);
  ok('result.home / away 存在', !!result.home && !!result.away);
  ok('result.probabilities 存在', result.probabilities?.source !== undefined);
  ok('result.rankScore 是数字', typeof result.rankScore === 'number');
  ok('result.riskLevel 存在', !!result.riskLevel);
  ok('result.completenessScore 是数字', typeof result.completenessScore === 'number');
  ok('result.reportMarkdown 有内容', result.reportMarkdown?.length > 50);

  // betAdvice 验收
  const betAdvice = result.reportStructured?.betAdvice;
  ok('reportStructured.betAdvice 存在', !!betAdvice, 'betAdvice 为空表示 report.js 未生成');
  ok('betAdvice.recommendation 存在', !!betAdvice?.recommendation);
  ok('betAdvice.trustedPlans 是数组', Array.isArray(betAdvice?.trustedPlans));
  ok('betAdvice.avoidPlans 是数组', Array.isArray(betAdvice?.avoidPlans));
  ok('betAdvice.invalidIf 是数组', Array.isArray(betAdvice?.invalidIf));
  ok('betAdvice.liveChecklist 是数组', Array.isArray(betAdvice?.liveChecklist));
  ok('result.trustedPlans 由 betAdvice 正确传入', Array.isArray(result.trustedPlans));
  ok('result.avoidPlans 由 betAdvice 正确传入', Array.isArray(result.avoidPlans));

  // beginnerSummary 验收
  const bs = result.reportStructured?.beginnerSummary;
  ok('reportStructured.beginnerSummary 存在', !!bs, 'beginnerSummary 为空，报告不满足小白可读要求');
  ok('beginnerSummary.conclusion 有内容', !!bs?.conclusion);
  ok('beginnerSummary.reasons 是数组(≥1)', Array.isArray(bs?.reasons) && bs?.reasons.length >= 1);
  ok('beginnerSummary.riskLabel 存在', !!bs?.riskLabel);
  ok('beginnerSummary.actionText 有内容', !!bs?.actionText);
  ok('beginnerSummary.trustLabel 存在', !!bs?.trustLabel);

  // portfolio 验收
  let portfolio;
  try {
    portfolio = buildDailyPortfolio([result]);
  } catch (err) {
    ok('buildDailyPortfolio 执行成功', false, err.message);
    return;
  }
  ok('buildDailyPortfolio 执行成功', !!portfolio);
  ok('portfolio.stable 是数组', Array.isArray(portfolio?.stable));
  ok('portfolio.balanced 是数组', Array.isArray(portfolio?.balanced));
  ok('portfolio.explore 是数组', Array.isArray(portfolio?.explore));
  ok('portfolio.stats.total 是数字', typeof portfolio?.stats?.total === 'number');

  console.log(`\n  📊 Portfolio stats: total=${portfolio.stats.total}, stable=${portfolio.stable.length}, balanced=${portfolio.balanced.length}, explore=${portfolio.explore.length}`);
  if (betAdvice?.recommendation) {
    console.log(`  🎯 betAdvice.recommendation=${betAdvice.recommendation}, trustedPlans=${betAdvice.trustedPlans.length}, avoidPlans=${betAdvice.avoidPlans.length}`);
  }
  if (bs?.conclusion) {
    console.log(`  📝 beginnerSummary: ${bs.conclusion}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// B. 在线 API 验收（--live 或 --port 时）
// ────────────────────────────────────────────────────────────────────────────
async function runLiveApiAcceptance() {
  section('B. 在线 API 验收（连接服务）');

  // 1. health
  let health;
  try {
    health = await httpGet('/health');
  } catch (err) {
    ok('GET /health 可访问', false, err.message);
    console.log('  ⚠️ 服务未启动，跳过在线API验收');
    return;
  }
  ok('GET /health ok=true', health.ok === true);
  ok('GET /health db=ok', health.db === 'ok');

  // 2. /api/jobs/status
  let jobsStatus;
  try {
    jobsStatus = await httpGet('/api/jobs/status');
    ok('GET /api/jobs/status 可访问', Array.isArray(jobsStatus?.recentRuns));
  } catch (err) {
    ok('GET /api/jobs/status 可访问', false, err.message);
  }

  // 3. /api/matches
  let matchesList;
  try {
    matchesList = await httpGet('/api/matches');
    ok('GET /api/matches 可访问', Array.isArray(matchesList?.matches));
    console.log(`  📋 当前DB比赛数：${matchesList?.matches?.length ?? 0}`);
  } catch (err) {
    ok('GET /api/matches 可访问', false, err.message);
  }

  // 4. /api/reports/daily
  let dailyReport;
  try {
    dailyReport = await httpGet('/api/reports/daily');
    ok('GET /api/reports/daily 可访问', true);
    ok('daily report date 存在', !!dailyReport?.date);
    ok('daily report analyses 是数组', Array.isArray(dailyReport?.analyses));
    console.log(`  📅 日报日期：${dailyReport?.date}，分析条数：${dailyReport?.analyses?.length ?? 0}`);

    // 检查第一条报告是否有 beginnerSummary
    const first = dailyReport?.analyses?.[0];
    if (first) {
      const bs = first.reportStructured?.beginnerSummary || first.beginnerSummary;
      ok('第一条报告有 beginnerSummary', !!bs, '报告小白化字段缺失');
      const ba = first.reportStructured?.betAdvice || first.betAdvice;
      ok('第一条报告有 betAdvice', !!ba, 'betAdvice 字段缺失');
    }
  } catch (err) {
    ok('GET /api/reports/daily 可访问', false, err.message);
  }

  // 5. /api/push/logs
  try {
    const pushLogs = await httpGet('/api/push/logs');
    ok('GET /api/push/logs 可访问', Array.isArray(pushLogs?.logs));
  } catch (err) {
    ok('GET /api/push/logs 可访问', false, err.message);
  }

  // 6. /api/results
  try {
    const results = await httpGet('/api/results');
    ok('GET /api/results 可访问', Array.isArray(results?.results));
    console.log(`  📊 赛果记录数：${results?.results?.length ?? 0}`);
  } catch (err) {
    ok('GET /api/results 可访问', false, err.message);
  }

  // 7. /api/backtest/runs
  try {
    const btruns = await httpGet('/api/backtest/runs');
    ok('GET /api/backtest/runs 可访问', Array.isArray(btruns?.runs));
    console.log(`  🔬 回测记录数：${btruns?.runs?.length ?? 0}`);
  } catch (err) {
    ok('GET /api/backtest/runs 可访问', false, err.message);
  }

  // 8. Elo API
  try {
    const eloTeams = await httpGet('/api/elo/teams?limit=5');
    ok('GET /api/elo/teams 可访问', Array.isArray(eloTeams?.teams));
    console.log(`  ⚽ Elo球队记录数：${eloTeams?.teams?.length ?? 0}`);
  } catch (err) {
    ok('GET /api/elo/teams 可访问', false, err.message);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// C. 在线采集验收（--live 时）
// ────────────────────────────────────────────────────────────────────────────
async function runLiveCollectAcceptance() {
  section('C. 真实采集验收（--live，需外网 + Playwright）');
  console.log('  ⚠️ 真实采集将访问 live.titan007.com，预计耗时 30-120 秒...');

  // 采集今日赛事
  let collectResult;
  try {
    collectResult = await httpPost('/api/collect/today', {});
    ok('POST /api/collect/today 返回 ok', collectResult.ok === true);
    ok('返回 source=titan007', collectResult.source === 'titan007', `actual: ${collectResult.source}`);
    ok('返回 count 是数字', typeof collectResult.count === 'number');
    ok('count >= 1', collectResult.count >= 1, `actual: ${collectResult.count}`);
    ok('matches 是数组', Array.isArray(collectResult.matches));
    console.log(`  📋 今日采集：${collectResult.count} 场 (source=${collectResult.source})`);

    // 验证第一场比赛字段
    const first = collectResult.matches?.[0];
    if (first) {
      ok('match.matchId 存在', !!first.matchId);
      ok('match.home 存在', !!first.home);
      ok('match.away 存在', !!first.away);
      ok('match.league 存在', !!first.league);
      ok('match.matchTime 存在', !!first.matchTime);
      ok('match.businessDate 存在', !!first.businessDate);
      console.log(`  🔍 示例比赛：[${first.matchId}] ${first.home} vs ${first.away} (${first.league})`);

      // 采集单场详情
      const matchId = first.matchId;
      console.log(`\n  ⏳ 采集单场详情 matchId=${matchId}...`);
      try {
        const detailResult = await httpPost(`/api/collect/${matchId}`, {});
        ok(`POST /api/collect/${matchId} 返回 ok`, detailResult.ok === true);
        ok('snapshot.matchId 一致', detailResult.snapshot?.matchId === matchId);
        ok('snapshot.completenessScore 是数字', typeof detailResult.snapshot?.completenessScore === 'number');
        ok('snapshot.source=titan007', detailResult.snapshot?.source === 'titan007');
        console.log(`  📊 完整度分：${detailResult.snapshot?.completenessScore}`);
        console.log(`  📊 snapshotType：${detailResult.snapshot?.snapshotType}`);
        if (detailResult.snapshot?.errors?.length) {
          console.log(`  ⚠️ 采集警告：${detailResult.snapshot.errors.map(e => e.message || e).join('; ')}`);
        }
      } catch (err) {
        ok(`单场详情采集成功`, false, err.message);
      }
    }
  } catch (err) {
    ok('POST /api/collect/today 成功', false, err.message);
    return;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 主入口
// ────────────────────────────────────────────────────────────────────────────
console.log('═'.repeat(60));
console.log('🏟️  足球预测服务 — 全功能运营验收脚本');
console.log(`   模式: ${LIVE ? '在线 (--live)' : '离线'} | 时间: ${new Date().toLocaleString('zh-CN')}`);
console.log('═'.repeat(60));

try {
  await runOfflineAnalysis();

  if (LIVE || portArg) {
    await runLiveApiAcceptance();
    if (LIVE) {
      await runLiveCollectAcceptance();
    }
  } else {
    console.log('\n  ℹ️  跳过在线API验收（加 --live 或 --port=端口 启用）');
  }
} catch (err) {
  console.error('\n💥 验收脚本意外崩溃:', err.message);
  console.error(err.stack);
  failed++;
  failures.push(`脚本崩溃: ${err.message}`);
}

printSummary();
