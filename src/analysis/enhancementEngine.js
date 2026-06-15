/**
 * enhancementEngine.js
 * server-only 独立增强层：校准、CLV、评级先验、确定性蒙特卡洛、回测门禁。
 *
 * 设计原则：
 *   - 只依赖 server/src/analysis 内部链路产生的结构化对象。
 *   - 不读取、不导入项目根目录 js/。
 *   - 不直接覆盖原始引擎结论，而是生成可审计的增强层补充结论。
 */

import * as eloService from '../ratings/eloService.js';

const VERSION = 'server-enhancement-v1';

function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  const n = num(value, min);
  return Math.max(min, Math.min(max, n));
}

function round(value, digits = 2) {
  const n = num(value, 0);
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function pct01(value) {
  const n = num(value, null);
  if (n === null) return null;
  if (n > 1) return clamp(n / 100, 0, 1);
  return clamp(n, 0, 1);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function riskPenalty(level) {
  return ({
    low: 0,
    medium_low: 6,
    medium: 14,
    medium_high: 24,
    high: 36,
    unknown: 18,
  })[level] ?? 18;
}

function probabilityEntries(probabilities = {}) {
  return [
    { key: 'home', label: '主胜', p: pct01(probabilities.home) },
    { key: 'draw', label: '平局', p: pct01(probabilities.draw) },
    { key: 'away', label: '客胜', p: pct01(probabilities.away) },
  ].filter(x => x.p !== null);
}

function leadingProbability(probabilities = {}) {
  const entries = probabilityEntries(probabilities).sort((a, b) => b.p - a.p);
  return entries[0] || { key: 'unknown', label: '未知', p: null };
}

function qualityScore(normalized = {}, snapshot = {}) {
  const dq = normalized.derived?.dataQuality;
  const dc = normalized.derived?.dataCompleteness;
  const fromQuality = num(dq?.score, null);
  const fromOverall = num(dc?.overallScore ?? dc?.score, null);
  const fromSnapshot = num(snapshot?.completenessScore, null);
  if (fromQuality !== null) return clamp(fromQuality, 0, 100);
  if (fromOverall !== null) return clamp(fromOverall, 0, 100);
  if (fromSnapshot !== null) return clamp(fromSnapshot * 100, 0, 100);
  return 0;
}

function buildCalibration({ probabilities = {}, normalized = {}, riskProfile = {}, snapshot = {}, proMarket = {} } = {}) {
  const lead = leadingProbability(probabilities);
  const qScore = qualityScore(normalized, snapshot);
  const missingCount = safeArray(normalized.derived?.missingFields).length;
  const proConfidence = num(proMarket?.score?.confidenceDelta, 0);
  const reliabilityScore = clamp(
    qScore * 0.58 +
    (lead.p !== null ? (1 - Math.abs(lead.p - 0.5)) * 22 : 0) +
    clamp(proConfidence + 10, 0, 20) -
    riskPenalty(riskProfile?.level) -
    Math.min(12, missingCount * 2),
    0,
    100,
  );

  const maxPct = lead.p === null ? null : round(lead.p * 100, 1);
  const band = maxPct === null
    ? 'unavailable'
    : `${Math.floor(maxPct / 5) * 5}-${Math.floor(maxPct / 5) * 5 + 5}%`;

  let status = 'bootstrap';
  if (reliabilityScore >= 72) status = 'usable_with_audit';
  else if (reliabilityScore < 45) status = 'needs_history';

  const warnings = [];
  if (status === 'bootstrap') warnings.push('当前为服务端冷启动校准，尚未接入足量赛果闭环样本。');
  if (missingCount > 0) warnings.push(`存在 ${missingCount} 个缺失字段，概率校准需降权。`);
  if (['medium_high', 'high'].includes(riskProfile?.level)) warnings.push('冷门风险偏高，禁止仅凭概率排序放大仓位。');

  return {
    status,
    reliabilityScore: round(reliabilityScore, 1),
    lead,
    probabilityBand: band,
    sampleRequirement: {
      minClosedMatches: 200,
      minLeagueClosedMatches: 40,
      reason: '需要按联赛、概率分桶、盘口深度、风险层级做命中率与校准曲线统计。',
    },
    usageGuideline: status === 'usable_with_audit'
      ? '可进入候选池，但仍需 CLV 与回测门禁共同确认。'
      : '仅作为排序参考，等待更多赛果与收盘赔率样本。',
    warnings,
    method: 'bootstrap reliability = 数据质量×0.58 + 概率稳定性 + 专业盘口信心 - 风险惩罚 - 缺失字段惩罚。',
  };
}

function buildClv({ normalized = {}, quant = null, proMarket = null } = {}) {
  const hasWdw = hasWdwBaseline(normalized.odds);
  const hasAsian = normalized.asian?.currentLineValue != null || normalized.asian?.currentLine != null;
  const hasOu = normalized.overunder?.currentLine != null;
  const baseline = { wdw: hasWdw, asian: hasAsian, overunder: hasOu };
  const baselineScore = (hasWdw ? 35 : 0) + (hasAsian ? 35 : 0) + (hasOu ? 30 : 0);
  
  const valueSignals = [];
  const quantOpportunities = [
    ...safeArray(quant?.value?.opportunities),
    ...safeArray(quant?.valueBets),
  ];
  quantOpportunities.forEach(opp => {
    if (num(opp.edge, 0) > 0.02) {
      valueSignals.push({ label: opp.label, edge: opp.edge, ev: opp.ev, tier: opp.tier, source: 'quant' });
    }
  });
  if (proMarket?.valueRead?.signals) {
    safeArray(proMarket.valueRead.signals).forEach(sig => {
      if (num(sig.edge, 0) > 0) {
        valueSignals.push({ label: sig.label, edge: sig.edge, ev: null, tier: null, source: 'proMarket' });
      }
    });
  }
  
  const readinessScore = clamp(
    baselineScore +
    Math.min(20, valueSignals.length * 6) +
    (proMarket?.score?.confidenceDelta ?? 0),
    0,
    100,
  );
  
  const status = readinessScore >= 75
    ? 'tracking_ready'
    : readinessScore >= 45
      ? 'baseline_only'
      : 'insufficient_market';

  return {
    status,
    readinessScore: round(readinessScore, 1),
    baseline,
    valueSignalCount: valueSignals.length,
    valueSignals: valueSignals.slice(0, 5).map(v => ({
      label: v.label,
      edge: num(v.edge, null),
      ev: num(v.ev, null),
      tier: v.tier,
    })),
    monitorPlan: {
      checkpoints: ['T-24h', 'T-6h', 'T-2h', 'T-30m', 'closing'],
      compareFields: ['胜平负均赔', '主流亚盘线', '亚盘主客水', '大小球线', '大小球大小水'],
      positiveClvRule: '候选方向在临场收盘前赔率/盘口向有利方向移动，且不伴随数据质量降级。',
    },
    requiredSnapshots: status === 'tracking_ready' ? 2 : 4,
    method: 'CLV readiness 基于胜平负/亚盘/大小球基线完整度、盘口路径点、量化 value 信号和专业盘口 edge 共同评分。',
  };
}

function hasWdwBaseline(odds = {}) {
  const sources = [
    odds?.current,
    odds?.averageCurrent,
    odds?.keyOdds?.ao?.current,
    odds?.summary?.averageCurrent,
  ];

  return sources.some(source => {
    if (!source) return false;
    const win = num(source.win, null);
    const draw = num(source.draw, null);
    const loss = num(source.loss, null);
    return win !== null && draw !== null && loss !== null;
  });
}

function extractRecentAdvantage(normalized = {}) {
  const rs = normalized.stats?.recentStats;
  const hf = num(rs?.homeFor ?? rs?.home?.进球?.n10, null);
  const ha = num(rs?.homeAgainst ?? rs?.home?.失球?.n10, null);
  const af = num(rs?.awayFor ?? rs?.away?.进球?.n10, null);
  const aa = num(rs?.awayAgainst ?? rs?.away?.失球?.n10, null);
  if ([hf, ha, af, aa].some(v => v === null)) return 0;
  return clamp(((hf - ha) - (af - aa)) * 18, -45, 45);
}

async function buildRatingPrior({ normalized = {}, probabilities = {}, riskProfile = {}, todayMatch = {} } = {}) {
  const homeName = normalized.matchInfo?.home || todayMatch?.home || '';
  const awayName = normalized.matchInfo?.away || todayMatch?.away || '';
  const league = normalized.matchInfo?.league || todayMatch?.league || '';
  
  // 尝试获取真实 Elo Rating
  let eloData = null;
  let status = 'bootstrap_prior';
  let method = '冷启动 rating prior：1500 基准 + 主场优势 + 市场概率边际 + 亚盘深度 + 近期攻防差 - 风险阻尼';
  
  try {
    if (homeName && awayName) {
      eloData = await eloService.getTeamRatingsForMatch(homeName, awayName, league);
      if (eloData && eloData.home && eloData.away) {
        status = 'elo_rating';
        method = `Elo Rating 系统评分（home: ${eloData.home.matches_played || 0} 场，away: ${eloData.away.matches_played || 0} 场）`;
      }
    }
  } catch (err) {
    console.warn('[buildRatingPrior] Elo query failed:', err.message);
  }
  
  let homeRating, awayRating, ratingDiff;
  const factors = {};
  
  if (eloData && eloData.home && eloData.away) {
    // 使用真实 Elo Rating
    homeRating = round(eloData.home.rating, 1);
    awayRating = round(eloData.away.rating, 1);
    ratingDiff = round((eloData.expected?.ratingDiff ?? (homeRating - awayRating)), 1);
    
    factors.eloHome = homeRating;
    factors.eloAway = awayRating;
    factors.homeAdvantage = eloData.expected?.homeAdvantage || 55;
    factors.expectedHome = round((eloData.expected?.home || 0.5) * 100, 1);
    factors.matchesPlayedHome = eloData.home.matches_played || 0;
    factors.matchesPlayedAway = eloData.away.matches_played || 0;
    factors.provisional = (eloData.home.matches_played < 10 || eloData.away.matches_played < 10) ? 'yes' : 'no';
  } else {
    // 回退到 bootstrap 方法
    const homeBase = 1500 + 35;
    const awayBase = 1500;
    const hp = pct01(probabilities.home) ?? 0.333;
    const ap = pct01(probabilities.away) ?? 0.333;
    const probEdge = clamp((hp - ap) * 260, -90, 90);
    const asianLine = num(normalized.asian?.currentLineValue, 0);
    const asianEdge = clamp(-asianLine * 32, -45, 45);
    const recentEdge = extractRecentAdvantage(normalized);
    const riskDamp = riskPenalty(riskProfile?.level) * 0.35;

    homeRating = round(homeBase + probEdge + asianEdge + recentEdge - riskDamp, 1);
    awayRating = round(awayBase - probEdge - asianEdge - recentEdge + riskDamp * 0.35, 1);
    ratingDiff = round(homeRating - awayRating, 1);
    
    factors.homeAdvantage = 35;
    factors.probabilityEdge = round(probEdge, 1);
    factors.asianLineEdge = round(asianEdge, 1);
    factors.recentFormEdge = round(recentEdge, 1);
    factors.riskDamp = round(riskDamp, 1);
  }

  let verdict = 'balanced_prior';
  if (ratingDiff >= 80) verdict = 'home_prior_strong';
  else if (ratingDiff >= 35) verdict = 'home_prior_light';
  else if (ratingDiff <= -80) verdict = 'away_prior_strong';
  else if (ratingDiff <= -35) verdict = 'away_prior_light';

  return {
    status,
    homeRating,
    awayRating,
    ratingDiff,
    verdict,
    factors,
    method,
    eloAvailable: !!eloData,
  };
}

function seededRandom(seedText = '') {
  let seed = 2166136261;
  for (let i = 0; i < seedText.length; i++) {
    seed ^= seedText.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  return () => {
    seed += 0x6D2B79F5;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function samplePoisson(lambda, rand) {
  const L = Math.exp(-Math.max(0.05, lambda));
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > L && k < 12);
  return k - 1;
}

function fallbackLambda({ normalized = {}, probabilities = {}, quant = {} } = {}) {
  if (quant?.poisson?.ok) {
    return {
      home: num(quant.poisson.lambdaHome, 1.25),
      away: num(quant.poisson.lambdaAway, 1.1),
      source: 'quant.poisson',
    };
  }

  const total = num(normalized.overunder?.currentLine, null) || num(quant?.poisson?.expectedGoals, null) || 2.5;
  const hp = pct01(probabilities.home) ?? 0.34;
  const ap = pct01(probabilities.away) ?? 0.33;
  const advantage = clamp((hp - ap) * 1.45, -0.85, 0.85);
  const home = clamp(total / 2 + advantage / 2, 0.25, 4.2);
  const away = clamp(total - home, 0.25, 4.2);
  return { home, away, source: 'market_probability_fallback' };
}

function buildMonteCarlo({ matchId = '', normalized = {}, probabilities = {}, quant = {} } = {}) {
  const lambda = fallbackLambda({ normalized, probabilities, quant });
  const simulations = 5000;
  const rand = seededRandom(`${VERSION}:${matchId}:${lambda.home}:${lambda.away}`);
  const scoreMap = new Map();
  let home = 0;
  let draw = 0;
  let away = 0;
  let over25 = 0;
  let btts = 0;
  let totalGoals = 0;

  for (let i = 0; i < simulations; i++) {
    const hg = samplePoisson(lambda.home, rand);
    const ag = samplePoisson(lambda.away, rand);
    if (hg > ag) home++;
    else if (hg === ag) draw++;
    else away++;
    if (hg + ag > 2.5) over25++;
    if (hg > 0 && ag > 0) btts++;
    totalGoals += hg + ag;
    const key = `${hg}:${ag}`;
    scoreMap.set(key, (scoreMap.get(key) || 0) + 1);
  }

  const topScores = [...scoreMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([score, count]) => ({ score, probability: round(count / simulations, 4) }));

  const outcome = {
    home: round(home / simulations, 4),
    draw: round(draw / simulations, 4),
    away: round(away / simulations, 4),
  };
  const lead = leadingProbability(outcome);
  const volatility = round(1 - (lead.p || 0), 4);

  return {
    ok: true,
    simulations,
    seed: `${VERSION}:${matchId}`,
    lambda: { home: round(lambda.home, 3), away: round(lambda.away, 3), source: lambda.source },
    outcome,
    overUnder: { over25: round(over25 / simulations, 4), under25: round(1 - over25 / simulations, 4) },
    btts: { yes: round(btts / simulations, 4), no: round(1 - btts / simulations, 4) },
    expectedGoals: round(totalGoals / simulations, 3),
    topScores,
    volatility,
    method: '确定性 Monte Carlo：使用 matchId 派生固定种子，按 λ 分别采样主客进球 5000 次，保证测试和部署输出可复现。',
  };
}

function buildBacktestGate({ calibration = {}, clv = {}, ratingPrior = {}, monteCarlo = {}, riskProfile = {} } = {}) {
  const blockers = [];
  if (calibration.reliabilityScore < 55) blockers.push('calibration_reliability_lt_55');
  if (clv.readinessScore < 55) blockers.push('clv_readiness_lt_55');
  if (['medium_high', 'high'].includes(riskProfile?.level)) blockers.push('risk_level_too_high');
  if (monteCarlo.volatility > 0.68) blockers.push('monte_carlo_volatility_high');

  return {
    status: blockers.length ? 'blocked_until_verified' : 'paper_trade_ready',
    blockers,
    requiredData: [
      '最终赛果（90分钟口径/竞彩口径需分开）',
      '开盘/即时/临场收盘胜平负赔率',
      '亚盘盘口与水位时间序列',
      '大小球盘口与水位时间序列',
      '推荐方向、概率分桶、风险等级、数据完整度',
    ],
    metrics: ['Brier score', 'Log loss', 'ROI', 'CLV均值', '按概率分桶命中率', '按联赛/盘口深度分层回撤'],
    gates: {
      minPaperMatches: 100,
      minPositiveClvRate: 0.52,
      maxCalibrationError: 0.08,
      maxDrawdownUnits: 12,
    },
    method: '回测门禁不在冷启动时伪造收益；只给出可执行的样本字段、指标和准入阈值，待赛果闭环后从 server 数据库计算。',
  };
}

function buildDecision({ calibration = {}, clv = {}, ratingPrior = {}, monteCarlo = {}, riskProfile = {}, rankScore = 0 } = {}) {
  const mcLead = leadingProbability(monteCarlo.outcome);
  const calibratedLead = calibration.lead || {};
  const agreement = mcLead.key !== 'unknown' && calibratedLead.key && mcLead.key === calibratedLead.key;
  let rankDelta = 0;
  if (calibration.reliabilityScore >= 70) rankDelta += 3;
  if (clv.readinessScore >= 70) rankDelta += 3;
  if (agreement) rankDelta += 2;
  if (monteCarlo.volatility > 0.66) rankDelta -= 5;
  if (['medium_high', 'high'].includes(riskProfile?.level)) rankDelta -= 8;

  const enhancedScore = clamp(num(rankScore, 0) + rankDelta, 0, 100);
  let candidateTier = 'observe_only';
  if (enhancedScore >= 72 && calibration.reliabilityScore >= 70 && clv.readinessScore >= 65 && !['medium_high', 'high'].includes(riskProfile?.level)) {
    candidateTier = 'trusted_candidate';
  } else if (enhancedScore >= 58 && calibration.reliabilityScore >= 55) {
    candidateTier = 'balanced_candidate';
  }

  return {
    originalRankScore: rankScore,
    rankDelta: round(rankDelta, 1),
    enhancedScore: round(enhancedScore, 1),
    candidateTier,
    agreement,
    leadDirection: mcLead,
    notes: [
      agreement ? '蒙特卡洛方向与赔率去虚校准主方向一致。' : '蒙特卡洛方向与校准主方向不完全一致，需人工复核。',
      candidateTier === 'trusted_candidate' ? '满足服务端增强层可信候选基础条件。' : '未满足可信候选完整门禁，默认降级为观察或平衡候选。',
    ],
  };
}

export async function buildServerEnhancement(input = {}) {
  const calibration = buildCalibration(input);
  const clv = buildClv(input);
  const ratingPrior = await buildRatingPrior(input);
  const monteCarlo = buildMonteCarlo(input);
  const backtest = buildBacktestGate({ ...input, calibration, clv, ratingPrior, monteCarlo });
  const decision = buildDecision({ ...input, calibration, clv, ratingPrior, monteCarlo });

  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    calibration,
    clv,
    ratingPrior,
    monteCarlo,
    backtest,
    decision,
  };
}

export function enhancementToMarkdown(enhancement = null) {
  if (!enhancement) return '';
  const L = [];
  L.push('### 🧪 服务端独立增强层（server-only）');
  L.push(`- 版本：${enhancement.version || VERSION}`);
  L.push(`- 校准：${enhancement.calibration?.status || '-'}，可靠度=${enhancement.calibration?.reliabilityScore ?? '-'}，主方向=${enhancement.calibration?.lead?.label || '-'}`);
  L.push(`- CLV：${enhancement.clv?.status || '-'}，准备度=${enhancement.clv?.readinessScore ?? '-'}，需快照=${enhancement.clv?.requiredSnapshots ?? '-'}`);
  L.push(`- 评级先验：${enhancement.ratingPrior?.verdict || '-'}，ratingDiff=${enhancement.ratingPrior?.ratingDiff ?? '-'}，状态=${enhancement.ratingPrior?.status || '-'}`);
  const mc = enhancement.monteCarlo;
  if (mc?.ok) {
    L.push(`- Monte Carlo：${mc.simulations}次，胜平负=${round((mc.outcome.home || 0) * 100, 1)}% / ${round((mc.outcome.draw || 0) * 100, 1)}% / ${round((mc.outcome.away || 0) * 100, 1)}%，期望进球=${mc.expectedGoals}`);
    if (mc.topScores?.length) L.push(`- 高频比分：${mc.topScores.map(s => `${s.score}(${round(s.probability * 100, 1)}%)`).join('、')}`);
  }
  L.push(`- 回测门禁：${enhancement.backtest?.status || '-'}${enhancement.backtest?.blockers?.length ? `；阻断：${enhancement.backtest.blockers.join(', ')}` : ''}`);
  L.push(`- 增强决策：${enhancement.decision?.candidateTier || '-'}，增强分=${enhancement.decision?.enhancedScore ?? '-'}（Δ${enhancement.decision?.rankDelta ?? 0}）`);
  return L.join('\n');
}

export default {
  buildServerEnhancement,
  enhancementToMarkdown,
};
