import express from 'express';
import cron from 'node-cron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { config, maskSecret } from './config.js';
import * as db from './db/index.js';
import { collectTodayMatches } from './collectors/titanTodayCollector.js';
import { collectMatchDetail } from './collectors/titanMatchCollector.js';
import { collectSporttery, injectSportteryIntoMatches } from './collectors/sportteryCollector.js';
import { pushDailyReportToAll, pushMatchSummaryToAll } from './push/pushRouter.js';
import { analyzeMatch, analyzeDailyMatches, buildDailyPortfolio, warmupAnalysisModules } from './analysis/matchAnalyzer.js';
import { validateJsRoot } from './analysis/jsModuleLoader.js';
import { runResultSyncJob, runBacktestIfReady } from './results/resultSyncService.js';
import * as eloService from './ratings/eloService.js';
import * as marketTimelineDb from './db/marketTimelineDb.js';
import * as clvDb from './clv/clvDb.js';

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const APP_PORT = Number(config.APP_PORT ?? config.appPort ?? process.env.PORT ?? 3000);
const APP_TIMEZONE = config.TIMEZONE ?? config.timezone ?? process.env.TZ ?? 'Asia/Shanghai';
const DAILY_COLLECT_CRON =
  config.DAILY_COLLECT_CRON ??
  config.dailyCollectCron ??
  process.env.DAILY_COLLECT_CRON ??
  '0 8 * * *';

// 赛果同步 Cron（每天 23:00），可通过 RESULT_SYNC_CRON=false 关闭
const RESULT_SYNC_CRON_RAW =
  config.RESULT_SYNC_CRON ??
  config.resultSyncCron ??
  process.env.RESULT_SYNC_CRON ??
  '0 23 * * *';
const RESULT_SYNC_CRON = RESULT_SYNC_CRON_RAW === 'false' ? null : RESULT_SYNC_CRON_RAW;

const SECRET_KEY_PATTERN = /(secret|token|key|api[_-]?key|password|passwd|pwd|credential|webhook)/i;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

let httpServer = null;
let dailyCollectTask = null;
let resultSyncTask = null;
let shuttingDown = false;

app.use(express.json({ limit: '1mb' }));

// 静态文件服务（前端管理页面）
app.use('/admin', express.static(join(__dirname, '../public')));

// ─── 工具函数 ─────────────────────────────────────────────────

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function getDbFunction(names, { required = true } = {}) {
  for (const name of names) {
    if (typeof db[name] === 'function') return db[name];
  }
  if (!required) return null;
  throw new Error(`数据库函数未实现：${names.join(' / ')}`);
}

function parseLimit(value, fallback = DEFAULT_LIMIT) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_LIMIT);
}

