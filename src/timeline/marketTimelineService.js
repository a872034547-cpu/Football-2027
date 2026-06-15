/**
 * Market Timeline Service
 * 盘口时间线服务：记录盘口变化、分析临场反向和欧亚背离
 */

const DEFAULT_MAX_SNAPSHOTS = 36;
const DEFAULT_MIN_INTERVAL_MS = 5 * 60 * 1000; // 5分钟

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const match = String(value).replace(/,/g, '.').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const p = Math.pow(10, digits);
  return Math.round(n * p) / p;
}

function text(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const s = String(value).trim();
  return s || fallback;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function marketSideFromOdds(odds = {}) {
  const win = num(odds.win);
  const loss = num(odds.loss);
  if (win === null || loss === null) return 'unknown';
  if (win + 0.12 < loss) return 'home';
  if (loss + 0.12 < win) return 'away';
  return 'balanced';
}

function snapshotSignature(snapshot = {}) {
  return [
    snapshot.asian?.lineValue || snapshot.asian_line_value,
    snapshot.asian?.homeWater || snapshot.asian_home_water,
    snapshot.asian?.awayWater || snapshot.asian_away_water,
    snapshot.overunder?.lineValue || snapshot.ou_line_value,
    snapshot.overunder?.overWater || snapshot.ou_over_water,
    snapshot.overunder?.underWater || snapshot.ou_under_water,
    snapshot.euro?.win || snapshot.euro_win,
    snapshot.euro?.draw || snapshot.euro_draw,
    snapshot.euro?.loss || snapshot.euro_loss
  ].map(v => v === null || v === undefined ? '' : String(v)).join('|');
}

/**
 * 从 normalized 数据构建盘口快照
 */
export function buildMarketSnapshot(matchId, normalized = {}, options = {}) {
  const odds = normalized.odds || {};
  const asian = normalized.asian || {};
  const ou = normalized.overunder || {};
  const currentOdds = odds.averageCurrent || {};
  const capturedAt = options.capturedAt || normalized.fetchTime || Date.now();
  const capturedIso = typeof capturedAt === 'number' ? new Date(capturedAt).toISOString() : new Date(capturedAt).toISOString();

  return {
    id: `${matchId || normalized.matchId || 'match'}_${Date.parse(capturedIso) || Date.now()}`,
    matchId: matchId || normalized.matchId || '',
    capturedAt: capturedIso,
    fetchTime: normalized.fetchTime || null,
    phase: normalized.derived?.timeContext?.phase || '',
    phaseLabel: normalized.derived?.timeContext?.phaseLabel || '',
    minutesToKickoff: normalized.derived?.timeContext?.minutesToKickoff ?? null,
    asian: {
      line: firstDefined(asian.currentLine, asian.mainLine),
      lineValue: Number.isFinite(Number(asian.currentLineValue)) ? Number(asian.currentLineValue) : null,
      homeWater: Number.isFinite(Number(asian.currentHomeWater)) ? Number(asian.currentHomeWater) : null,
      awayWater: Number.isFinite(Number(asian.currentAwayWater)) ? Number(asian.currentAwayWater) : null
    },
    overunder: {
      line: firstDefined(ou.currentLine, ou.mainLine),
      lineValue: Number.isFinite(Number(ou.currentLine)) ? Number(ou.currentLine) : Number.isFinite(Number(ou.mainLine)) ? Number(ou.mainLine) : null,
      overWater: Number.isFinite(Number(ou.currentOverWater)) ? Number(ou.currentOverWater) : null,
      underWater: Number.isFinite(Number(ou.currentUnderWater)) ? Number(ou.currentUnderWater) : null
    },
    euro: {
      win: Number.isFinite(Number(currentOdds.win)) ? Number(currentOdds.win) : null,
      draw: Number.isFinite(Number(currentOdds.draw)) ? Number(currentOdds.draw) : null,
      loss: Number.isFinite(Number(currentOdds.loss)) ? Number(currentOdds.loss) : null,
      favoriteSide: marketSideFromOdds(currentOdds)
    },
    completenessScore: normalized.derived?.dataCompleteness?.score ?? null
  };
}

/**
 * 分析盘口时间线
 */
export function analyzeMarketTimeline(snapshots = []) {
  const filtered = safeArray(snapshots).filter(Boolean);
  if (!filtered.length) {
    return {
      sampleCount: 0,
      asianLineDelta: null,
      asianWaterTrend: 'unknown',
      ouLineDelta: null,
      ouWaterTrend: 'unknown',
      euroFavoriteTrend: 'unknown',
      lateReverse: false,
      euroAsianDivergence: false,
      volatilityScore: 0,
      timelineSignal: {
        code: 'timeline_missing',
        label: '缺少盘口过程',
        severity: 'low',
        plain: '当前只有单次盘口截面，尚不能判断临场过程。'
      }
    };
  }

  const first = filtered[0];
  const last = filtered[filtered.length - 1];
  const prev = filtered.length >= 2 ? filtered[filtered.length - 2] : first;
  
  const asianLineDelta = lineDelta(getAsianLine(first), getAsianLine(last));
  const lateAsianDelta = lineDelta(getAsianLine(prev), getAsianLine(last));
  const ouLineDelta = lineDelta(getOuLine(first), getOuLine(last));
  const lateOuDelta = lineDelta(getOuLine(prev), getOuLine(last));
  const homeWaterDelta = lineDelta(getAsianHomeWater(first), getAsianHomeWater(last));
  const awayWaterDelta = lineDelta(getAsianAwayWater(first), getAsianAwayWater(last));
  const overWaterDelta = lineDelta(getOuOverWater(first), getOuOverWater(last));
  const underWaterDelta = lineDelta(getOuUnderWater(first), getOuUnderWater(last));
  const euroWinDelta = lineDelta(getEuroWin(first), getEuroWin(last));
  const euroLossDelta = lineDelta(getEuroLoss(first), getEuroLoss(last));

  const asianWaterTrend = classifyWaterTrend(homeWaterDelta, awayWaterDelta, 'home', 'away');
  const ouWaterTrend = classifyWaterTrend(overWaterDelta, underWaterDelta, 'over', 'under');
  const euroFavoriteTrend = classifyEuroTrend(first, last, euroWinDelta, euroLossDelta);
  const lateReverse = detectLateReverse({ snapshots: filtered, asianLineDelta, lateAsianDelta, ouLineDelta, lateOuDelta, homeWaterDelta, awayWaterDelta, euroWinDelta, euroLossDelta });
  const euroAsianDivergence = detectEuroAsianDivergence({ first, last, asianLineDelta, homeWaterDelta, awayWaterDelta, euroWinDelta, euroLossDelta });
  const volatilityScore = calcVolatilityScore(filtered);
  const timelineSignal = buildTimelineSignal({ snapshots: filtered, lateReverse, euroAsianDivergence, volatilityScore, asianLineDelta, ouLineDelta, asianWaterTrend, ouWaterTrend, euroFavoriteTrend });

  return {
    sampleCount: filtered.length,
    firstCapturedAt: first.capturedAt || first.captured_at || null,
    lastCapturedAt: last.capturedAt || last.captured_at || null,
    asianLineDelta,
    asianWaterTrend,
    asianHomeWaterDelta: round(homeWaterDelta),
    asianAwayWaterDelta: round(awayWaterDelta),
    ouLineDelta,
    ouWaterTrend,
    ouOverWaterDelta: round(overWaterDelta),
    ouUnderWaterDelta: round(underWaterDelta),
    euroFavoriteTrend,
    euroWinDelta: round(euroWinDelta),
    euroLossDelta: round(euroLossDelta),
    lateReverse,
    euroAsianDivergence,
    volatilityScore,
    timelineSignal
  };
}

// Helper functions to get values from snapshots (support both camelCase and snake_case)
function getAsianLine(snap) {
  return num(snap.asian?.lineValue || snap.asian_line_value);
}
function getAsianHomeWater(snap) {
  return num(snap.asian?.homeWater || snap.asian_home_water);
}
function getAsianAwayWater(snap) {
  return num(snap.asian?.awayWater || snap.asian_away_water);
}
function getOuLine(snap) {
  return num(snap.overunder?.lineValue || snap.ou_line_value);
}
function getOuOverWater(snap) {
  return num(snap.overunder?.overWater || snap.ou_over_water);
}
function getOuUnderWater(snap) {
  return num(snap.overunder?.underWater || snap.ou_under_water);
}
function getEuroWin(snap) {
  return num(snap.euro?.win || snap.euro_win);
}
function getEuroDraw(snap) {
  return num(snap.euro?.draw || snap.euro_draw);
}
function getEuroLoss(snap) {
  return num(snap.euro?.loss || snap.euro_loss);
}
function getEuroFavoriteSide(snap) {
  return snap.euro?.favoriteSide || snap.euro_favorite_side || 'unknown';
}

function lineDelta(firstValue, lastValue) {
  const a = num(firstValue);
  const b = num(lastValue);
  if (a === null || b === null) return null;
  return round(b - a, 3);
}

function classifyWaterTrend(leftDelta, rightDelta, leftLabel, rightLabel) {
  if (leftDelta === null && rightDelta === null) return 'unknown';
  const l = leftDelta || 0;
  const r = rightDelta || 0;
  if (Math.abs(l - r) < 0.04) return 'balanced';
  if (l < r) return `${leftLabel}_cooling_or_supported`;
  return `${rightLabel}_cooling_or_supported`;
}

function classifyEuroTrend(first, last, winDelta, lossDelta) {
  const firstFav = getEuroFavoriteSide(first);
  const lastFav = getEuroFavoriteSide(last);
  if (firstFav !== lastFav && lastFav !== 'unknown') return `favorite_switch_${lastFav}`;
  if (winDelta === null && lossDelta === null) return 'unknown';
  if ((winDelta || 0) < -0.05) return 'home_shortening';
  if ((lossDelta || 0) < -0.05) return 'away_shortening';
  if ((winDelta || 0) > 0.05 && (lossDelta || 0) > 0.05) return 'draw_or_uncertain';
  return 'stable';
}

function detectLateReverse({ snapshots, asianLineDelta, lateAsianDelta, ouLineDelta, lateOuDelta, homeWaterDelta, awayWaterDelta, euroWinDelta, euroLossDelta }) {
  if (snapshots.length < 2) return false;
  if (lateAsianDelta !== null && asianLineDelta !== null && Math.sign(lateAsianDelta) !== 0 && Math.sign(asianLineDelta) !== 0 && Math.sign(lateAsianDelta) !== Math.sign(asianLineDelta)) return true;
  if (lateOuDelta !== null && ouLineDelta !== null && Math.sign(lateOuDelta) !== 0 && Math.sign(ouLineDelta) !== 0 && Math.sign(lateOuDelta) !== Math.sign(ouLineDelta)) return true;
  if (Math.abs(homeWaterDelta || 0) >= 0.16 || Math.abs(awayWaterDelta || 0) >= 0.16) return true;
  if (Math.abs(euroWinDelta || 0) >= 0.18 || Math.abs(euroLossDelta || 0) >= 0.18) return true;
  return false;
}

function detectEuroAsianDivergence({ first, last, asianLineDelta, homeWaterDelta, awayWaterDelta, euroWinDelta, euroLossDelta }) {
  const fav = getEuroFavoriteSide(last) || getEuroFavoriteSide(first) || 'unknown';
  if (fav === 'home') {
    const euroSupportsHome = (euroWinDelta || 0) < -0.05;
    const asianWeakensHome = (asianLineDelta || 0) > 0.12 || (homeWaterDelta || 0) > 0.10;
    return !!(euroSupportsHome && asianWeakensHome);
  }
  if (fav === 'away') {
    const euroSupportsAway = (euroLossDelta || 0) < -0.05;
    const asianWeakensAway = (asianLineDelta || 0) < -0.12 || (awayWaterDelta || 0) > 0.10;
    return !!(euroSupportsAway && asianWeakensAway);
  }
  return false;
}

function calcVolatilityScore(snapshots = []) {
  let score = 0;
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const curr = snapshots[i];
    score += Math.abs(lineDelta(getAsianLine(prev), getAsianLine(curr)) || 0) * 18;
    score += Math.abs(lineDelta(getOuLine(prev), getOuLine(curr)) || 0) * 12;
    score += Math.abs(lineDelta(getAsianHomeWater(prev), getAsianHomeWater(curr)) || 0) * 20;
    score += Math.abs(lineDelta(getAsianAwayWater(prev), getAsianAwayWater(curr)) || 0) * 20;
    score += Math.abs(lineDelta(getEuroWin(prev), getEuroWin(curr)) || 0) * 8;
    score += Math.abs(lineDelta(getEuroLoss(prev), getEuroLoss(curr)) || 0) * 8;
  }
  return round(Math.min(100, score), 1) || 0;
}

