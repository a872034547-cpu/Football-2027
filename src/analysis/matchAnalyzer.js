/**
 * matchAnalyzer.js
 * 服务端完整分析链路：
 *   snapshotToStored → normalizeMatch → quantAnalyze → proMarket → risk → report
 *
 * 所有分析模块从 js/ 目录动态加载（本地开发和 Docker 均可用）
 */

import { loadModule, preloadAnalysisModules } from './jsModuleLoader.js';
import { snapshotToStored } from './snapshotToStored.js';
import { buildServerEnhancement, enhancementToMarkdown } from './enhancementEngine.js';
import { appendMarketSnapshot } from '../timeline/marketTimelineService.js';
import { buildRecommendSnapshot } from '../clv/clvService.js';

let _modulesPreloaded = false;

/**
 * 预加载所有分析模块（服务启动时调用一次）
 */
export async function warmupAnalysisModules() {
  if (_modulesPreloaded) return;
  await preloadAnalysisModules();
  _modulesPreloaded = true;
}

/**
 * 分析单场比赛，返回完整结构化结果
 *
 * @param {Object} snapshot    来自 titanMatchCollector.collectMatchDetail
 * @param {Object} todayMatch  来自 titanTodayCollector，含 home/away/league/matchTime/jingcai 等
 * @returns {Promise<MatchAnalysisResult>}
 */
export async function analyzeMatch(snapshot, todayMatch = {}, options = {}) {
  const matchId = snapshot?.matchId || todayMatch?.matchId || '';

  // Step 1: 格式转换
  const stored = snapshotToStored(snapshot, todayMatch);

  // Step 2: 归一化
  const { normalizeMatch, normalizedToMarkdown } = await loadModule('match-normalizer.js');
  const normalized = normalizeMatch(stored);

  // Step 2.5: 可选接入盘口时间线（只在主流水线传入 DB 适配器时启用，避免纯分析测试产生数据库依赖）
  const marketTimeline = await buildOptionalMarketTimeline({ matchId, normalized, options });

  // Step 3: 量化分析
  const { analyze: quantAnalyze, toMarkdown: quantToMarkdown } = await loadModule('quant-engine.js');
  const recentStats = extractRecentStats(normalized, snapshot);
  const quant = quantAnalyze(stored.data, recentStats);

  // Step 4: 专业盘口分析
  const { analyzeProfessionalMarket, professionalMarketToMarkdown } = await loadModule('pro-market-engine.js');
  const proMarket = analyzeProfessionalMarket({
    normalized,
    quant,
    marketTimeline,
    jingcaiDeviation: stored.data.jingcai?.deviation || null,
  });

  // Step 5: 冷门风险评估
  const { analyzeUpsetRisk, riskProfileToMarkdown } = await loadModule('risk-engine.js');
  const riskProfile = analyzeUpsetRisk({
    normalized,
    quant,
    proMarket,
  });

  // Step 6: 生成报告
  const { ReportGenerator } = await loadModule('report.js');
  const reportGen = new ReportGenerator();
  const report = reportGen.generate(stored, {
    normalized,
    quant,
    proMarket,
    riskProfile,
  });

  // Step 7: 计算概率和排名分
  const probabilities = extractProbabilities(normalized, quant);
  const rankScore = calcRankScore({
    normalized,
    quant,
    riskProfile,
    snapshot,
    probabilities,
  });

  // Step 8: server-only 增强层（校准 / CLV / rating prior / Monte Carlo / backtest gate）
  const serverEnhancement = await buildServerEnhancement({
    matchId,
    stored,
    todayMatch,
    normalized,
    quant,
    proMarket,
    riskProfile,
    snapshot,
    probabilities,
    rankScore,
    marketTimeline,
  });
  const enhancementMd = enhancementToMarkdown(serverEnhancement);

  // Step 8.5: 可选记录推荐价 CLV 快照（主流水线启用；纯分析测试默认不写 DB）
  const clvRecommendation = await buildOptionalClvRecommendation({
    matchId,
    normalized,
    probabilities,
    riskProfile,
    serverEnhancement,
    options,
  });

  return {
    matchId,
    businessDate: todayMatch?.businessDate || todayMatch?.matchTime?.slice(0, 10) || '',
    home: normalized.matchInfo.home || todayMatch?.home || '',
    away: normalized.matchInfo.away || todayMatch?.away || '',
    league: normalized.matchInfo.league || todayMatch?.league || '',
    matchTime: todayMatch?.matchTime || '',

    // 核心输出
    probabilities,
    rankScore,
    enhancedRankScore: serverEnhancement?.decision?.enhancedScore ?? rankScore,
    enhancedCandidateTier: serverEnhancement?.decision?.candidateTier || 'observe_only',
    confidence: riskProfile?.level || 'unknown',
    riskLevel: riskProfile?.level || 'unknown',
    riskScore: riskProfile?.score ?? null,
    completenessScore: snapshot?.completenessScore ?? 0,
    dataQualityLevel: normalized.derived?.dataQuality?.level || 'low',
    dataQualityScore: normalized.derived?.dataCompleteness?.score ?? 0,

    // 竞彩偏差
    jingcai: stored.data.jingcai || null,

    // 报告
    reportMarkdown: report.markdown || '',
    reportStructured: report.structured || {},

    // 各层分析结果（供调试/审计）
    quant,
    proMarket,
    riskProfile,
    normalized,
    serverEnhancement,
    marketTimeline,
    clvRecommendation,

    // Markdown 摘要
    normalizedMd: normalizedToMarkdown(normalized),
    quantMd: quantToMarkdown(quant),
    proMarketMd: typeof professionalMarketToMarkdown === 'function'
      ? professionalMarketToMarkdown(proMarket)
      : '',
    riskMd: typeof riskProfileToMarkdown === 'function'
      ? riskProfileToMarkdown(riskProfile)
      : '',
    enhancementMd,

    // 可信方案（从报告结构化中提取）
    trustedPlans: report.structured?.betAdvice?.trustedPlans || [],
    avoidPlans: report.structured?.betAdvice?.avoidPlans || [],
    invalidIf: report.structured?.betAdvice?.invalidIf || [],
    liveChecklist: report.structured?.betAdvice?.liveChecklist || [],

    // 元信息
    errors: snapshot?.errors || [],
    analyzedAt: new Date().toISOString(),
  };
}

