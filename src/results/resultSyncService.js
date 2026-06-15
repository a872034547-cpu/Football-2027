/**
 * resultSyncService.js
 * P0 赛果同步与结算服务：
 * 1. 查询待结算比赛（已采集分析报告，但尚无赛果）。
 * 2. 通过 resultCollector 采集赛果。
 * 3. 写入 match_results，调用 settlementService 生成 prediction_outcomes。
 * 4. 可选触发离线 walk-forward 回测，保存 backtest_runs + calibration_buckets。
 *
 * 设计原则：
 * - 单次 job 全部通过 Promise.allSettled 保护，不因单场失败中止整批次。
 * - 不重新采集盘口/详情，只需要最终比分。
 * - 回测在样本量达到阈值后才自动触发，避免样本过少时误导校准。
 */

import { collectMatchResults } from '../collectors/resultCollector.js';
import { settleAnalysisReport, buildMatchResult } from './settlementService.js';
import { runWalkForwardBacktest } from '../backtest/walkForwardBacktest.js';
import * as db from '../db/index.js';
import * as eloService from '../ratings/eloService.js';
import * as clvDb from '../clv/clvDb.js';
import * as marketTimelineDb from '../db/marketTimelineDb.js';
import { buildClosingSnapshot, calculateClv, settleBet } from '../clv/clvService.js';

const MIN_BACKTEST_SAMPLES = 10;
const BACKTEST_AUTO_TRIGGER_THRESHOLD = 20;
const DEFAULT_CONCURRENCY = 3;

/**
 * 执行一次完整的赛果同步 + 结算 + 可选回测 job
 * @param {Object} options
 * @param {string} [options.date]          指定业务日期，默认同步所有待结算
 * @param {string} [options.titanBaseUrl]
 * @param {number} [options.concurrency]
 * @param {boolean} [options.triggerBacktest]  是否触发回测（默认自动判断）
 * @param {string} [options.jobId]
 * @returns {Promise<Object>} job 结果摘要
 */
