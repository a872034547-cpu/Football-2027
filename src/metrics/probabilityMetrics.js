const OUTCOME_ORDER = ['home', 'draw', 'away'];
const OUTCOME_ALIASES = new Map([
  ['h', 'home'],
  ['home', 'home'],
  ['home_win', 'home'],
  ['主', 'home'],
  ['主胜', 'home'],
  ['胜', 'home'],
  ['1', 'home'],
  ['d', 'draw'],
  ['draw', 'draw'],
  ['tie', 'draw'],
  ['平', 'draw'],
  ['平局', 'draw'],
  ['x', 'draw'],
  ['0', 'draw'],
  ['a', 'away'],
  ['away', 'away'],
  ['away_win', 'away'],
  ['客', 'away'],
  ['客胜', 'away'],
  ['负', 'away'],
  ['2', 'away'],
]);

export function normalizeOutcomeSide(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim().toLowerCase();
  return OUTCOME_ALIASES.get(raw) || null;
}

export function actualOutcomeFromScore(homeScore, awayScore) {
  // 明确拒绝 null/undefined/空字符串，避免 Number(null)=0 被当做有效比分
  if (homeScore === null || homeScore === undefined || homeScore === ''
    || awayScore === null || awayScore === undefined || awayScore === '') return null;

  const home = Number(homeScore);
  const away = Number(awayScore);

  if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
  if (home > away) return 'home';
  if (home < away) return 'away';
  return 'draw';
}

export function actualOutcome1x2(input = {}) {
  const explicit = normalizeOutcomeSide(
    input.actualSide
      ?? input.actual_side
      ?? input.result1x2
      ?? input.result_1x2
      ?? input.settledResult
      ?? input.settled_result
      ?? input.result,
  );
  if (explicit) return explicit;

  return actualOutcomeFromScore(input.homeScore ?? input.home_score, input.awayScore ?? input.away_score);
}

export function normalizeProb1x2(probabilities = {}) {
  const source = probabilities?.probabilities_json && typeof probabilities.probabilities_json === 'object'
    ? probabilities.probabilities_json
    : probabilities;

  const raw = {
    home: numberFrom(source.home ?? source.win ?? source.h ?? source.homeWin ?? source.home_win),
    draw: numberFrom(source.draw ?? source.tie ?? source.d ?? source.x),
    away: numberFrom(source.away ?? source.loss ?? source.a ?? source.awayWin ?? source.away_win),
  };

  const values = Object.fromEntries(
    OUTCOME_ORDER.map((key) => [key, Number.isFinite(raw[key]) && raw[key] > 1 ? raw[key] / 100 : raw[key]]),
  );
  const sum = OUTCOME_ORDER.reduce((acc, key) => acc + Math.max(0, values[key] || 0), 0);

  if (sum <= 0) {
    return { home: 1 / 3, draw: 1 / 3, away: 1 / 3, source: 'fallback_equal' };
  }

  return {
    home: round(values.home / sum, 6),
    draw: round(values.draw / sum, 6),
    away: round(values.away / sum, 6),
    source: source.source || probabilities.source || 'normalized',
  };
}

export function leadingPick(probabilities = {}) {
  const probs = normalizeProb1x2(probabilities);
  const side = OUTCOME_ORDER
    .map((key) => ({ side: key, probability: probs[key] }))
    .sort((a, b) => b.probability - a.probability)[0];

  return {
    side: side.side,
    probability: round(side.probability, 6),
  };
}

export function brierScore1x2(probabilities = {}, actual) {
  const probs = normalizeProb1x2(probabilities);
  const side = normalizeOutcomeSide(actual);
  if (!side) return null;

  const score = OUTCOME_ORDER.reduce((acc, key) => {
    const observed = key === side ? 1 : 0;
    return acc + ((probs[key] - observed) ** 2);
  }, 0);

  return round(score, 6);
}

export function logLoss1x2(probabilities = {}, actual, epsilon = 1e-15) {
  const probs = normalizeProb1x2(probabilities);
  const side = normalizeOutcomeSide(actual);
  if (!side) return null;

  const p = clamp(probs[side], epsilon, 1 - epsilon);
  return round(-Math.log(p), 6);
}

export function rps1x2(probabilities = {}, actual) {
  const probs = normalizeProb1x2(probabilities);
  const side = normalizeOutcomeSide(actual);
  if (!side) return null;

  let cumulativePredicted = 0;
  let cumulativeObserved = 0;
  let score = 0;

  for (let i = 0; i < OUTCOME_ORDER.length - 1; i++) {
    const key = OUTCOME_ORDER[i];
    cumulativePredicted += probs[key];
    cumulativeObserved += key === side ? 1 : 0;
    score += (cumulativePredicted - cumulativeObserved) ** 2;
  }

  return round(score / (OUTCOME_ORDER.length - 1), 6);
}

