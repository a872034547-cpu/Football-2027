/**
 * CLV (Closing Line Value) 服务
 * 
 * 核心能力：
 * 1. 构建推荐价快照（recommendation snapshot）
 * 2. 构建收盘价快照（closing snapshot）
 * 3. 计算 CLV（价格差异、概率差异、等级评定）
 * 4. 结算投注结果（win/loss/push）
 * 5. 回测统计（分层、CLV 等级、盈利相关性）
 */

function num(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 4) {
  const n = num(value);
  if (n === null) return null;
  const base = 10 ** digits;
  return Math.round(n * base) / base;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function toIsoTimestamp(value, fallback = Date.now()) {
  const raw = firstDefined(value, fallback);
  const date = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(date.getTime())) return new Date(fallback).toISOString();
  return date.toISOString();
}

/**
 * 解析赔率为欧赔 decimal 格式
 * @param {*} value - 原始赔率（可能是亚盘水位 0.95 或欧赔 1.95）
 * @returns {number|null}
 */
function parseDecimalOdds(value) {
  const raw = num(value);
  if (raw === null || raw <= 0) return null;
  // 已经是 decimal odds (>= 1.01)
  if (raw >= 1.01) return raw;
  // 亚盘水位（0.8-1.2 范围），转为 decimal
  if (raw >= 0.5 && raw <= 1.5) return raw + 1;
  return null;
}

/**
 * 计算隐含概率
 * @param {number} decimalOdds - 欧赔
 * @returns {number|null} - 百分比（0-100）
 */
function impliedProbability(decimalOdds) {
  const odds = parseDecimalOdds(decimalOdds);
  if (!odds || odds <= 1) return null;
  return round(100 / odds, 3);
}

/**
 * 解析盘口值（亚盘/大小球）
 * @param {*} value - 盘口描述，如 '主队-0.5', '大2.5', 0.5
 * @returns {number|null}
 */
function parseLineValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  
  const text = String(value).trim();
  // 中文盘口映射
  const cnMap = {
    '平手': 0, '平手/半球': 0.25, '半球': 0.5, '半球/一球': 0.75,
    '一球': 1, '一球/球半': 1.25, '球半': 1.5, '球半/两球': 1.75,
    '两球': 2, '两球/两球半': 2.25, '两球半': 2.5, '两球半/三球': 2.75,
    '三球': 3,
    '受让平手/半球': -0.25, '受让半球': -0.5, '受让半球/一球': -0.75,
    '受让一球': -1, '受让一球/球半': -1.25, '受让球半': -1.5,
    '受让球半/两球': -1.75, '受让两球': -2, '受让两球/两球半': -2.25,
    '受让两球半': -2.5, '受让两球半/三球': -2.75, '受让三球': -3
  };
  if (cnMap[text] !== undefined) return cnMap[text];
  
  // 数字解析（支持负数、小数、两球盘 0.5/1）
  const cleaned = text.replace(/[－—]/g, '-').replace(/大|小|球|盘口|让|主队|客队/g, '');
  if (cleaned.includes('/')) {
    const parts = cleaned.split('/').map(v => num(v)).filter(v => v !== null);
    if (parts.length === 2) return round((parts[0] + parts[1]) / 2, 2);
  }
  return num(cleaned);
}

/**
 * 从 normalized 数据中提取当前盘口（推荐时或收盘时）
 * @param {object} normalized - 规范化的比赛数据
 * @param {string} mode - 'recommend' | 'closing'
 * @returns {object} - { asian, ou, euro }
 */
