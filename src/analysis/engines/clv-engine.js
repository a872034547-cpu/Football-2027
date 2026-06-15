/**
 * CLV（Closing Line Value）引擎：记录推荐时价格、收盘价格，并给出简洁复盘标签。
 * 口径：推荐赔率高于收盘赔率、或推荐盘口比收盘线更有利，视为 CLV+。
 */

const CLV_STATUS_LABELS = {
  positive: 'CLV+ 早于市场',
  negative: 'CLV- 被市场否定',
  flat: 'CLV= 基本持平',
  missing: 'CLV? 缺收盘线'
};

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).replace(/,/g, '.').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function parseDecimalOdds(value) {
  const raw = num(value);
  if (raw === null || raw <= 0) return null;
  if (raw >= 1.01) return raw;
  // 亚盘/大小球水位常见为 0.80/0.95，转为十进制赔率 1.80/1.95。
  return raw + 1;
}

function parseFirstDecimalOdds(text) {
  if (text === null || text === undefined || text === '') return null;
  const matches = String(text).replace(/,/g, '.').match(/\d+(?:\.\d+)?/g) || [];
  for (const raw of matches) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1.01) return n;
  }
  return null;
}

function parseLineValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (!text) return null;

  const cnMap = {
    '受让三球': -3,
    '受让两球半/三球': -2.75,
    '受让两球半': -2.5,
    '受让两球/两球半': -2.25,
    '受让两球': -2,
    '受让球半/两球': -1.75,
    '受让球半': -1.5,
    '受让一球/球半': -1.25,
    '受让一球': -1,
    '受让半球/一球': -0.75,
    '受让半球': -0.5,
    '受让平手/半球': -0.25,
    '平手': 0,
    '平手/半球': 0.25,
    '半球': 0.5,
    '半球/一球': 0.75,
    '一球': 1,
    '一球/球半': 1.25,
    '球半': 1.5,
    '球半/两球': 1.75,
    '两球': 2,
    '两球/两球半': 2.25,
    '两球半': 2.5,
    '两球半/三球': 2.75,
    '三球': 3
  };
  if (cnMap[text] !== undefined) return cnMap[text];

  const cleaned = text.replace(/[－—]/g, '-').replace(/大|小|球|盘口|让/g, '');
  if (cleaned.includes('/')) {
    const parts = cleaned.split('/').map(v => num(v)).filter(v => Number.isFinite(v));
    if (parts.length === 2) return (parts[0] + parts[1]) / 2;
  }
  return num(cleaned);
}

function pickNormalized(input = {}) {
  if (!input || typeof input !== 'object') return {};
  if (input.normalized) return input.normalized || {};
  if (input.derived?.normalized) return input.derived.normalized || {};
  if (input.data?.normalized) return input.data.normalized || {};
  if (input.data?.derived?.normalized) return input.data.derived.normalized || {};
  return input;
}

function detectBetKind(record = {}) {
  const text = `${record.betType || ''} ${record.selection || ''}`.toLowerCase();
  if (/大小|大小球|进球|over|under|大球|小球/.test(text)) return 'overunder';
  if (/亚盘|让球|handicap|受让|平手|半球|一球|球半/.test(text)) return 'asian';
  if (/胜平负|欧赔|1x2|主胜|平局|客胜|胜负/.test(text)) return 'winDrawWin';
  return 'unknown';
}

function detectSelectionSide(record = {}) {
  const text = `${record.selection || ''} ${record.betType || ''}`.toLowerCase();
  if (/大球|\bover\b| over |大\s*\d/.test(text)) return 'over';
  if (/小球|\bunder\b| under |小\s*\d/.test(text)) return 'under';
  if (/平局|和局|\bdraw\b|^x$/.test(text)) return 'draw';
  if (/客胜|客队|\baway\b|负/.test(text)) return 'away';
  if (/主胜|主队|\bhome\b|胜/.test(text)) return 'home';
  return 'unknown';
}

function oddsForSideFromNormalized(normalized = {}, record = {}) {
  const kind = detectBetKind(record);
  const side = detectSelectionSide(record);
  const asian = normalized.asian || {};
  const ou = normalized.overunder || normalized.overUnder || {};
  const odds = normalized.odds || normalized.winDrawWin || {};
  const current = odds.averageCurrent || odds.current || odds.keyCurrent || {};

  if (kind === 'overunder') {
    if (side === 'over') return parseDecimalOdds(firstDefined(ou.overDecimalOdds, ou.currentOverWater, ou.currentOver, ou.currentOverPay));
    if (side === 'under') return parseDecimalOdds(firstDefined(ou.underDecimalOdds, ou.currentUnderWater, ou.currentUnder, ou.currentUnderPay));
  }
  if (kind === 'asian') {
    if (side === 'home') return parseDecimalOdds(firstDefined(asian.homeDecimalOdds, asian.currentHomeWater, asian.currentHome, asian.currentHomePay));
    if (side === 'away') return parseDecimalOdds(firstDefined(asian.awayDecimalOdds, asian.currentAwayWater, asian.currentAway, asian.currentAwayPay));
  }
  if (side === 'home') return parseDecimalOdds(firstDefined(current.win, odds.winOdds, odds.currentWin));
  if (side === 'draw') return parseDecimalOdds(firstDefined(current.draw, odds.drawOdds, odds.currentDraw));
  if (side === 'away') return parseDecimalOdds(firstDefined(current.loss, current.away, odds.lossOdds, odds.currentLoss));
  return null;
}