/**
 * 批量分析今日所有比赛（并发限制）
 *
 * @param {Array} matchItems  每项包含 { snapshot, todayMatch }
 * @param {Object} options
 * @returns {Promise<MatchAnalysisResult[]>}
 */
export async function analyzeDailyMatches(matchItems, { concurrency = 4, ...analysisOptions } = {}) {
  const results = [];
  const errors = [];

  for (let i = 0; i < matchItems.length; i += concurrency) {
    const batch = matchItems.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      batch.map(({ snapshot, todayMatch }) => analyzeMatch(snapshot, todayMatch, analysisOptions)),
    );

    for (let j = 0; j < settled.length; j++) {
      const r = settled[j];
      const matchId = batch[j]?.todayMatch?.matchId || batch[j]?.snapshot?.matchId;
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        const errMsg = r.reason?.message || String(r.reason);
        console.error(`[matchAnalyzer] matchId=${matchId} 分析失败:`, errMsg);
        errors.push({ matchId, error: errMsg });
      }
    }
  }

  // 按服务端增强分优先、原始综合评分兜底排序
  results.sort((a, b) => (b.enhancedRankScore ?? b.rankScore) - (a.enhancedRankScore ?? a.rankScore));

  return { results, errors };
}

/**
 * 根据分析结果生成可信组合方案
 *
 * @param {MatchAnalysisResult[]} results  已排序的分析结果列表
 * @returns {Object} { stable, balanced, explore, avoidList }
 */
export function buildDailyPortfolio(results) {
  const validResults = results.filter(r =>
    r.dataQualityLevel !== 'low' &&
    r.completenessScore > 0 &&
    r.riskLevel !== 'unknown'
  );

  // 稳健方案：低/中低风险 + 高完整度 + 欧赔有效
  const stable = validResults.filter(r =>
    ['low', 'medium_low'].includes(r.riskLevel) &&
    r.completenessScore >= 0.6 &&
    r.rankScore >= 50
  ).slice(0, 5);

  // 平衡方案：不超过中风险 + 有一定数据支撑
  const balanced = validResults.filter(r =>
    ['low', 'medium_low', 'medium'].includes(r.riskLevel) &&
    r.completenessScore >= 0.4
  ).slice(0, 8);

  // 探索方案：前10名，包含高风险（需明确标注）
  const explore = results.slice(0, 10);

  // 全局回避列表（高风险或数据严重不足）
  const avoidList = results.filter(r =>
    r.riskLevel === 'high' ||
    r.completenessScore < 0.2 ||
    r.dataQualityLevel === 'low'
  ).map(r => ({
    matchId: r.matchId,
    home: r.home,
    away: r.away,
    reason: r.riskLevel === 'high' ? '高冷门风险' : '数据不足',
  }));

  return {
    stable: stable.map(formatPlanItem),
    balanced: balanced.map(formatPlanItem),
    explore: explore.map(formatPlanItem),
    avoidList,
    stats: {
      total: results.length,
      valid: validResults.length,
      stableCount: stable.length,
      balancedCount: balanced.length,
      avoidCount: avoidList.length,
    },
  };
}