function extractMarketData(normalized = {}, mode = 'recommend') {
  const asian = normalized.asian || {};
  const ou = normalized.overunder || normalized.overUnder || {};
  const odds = normalized.odds || normalized.winDrawWin || {};
  const current = odds.averageCurrent || odds.current || odds.keyCurrent || {};
  
  return {
    asian: {
      line: firstDefined(asian.currentLine, asian.mainLine),
      lineValue: parseLineValue(firstDefined(asian.currentLineValue, asian.currentLine, asian.mainLine)),
      homeWater: num(firstDefined(asian.currentHomeWater, asian.homeWater, asian.currentHome)),
      awayWater: num(firstDefined(asian.currentAwayWater, asian.awayWater, asian.currentAway))
    },
    ou: {
      line: firstDefined(ou.currentLine, ou.mainLine),
      lineValue: parseLineValue(firstDefined(ou.currentLineValue, ou.currentLine, ou.mainLine)),
      overWater: num(firstDefined(ou.currentOverWater, ou.currentOver, ou.currentOverPay)),
      underWater: num(firstDefined(ou.currentUnderWater, ou.currentUnder, ou.currentUnderPay))
    },
    euro: {
      win: num(firstDefined(current.win, odds.winOdds, odds.currentWin)),
      draw: num(firstDefined(current.draw, odds.drawOdds, odds.currentDraw)),
      loss: num(firstDefined(current.loss, current.away, odds.lossOdds, odds.currentLoss))
    },
    fetchTime: normalized.fetchTime || Date.now(),
    phase: normalized.derived?.timeContext?.phase || 'unknown',
    minutesToKickoff: normalized.derived?.timeContext?.minutesToKickoff ?? null
  };
}

/**
 * 构建推荐价快照
 * @param {object} params - { matchId, predictionSide, predictionKind, normalized, timestamp }
 * @returns {object} - recommendation snapshot
 */
export function buildRecommendSnapshot({
  matchId,
  recommendationId = null,
  predictionSide = 'home',  // 'home', 'draw', 'away', 'over', 'under'
  predictionKind = 'wdw',   // 'wdw', 'asian', 'ou'
  normalized = {},
  predictionProb = null,
  confidence = null,
  riskLevel = null,
  tier = null,
  timestamp = null
} = {}) {
  const market = extractMarketData(normalized, 'recommend');
  const capturedAt = toIsoTimestamp(timestamp, market.fetchTime || Date.now());
  
  let odds = null;
  let line = null;
  let lineValue = null;
  let water = null;
  
  if (predictionKind === 'wdw') {
    if (predictionSide === 'home') odds = market.euro.win;
    else if (predictionSide === 'draw') odds = market.euro.draw;
    else if (predictionSide === 'away') odds = market.euro.loss;
  } else if (predictionKind === 'asian') {
    line = market.asian.line;
    lineValue = market.asian.lineValue;
    if (predictionSide === 'home') {
      odds = parseDecimalOdds(market.asian.homeWater);
      water = market.asian.homeWater;
    } else if (predictionSide === 'away') {
      odds = parseDecimalOdds(market.asian.awayWater);
      water = market.asian.awayWater;
    }
  } else if (predictionKind === 'ou') {
    line = market.ou.line;
    lineValue = market.ou.lineValue;
    if (predictionSide === 'over') {
      odds = parseDecimalOdds(market.ou.overWater);
      water = market.ou.overWater;
    } else if (predictionSide === 'under') {
      odds = parseDecimalOdds(market.ou.underWater);
      water = market.ou.underWater;
    }
  }
  
  return {
    matchId,
    recommendationId: recommendationId || `${matchId}_${Date.now()}`,
    recommendAt: capturedAt,
    recommendPhase: market.phase,
    recommendMinutesToKickoff: market.minutesToKickoff,
    recommendBetKind: predictionKind,
    recommendSelectionSide: predictionSide,
    recommendLine: line,
    recommendLineValue: lineValue,
    recommendOdds: odds,
    recommendWater: water,
    recommendImpliedProb: impliedProbability(odds),
    predictionProb,
    predictionConfidence: confidence,
    riskLevel,
    tier
  };
}

/**
 * 构建收盘价快照（基于 market timeline 的最后一条快照）
 * @param {object} params - { matchId, recommendationId, lastSnapshot }
 * @returns {object} - partial closing data
 */