function lineForRecord(normalized = {}, record = {}) {
  const kind = detectBetKind(record);
  if (kind === 'asian') {
    const asian = normalized.asian || {};
    return {
      line: firstDefined(asian.currentLine, asian.mainLine),
      lineValue: parseLineValue(firstDefined(asian.currentLineValue, asian.currentLine, asian.mainLine))
    };
  }
  if (kind === 'overunder') {
    const ou = normalized.overunder || normalized.overUnder || {};
    return {
      line: firstDefined(ou.currentLine, ou.mainLine),
      lineValue: parseLineValue(firstDefined(ou.currentLineValue, ou.currentLine, ou.mainLine))
    };
  }
  return { line: null, lineValue: null };
}

function buildSnapshot(record = {}, source = {}, mode = 'recommend') {
  const normalized = pickNormalized(source);
  const asian = normalized.asian || {};
  const ou = normalized.overunder || normalized.overUnder || {};
  const odds = normalized.odds || normalized.winDrawWin || {};
  const current = odds.averageCurrent || odds.current || odds.keyCurrent || {};
  const line = lineForRecord(normalized, record);
  const parsedRecordOdds = parseFirstDecimalOdds(firstDefined(record.recommendOdds, record.odds, record.betOdds, record.price));
  const sideOdds = oddsForSideFromNormalized(normalized, record);
  const price = mode === 'recommend'
    ? firstDefined(parsedRecordOdds, sideOdds)
    : firstDefined(sideOdds, parseFirstDecimalOdds(record.closingOdds));

  return {
    capturedAt: new Date().toISOString(),
    mode,
    betType: record.betType || '',
    selection: record.selection || '',
    selectionSide: detectSelectionSide(record),
    betKind: detectBetKind(record),
    line: line.line,
    lineValue: line.lineValue,
    odds: price,
    asianLine: firstDefined(asian.currentLine, asian.mainLine),
    asianLineValue: parseLineValue(firstDefined(asian.currentLineValue, asian.currentLine, asian.mainLine)),
    asianHomeWater: firstDefined(asian.currentHomeWater, asian.homeWater, asian.currentHome),
    asianAwayWater: firstDefined(asian.currentAwayWater, asian.awayWater, asian.currentAway),
    ouLine: firstDefined(ou.currentLine, ou.mainLine),
    ouLineValue: parseLineValue(firstDefined(ou.currentLineValue, ou.currentLine, ou.mainLine)),
    ouOverWater: firstDefined(ou.currentOverWater, ou.currentOver, ou.currentOverPay),
    ouUnderWater: firstDefined(ou.currentUnderWater, ou.currentUnder, ou.currentUnderPay),
    winOdds: firstDefined(current.win, odds.winOdds, odds.currentWin),
    drawOdds: firstDefined(current.draw, odds.drawOdds, odds.currentDraw),
    lossOdds: firstDefined(current.loss, current.away, odds.lossOdds, odds.currentLoss)
  };
}

export function buildRecommendationPriceSnapshot(record = {}, context = {}) {
  return buildSnapshot(record, context, 'recommend');
}

export function buildClosingPriceSnapshot(storedOrData = {}, record = {}) {
  return buildSnapshot(record, storedOrData, 'closing');
}

function calcLineDelta(record = {}, recommend = {}, closing = {}) {
  const recLine = parseLineValue(firstDefined(recommend.lineValue, recommend.line, record.recommendLine));
  const closeLine = parseLineValue(firstDefined(closing.lineValue, closing.line, record.closingLine));
  if (recLine === null || closeLine === null) return null;
  const kind = recommend.betKind || closing.betKind || detectBetKind(record);
  const side = recommend.selectionSide || closing.selectionSide || detectSelectionSide(record);
  if (kind === 'asian') {
    if (side === 'home') return closeLine - recLine;
    if (side === 'away') return recLine - closeLine;
  }
  if (kind === 'overunder') {
    if (side === 'over') return closeLine - recLine;
    if (side === 'under') return recLine - closeLine;
  }
  return null;
}

function impliedProbability(decimalOdds) {
  const o = parseDecimalOdds(decimalOdds);
  return o && o > 1 ? Number((100 / o).toFixed(3)) : null;
}