// ─── 内部辅助函数 ─────────────────────────────────────────────

async function buildOptionalMarketTimeline({ matchId, normalized, options = {} }) {
  if (!matchId) return options.marketTimeline || null;

  if (options.marketTimelineByMatch instanceof Map && options.marketTimelineByMatch.has(matchId)) {
    return options.marketTimelineByMatch.get(matchId);
  }

  if (!options.persistMarketTimeline || !options.marketTimelineDb) {
    return options.marketTimeline || null;
  }

  try {
    const result = await appendMarketSnapshot(options.marketTimelineDb, matchId, normalized, {
      capturedAt: normalized.fetchTime || Date.now(),
      minIntervalMs: options.marketTimelineMinIntervalMs,
      maxSnapshots: options.marketTimelineMaxSnapshots,
    });
    const analysis = result?.analysis || null;
    return {
      matchId,
      appended: Boolean(result?.appended),
      skippedReason: result?.reason || null,
      movement: analysis,
      summary: analysis?.timelineSignal?.plain || '',
      latestSnapshot: result?.snapshot || null,
    };
  } catch (err) {
    console.warn(`[matchAnalyzer] matchId=${matchId} 盘口时间线写入失败（不阻断分析）:`, err.message);
    return {
      matchId,
      appended: false,
      error: err.message,
      summary: '',
    };
  }
}

async function buildOptionalClvRecommendation({ matchId, normalized, probabilities, riskProfile, serverEnhancement, options = {} }) {
  if (!matchId) return null;

  if (options.clvRecommendationByMatch instanceof Map && options.clvRecommendationByMatch.has(matchId)) {
    return options.clvRecommendationByMatch.get(matchId);
  }

  if (!options.persistClv || !options.clvDb) return null;

  const primaryPick = extractPrimaryPick(probabilities);
  if (!primaryPick?.side) {
    return { matchId, saved: false, reason: 'no_primary_pick' };
  }

  const recommendationId = `${matchId}:wdw:${primaryPick.side}`;
  const snapshot = buildRecommendSnapshot({
    matchId,
    recommendationId,
    predictionKind: 'wdw',
    predictionSide: primaryPick.side,
    normalized,
    predictionProb: primaryPick.probability,
    confidence: serverEnhancement?.decision?.enhancedScore ?? null,
    riskLevel: riskProfile?.level || null,
    tier: serverEnhancement?.decision?.candidateTier || null,
    timestamp: normalized.fetchTime || null,
  });

  if (!snapshot.recommendOdds) {
    return {
      matchId,
      recommendationId,
      saved: false,
      reason: 'missing_recommend_odds',
      predictionSide: primaryPick.side,
    };
  }

  try {
    options.clvDb.upsertClvSnapshot(snapshot);
    return {
      matchId,
      recommendationId,
      saved: true,
      predictionKind: snapshot.recommendBetKind,
      predictionSide: snapshot.recommendSelectionSide,
      recommendOdds: snapshot.recommendOdds,
      recommendImpliedProb: snapshot.recommendImpliedProb,
      predictionProb: snapshot.predictionProb,
      tier: snapshot.tier,
    };
  } catch (err) {
    console.warn(`[matchAnalyzer] matchId=${matchId} CLV推荐价快照写入失败（不阻断分析）:`, err.message);
    return {
      matchId,
      recommendationId,
      saved: false,
      error: err.message,
      predictionSide: primaryPick.side,
    };
  }
}