export function buildClosingSnapshot({
  matchId,
  recommendationId,
  predictionKind,
  predictionSide,
  lastSnapshot = {}
} = {}) {
  const capturedAt = lastSnapshot?.capturedAt ?? lastSnapshot?.captured_at ?? null;
  if (!lastSnapshot || !capturedAt) {
    return {
      matchId,
      recommendationId,
      closingAt: null,
      closingOdds: null,
      closingLine: null,
      closingLineValue: null,
      closingWater: null,
      closingImpliedProb: null
    };
  }
  
  const phase = lastSnapshot.phase || 'closing';
  const minutesToKickoff = lastSnapshot.minutesToKickoff ?? lastSnapshot.minutes_to_kickoff ?? null;
  
  let odds = null;
  let line = null;
  let lineValue = null;
  let water = null;
  
  if (predictionKind === 'wdw') {
    const euro = lastSnapshot.euro || {};
    if (predictionSide === 'home') odds = num(euro.win ?? lastSnapshot.euro_win);
    else if (predictionSide === 'draw') odds = num(euro.draw ?? lastSnapshot.euro_draw);
    else if (predictionSide === 'away') odds = num(euro.loss ?? lastSnapshot.euro_loss);
  } else if (predictionKind === 'asian') {
    const asian = lastSnapshot.asian || {};
    line = asian.line ?? lastSnapshot.asian_line;
    lineValue = num(asian.lineValue ?? lastSnapshot.asian_line_value);
    if (predictionSide === 'home') {
      water = num(asian.homeWater ?? lastSnapshot.asian_home_water);
      odds = parseDecimalOdds(water);
    } else if (predictionSide === 'away') {
      water = num(asian.awayWater ?? lastSnapshot.asian_away_water);
      odds = parseDecimalOdds(water);
    }
  } else if (predictionKind === 'ou') {
    const ou = lastSnapshot.overunder || lastSnapshot.ou || {};
    line = ou.line ?? lastSnapshot.ou_line;
    lineValue = num(ou.lineValue ?? lastSnapshot.ou_line_value);
    if (predictionSide === 'over') {
      water = num(ou.overWater ?? lastSnapshot.ou_over_water);
      odds = parseDecimalOdds(water);
    } else if (predictionSide === 'under') {
      water = num(ou.underWater ?? lastSnapshot.ou_under_water);
      odds = parseDecimalOdds(water);
    }
  }
  
  return {
    matchId,
    recommendationId,
    closingAt: capturedAt,
    closingPhase: phase,
    closingMinutesToKickoff: minutesToKickoff,
    closingLine: line,
    closingLineValue: lineValue,
    closingOdds: odds,
    closingWater: water,
    closingImpliedProb: impliedProbability(odds)
  };
}

/**
 * 计算 CLV
 * @param {object} snapshot - 包含 recommend 和 closing 数据的快照
 * @returns {object} - CLV 指标
 */
export function calculateClv(snapshot = {}) {
  const recOdds = num(snapshot.recommendOdds);
  const closeOdds = num(snapshot.closingOdds);
  const recProb = num(snapshot.recommendImpliedProb);
  const closeProb = num(snapshot.closingImpliedProb);
  const recLine = num(snapshot.recommendLineValue);
  const closeLine = num(snapshot.closingLineValue);
  
  // 缺少收盘数据
  if (closeOdds === null && closeLine === null) {
    return {
      clvPriceDelta: null,
      clvProbDelta: null,
      clvPercent: null,
      clvStatus: 'unavailable',
      clvGrade: 'unavailable',
      lineMovement: 'unknown',
      waterMovement: 'unknown'
    };
  }
  
  // 赔率 CLV
  const priceDelta = recOdds !== null && closeOdds !== null
    ? round(recOdds - closeOdds, 4)
    : null;
  
  const probDelta = recProb !== null && closeProb !== null
    ? round(closeProb - recProb, 3)
    : null;
  
  const clvPercent = recProb !== null && probDelta !== null
    ? round((probDelta / recProb) * 100, 2)
    : null;
  
  // 盘口移动
  let lineMovement = 'unchanged';
  if (recLine !== null && closeLine !== null) {
    if (Math.abs(closeLine - recLine) >= 0.1) {
      lineMovement = closeLine > recLine ? 'deeper' : 'shallower';
    }
  }
  
  const recWater = num(snapshot.recommendWater);
  const closeWater = num(snapshot.closingWater);
  let waterMovement = 'unchanged';
  if (recWater !== null && closeWater !== null) {
    if (Math.abs(closeWater - recWater) >= 0.02) {
      waterMovement = closeWater > recWater ? 'higher' : 'lower';
    }
  }
  
  // 综合 CLV 评分（赔率 + 盘口）
  let totalScore = priceDelta || 0;
  if (recLine !== null && closeLine !== null) {
    const kind = snapshot.recommendBetKind;
    const side = snapshot.recommendSelectionSide;
    let lineDelta = closeLine - recLine;
    // 调整方向：亚盘客队、大小球小球需要反向
    if ((kind === 'asian' && side === 'away') || (kind === 'ou' && side === 'under')) {
      lineDelta = -lineDelta;
    }
    totalScore += lineDelta * 0.18;  // 每 0.25 盘口约等于 0.045 赔率
  }
  
  let clvStatus = 'neutral';
  let clvGrade = 'fair';
  
  if (Math.abs(totalScore) < 0.015) {
    clvStatus = 'neutral';
    clvGrade = 'fair';
  } else if (totalScore > 0) {
    clvStatus = 'positive';
    if (totalScore >= 0.10) clvGrade = 'excellent';  // +10%以上
    else if (totalScore >= 0.05) clvGrade = 'good';   // +5%~10%
    else clvGrade = 'fair';                            // +1.5%~5%
  } else {
    clvStatus = 'negative';
    if (totalScore <= -0.10) clvGrade = 'poor';       // -10%以下
    else clvGrade = 'negative';                        // -1.5%~-10%
  }
  
  return {
    clvPriceDelta: priceDelta,
    clvProbDelta: probDelta,
    clvPercent,
    clvStatus,
    clvGrade,
    lineMovement,
    waterMovement
  };
}