function todayInTimezone(timeZone = APP_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const partMap = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${partMap.year}-${partMap.month}-${partMap.day}`;
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function maskValue(key, value) {
  if (value == null) return value;
  if (SECRET_KEY_PATTERN.test(key)) {
    return { configured: String(value).length > 0, masked: maskSecret(String(value)) };
  }
  if (Array.isArray(value)) return value.map((item, i) => maskValue(`${key}.${i}`, item));
  if (typeof value === 'object') return maskConfigSnapshot(value);
  return value;
}

function maskConfigSnapshot(source = config) {
  return Object.fromEntries(
    Object.entries(source)
      .filter(([, v]) => typeof v !== 'function')
      .map(([k, v]) => [k, maskValue(k, v)]),
  );
}

// ─── DB 包装 ──────────────────────────────────────────────────

function listMatches(query) {
  return db.listMatches(query);
}

function getDailyReport(date) {
  return db.getDailyPortfolio(date);
}

function getMatchReport(matchId) {
  return db.getAnalysisReport(matchId);
}

function upsertLearningProfile(key, patch) {
  return db.upsertLearningProfile(key, patch);
}

// ─── 路由：健康与状态 ──────────────────────────────────────────

app.get('/health', (req, res) => {
  const jsRoot = validateJsRoot();
  res.json({
    ok: true,
    service: 'football-auto',
    time: new Date().toISOString(),
    timezone: APP_TIMEZONE,
    jsModules: jsRoot,
  });
});

app.get(
  '/api/jobs/status',
  asyncRoute(async (req, res) => {
    const limit = parseLimit(req.query.limit, 10);
    const recentRuns = db.getLatestJobRuns(limit);
    res.json({
      ok: true,
      time: new Date().toISOString(),
      timezone: APP_TIMEZONE,
      dailyCollectCron: DAILY_COLLECT_CRON,
      config: maskConfigSnapshot(),
      job_runs: recentRuns,
    });
  }),
);

// ─── 路由：查询 ───────────────────────────────────────────────

app.get(
  '/api/matches',
  asyncRoute(async (req, res) => {
    const query = {
      date: normalizeOptionalString(req.query.date),
      status: normalizeOptionalString(req.query.status),
      limit: parseLimit(req.query.limit),
    };
    res.json({ ok: true, query, matches: listMatches(query) });
  }),
);

app.get(
  '/api/reports/daily',
  asyncRoute(async (req, res) => {
    const date = normalizeOptionalString(req.query.date) ?? todayInTimezone();
    res.json({ ok: true, date, report: getDailyReport(date) });
  }),
);

app.get(
  '/api/reports/:matchId',
  asyncRoute(async (req, res) => {
    const matchId = normalizeOptionalString(req.params.matchId);
    if (!matchId) return res.status(400).json({ ok: false, error: 'matchId 不能为空' });
    res.json({ ok: true, matchId, report: getMatchReport(matchId) });
  }),
);

// ─── 路由：Elo Rating ─────────────────────────────────────────

app.get(
  '/api/elo/teams/:teamKey',
  asyncRoute(async (req, res) => {
    const teamKey = normalizeOptionalString(req.params.teamKey);
    const namespace = normalizeOptionalString(req.query.namespace) ?? 'global';
    
    if (!teamKey) {
      return res.status(400).json({ ok: false, error: 'teamKey 不能为空' });
    }

    const rating = db.getTeamRating(namespace, teamKey);
    if (!rating) {
      return res.status(404).json({ ok: false, error: '未找到该球队的 Elo 评分' });
    }

    res.json({ ok: true, namespace, teamKey, rating });
  }),
);

app.get(
  '/api/elo/teams',
  asyncRoute(async (req, res) => {
    const namespace = normalizeOptionalString(req.query.namespace) ?? 'global';
    const league = normalizeOptionalString(req.query.league);
    const limit = parseLimit(req.query.limit, 100);

    const ratings = db.listTeamRatings({ namespace, league, limit });
    res.json({ ok: true, namespace, league, count: ratings.length, ratings });
  }),
);

app.get(
  '/api/elo/match-prediction',
  asyncRoute(async (req, res) => {
    const homeTeam = normalizeOptionalString(req.query.homeTeam);
    const awayTeam = normalizeOptionalString(req.query.awayTeam);
    const league = normalizeOptionalString(req.query.league);
    const namespace = normalizeOptionalString(req.query.namespace) ?? 'global';

    if (!homeTeam || !awayTeam) {
      return res.status(400).json({
        ok: false,
        error: '必须提供 homeTeam 和 awayTeam 参数'
      });
    }

    try {
      const prediction = await eloService.getTeamRatingsForMatch(
        homeTeam,
        awayTeam,
        league,
        namespace
      );

      if (!prediction) {
        return res.status(404).json({
          ok: false,
          error: '无法获取球队评分，可能球队名称不匹配或数据不存在'
        });
      }

      res.json({
        ok: true,
        namespace,
        homeTeam,
        awayTeam,
        league,
        prediction
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }),
);

app.get(
  '/api/elo/events/:matchId',
  asyncRoute(async (req, res) => {
    const matchId = normalizeOptionalString(req.params.matchId);
    const namespace = normalizeOptionalString(req.query.namespace) ?? 'global';
    const limit = parseLimit(req.query.limit, 50);

    if (!matchId) {
      return res.status(400).json({ ok: false, error: 'matchId 不能为空' });
    }

    const events = db.listEloRatingEvents({ matchId, namespace, limit });
    res.json({ ok: true, matchId, namespace, count: events.length, events });
  }),
);

app.get(
  '/api/elo/events',
  asyncRoute(async (req, res) => {
    const teamKey = normalizeOptionalString(req.query.teamKey);
    const namespace = normalizeOptionalString(req.query.namespace) ?? 'global';
    const limit = parseLimit(req.query.limit, 50);

    const events = db.listEloRatingEvents({ teamKey, namespace, limit });
    res.json({ ok: true, teamKey, namespace, count: events.length, events });
  }),
);

// ─── 路由：采集 ───────────────────────────────────────────────

app.post(
  '/api/collect/today',
  asyncRoute(async (req, res) => {
    const date = normalizeOptionalString(req.body?.date) ?? normalizeOptionalString(req.query.date) ?? todayInTimezone();
    const pushOnComplete = req.body?.push !== false;
    const jobId = db.startJobRun('daily_pipeline', { date, trigger: 'api_collect' });

    // 立即返回 202，完整流水线后台执行
    res.status(202).json({
      ok: true,
      message: '采集+分析+报告+推送流水线已启动，请稍后查询 /api/reports/daily 获取结果',
      jobId,
      date,
    });

    runDailyPipeline(jobId, date, pushOnComplete).catch((err) => {
      console.error('[collect_today] 流水线未捕获错误', err);
      try { db.finishJobRun(jobId, 'error', err.message, { date }); } catch (_) {}
    });
  }),
);

app.post(
  '/api/collect/:matchId',
  asyncRoute(async (req, res) => {
    const matchId = normalizeOptionalString(req.params.matchId);
    if (!matchId) return res.status(400).json({ ok: false, error: 'matchId 不能为空' });

    const jobId = db.startJobRun('collect_match', { matchId, trigger: 'api' });
    try {
      const snapshot = await collectMatchDetail(matchId, { titanBaseUrl: config.titanBaseUrl });
      db.insertSnapshot({ match_id: matchId, ...snapshot, snapshot_json: snapshot });
      db.finishJobRun(jobId, 'success', `completeness=${snapshot.completenessScore}`, { matchId });
      res.json({ ok: true, matchId, snapshot });
    } catch (err) {
      db.finishJobRun(jobId, 'error', err.message, { matchId });
      throw err;
    }
  }),
);

// ─── 路由：今日全流水线 ───────────────────────────────────────

app.post(
  '/api/jobs/daily/run',
  asyncRoute(async (req, res) => {
    const date =
      normalizeOptionalString(req.body?.date) ??
      normalizeOptionalString(req.query.date) ??
      todayInTimezone();
    const pushOnComplete = req.body?.push !== false;
    const jobId = db.startJobRun('daily_pipeline', { date, trigger: 'api' });

    // 立即返回 202，流水线后台执行
    res.status(202).json({
      ok: true,
      message: '今日流水线已启动，请稍后查询 /api/reports/daily 获取结果',
      jobId,
      date,
    });

    runDailyPipeline(jobId, date, pushOnComplete).catch((err) => {
      console.error('[daily_pipeline] 未捕获错误', err);
      try { db.finishJobRun(jobId, 'error', err.message, { date }); } catch (_) {}
    });
  }),
);

// ─── 路由：推送 ───────────────────────────────────────────────

app.post(
  '/api/push/daily',
  asyncRoute(async (req, res) => {
    const date = normalizeOptionalString(req.body?.date) ?? normalizeOptionalString(req.query.date) ?? todayInTimezone();
    const report = getDailyReport(date);
    if (!report) {
      return res.status(404).json({ ok: false, error: `未找到 ${date} 的日报，请先运行 /api/jobs/daily/run` });
    }
    const logPush = (channel, status, message) => {
      db.insertPushLog({ match_id: null, business_date: date, channel, status, message, payload_json: { date } });
    };
    const results = await pushDailyReportToAll(config, report, logPush);
    res.json({ ok: true, date, results });
  }),
);

app.post(
  '/api/push/:matchId',
  asyncRoute(async (req, res) => {
    const matchId = normalizeOptionalString(req.params.matchId);
    if (!matchId) return res.status(400).json({ ok: false, error: 'matchId 不能为空' });
    const report = getMatchReport(matchId);
    if (!report) return res.status(404).json({ ok: false, error: `未找到 matchId=${matchId} 的分析报告` });
    const reportDate = report.business_date || report.businessDate || report.date || null;
    const logPush = (channel, status, message) => {
      db.insertPushLog({ match_id: matchId, business_date: reportDate, channel, status, message, payload_json: { matchId } });
    };
    const results = await pushMatchSummaryToAll(config, report, logPush);
    res.json({ ok: true, matchId, results });
  }),
);

app.get(
  '/api/push/logs',
  asyncRoute(async (req, res) => {
    const logs = db.listPushLogs({
      limit: parseLimit(req.query.limit, 20),
      channel: normalizeOptionalString(req.query.channel),
      status: normalizeOptionalString(req.query.status),
      matchId: normalizeOptionalString(req.query.matchId),
      date: normalizeOptionalString(req.query.date),
    });
    res.json({ ok: true, logs });
  }),
);

// ─── 路由：问答 ───────────────────────────────────────────────

app.post(
  '/api/qa',
  asyncRoute(async (req, res) => {
    const question = String(req.body?.question ?? req.body?.q ?? '').trim();
    if (!question) return res.status(400).json({ ok: false, error: 'question 不能为空' });

    const date = normalizeOptionalString(req.body?.date) ?? todayInTimezone();
    const dailyReport = getDailyReport(date);
    const matches = listMatches({ date, limit: 50 });

    const contextLines = [];
    if (dailyReport) {
      contextLines.push(`今日总览：${JSON.stringify(dailyReport).slice(0, 1000)}`);
    }
    if (Array.isArray(matches) && matches.length > 0) {
      contextLines.push(`今日 ${matches.length} 场比赛已采集：`);
      for (const m of matches.slice(0, 5)) {
        contextLines.push(`- ${m.home} vs ${m.away} (${m.league || '-'}) status=${m.status}`);
      }
    }

    const context = contextLines.join('\n') || '当日暂无采集数据';
    const answer = await callAiQa(question, context);

    res.json({
      ok: true,
      question,
      date,
      answer,
      context: contextLines.length > 0 ? '已附加今日数据上下文' : '无数据上下文',
    });
  }),
);

// ─── 路由：赛果同步与复盘 ─────────────────────────────────────

// ─── 路由：赛果同步与回测 ──────────────────────────────────────

/**
 * POST /api/results/sync
 * 自动采集赛果 → 结算预测 → 可选触发回测
 * Body: { date?: string, triggerBacktest?: boolean|null, concurrency?: number }
 */
app.post(
  '/api/results/sync',
  asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const date = normalizeOptionalString(body.date) ?? todayInTimezone();
    const triggerBacktest = body.triggerBacktest ?? null; // null=auto, true=强制, false=跳过
    const concurrency = Number(body.concurrency) || 3;

    const jobId = db.startJobRun('result_sync', { date, trigger: 'api' });
    try {
      const result = await runResultSyncJob({
        date,
        titanBaseUrl: config.titanBaseUrl,
        concurrency,
        triggerBacktest,
        jobId,
      });
      db.finishJobRun(
        jobId,
        result.ok ? 'success' : 'error',
        `sync=${result.syncCount} settled=${result.settledCount} fail=${result.failCount}`,
        { date, ...result },
      );
      res.status(result.ok ? 200 : 207).json({ ok: result.ok, date, jobId, ...result });
    } catch (err) {
      db.finishJobRun(jobId, 'error', err.message, { date });
      throw err;
    }
  }),
);

/**
 * GET /api/results
 * 查询已采集的赛果记录
 */
app.get(
  '/api/results',
  asyncRoute(async (req, res) => {
    const date = normalizeOptionalString(req.query.date);
    const limit = parseLimit(req.query.limit, 50);
    const results = db.listMatchResults({ date, limit });
    res.json({ ok: true, date, count: results.length, results });
  }),
);

/**
 * GET /api/backtest/runs
 * 查询历史回测记录
 */
app.get(
  '/api/backtest/runs',
  asyncRoute(async (req, res) => {
    const limit = parseLimit(req.query.limit, 10);
    const runs = db.getLatestBacktestRuns(limit);
    res.json({ ok: true, count: runs.length, runs });
  }),
);

/**
 * POST /api/backtest/run
 * 手动触发一次回测（基于所有已结算 prediction_outcomes）
 */
app.post(
  '/api/backtest/run',
  asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const label = normalizeOptionalString(body.label) ?? `manual_${Date.now()}`;

    const result = await runBacktestIfReady({ label });
    if (!result) {
      return res.status(202).json({
        ok: false,
        message: '已结算记录不足，跳过回测（需 ≥ 10 条）',
      });
    }
    res.json({ ok: true, label, ...result });
  }),
);

// ─── 404 & 错误处理 ───────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not Found', path: req.originalUrl });
});

app.use((error, req, res, next) => {
  if (res.headersSent) { next(error); return; }
  const status = Number.isInteger(error.status) ? error.status : 500;
  console.error('[server:error]', {
    method: req.method,
    path: req.originalUrl,
    message: error.message,
    stack: error.stack,
  });
  res.status(status).json({
    ok: false,
    error: status >= 500 ? 'Internal Server Error' : error.message,
    message: error.message,
  });
});

// ─── 日流水线核心 ─────────────────────────────────────────────

async function runDailyPipeline(jobId, date, pushOnComplete = false) {
  console.log(`[daily_pipeline] 开始 date=${date} jobId=${jobId}`);

  // Step 1: 采集今日赛事列表
  let matches = [];
  try {
    const result = await collectTodayMatches({
      date,
      titanBaseUrl: config.titanBaseUrl,
      timezone: APP_TIMEZONE,
    });
    matches = result.matches;
    for (const m of matches) db.upsertMatch({ ...m, source_json: m });
    console.log(`[daily_pipeline] 今日赛事采集完成 count=${matches.length}`);
  } catch (err) {
    console.error('[daily_pipeline] 今日赛事采集失败', err.message);
    db.finishJobRun(jobId, 'error', `今日赛事采集失败: ${err.message}`, { date });
    return;
  }

  // Step 2: 竞彩数据注入（失败不阻断）
  try {
    const spResult = await collectSporttery({ date, timezone: APP_TIMEZONE });
    matches = injectSportteryIntoMatches(spResult.matches, matches);
    console.log(`[daily_pipeline] 竞彩采集完成 count=${spResult.matches.length}`);
  } catch (err) {
    console.warn('[daily_pipeline] 竞彩采集失败（不阻断）', err.message);
  }

  // Step 3: 逐场采集详情（并发限制）
  const concurrency = config.collectConcurrency || 4;
  const snapshots = [];
  const matchSnapMap = new Map();

  for (let i = 0; i < matches.length; i += concurrency) {
    const batch = matches.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      batch.map(m => collectMatchDetail(m.matchId, { titanBaseUrl: config.titanBaseUrl })),
    );
    for (let j = 0; j < settled.length; j++) {
      const r = settled[j];
      if (r.status === 'fulfilled') {
        const snap = r.value;
        snapshots.push(snap);
        matchSnapMap.set(snap.matchId, snap);
        db.insertSnapshot({ match_id: snap.matchId, ...snap, snapshot_json: snap });
      } else {
        console.warn(`[daily_pipeline] matchId=${batch[j]?.matchId} 详情采集失败`, r.reason?.message);
      }
    }
  }
  console.log(`[daily_pipeline] 详情采集完成 success=${snapshots.length}/${matches.length}`);

  // Step 4: 使用真实分析链路（quant + proMarket + risk + report）
  console.log(`[daily_pipeline] 开始分析 ${snapshots.length} 场...`);

  const matchItems = snapshots.map(snap => ({
    snapshot: snap,
    todayMatch: matches.find(m => m.matchId === snap.matchId) || {},
  }));

  const { results: analysisResults, errors: analysisErrors } = await analyzeDailyMatches(
    matchItems,
    {
      concurrency: Math.min(2, concurrency), // 分析链路比采集更重，限制并发
      persistMarketTimeline: true,
      marketTimelineDb,
      persistClv: true,
      clvDb,
    },
  );

  if (analysisErrors.length > 0) {
    console.warn(`[daily_pipeline] ${analysisErrors.length} 场分析失败`, analysisErrors.slice(0, 3));
  }

  // 保存单场分析报告到 DB
  for (const ar of analysisResults) {
    db.upsertAnalysisReport({
      match_id: ar.matchId,
      business_date: ar.businessDate || date,
      rank_score: ar.rankScore,
      confidence: ar.completenessScore,
      risk_level: ar.riskLevel,
      probabilities_json: ar.probabilities,
      trusted_plans_json: ar.trustedPlans,
      avoid_plans_json: ar.avoidPlans,
      audit_report_md: ar.reportMarkdown,
      workflow_report_md: [ar.quantMd, ar.proMarketMd, ar.enhancementMd].filter(Boolean).join('\n\n'),
      agent_json: {
        riskProfile: ar.riskProfile,
        quant: { ok: ar.quant?.deMargin?.ok, poisson: ar.quant?.poisson?.ok },
        normalized: { dataQuality: ar.normalized?.derived?.dataQuality },
        serverEnhancement: ar.serverEnhancement,
        enhancedCandidateTier: ar.enhancedCandidateTier,
        enhancedRankScore: ar.enhancedRankScore,
        marketTimeline: ar.marketTimeline,
        clvRecommendation: ar.clvRecommendation,
      },
    });
  }

  // 对没有快照的比赛补充基础数据
  const analyzedIds = new Set(analysisResults.map(r => r.matchId));
  const unanalyzed = matches
    .filter(m => !analyzedIds.has(m.matchId))
    .map(m => ({
      matchId: m.matchId, home: m.home, away: m.away, league: m.league,
      matchTime: m.matchTime, businessDate: date,
      rankScore: 0, riskLevel: 'unknown', completenessScore: 0,
      probabilities: null, trustedPlans: [], avoidPlans: [],
    }));

  const allRanked = [...analysisResults, ...unanalyzed];

  // 生成可信组合方案
  const portfolioItems = buildDailyPortfolio(analysisResults);

  const portfolio = {
    date,
    totalMatches: matches.length,
    collectedDetails: snapshots.length,
    analyzedDetails: analysisResults.length,
    rankedMatches: allRanked,
    stable: portfolioItems.stable,
    balanced: portfolioItems.balanced,
    explore: portfolioItems.explore,
    avoidList: portfolioItems.avoidList,
    stats: portfolioItems.stats,
    generatedAt: new Date().toISOString(),
    analysisNote: `本次分析使用量化引擎 + 专业盘口分析 + 风险评估 + server-only增强层（校准/CLV/评级/蒙特卡洛/回测门禁），共处理 ${analysisResults.length} 场`,
  };

  db.upsertDailyPortfolio({ date, business_date: date, ...portfolio, payload_json: portfolio });
  console.log(`[daily_pipeline] 日报生成完成 date=${date}`);

  // Step 5: 推送
  if (pushOnComplete && config.autoPushChannels?.length > 0) {
    const publicUrl = `${config.publicReportBaseUrl}/daily/${date}`;
    const logPush = (channel, status, message) => {
      db.insertPushLog({ match_id: null, business_date: date, channel, status, message, payload_json: { date } });
    };
    const pushResults = await pushDailyReportToAll(config, { ...portfolio, publicReportUrl: publicUrl }, logPush);
    console.log(`[daily_pipeline] 推送完成 ok=${pushResults.filter(r => r.ok).length}/${pushResults.length}`);
  }

  db.finishJobRun(jobId, 'success',
    `采集 ${matches.length} 场，详情 ${snapshots.length} 场，已生成日报`,
    { date, matchCount: matches.length, detailCount: snapshots.length },
  );
}

/**
 * 调用 AI 接口回答问答
 */
async function callAiQa(question, context) {
  if (!config.aiCustomEndpoint || !config.aiApiKey) {
    return 'AI 未配置（请在 .env 中设置 AI_CUSTOM_ENDPOINT 和 AI_API_KEY）。\n根据已有数据：\n' + context;
  }

  const messages = [
    {
      role: 'system',
      content: '你是足球预测系统的数据分析助手。只根据提供的数据回答，不捏造盘口、赔率或比赛结果。如果数据不足，明确说明。',
    },
    {
      role: 'user',
      content: `背景数据：\n${context}\n\n问题：${question}`,
    },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.aiTimeoutMs || 60000);

  try {
    const resp = await fetch(config.aiCustomEndpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.aiApiKey}`,
      },
      body: JSON.stringify({
        model: config.aiModel || 'gpt-4o-mini',
        messages,
        max_tokens: 1000,
        temperature: 0.3,
      }),
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`AI API HTTP ${resp.status}`);
    const json = await resp.json();
    return json?.choices?.[0]?.message?.content?.trim() || '（AI 返回空内容）';
  } catch (err) {
    clearTimeout(timer);
    console.error('[QA] AI 调用失败', err.message);
    return `AI 调用失败（${err.message}）。\n根据已有数据：\n${context}`;
  }
}