function extractPrimaryPick(probabilities = {}) {
  const entries = [
    ['home', probabilities.home],
    ['draw', probabilities.draw],
    ['away', probabilities.away],
  ]
    .map(([side, probability]) => ({ side, probability: Number(probability) }))
    .filter(item => Number.isFinite(item.probability));

  if (!entries.length) return null;
  entries.sort((a, b) => b.probability - a.probability);
  return entries[0];
}

/**
 * 从归一化数据和量化结果提取概率
 */
function extractProbabilities(normalized, quant) {
  // 优先用量化去水概率
  if (quant?.deMargin?.ok && quant.deMargin.probabilities) {
    const p = quant.deMargin.probabilities;
    return {
      home: Math.round((p.win || p.home || 0) * 100) / 100,
      draw: Math.round((p.draw || 0) * 100) / 100,
      away: Math.round((p.loss || p.away || 0) * 100) / 100,
      source: 'deMargin',
    };
  }

  // 降级：用欧赔均值手动去水
  const avg = normalized.odds?.averageCurrent;
  if (avg?.win && avg?.draw && avg?.loss) {
    const w = parseFloat(avg.win), d = parseFloat(avg.draw), l = parseFloat(avg.loss);
    if (w > 1 && d > 1 && l > 1) {
      const total = 1 / w + 1 / d + 1 / l;
      return {
        home: Math.round((1 / w / total) * 100) / 100,
        draw: Math.round((1 / d / total) * 100) / 100,
        away: Math.round((1 / l / total) * 100) / 100,
        source: 'odds_raw',
      };
    }
  }

  return { home: null, draw: null, away: null, source: 'unavailable' };
}

/**
 * 计算综合排名分（0-100）
 */
function calcRankScore({ normalized, quant, riskProfile, snapshot, probabilities }) {
  let score = 0;

  // 数据完整度（30分）
  const completeness = snapshot?.completenessScore ?? 0;
  score += Math.round(completeness * 30);

  // 盘口有效性（20分）
  const asianValid = normalized.asian?.lineQuality?.valid ? 10 : 0;
  const ouValid = normalized.overunder?.lineQuality?.valid ? 10 : 0;
  score += asianValid + ouValid;

  // 量化分析可信度（20分）
  if (quant?.deMargin?.ok) score += 10;
  if (quant?.poisson?.ok) score += 10;

  // 风险扣分（-20到0）
  const riskPenalty = {
    low: 0,
    medium_low: -5,
    medium: -10,
    medium_high: -15,
    high: -20,
    unknown: -10,
  };
  score += riskPenalty[riskProfile?.level] ?? -10;

  // 概率有效性（10分）
  if (probabilities?.home && probabilities?.draw && probabilities?.away) score += 10;

  // 欧赔数量（最多10分）
  const wdwCount = normalized.odds?.companies?.length || 0;
  score += Math.min(10, wdwCount * 2);

  return Math.max(0, Math.min(100, score));
}

/**
 * 从归一化数据中提取近期攻防数据（供量化分析使用）
 */
function extractRecentStats(normalized, snapshot) {
  // 如果归一化数据有近期战绩，提取进失球均值
  const rs = normalized.stats?.recentStats;
  if (rs?.source && rs?.source !== 'market_implied') {
    return rs;
  }

  // 降级：返回市场隐含数据（quantity-engine 会自动处理）
  return null;
}

/**
 * 格式化方案条目
 */
function formatPlanItem(r) {
  return {
    matchId: r.matchId,
    home: r.home,
    away: r.away,
    league: r.league,
    matchTime: r.matchTime,
    rankScore: r.rankScore,
    enhancedRankScore: r.enhancedRankScore,
    enhancedCandidateTier: r.enhancedCandidateTier,
    riskLevel: r.riskLevel,
    completenessScore: r.completenessScore,
    probabilities: r.probabilities,
    trustedPlans: r.trustedPlans,
    avoidPlans: r.avoidPlans,
    invalidIf: r.invalidIf,
    serverEnhancement: r.serverEnhancement ? {
      version: r.serverEnhancement.version,
      calibration: r.serverEnhancement.calibration,
      clv: r.serverEnhancement.clv,
      ratingPrior: r.serverEnhancement.ratingPrior,
      monteCarlo: r.serverEnhancement.monteCarlo,
      backtest: r.serverEnhancement.backtest,
      decision: r.serverEnhancement.decision,
    } : null,
    jingcai: r.jingcai ? {
      hasDeviation: r.jingcai.hasDeviation,
      deviation: r.jingcai.deviation,
    } : null,
  };
}