/**
 * 结算投注结果
 * @param {object} snapshot - CLV 快照
 * @param {object} matchResult - 比赛结果 { homeScore, awayScore }
 * @returns {object} - { betOutcome, betProfit }
 */
export function settleBet(snapshot = {}, matchResult = {}) {
  const homeScore = num(matchResult.homeScore ?? matchResult.home_score);
  const awayScore = num(matchResult.awayScore ?? matchResult.away_score);
  
  if (homeScore === null || awayScore === null) {
    return { betOutcome: 'pending', betProfit: null };
  }
  
  const kind = snapshot.recommendBetKind;
  const side = snapshot.recommendSelectionSide;
  const odds = num(snapshot.recommendOdds);
  const line = num(snapshot.recommendLineValue);
  
  let betOutcome = 'void';
  let betProfit = null;
  
  if (kind === 'wdw') {
    const actual = homeScore > awayScore ? 'home'
      : homeScore < awayScore ? 'away'
      : 'draw';
    betOutcome = actual === side ? 'win' : 'loss';
    betProfit = betOutcome === 'win' ? round((odds - 1), 4) : -1;
  } else if (kind === 'asian' && line !== null) {
    const adjustedHome = homeScore - line;
    const diff = side === 'home' ? adjustedHome - awayScore : awayScore - adjustedHome;
    if (Math.abs(diff) < 0.01) {
      betOutcome = 'push';
      betProfit = 0;
    } else if (diff > 0) {
      betOutcome = 'win';
      betProfit = odds ? round(odds - 1, 4) : null;
    } else {
      betOutcome = 'loss';
      betProfit = -1;
    }
  } else if (kind === 'ou' && line !== null) {
    const totalGoals = homeScore + awayScore;
    const diff = side === 'over' ? totalGoals - line : line - totalGoals;
    if (Math.abs(diff) < 0.01) {
      betOutcome = 'push';
      betProfit = 0;
    } else if (diff > 0) {
      betOutcome = 'win';
      betProfit = odds ? round(odds - 1, 4) : null;
    } else {
      betOutcome = 'loss';
      betProfit = -1;
    }
  }
  
  return { betOutcome, betProfit };
}

/**
 * 回测统计：按 CLV 状态/等级分层
 * @param {Array} clvSnapshots - CLV 快照列表
 * @returns {object} - 回测汇总
 */