export function metricsFor1x2(probabilities = {}, actual) {
  const actualSide = normalizeOutcomeSide(actual);
  if (!actualSide) {
    return {
      ok: false,
      reason: 'missing_actual_outcome',
    };
  }

  const probs = normalizeProb1x2(probabilities);
  const pick = leadingPick(probs);

  return {
    ok: true,
    probabilities: probs,
    predictedSide: pick.side,
    predictedProb: pick.probability,
    actualSide,
    isHit: pick.side === actualSide,
    brier: brierScore1x2(probs, actualSide),
    logLoss: logLoss1x2(probs, actualSide),
    rps: rps1x2(probs, actualSide),
  };
}

export function probabilityBucket(probability, bucketSize = 0.1) {
  const p = clamp(numberFrom(probability, 0), 0, 1);
  const size = clamp(numberFrom(bucketSize, 0.1), 0.01, 1);
  const min = Math.floor(p / size) * size;
  const max = Math.min(1, min + size);

  return {
    min: round(min, 6),
    max: round(max, 6),
    key: `${round(min, 2).toFixed(2)}-${round(max, 2).toFixed(2)}`,
  };
}

export function reliabilityCurve(items = [], { bucketSize = 0.1 } = {}) {
  const buckets = new Map();

  for (const item of items) {
    const probability = numberFrom(item.probability ?? item.predictedProb ?? item.predicted_prob);
    const hit = item.hit ?? item.isHit ?? item.is_hit;
    if (!Number.isFinite(probability) || hit === undefined || hit === null) continue;

    const bucket = probabilityBucket(probability, bucketSize);
    if (!buckets.has(bucket.key)) {
      buckets.set(bucket.key, {
        bucket: bucket.key,
        bucketMin: bucket.min,
        bucketMax: bucket.max,
        sampleCount: 0,
        predictedSum: 0,
        actualSum: 0,
      });
    }

    const row = buckets.get(bucket.key);
    row.sampleCount += 1;
    row.predictedSum += probability;
    row.actualSum += Number(Boolean(hit));
  }

  return [...buckets.values()]
    .sort((a, b) => a.bucketMin - b.bucketMin)
    .map((row) => ({
      bucket: row.bucket,
      bucketMin: row.bucketMin,
      bucketMax: row.bucketMax,
      sampleCount: row.sampleCount,
      predictedAvg: round(row.predictedSum / row.sampleCount, 6),
      actualRate: round(row.actualSum / row.sampleCount, 6),
      gap: round((row.actualSum / row.sampleCount) - (row.predictedSum / row.sampleCount), 6),
    }));
}

export function expectedCalibrationError(items = [], { bucketSize = 0.1 } = {}) {
  const curve = reliabilityCurve(items, { bucketSize });
  const total = curve.reduce((acc, row) => acc + row.sampleCount, 0);
  if (total <= 0) return null;

  const weightedGap = curve.reduce(
    (acc, row) => acc + (row.sampleCount / total) * Math.abs(row.actualRate - row.predictedAvg),
    0,
  );

  return round(weightedGap, 6);
}

export function summarizeOutcomeMetrics(outcomes = [], { bucketSize = 0.1 } = {}) {
  // 支持 is_hit / isHit / hit 三种字段名
  const valid = outcomes.filter((row) => {
    if (!row) return false;
    const hitVal = row.is_hit ?? row.isHit ?? row.hit;
    return hitVal !== null && hitVal !== undefined;
  });
  const sampleCount = valid.length;

  if (sampleCount === 0) {
    return {
      sampleCount: 0,
      hitRate: null,
      avgBrier: null,
      avgLogLoss: null,
      avgRps: null,
      ece: null,
      reliability: [],
    };
  }

  const reliabilityItems = valid.map((row) => ({
    probability: row.predicted_prob ?? row.predictedProb ?? row.probability,
    hit: row.hit ?? row.is_hit ?? row.isHit,
  }));

  return {
    sampleCount,
    hitRate: round(
      valid.reduce((acc, row) => acc + Number(Boolean(row.hit ?? row.is_hit ?? row.isHit)), 0) / sampleCount,
      6,
    ),
    avgBrier: averageMetric(valid, 'brier'),
    avgLogLoss: averageMetric(valid, 'log_loss', 'logLoss'),
    avgRps: averageMetric(valid, 'rps'),
    ece: expectedCalibrationError(reliabilityItems, { bucketSize }),
    reliability: reliabilityCurve(reliabilityItems, { bucketSize }),
  };
}

function averageMetric(rows, ...keys) {
  const values = rows
    .map((row) => {
      for (const key of keys) {
        const value = numberFrom(row[key]);
        if (Number.isFinite(value)) return value;
      }
      return null;
    })
    .filter((value) => Number.isFinite(value));

  if (!values.length) return null;
  return round(values.reduce((acc, value) => acc + value, 0) / values.length, 6);
}

function numberFrom(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  const n = numberFrom(value, min);
  return Math.max(min, Math.min(max, n));
}

function round(value, digits = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const base = 10 ** digits;
  return Math.round(n * base) / base;
}

export default {
  normalizeOutcomeSide,
  actualOutcomeFromScore,
  actualOutcome1x2,
  normalizeProb1x2,
  leadingPick,
  brierScore1x2,
  logLoss1x2,
  rps1x2,
  metricsFor1x2,
  probabilityBucket,
  reliabilityCurve,
  expectedCalibrationError,
  summarizeOutcomeMetrics,
};
