#!/usr/bin/env node

/**
 * smoke-local.mjs
 * 本地全流程冒烟验证：样例赛事 → 分析 → 写库 → 日报组合 → mock 赛果同步 → 结算/Elo/CLV。
 *
 * 重要：本脚本只使用项目内置样例数据，不访问外网，不会写入生产数据库，不能作为真实投注依据。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_FILE);
const SERVER_ROOT = path.resolve(SCRIPT_DIR, '..');
const DATA_DIR = path.join(SERVER_ROOT, 'data');
const SMOKE_DB = path.join(DATA_DIR, '__smoke_local__.sqlite');

process.env.DATABASE_PATH = SMOKE_DB;
process.env.APP_PORT = process.env.APP_PORT || '13020';
process.env.DAILY_COLLECT_CRON = '';
process.env.RESULT_SYNC_CRON = 'false';
process.env.TIMEZONE = process.env.TIMEZONE || 'Asia/Shanghai';

function assert(condition, message, detail = undefined) {
  if (!condition) {
    const suffix = detail === undefined ? '' : `：${JSON.stringify(detail).slice(0, 300)}`;
    throw new Error(`${message}${suffix}`);
  }
}

function todayInTimezone(timeZone = 'Asia/Shanghai') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function cleanupSmokeDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${SMOKE_DB}${suffix}`;
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  }
}

function toMatchRow(match) {
  return {
    match_id: match.matchId,
    business_date: match.businessDate || match.date,
    league: match.league,
    home: match.home,
    away: match.away,
    match_time: match.matchTime,
    status: match.status || 'scheduled',
    source_json: match,
  };
}

function toReportRow(result, date) {
  return {
    match_id: result.matchId,
    business_date: result.businessDate || date,
    rank_score: result.rankScore,
    confidence: result.completenessScore,
    risk_level: result.riskLevel,
    probabilities_json: result.probabilities,
    trusted_plans_json: result.trustedPlans,
    avoid_plans_json: result.avoidPlans,
    audit_report_md: result.reportMarkdown,
    workflow_report_md: [result.quantMd, result.proMarketMd, result.enhancementMd].filter(Boolean).join('\n\n'),
    agent_json: {
      riskProfile: result.riskProfile,
      quant: { ok: result.quant?.deMargin?.ok, poisson: result.quant?.poisson?.ok },
      normalized: { dataQuality: result.normalized?.derived?.dataQuality },
      serverEnhancement: result.serverEnhancement,
      enhancedCandidateTier: result.enhancedCandidateTier,
      enhancedRankScore: result.enhancedRankScore,
      marketTimeline: result.marketTimeline,
      clvRecommendation: result.clvRecommendation,
      smokeOnly: true,
    },
  };
}

function buildMockResult(match, index) {
  const patterns = [
    { homeScore: 2, awayScore: 1, result1x2: 'home' },
    { homeScore: 1, awayScore: 1, result1x2: 'draw' },
    { homeScore: 0, awayScore: 2, result1x2: 'away' },
  ];
  const score = patterns[index % patterns.length];

  return {
    ok: true,
    matchId: match.matchId,
    homeScore: score.homeScore,
    awayScore: score.awayScore,
    result1x2: score.result1x2,
    totalGoals: score.homeScore + score.awayScore,
    source: 'local_smoke_mock',
    fetchedAt: new Date().toISOString(),
    pageUrl: 'local://smoke/mock-result',
  };
}

async function main() {
  cleanupSmokeDb();

  const db = await import('../src/db/index.js');
  const sampleData = await import('../src/collectors/sampleData.js');
  const analyzer = await import('../src/analysis/matchAnalyzer.js');
  const { runResultSyncJob } = await import('../src/results/resultSyncService.js');
  const marketTimelineDb = await import('../src/db/marketTimelineDb.js');
  const clvDb = await import('../src/clv/clvDb.js');

  try {
    db.initDb();

    const date = todayInTimezone(process.env.TIMEZONE);
    const sampleMatches = sampleData.getSampleTodayMatches(date);
    const selectedMatches = sampleMatches.slice(0, 3);

    assert(selectedMatches.length >= 3, '样例赛事数量不足，至少需要 3 场', { count: selectedMatches.length });

    const matchItems = [];
    for (const match of selectedMatches) {
      db.upsertMatch(toMatchRow(match));

      const snapshot = sampleData.getSampleMatchSnapshot(match.matchId, date);
      assert(snapshot, `无法生成样例快照 matchId=${match.matchId}`);

      db.insertSnapshot({
        match_id: match.matchId,
        snapshot_type: 'sample_full',
        data_json: snapshot,
        completeness_score: snapshot.completenessScore,
      });

      matchItems.push({ snapshot, todayMatch: match });
    }

    const { results: analysisResults, errors: analysisErrors } = await analyzer.analyzeDailyMatches(matchItems, {
      concurrency: 2,
      persistMarketTimeline: true,
      marketTimelineDb,
      persistClv: true,
      clvDb,
    });

    assert(analysisErrors.length === 0, '样例赛事分析不应产生错误', analysisErrors);
    assert(analysisResults.length === selectedMatches.length, '分析结果数量应等于样例赛事数量', {
      expected: selectedMatches.length,
      actual: analysisResults.length,
    });

    for (const result of analysisResults) {
      db.upsertAnalysisReport(toReportRow(result, date));
    }

    const portfolio = analyzer.buildDailyPortfolio(analysisResults);
    db.upsertDailyPortfolio({
      business_date: date,
      summary_md: '本地 smoke 样例日报，仅用于链路验证，不作为投注依据。',
      ranked_json: analysisResults,
      combos_json: portfolio,
    });

    const mockResults = selectedMatches.map((match, index) => buildMockResult(match, index));
    const syncResult = await runResultSyncJob({
      date,
      triggerBacktest: false,
      _mockCollectResults: {
        results: mockResults,
        summary: { total: mockResults.length, success: mockResults.length, fail: 0 },
      },
    });

    const storedMatches = db.listMatches({ date, limit: 20 });
    const storedPortfolio = db.getDailyPortfolio(date);
    const storedResults = db.listMatchResults({ date, limit: 20 });
    const storedOutcomes = db.listPredictionOutcomes({ date, limit: 20 });
    const latestJobs = db.getLatestJobRuns(5);

    assert(storedMatches.length >= selectedMatches.length, 'matches 表应已写入样例赛事', storedMatches.length);
    assert(storedPortfolio !== null, 'daily_portfolios 表应已写入样例日报');
    assert(storedResults.length >= selectedMatches.length, 'match_results 表应已写入 mock 赛果', storedResults.length);
    assert(storedOutcomes.length >= selectedMatches.length, 'prediction_outcomes 表应已写入预测结算结果', storedOutcomes.length);
    assert(syncResult.ok === true, 'runResultSyncJob 应成功完成', syncResult);

    console.log('\n✅ 本地全流程 smoke 验证通过');
    console.log('────────────────────────────────────────');
    console.log(`数据库：${SMOKE_DB}`);
    console.log(`业务日期：${date}`);
    console.log(`样例赛事：${selectedMatches.length} 场`);
    console.log(`分析结果：${analysisResults.length} 条`);
    console.log(`日报组合：stable=${portfolio.stable.length} balanced=${portfolio.balanced.length} explore=${portfolio.explore.length} avoid=${portfolio.avoidList.length}`);
    console.log(`赛果同步：sync=${syncResult.syncCount} settled=${syncResult.settledCount} fail=${syncResult.failCount}`);
    console.log(`CLV 结算：settled=${syncResult.clvSettledCount} fail=${syncResult.clvFailCount}`);
    console.log(`预测结算入库：${storedOutcomes.length} 条`);
    console.log(`最近任务记录：${latestJobs.length} 条`);
    console.log('说明：以上为本地样例链路验证，不访问外网，不代表真实比赛预测结论。\n');
  } finally {
    try { db.closeDb(); } catch (_) {}
  }
}

main().catch((error) => {
  console.error('\n❌ 本地全流程 smoke 验证失败');
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