function buildTimelineSignal({ snapshots, lateReverse, euroAsianDivergence, volatilityScore, asianLineDelta, ouLineDelta, asianWaterTrend, ouWaterTrend, euroFavoriteTrend }) {
  if (!snapshots.length) {
    return { code: 'timeline_missing', label: '缺少盘口过程', severity: 'low', plain: '当前只有单次盘口截面，尚不能判断临场过程。' };
  }
  if (lateReverse) {
    return { code: 'late_market_reverse', label: '临场反向', severity: 'high', plain: '盘口生命周期出现临场反向/大幅水位变化，原方向必须降仓或重新确认。' };
  }
  if (euroAsianDivergence) {
    return { code: 'euro_asian_divergence', label: '欧亚背离', severity: 'medium', plain: '欧赔与亚盘过程不同步，存在诱买或保护盘口风险。' };
  }
  if (volatilityScore >= 18) {
    return { code: 'high_volatility', label: '盘口高波动', severity: 'medium', plain: '盘口过程波动偏高，建议降低仓位并等待临场确认。' };
  }
  if (snapshots.length === 1) {
    return { code: 'single_snapshot', label: '单点截面', severity: 'low', plain: '已有盘口快照，但样本不足，继续监控盘口生命周期。' };
  }
  return {
    code: 'market_stable',
    label: '盘口过程稳定',
    severity: 'low',
    plain: `盘口过程相对稳定：亚盘Δ=${asianLineDelta ?? '-'}，大小球Δ=${ouLineDelta ?? '-'}，亚水=${text(asianWaterTrend, '-')}，大小水=${text(ouWaterTrend, '-')}，欧赔=${text(euroFavoriteTrend, '-')}。`
  };
}