// ─── Cron 注册 ────────────────────────────────────────────────

async function registerResultSyncCron() {
  if (!RESULT_SYNC_CRON || !cron.validate(RESULT_SYNC_CRON)) {
    console.warn(`[cron] RESULT_SYNC_CRON 无效或已禁用，跳过：${RESULT_SYNC_CRON}`);
    return null;
  }

  const task = cron.schedule(
    RESULT_SYNC_CRON,
    () => {
      const date = todayInTimezone();
      const jobId = db.startJobRun('result_sync', { date, trigger: 'cron' });
      console.log(`[cron] result_sync 启动 date=${date}`);
      runResultSyncJob({
        date,
        titanBaseUrl: config.titanBaseUrl,
        concurrency: 3,
        triggerBacktest: null, // auto
        jobId,
      }).then(result => {
        db.finishJobRun(
          jobId,
          result.ok ? 'success' : 'error',
          `sync=${result.syncCount} settled=${result.settledCount} fail=${result.failCount}`,
          { date, ...result },
        );
      }).catch(err => {
        console.error('[cron] result_sync 未捕获错误', err);
        try { db.finishJobRun(jobId, 'error', err.message, { date }); } catch (_) {}
      });
    },
    { timezone: APP_TIMEZONE },
  );

  console.log(`[cron] RESULT_SYNC_CRON 已注册：${RESULT_SYNC_CRON} (${APP_TIMEZONE})`);
  return task;
}