function calcPriceClv(recOdds, closeOdds) {
  if (recOdds === null || closeOdds === null || closeOdds <= 1) return null;
  return Number(((recOdds / closeOdds - 1) * 100).toFixed(3));
}

export function calculateClv(record = {}) {
  const recommend = record.recommendSnapshot || {};
  const closing = record.closingSnapshot || {};
  const recOdds = parseDecimalOdds(firstDefined(recommend.odds, record.recommendOdds, record.odds));
  const closeOdds = parseDecimalOdds(firstDefined(closing.odds, record.closingOdds));
  const oddsDelta = recOdds !== null && closeOdds !== null ? Number((recOdds - closeOdds).toFixed(4)) : null;
  const lineDelta = calcLineDelta(record, recommend, closing);
  const recommendImpliedProb = impliedProbability(recOdds);
  const closingImpliedProb = impliedProbability(closeOdds);
  const impliedProbDelta = recommendImpliedProb !== null && closingImpliedProb !== null
    ? Number((closingImpliedProb - recommendImpliedProb).toFixed(3))
    : null;
  const priceClv = calcPriceClv(recOdds, closeOdds);
  const lineClv = lineDelta === null ? null : Number(lineDelta.toFixed(4));
  const clvPercent = priceClv !== null || lineClv !== null
    ? Number(((priceClv || 0) + (lineClv || 0) * 4.5).toFixed(3))
    : null;

  if (oddsDelta === null && lineDelta === null) {
    return {
      status: 'missing',
      score: null,
      oddsDelta,
      lineDelta,
      recommendImpliedProb,
      closingImpliedProb,
      impliedProbDelta,
      priceClv,
      lineClv,
      clvPercent,
      method: 'price_implied_probability_plus_line_delta',
      label: CLV_STATUS_LABELS.missing,
      explanation: '缺少推荐价或收盘价，暂不能判断是否跑赢市场。'
    };
  }

  const oddsScore = oddsDelta === null ? 0 : oddsDelta;
  const lineScore = lineDelta === null ? 0 : lineDelta * 0.18;
  const score = Number((oddsScore + lineScore).toFixed(4));
  const status = Math.abs(score) < 0.015 ? 'flat' : score > 0 ? 'positive' : 'negative';
  const parts = [];
  if (oddsDelta !== null) parts.push(`赔率差 ${oddsDelta > 0 ? '+' : ''}${oddsDelta}`);
  if (impliedProbDelta !== null) parts.push(`隐含概率CLV ${impliedProbDelta > 0 ? '+' : ''}${impliedProbDelta}pct`);
  if (priceClv !== null) parts.push(`价格CLV ${priceClv > 0 ? '+' : ''}${priceClv}%`);
  if (lineDelta !== null) parts.push(`盘口优势 ${lineDelta > 0 ? '+' : ''}${Number(lineDelta.toFixed(3))}`);

  return {
    status,
    score,
    oddsDelta,
    lineDelta: lineClv,
    recommendImpliedProb,
    closingImpliedProb,
    impliedProbDelta,
    priceClv,
    lineClv,
    clvPercent,
    method: 'price_implied_probability_plus_line_delta',
    label: CLV_STATUS_LABELS[status],
    explanation: parts.length ? parts.join('；') : CLV_STATUS_LABELS[status]
  };
}

export function clvToLabel(clvOrStatus) {
  const status = typeof clvOrStatus === 'string' ? clvOrStatus : clvOrStatus?.status;
  return CLV_STATUS_LABELS[status] || CLV_STATUS_LABELS.missing;
}

export function enrichRecordWithRecommendationClv(record = {}, context = {}) {
  const recommendSnapshot = buildRecommendationPriceSnapshot(record, context);
  const base = {
    ...record,
    recommendSnapshot,
    recommendOdds: firstDefined(record.recommendOdds, recommendSnapshot.odds, record.odds),
    recommendLine: firstDefined(record.recommendLine, recommendSnapshot.line)
  };
  const clv = calculateClv(base);
  return {
    ...base,
    clv,
    clvScore: clv.score,
    clvStatus: clv.status,
    clvLabel: clv.label
  };
}

export function enrichRecordWithClosingClv(record = {}, storedOrData = {}) {
  const closingSnapshot = buildClosingPriceSnapshot(storedOrData, record);
  const base = {
    ...record,
    closingSnapshot,
    closingOdds: firstDefined(record.closingOdds, closingSnapshot.odds),
    closingLine: firstDefined(record.closingLine, closingSnapshot.line)
  };
  const clv = calculateClv(base);
  return {
    ...base,
    clv,
    clvScore: clv.score,
    clvStatus: clv.status,
    clvLabel: clv.label
  };
}

export default {
  buildRecommendationPriceSnapshot,
  buildClosingPriceSnapshot,
  calculateClv,
  clvToLabel,
  enrichRecordWithRecommendationClv,
  enrichRecordWithClosingClv
};