export async function runResultSyncJob({
  date = null,
  titanBaseUrl = 'https://live.titan007.com',
  concurrency = DEFAULT_CONCURRENCY,
  triggerBacktest = null,
  jobId = null,
  /** 测试专用：直接注入采集结果，跳过 Playwright 网络请求 */
  _mockCollectResults = null,
} = {}) {
  const startedAt = new Date().toISOString();
  const runId = jobId || `result_sync:${startedAt}`;
  console.log(`[ResultSyncJob] 开始 runId=${runId} date=${date || 'all'}`);

  // ── Step 1: 查询待结算比赛 ──────────────────────────────────
  const pendingMatches = findPendingSettlementMatches(date);
  console.log(`[ResultSyncJob] 待结算比赛 count=${pendingMatches.length}`);

  if (pendingMatches.length === 0) {
    return {
      ok: true,
      runId,
      message: '无待结算比赛',
      syncCount: 0,
      settledCount: 0,
      failCount: 0,
      clvSettledCount: 0,
      clvFailCount: 0,
      backtestTriggered: false,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  // ── Step 2: 采集赛果 ─────────────────────────────────────────
  const matchIds = pendingMatches.map((m) => m.match_id);
  const { results: rawResults, summary } = _mockCollectResults
    ? _mockCollectResults
    : await collectMatchResults(matchIds, { titanBaseUrl, concurrency });

  console.log(`[ResultSyncJob] 赛果采集完成 ${summary.success}/${summary.total} 成功`);

  // ── Step 3: 保存赛果 + 结算预测 ───────────────────────────────
  let settledCount = 0;
  let failCount = 0;
  const failedMatchIds = [];
  let clvSettledCount = 0;
  let clvFailCount = 0;

  for (const raw of rawResults) {
    if (!raw.ok || raw.result1x2 === null) {
      failCount++;
      failedMatchIds.push(raw.matchId);
      continue;
    }

    try {
      // 3a. 保存赛果
      const matchResultRow = buildMatchResult({
        ...raw,
        business_date: findMatchDate(raw.matchId, pendingMatches),
        home: findMatchField(raw.matchId, pendingMatches, 'home'),
        away: findMatchField(raw.matchId, pendingMatches, 'away'),
        league: findMatchField(raw.matchId, pendingMatches, 'league'),
      });

      db.upsertMatchResult(matchResultRow);

      // 3a+. P1: 更新 Elo Rating
      try {
        await eloService.processMatchResult(matchResultRow);
      } catch (eloErr) {
        console.warn(`[ResultSyncJob] matchId=${raw.matchId} Elo更新失败: ${eloErr.message}`);
      }

      // 3a++. P1: 使用盘口时间线最后一条快照补齐 CLV 收盘价并结算投注结果
      try {
        const clvResult = settleClvSnapshotsForMatch(raw.matchId, matchResultRow);
        clvSettledCount += clvResult.settledCount;
        clvFailCount += clvResult.failCount;
      } catch (clvErr) {
        clvFailCount++;
        console.warn(`[ResultSyncJob] matchId=${raw.matchId} CLV结算失败（不阻断P0结算）: ${clvErr.message}`);
      }

      // 3b. 从 analysis_reports 获取对应预测报告
      const report = db.getAnalysisReport(raw.matchId);

      if (report) {
        const settled = settleAnalysisReport(report, raw);
        if (settled.ok) {
          db.upsertPredictionOutcome(settled.outcome);
          settledCount++;
        } else {
          console.warn(`[ResultSyncJob] matchId=${raw.matchId} 结算失败: ${settled.reason}`);
          failCount++;
          failedMatchIds.push(raw.matchId);
        }
      } else {
        // 有赛果但没有分析报告，只保存赛果不结算
        console.info(`[ResultSyncJob] matchId=${raw.matchId} 赛果已保存，无对应分析报告，跳过结算`);
        settledCount++;
      }
    } catch (err) {
      console.error(`[ResultSyncJob] matchId=${raw.matchId} 保存/结算异常: ${err.message}`);
      failCount++;
      failedMatchIds.push(raw.matchId);
    }
  }

  console.log(`[ResultSyncJob] 结算完成 settled=${settledCount} fail=${failCount}`);

  // ── Step 4: 可选触发回测 ─────────────────────────────────────
  let backtestResult = null;
  const shouldTrigger = triggerBacktest === null
    ? settledCount >= MIN_BACKTEST_SAMPLES
    : triggerBacktest;

  if (shouldTrigger) {
    backtestResult = await runBacktestIfReady({ date, runId });
  }

  const finishedAt = new Date().toISOString();

  const result = {
    ok: true,
    runId,
    syncCount: summary.success,
    settledCount,
    failCount,
    failedMatchIds: failedMatchIds.slice(0, 20),
    backtestTriggered: backtestResult !== null,
    backtestRunId: backtestResult?.runId ?? null,
    backtestSampleCount: backtestResult?.sampleCount ?? null,
    backtestGlobalHitRate: backtestResult?.global?.hitRate ?? null,
    clvSettledCount,
    clvFailCount,
    startedAt,
    finishedAt,
    date,
  };

  console.log(`[ResultSyncJob] 完成 settled=${settledCount} fail=${failCount} clvSettled=${clvSettledCount} clvFail=${clvFailCount} backtest=${result.backtestTriggered}`);
  return result;
}

/**
 * 执行离线回测（如果样本量足够）
 */
export async function runBacktestIfReady({ date = null, label = null } = {}) {
  const allOutcomes = db.listPredictionOutcomes({ limit: 2000 });
  const settled = allOutcomes.filter((row) => row.settled_result !== null && row.is_hit !== null);

  if (settled.length < MIN_BACKTEST_SAMPLES) {
    console.info(`[Backtest] 样本量不足 (${settled.length} < ${MIN_BACKTEST_SAMPLES})，跳过回测`);
    return null;
  }

  const runId = `backtest:${new Date().toISOString()}`;
  const startedAt = new Date().toISOString();

  try {
    const backtestResult = runWalkForwardBacktest(settled, {
      label: label || (date ? `daily:${date}` : 'auto'),
      dateFrom: date,
    });

    const finishedAt = new Date().toISOString();

    // 保存 backtest_run
    db.upsertBacktestRun({
      run_id: runId,
      label: backtestResult.label,
      started_at: startedAt,
      finished_at: finishedAt,
      status: 'done',
      date_from: backtestResult.dateFrom,
      date_to: backtestResult.dateTo,
      sample_count: backtestResult.sampleCount,
      metrics_json: backtestResult.global,
      segments_json: backtestResult.segments,
      timeline_json: backtestResult.timeline,
      config_json: { bucketSize: 0.1, minSamples: MIN_BACKTEST_SAMPLES },
    });

    // 保存 calibration_buckets（全局 reliability curve）
    if (backtestResult.global?.reliability?.length > 0) {
      const buckets = backtestResult.global.reliability.map((row) => ({
        ...row,
        segment: 'global',
      }));
      db.insertCalibrationBuckets(runId, buckets);
    }

    // 保存各分段的 reliability curve
    for (const tierSeg of backtestResult.segments.byTier || []) {
      if (tierSeg.reliability?.length > 0) {
        const buckets = tierSeg.reliability.map((row) => ({ ...row, segment: tierSeg.segment }));
        db.insertCalibrationBuckets(runId, buckets);
      }
    }

    console.log(`[Backtest] 完成 runId=${runId} samples=${backtestResult.sampleCount} hitRate=${backtestResult.global?.hitRate}`);

    return { runId, ...backtestResult };
  } catch (err) {
    console.error(`[Backtest] 执行失败: ${err.message}`);

    db.upsertBacktestRun({
      run_id: runId,
      label: label || 'auto',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: 'error',
      notes: err.message?.slice(0, 500),
    });

    return null;
  }
}

function settleClvSnapshotsForMatch(matchId, matchResultRow) {
  const snapshots = clvDb.listClvSnapshotsByMatch(matchId);
  if (!snapshots.length) return { settledCount: 0, failCount: 0 };

  const latestMarketSnapshot = marketTimelineDb.listMarketSnapshots(matchId, 1)?.[0] || null;
  let settledCount = 0;
  let failCount = 0;

  for (const row of snapshots) {
    try {
      const base = clvRowToServiceSnapshot(row);
      const closing = buildClosingSnapshot({
        matchId,
        recommendationId: base.recommendationId,
        predictionKind: base.recommendBetKind,
        predictionSide: base.recommendSelectionSide,
        lastSnapshot: latestMarketSnapshot,
      });
      const merged = { ...base, ...closing };
      const clv = calculateClv(merged);
      const bet = settleBet(merged, matchResultRow);
      clvDb.upsertClvSnapshot({
        ...merged,
        ...clv,
        ...bet,
        matchResultHomeScore: matchResultRow.home_score,
        matchResultAwayScore: matchResultRow.away_score,
        matchSettled: 1,
        source: {
          previous: row.source_json || null,
          closingSource: latestMarketSnapshot || null,
          settledAt: new Date().toISOString(),
        },
      });
      settledCount++;
    } catch (err) {
      failCount++;
      console.warn(`[ResultSyncJob] matchId=${matchId} recommendation=${row.recommendation_id || ''} 单条CLV结算失败: ${err.message}`);
    }
  }

  return { settledCount, failCount };
}

function clvRowToServiceSnapshot(row = {}) {
  return {
    matchId: row.match_id,
    recommendationId: row.recommendation_id,
    recommendAt: row.recommend_at,
    recommendPhase: row.recommend_phase,
    recommendMinutesToKickoff: row.recommend_minutes_to_kickoff,
    recommendBetKind: row.recommend_bet_kind,
    recommendSelectionSide: row.recommend_selection_side,
    recommendLine: row.recommend_line,
    recommendLineValue: row.recommend_line_value,
    recommendOdds: row.recommend_odds,
    recommendWater: row.recommend_water,
    recommendImpliedProb: row.recommend_implied_prob,
    closingAt: row.closing_at,
    closingPhase: row.closing_phase,
    closingMinutesToKickoff: row.closing_minutes_to_kickoff,
    closingLine: row.closing_line,
    closingLineValue: row.closing_line_value,
    closingOdds: row.closing_odds,
    closingWater: row.closing_water,
    closingImpliedProb: row.closing_implied_prob,
    clvPriceDelta: row.clv_price_delta,
    clvProbDelta: row.clv_prob_delta,
    clvPercent: row.clv_percent,
    clvStatus: row.clv_status,
    clvGrade: row.clv_grade,
    lineMovement: row.line_movement,
    waterMovement: row.water_movement,
    matchResultHomeScore: row.match_result_home_score,
    matchResultAwayScore: row.match_result_away_score,
    matchSettled: row.match_settled,
    betOutcome: row.bet_outcome,
    betProfit: row.bet_profit,
    predictionProb: row.prediction_prob,
    predictionConfidence: row.prediction_confidence,
    riskLevel: row.risk_level,
    tier: row.tier,
  };
}

/**
 * 获取待结算比赛（有分析报告但尚未结算，且状态为 finished）
 */
function findPendingSettlementMatches(date = null) {
  // 获取所有已有分析报告的比赛
  const reports = date
    ? listAnalysisReportsByDate(date)
    : listUnsettledAnalysisReports();

  const settledMatchIds = new Set(
    db.listPredictionOutcomes({ limit: 5000 }).map((row) => row.match_id),
  );

  const alreadyHaveResult = new Set(
    db.listMatchResults({ limit: 5000 }).map((row) => row.match_id),
  );

  return reports.filter((report) => {
    // 跳过已结算的
    if (settledMatchIds.has(report.match_id)) return false;
    // 跳过已有赛果但结算失败的（避免重复失败采集）
    if (alreadyHaveResult.has(report.match_id)) return false;
    return true;
  });
}

function listAnalysisReportsByDate(date) {
  try {
    const database = db.getDb();
    return database
      .prepare(`
        SELECT
          ar.match_id,
          ar.business_date,
          m.home,
          m.away,
          m.league
        FROM analysis_reports ar
        LEFT JOIN matches m ON m.match_id = ar.match_id
        WHERE ar.business_date = ?
        ORDER BY ar.match_id
      `)
      .all(date);
  } catch (err) {
    console.warn(`[ResultSyncJob] 查询待结算分析报告失败: ${err.message}`);
    return [];
  }
}

function listUnsettledAnalysisReports() {
  try {
    const database = db.getDb();
    // 获取最近 30 天的分析报告
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return database
      .prepare(`
        SELECT
          ar.match_id,
          ar.business_date,
          m.home,
          m.away,
          m.league
        FROM analysis_reports ar
        LEFT JOIN matches m ON m.match_id = ar.match_id
        WHERE ar.business_date >= ?
        ORDER BY ar.business_date ASC, ar.match_id
      `)
      .all(thirtyDaysAgo);
  } catch (err) {
    console.warn(`[ResultSyncJob] 查询未结算分析报告失败: ${err.message}`);
    return [];
  }
}

function findMatchDate(matchId, pendingMatches) {
  return pendingMatches.find((m) => m.match_id === matchId)?.business_date || null;
}

function findMatchField(matchId, pendingMatches, field) {
  return pendingMatches.find((m) => m.match_id === matchId)?.[field] || null;
}

export default { runResultSyncJob, runBacktestIfReady };
