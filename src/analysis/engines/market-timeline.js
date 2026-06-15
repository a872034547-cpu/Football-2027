/**
 * 盘口生命周期 marketTimeline：把单次盘口截面升级为多次采集过程。
 * 目标：记录欧赔/亚盘/大小球随时间变化，并输出临场反向、欧亚背离、大小球配合度等过程信号。
 */
import { normalizeMatch } from './match-normalizer.js';

const DEFAULT_MAX_SNAPSHOTS = 36;

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
    snapshot.asian?.lineValue,
    snapshot.asian?.homeWater,
    snapshot.asian?.awayWater,
    snapshot.overunder?.lineValue,
    snapshot.overunder?.overWater,
    snapshot.overunder?.underWater,
    snapshot.euro?.win,
    snapshot.euro?.draw,
    snapshot.euro?.loss
  ].map(v => v === null || v === undefined ? '' : String(v)).join('|');
}

function normalizeStored(matchId, storedOrData = {}) {
  if (storedOrData?.data) return storedOrData;
  return {
    matchId,
    fetchTime: storedOrData?.fetchTime || Date.now(),
    data: storedOrData || {}
  };
}

export function buildMarketSnapshot(matchId, storedOrData = {}, options = {}) {
  const stored = normalizeStored(matchId, storedOrData);
  const normalized = options.normalized || normalizeMatch(stored);
  const odds = normalized.odds || {};
  const asian = normalized.asian || {};
  const ou = normalized.overunder || {};
  const currentOdds = odds.averageCurrent || {};
  const capturedAt = options.capturedAt || stored.fetchTime || stored.data?.fetchTime || Date.now();
  const capturedIso = typeof capturedAt === 'number' ? new Date(capturedAt).toISOString() : new Date(capturedAt).toISOString();

  return {
    id: `${matchId || normalized.matchId || 'match'}_${Date.parse(capturedIso) || Date.now()}`,
    matchId: matchId || normalized.matchId || '',
    capturedAt: capturedIso,
    fetchTime: stored.fetchTime || stored.data?.fetchTime || null,
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

export function analyzeMarketTimeline(timeline = {}) {
  const snapshots = safeArray(timeline.snapshots || timeline).filter(Boolean);
  if (!snapshots.length) {
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

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const prev = snapshots.length >= 2 ? snapshots[snapshots.length - 2] : first;
  const asianLineDelta = lineDelta(first.asian?.lineValue, last.asian?.lineValue);
  const lateAsianDelta = lineDelta(prev.asian?.lineValue, last.asian?.lineValue);
  const ouLineDelta = lineDelta(first.overunder?.lineValue, last.overunder?.lineValue);
  const lateOuDelta = lineDelta(prev.overunder?.lineValue, last.overunder?.lineValue);
  const homeWaterDelta = lineDelta(first.asian?.homeWater, last.asian?.homeWater);
  const awayWaterDelta = lineDelta(first.asian?.awayWater, last.asian?.awayWater);
  const overWaterDelta = lineDelta(first.overunder?.overWater, last.overunder?.overWater);
  const underWaterDelta = lineDelta(first.overunder?.underWater, last.overunder?.underWater);
  const euroWinDelta = lineDelta(first.euro?.win, last.euro?.win);
  const euroLossDelta = lineDelta(first.euro?.loss, last.euro?.loss);

  const asianWaterTrend = classifyWaterTrend(homeWaterDelta, awayWaterDelta, 'home', 'away');
  const ouWaterTrend = classifyWaterTrend(overWaterDelta, underWaterDelta, 'over', 'under');
  const euroFavoriteTrend = classifyEuroTrend(first, last, euroWinDelta, euroLossDelta);
  const lateReverse = detectLateReverse({ snapshots, asianLineDelta, lateAsianDelta, ouLineDelta, lateOuDelta, homeWaterDelta, awayWaterDelta, euroWinDelta, euroLossDelta });
  const euroAsianDivergence = detectEuroAsianDivergence({ first, last, asianLineDelta, homeWaterDelta, awayWaterDelta, euroWinDelta, euroLossDelta });
  const volatilityScore = calcVolatilityScore(snapshots);
  const timelineSignal = buildTimelineSignal({ snapshots, lateReverse, euroAsianDivergence, volatilityScore, asianLineDelta, ouLineDelta, asianWaterTrend, ouWaterTrend, euroFavoriteTrend });

  return {
    sampleCount: snapshots.length,
    firstCapturedAt: first.capturedAt || null,
    lastCapturedAt: last.capturedAt || null,
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

export function buildMarketTimeline(input = {}) {
  const existing = input?.marketTimeline || input?.data?.marketTimeline || input || {};
  const snapshots = safeArray(existing.snapshots || existing).filter(Boolean);
  const movement = analyzeMarketTimeline({ snapshots });
  return {
    version: 'market-timeline-v1',
    updatedAt: new Date().toISOString(),
    snapshots,
    movement,
    summary: movement.timelineSignal?.plain || ''
  };
}

export function appendMarketSnapshot(matchId, storedOrData = {}, options = {}) {
  const existing = storedOrData?.marketTimeline || storedOrData?.data?.marketTimeline || {};
  const snapshots = safeArray(existing.snapshots).slice();
  const snapshot = options.snapshot || buildMarketSnapshot(matchId, storedOrData, options);
  const last = snapshots[snapshots.length - 1];
  const minIntervalMs = Number(options.minIntervalMs ?? 0);
  const lastTs = last?.capturedAt ? Date.parse(last.capturedAt) : 0;
  const nextTs = snapshot?.capturedAt ? Date.parse(snapshot.capturedAt) : Date.now();
  const sameAsLast = last && snapshotSignature(last) === snapshotSignature(snapshot);

  if (!sameAsLast || !last || (minIntervalMs > 0 && nextTs - lastTs >= minIntervalMs)) {
    snapshots.push(snapshot);
  } else if (last) {
    snapshots[snapshots.length - 1] = { ...last, capturedAt: snapshot.capturedAt, fetchTime: snapshot.fetchTime };
  }

  const maxSnapshots = Math.max(3, Number(options.maxSnapshots || DEFAULT_MAX_SNAPSHOTS));
  const trimmed = snapshots.slice(-maxSnapshots);
  const movement = analyzeMarketTimeline({ snapshots: trimmed });
  return {
    version: 'market-timeline-v1',
    updatedAt: new Date().toISOString(),
    snapshots: trimmed,
    movement,
    summary: movement.timelineSignal?.plain || ''
  };
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
  if (first?.euro?.favoriteSide !== last?.euro?.favoriteSide && last?.euro?.favoriteSide !== 'unknown') return `favorite_switch_${last.euro.favoriteSide}`;
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
  const fav = last?.euro?.favoriteSide || first?.euro?.favoriteSide || 'unknown';
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
    score += Math.abs(lineDelta(prev.asian?.lineValue, curr.asian?.lineValue) || 0) * 18;
    score += Math.abs(lineDelta(prev.overunder?.lineValue, curr.overunder?.lineValue) || 0) * 12;
    score += Math.abs(lineDelta(prev.asian?.homeWater, curr.asian?.homeWater) || 0) * 20;
    score += Math.abs(lineDelta(prev.asian?.awayWater, curr.asian?.awayWater) || 0) * 20;
    score += Math.abs(lineDelta(prev.euro?.win, curr.euro?.win) || 0) * 8;
    score += Math.abs(lineDelta(prev.euro?.loss, curr.euro?.loss) || 0) * 8;
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

export default {
  buildMarketSnapshot,
  appendMarketSnapshot,
  buildMarketTimeline,
  analyzeMarketTimeline
};