async function registerDailyCollectCron() {
  if (!DAILY_COLLECT_CRON || !cron.validate(DAILY_COLLECT_CRON)) {
    console.warn(`[cron] DAILY_COLLECT_CRON 无效，已跳过：${DAILY_COLLECT_CRON}`);
    return null;
  }

  const task = cron.schedule(
    DAILY_COLLECT_CRON,
    () => {
      const date = todayInTimezone();
      const jobId = db.startJobRun('daily_pipeline', { date, trigger: 'cron' });
      console.log(`[cron] daily_pipeline 启动 date=${date}`);
      runDailyPipeline(jobId, date, true).catch((err) => {
        console.error('[cron] daily_pipeline 未捕获错误', err);
        try { db.finishJobRun(jobId, 'error', err.message, { date }); } catch (_) {}
      });
    },
    { timezone: APP_TIMEZONE },
  );

  console.log(`[cron] DAILY_COLLECT_CRON 已注册：${DAILY_COLLECT_CRON} (${APP_TIMEZONE})`);
  return task;
}

// ─── 启动与关闭 ───────────────────────────────────────────────

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] 收到 ${signal}，开始关闭...`);

  try {
    if (dailyCollectTask) {
      dailyCollectTask.stop();
      if (typeof dailyCollectTask.destroy === 'function') dailyCollectTask.destroy();
    }
    if (resultSyncTask) {
      resultSyncTask.stop();
      if (typeof resultSyncTask.destroy === 'function') resultSyncTask.destroy();
    }

    if (httpServer) {
      await new Promise((resolve, reject) => {
        httpServer.close((err) => { if (err) reject(err); else resolve(); });
      });
    }

    const closeDb = getDbFunction(['closeDb', 'closeDatabase', 'shutdownDb'], { required: false });
    if (closeDb) await closeDb();

    console.log('[server] 已关闭。');
    process.exit(0);
  } catch (err) {
    console.error('[server] 关闭失败', err);
    process.exit(1);
  }
}

async function start() {
  const initDb = getDbFunction(['initDb', 'initializeDb', 'openDb']);
  await initDb();

  // 预热分析模块（非阻塞，失败不影响启动）
  warmupAnalysisModules().then(loaded => {
    const jsRoot = validateJsRoot();
    console.log(`[server] 分析模块预热完成 jsRoot=${jsRoot.ok ? jsRoot.path : 'FAILED'}`);
  }).catch(err => {
    console.warn('[server] 分析模块预热失败（将在首次调用时重试）:', err.message);
  });

  dailyCollectTask = await registerDailyCollectCron();
  resultSyncTask = await registerResultSyncCron();

  httpServer = app.listen(APP_PORT, () => {
    console.log(`[server] football-auto listening on port ${APP_PORT}`);
    console.log(`[server] timezone=${APP_TIMEZONE} cron=${DAILY_COLLECT_CRON} resultSyncCron=${RESULT_SYNC_CRON}`);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

start().catch((err) => {
  console.error('[server] 启动失败', err);
  process.exit(1);
});