/**
 * 追加盘口快照到时间线
 */
export async function appendMarketSnapshot(db, matchId, normalized = {}, options = {}) {
  const snapshot = buildMarketSnapshot(matchId, normalized, options);
  const existing = await db.listMarketSnapshots(matchId);
  const last = existing[existing.length - 1];
  
  const minIntervalMs = Number(options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
  const lastTs = last?.captured_at ? Date.parse(last.captured_at) : 0;
  const nextTs = snapshot?.capturedAt ? Date.parse(snapshot.capturedAt) : Date.now();
  const sameAsLast = last && snapshotSignature(last) === snapshotSignature(snapshot);

  // 去重：相同数据且时间间隔太短则跳过
  if (sameAsLast && minIntervalMs > 0 && nextTs - lastTs < minIntervalMs) {
    return { appended: false, reason: 'duplicate_or_too_soon' };
  }

  // 插入新快照
  await db.insertMarketSnapshot(snapshot);
  
  // 更新分析
  const maxSnapshots = Math.max(3, Number(options.maxSnapshots || DEFAULT_MAX_SNAPSHOTS));
  const allSnapshots = await db.listMarketSnapshots(matchId, maxSnapshots);
  const analysis = analyzeMarketTimeline(allSnapshots);
  await db.upsertMarketTimelineAnalysis(matchId, analysis);
  
  return { appended: true, snapshot, analysis };
}

/**
 * 获取比赛的盘口时间线
 */
export async function getMarketTimeline(db, matchId) {
  const snapshots = await db.listMarketSnapshots(matchId);
  const analysis = await db.getMarketTimelineAnalysis(matchId);
  return {
    matchId,
    snapshots,
    analysis: analysis || analyzeMarketTimeline(snapshots),
    summary: analysis?.signal_plain || ''
  };
}

export default {
  buildMarketSnapshot,
  analyzeMarketTimeline,
  appendMarketSnapshot,
  getMarketTimeline
};