export function backtestClvPerformance(clvSnapshots = []) {
  const settled = clvSnapshots.filter(s => s.matchSettled === 1 || s.match_settled === 1);
  const totalCount = settled.length;
  
  if (totalCount === 0) {
    return {
      totalCount: 0,
      clvPositiveRate: null,
      clvAvgPercent: null,
      winRate: null,
      roi: null,
      totalProfit: null,
      byGrade: {},
      byTier: {},
      clvProfitCorrelation: null
    };
  }
  
  const positiveCount = settled.filter(s => s.clvStatus === 'positive' || s.clv_status === 'positive').length;
  const clvPercentValues = settled
    .map(s => num(s.clvPercent ?? s.clv_percent))
    .filter(v => v !== null);
  const clvAvgPercent = clvPercentValues.length
    ? round(clvPercentValues.reduce((a, b) => a + b, 0) / clvPercentValues.length, 2)
    : null;
  
  const wins = settled.filter(s => (s.betOutcome ?? s.bet_outcome) === 'win').length;
  const losses = settled.filter(s => (s.betOutcome ?? s.bet_outcome) === 'loss').length;
  const winRate = (wins + losses) > 0 ? round(wins / (wins + losses), 4) : null;
  
  const profits = settled.map(s => num(s.betProfit ?? s.bet_profit, 0));
  const totalProfit = round(profits.reduce((a, b) => a + b, 0), 4);
  const roi = totalCount > 0 ? round((totalProfit / totalCount) * 100, 2) : null;
  
  // 按 CLV 等级分组
  const byGrade = {};
  for (const grade of ['excellent', 'good', 'fair', 'negative', 'poor', 'unavailable']) {
    const items = settled.filter(s => (s.clvGrade ?? s.clv_grade) === grade);
    if (items.length === 0) continue;
    const gradeWins = items.filter(s => (s.betOutcome ?? s.bet_outcome) === 'win').length;
    const gradeLosses = items.filter(s => (s.betOutcome ?? s.bet_outcome) === 'loss').length;
    const gradeProfit = items.map(s => num(s.betProfit ?? s.bet_profit, 0)).reduce((a, b) => a + b, 0);
    byGrade[grade] = {
      count: items.length,
      winRate: (gradeWins + gradeLosses) > 0 ? round(gradeWins / (gradeWins + gradeLosses), 4) : null,
      roi: round((gradeProfit / items.length) * 100, 2)
    };
  }
  
  // 按分层统计
  const byTier = {};
  for (const tier of ['core', 'balanced', 'aggressive']) {
    const items = settled.filter(s => s.tier === tier);
    if (items.length === 0) continue;
    const tierWins = items.filter(s => (s.betOutcome ?? s.bet_outcome) === 'win').length;
    const tierLosses = items.filter(s => (s.betOutcome ?? s.bet_outcome) === 'loss').length;
    const tierProfit = items.map(s => num(s.betProfit ?? s.bet_profit, 0)).reduce((a, b) => a + b, 0);
    const tierPositive = items.filter(s => (s.clvStatus ?? s.clv_status) === 'positive').length;
    byTier[tier] = {
      count: items.length,
      clvPositiveRate: round(tierPositive / items.length, 4),
      winRate: (tierWins + tierLosses) > 0 ? round(tierWins / (tierWins + tierLosses), 4) : null,
      roi: round((tierProfit / items.length) * 100, 2)
    };
  }
  
  // CLV 与盈利的 Pearson 相关系数（简化版）
  const pairs = settled
    .filter(s => num(s.clvPercent ?? s.clv_percent) !== null && num(s.betProfit ?? s.bet_profit) !== null)
    .map(s => ({
      clv: num(s.clvPercent ?? s.clv_percent),
      profit: num(s.betProfit ?? s.bet_profit)
    }));
  
  let clvProfitCorrelation = null;
  if (pairs.length >= 10) {
    const meanClv = pairs.reduce((a, b) => a + b.clv, 0) / pairs.length;
    const meanProfit = pairs.reduce((a, b) => a + b.profit, 0) / pairs.length;
    const numerator = pairs.reduce((sum, p) => sum + (p.clv - meanClv) * (p.profit - meanProfit), 0);
    const denomX = Math.sqrt(pairs.reduce((sum, p) => sum + (p.clv - meanClv) ** 2, 0));
    const denomY = Math.sqrt(pairs.reduce((sum, p) => sum + (p.profit - meanProfit) ** 2, 0));
    if (denomX > 0 && denomY > 0) {
      clvProfitCorrelation = round(numerator / (denomX * denomY), 4);
    }
  }
  
  return {
    totalCount,
    clvPositiveRate: round(positiveCount / totalCount, 4),
    clvAvgPercent,
    winRate,
    roi,
    totalProfit,
    byGrade,
    byTier,
    clvProfitCorrelation
  };
}

export default {
  buildRecommendSnapshot,
  buildClosingSnapshot,
  calculateClv,
  settleBet,
  backtestClvPerformance
};
