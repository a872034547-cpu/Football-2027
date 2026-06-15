/**
 * rule-calibration.js
 * R01-R14 动态规则校准画像：基于真实战绩、ROI proxy、CLV 和盘口过程信号给规则做后验降权/提示。
 *
 * 设计原则：
 * - 只生成校准画像，不直接改变 knowledge-engine 的规则命中。
 * - 小样本只观察，不做正向放大，避免过拟合。
 * - 负向证据可用于降仓/提示，正向证据必须达到可用样本后才增强。
 */

export const R_MR_RULE_ORDER = [
  'R-MR-01', 'R-MR-02', 'R-MR-03', 'R-MR-04', 'R-MR-05', 'R-MR-06', 'R-MR-07',
  'R-MR-08', 'R-MR-09', 'R-MR-10', 'R-MR-11', 'R-MR-12A', 'R-MR-12B', 'R-MR-13', 'R-MR-14'
];

const RULE_META = {
  'R-MR-01': { label: '碾压局：上盘穿盘 + 大球共振', baseStars: 3.5 },
  'R-MR-02': { label: '经济实惠型：上盘 + 小球共振', baseStars: 3 },
  'R-MR-03': { label: '冷门温床型：下盘 + 小球共振', baseStars: 3 },
  'R-MR-04': { label: '亚盘诱上 + 大小球不跟', baseStars: 4 },
  'R-MR-05': { label: '欧亚背离：欧赔深、亚盘浅', baseStars: 4 },
  'R-MR-06': { label: '升盘高水诱惑：上盘不稳', baseStars: 4 },
  'R-MR-07': { label: '大小球低水不升盘：大球过热陷阱', baseStars: 3.5 },
  'R-MR-08': { label: '降盘 + 大球：矛盾型大球', baseStars: 3 },
  'R-MR-09': { label: '一步到位型：强上盘', baseStars: 5 },
  'R-MR-10': { label: '试探洗盘型：上盘可追', baseStars: 3.5 },
  'R-MR-11': { label: '临场暴拉型：高风险', baseStars: 3 },
  'R-MR-12A': { label: '亚盘低水不升盘：真实防范', baseStars: 4 },
  'R-MR-12B': { label: '大小球低水不升盘：真实防范', baseStars: 4 },
  'R-MR-13': { label: '升盘不升水：真阻', baseStars: 3 },
  'R-MR-14': { label: '降盘降水：反诱', baseStars: 2.5 }
};

const SAMPLE_TIERS = [
  { key: 'observe', label: '仅观察', min: 0, max: 9, trust: 0.82 },
  { key: 'weak', label: '弱参考', min: 10, max: 29, trust: 0.92 },
  { key: 'usable', label: '可参考', min: 30, max: 99, trust: 1.0 },
  { key: 'strong', label: '强参考', min: 100, max: Infinity, trust: 1.06 }
];

function emptyRule(ruleId) {
  const meta = RULE_META[ruleId] || { label: ruleId, baseStars: 3 };
  return {
    ruleId,
    label: meta.label,
    baseStars: meta.baseStars,
    total: 0,
    pending: 0,
    push: 0,
    settled: 0,
    hit: 0,
    miss: 0,
    halfWin: 0,
    halfLoss: 0,
    hitScore: 0,
    profitProxy: 0,
    stakeProxy: 0,
    clv: { count: 0, positive: 0, negative: 0, flat: 0, missing: 0, scoreSum: 0, avgScore: null, positiveRate: null },
    timelineSignals: {},
    topRuleCount: 0,
    sampleTier: 'observe',
    sampleTierLabel: '仅观察',
    hitRate: null,
    roiProxy: null,
    dynamicWeight: meta.baseStars,
    weightDelta: 0,
    reliability: 'observe',
    action: 'observe',
    warning: '样本不足，仅记录表现，不放大权重。'
  };
}

function normalizeResult(value) {
  if (value === null || value === undefined || value === '') return 'pending';
  if (value === true) return 'hit';
  if (value === false) return 'miss';
  const text = String(value).trim();
  const lower = text.toLowerCase();
  if (!text || lower === 'pending' || /待|未验证|未結算|未结算/.test(text)) return 'pending';
  if (/^(◐)$/.test(text) || /半赢|半贏|half\s*-?\s*win|halfwin/.test(lower)) return 'halfWin';
  if (/^(◑)$/.test(text) || /半输|半輸|half\s*-?\s*loss|halfloss|half\s*-?\s*lose/.test(lower)) return 'halfLoss';
  if (/^(➖|-|—|=)$/.test(text) || /走盘|走水|走|退款|退回|push|void|refund/.test(lower)) return 'push';
  if (/^(✓|√|✅)$/.test(text) || /命中|全赢|贏|赢|hit|win|success|right|correct/.test(lower)) return 'hit';
  if (/^(✗|×|x|❌)$/.test(text) || /未中|全输|輸|输|miss|loss|lose|wrong|fail/.test(lower)) return 'miss';
  return 'pending';
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[^0-9.+\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function toArray(value) {
  if (Array.isArray(value)) return value.filter(v => v !== undefined && v !== null && v !== '');
  if (value === undefined || value === null || value === '') return [];
  if (typeof value === 'string' && value.includes(',')) return value.split(',').map(x => x.trim()).filter(Boolean);
  return [value];
}

function unique(list) {
  return Array.from(new Set(list));
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function normalizeRuleId(value) {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return '';
  const match = text.match(/R-MR-(?:12A|12B|0?[1-9]|1[0-4])/i);
  if (!match) return '';
  const raw = match[0].toUpperCase();
  if (/R-MR-12A|R-MR-12B/.test(raw)) return raw;
  const n = parseInt(raw.replace('R-MR-', ''), 10);
  return Number.isFinite(n) ? `R-MR-${String(n).padStart(2, '0')}` : raw;
}

function collectRuleIds(record = {}) {
  const raw = record.raw || record;
  const nestedRules = [
    ...toArray(raw.marketCommand?.currentMarketRead?.resonance?.rulesMatched),
    ...toArray(raw.marketCommand?.currentMarketRead?.resonance?.rules),
    ...toArray(raw.marketVerdict?.marketResonance?.rulesMatched),
    ...toArray(raw.ruleDecision?.marketResonance?.rulesMatched),
    ...toArray(raw.resonance?.rulesMatched)
  ].map(x => x?.ruleId || x);

  return unique([
    record.resonanceTopRuleId,
    raw.resonanceTopRuleId,
    raw.resonanceTopRule?.ruleId,
    raw.marketCommand?.currentMarketRead?.topRule?.ruleId,
    raw.marketVerdict?.marketResonance?.topRule?.ruleId,
    raw.ruleDecision?.marketResonance?.topRule?.ruleId,
    ...toArray(record.ruleIds),
    ...toArray(raw.topRuleIds),
    ...toArray(raw.triggeredRuleIds),
    ...toArray(raw.ruleIds),
    ...toArray(raw.candidateRuleIds),
    ...toArray(raw.ruleDecision?.triggeredRuleIds),
    ...nestedRules
  ].map(normalizeRuleId).filter(id => id && RULE_META[id]));
}

function isTopRule(record = {}, ruleId) {
  const raw = record.raw || record;
  const top = normalizeRuleId(pickFirst(
    record.resonanceTopRuleId,
    raw.resonanceTopRuleId,
    raw.resonanceTopRule?.ruleId,
    raw.marketCommand?.currentMarketRead?.topRule?.ruleId,
    raw.marketVerdict?.marketResonance?.topRule?.ruleId,
    raw.ruleDecision?.marketResonance?.topRule?.ruleId
  ));
  return top === ruleId;
}

function getOdds(record = {}) {
  const raw = record.raw || record;
  return num(pickFirst(record.odds, raw.odds, raw.oddsText, raw.price, raw.odd, raw.betOdds));
}

function getClv(record = {}) {
  const raw = record.raw || record;
  const status = pickFirst(record.clv?.status, raw.clvStatus, raw.clv?.status, 'missing');
  const score = num(pickFirst(record.clv?.score, raw.clvScore, raw.clv?.score));
  return {
    status: ['positive', 'negative', 'flat', 'missing'].includes(status) ? status : 'missing',
    score
  };
}

function getTimelineSignal(record = {}) {
  const raw = record.raw || record;
  return pickFirst(
    raw.marketTimelineSignalCode,
    raw.marketTimeline?.movement?.timelineSignal?.code,
    raw.marketCommand?.currentMarketRead?.timelineSignal?.code,
    raw.marketCommand?.marketTimeline?.movement?.timelineSignal?.code,
    raw.marketCommand?.marketTimeline?.timelineSignal?.code
  );
}

function addRecordToRule(rule, record) {
  const result = normalizeResult(pickFirst(record.betResult, record.result, record.outcome, record.status));
  const odds = getOdds(record);
  const clv = getClv(record);
  const timelineSignal = getTimelineSignal(record);

  rule.total += 1;
  if (isTopRule(record, rule.ruleId)) rule.topRuleCount += 1;

  if (timelineSignal) {
    rule.timelineSignals[timelineSignal] = (rule.timelineSignals[timelineSignal] || 0) + 1;
  }

  rule.clv[clv.status] = (rule.clv[clv.status] || 0) + 1;
  if (clv.status !== 'missing') rule.clv.count += 1;
  if (Number.isFinite(clv.score)) rule.clv.scoreSum += clv.score;

  if (result === 'pending') {
    rule.pending += 1;
    return;
  }
  if (result === 'push') {
    rule.push += 1;
    return;
  }

  rule.settled += 1;
  rule.stakeProxy += 1;

  if (result === 'hit') {
    rule.hit += 1;
    rule.hitScore += 1;
    rule.profitProxy += odds ? odds - 1 : 1;
  } else if (result === 'miss') {
    rule.miss += 1;
    rule.profitProxy -= 1;
  } else if (result === 'halfWin') {
    rule.halfWin += 1;
    rule.hitScore += 0.5;
    rule.profitProxy += odds ? (odds - 1) * 0.5 : 0.5;
  } else if (result === 'halfLoss') {
    rule.halfLoss += 1;
    rule.hitScore += 0.5;
    rule.profitProxy -= 0.5;
  }
}

function sampleTier(settled) {
  return SAMPLE_TIERS.find(t => settled >= t.min && settled <= t.max) || SAMPLE_TIERS[0];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finalizeRule(rule) {
  const tier = sampleTier(rule.settled);
  rule.sampleTier = tier.key;
  rule.sampleTierLabel = tier.label;
  rule.hitRate = rule.settled > 0 ? round1(rule.hitScore / rule.settled * 100) : null;
  rule.roiProxy = rule.stakeProxy > 0 ? round1(rule.profitProxy / rule.stakeProxy * 100) : null;
  rule.profitProxy = round2(rule.profitProxy);
  rule.clv.avgScore = rule.clv.count > 0 ? round2(rule.clv.scoreSum / rule.clv.count) : null;
  rule.clv.positiveRate = rule.clv.count > 0 ? round1(rule.clv.positive / rule.clv.count * 100) : null;

  const hitMult = !Number.isFinite(rule.hitRate) ? 1
    : rule.hitRate >= 68 ? 1.14
      : rule.hitRate >= 58 ? 1.07
        : rule.hitRate < 35 ? 0.76
          : rule.hitRate < 45 ? 0.88
            : 1;
  const roiMult = !Number.isFinite(rule.roiProxy) ? 1
    : rule.roiProxy >= 15 ? 1.07
      : rule.roiProxy < -20 ? 0.82
        : rule.roiProxy < -8 ? 0.92
          : 1;
  const clvMult = !Number.isFinite(rule.clv.positiveRate) ? 1
    : rule.clv.positiveRate >= 62 ? 1.07
      : rule.clv.positiveRate < 35 ? 0.88
        : 1;

  let dynamic = rule.baseStars * tier.trust * hitMult * roiMult * clvMult;

  // 小样本保护：observe 阶段不允许正向放大，只允许记录或轻微降权。
  if (tier.key === 'observe') dynamic = Math.min(rule.baseStars, dynamic);

  rule.dynamicWeight = round2(clamp(dynamic, 1.5, 5.5));
  rule.weightDelta = round2(rule.dynamicWeight - rule.baseStars);

  const weakPerformance = rule.settled >= 10 && ((Number.isFinite(rule.hitRate) && rule.hitRate < 42) || (Number.isFinite(rule.roiProxy) && rule.roiProxy < -12));
  const strongPerformance = rule.settled >= 30 && (rule.hitRate || 0) >= 58 && (rule.roiProxy || 0) >= 0 && (!Number.isFinite(rule.clv.positiveRate) || rule.clv.positiveRate >= 48);
  const clvWeak = rule.clv.count >= 5 && Number.isFinite(rule.clv.positiveRate) && rule.clv.positiveRate < 35;

  if (tier.key === 'observe') {
    rule.reliability = 'observe';
    rule.action = 'observe';
    rule.warning = `样本仅${rule.settled}单，处于观察期；不放大 ${rule.ruleId} 权重。`;
  } else if (weakPerformance || clvWeak) {
    rule.reliability = 'weak';
    rule.action = 'downgrade';
    rule.warning = `${rule.ruleId} 后验表现偏弱：有效${rule.settled}单，命中率${fmtPct(rule.hitRate)}，ROI代理${fmtPct(rule.roiProxy)}，CLV+率${fmtPct(rule.clv.positiveRate)}；总控应降仓或增加反证复核。`;
  } else if (strongPerformance) {
    rule.reliability = tier.key === 'strong' ? 'strong' : 'usable';
    rule.action = 'promote';
    rule.warning = `${rule.ruleId} 后验表现较稳：有效${rule.settled}单，命中率${fmtPct(rule.hitRate)}，ROI代理${fmtPct(rule.roiProxy)}；可作为同类盘口优先参考，但仍需临场确认。`;
  } else {
    rule.reliability = tier.key;
    rule.action = 'neutral';
    rule.warning = `${rule.ruleId} 样本进入${tier.label}：有效${rule.settled}单，维持基础权重，继续观察 CLV 与临场反证。`;
  }

  delete rule.hitScore;
  delete rule.stakeProxy;
  delete rule.clv.scoreSum;
  return rule;
}

function fmtPct(value) {
  return Number.isFinite(value) ? `${round1(value)}%` : '-';
}

function makeSummary(rules) {
  const settledRules = rules.filter(r => r.settled > 0);
  const downgraded = settledRules.filter(r => r.action === 'downgrade');
  const promoted = settledRules.filter(r => r.action === 'promote');
  const usable = settledRules.filter(r => ['usable', 'strong'].includes(r.reliability));
  return {
    version: 'rule-calibration-v1',
    generatedAt: new Date().toISOString(),
    ruleCount: rules.length,
    observedRuleCount: settledRules.length,
    downgradedCount: downgraded.length,
    promotedCount: promoted.length,
    usableRuleCount: usable.length,
    topDowngraded: downgraded.slice().sort((a, b) => a.dynamicWeight - b.dynamicWeight).slice(0, 5).map(minifyRule),
    topPromoted: promoted.slice().sort((a, b) => b.dynamicWeight - a.dynamicWeight).slice(0, 5).map(minifyRule),
    plain: downgraded.length
      ? `发现 ${downgraded.length} 条 R01-R14 规则后验偏弱，进入盘口总控时应降仓复核。`
      : promoted.length
        ? `已有 ${promoted.length} 条 R01-R14 规则达到可正向参考样本，但仍需临场反证过滤。`
        : 'R01-R14 动态校准处于样本积累阶段，默认不改变规则命中，只提供权重提示。'
  };
}

function minifyRule(rule) {
  return {
    ruleId: rule.ruleId,
    label: rule.label,
    settled: rule.settled,
    hitRate: rule.hitRate,
    roiProxy: rule.roiProxy,
    clvPositiveRate: rule.clv.positiveRate,
    dynamicWeight: rule.dynamicWeight,
    action: rule.action,
    sampleTier: rule.sampleTier
  };
}

export function buildRuleCalibrationProfile(records = [], options = {}) {
  const includeEmpty = options.includeEmpty !== false;
  const byRuleId = {};
  R_MR_RULE_ORDER.forEach(ruleId => { byRuleId[ruleId] = emptyRule(ruleId); });

  const list = Array.isArray(records) ? records : [];
  list.forEach(record => {
    collectRuleIds(record).forEach(ruleId => {
      if (!byRuleId[ruleId]) byRuleId[ruleId] = emptyRule(ruleId);
      addRecordToRule(byRuleId[ruleId], record);
    });
  });

  let rules = Object.values(byRuleId).map(finalizeRule);
  if (!includeEmpty) rules = rules.filter(r => r.total > 0 || r.settled > 0);

  rules.sort((a, b) => {
    const ai = R_MR_RULE_ORDER.indexOf(a.ruleId);
    const bi = R_MR_RULE_ORDER.indexOf(b.ruleId);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || a.ruleId.localeCompare(b.ruleId);
  });

  const finalByRuleId = {};
  rules.forEach(rule => { finalByRuleId[rule.ruleId] = rule; });

  return {
    version: 'rule-calibration-v1',
    generatedAt: new Date().toISOString(),
    sampleSize: list.length,
    byRuleId: finalByRuleId,
    rules,
    summary: makeSummary(rules)
  };
}

export function getRuleCalibration(profile = null, ruleId = '') {
  const id = normalizeRuleId(ruleId);
  if (!id || !profile) return null;
  return profile.byRuleId?.[id] || (Array.isArray(profile.rules) ? profile.rules.find(r => r.ruleId === id) : null) || null;
}

export function annotateRuleWithCalibration(rule = null, profile = null) {
  if (!rule || !rule.ruleId) return rule;
  const calibration = getRuleCalibration(profile, rule.ruleId);
  if (!calibration) return rule;
  const originalStars = num(rule.stars) || calibration.baseStars || 3;
  const adjustedStars = calibration.action === 'downgrade'
    ? Math.min(originalStars, calibration.dynamicWeight)
    : calibration.action === 'promote'
      ? Math.max(originalStars, calibration.dynamicWeight)
      : originalStars;

  return {
    ...rule,
    stars: round2(clamp(adjustedStars, 1.5, 5.5)),
    baseStars: originalStars,
    calibration: minifyRule(calibration),
    dynamicWeight: calibration.dynamicWeight,
    dynamicWeightDelta: calibration.weightDelta,
    risk: unique([...(Array.isArray(rule.risk) ? rule.risk : []), calibration.action === 'downgrade' ? calibration.warning : '', calibration.sampleTier === 'observe' ? calibration.warning : ''].filter(Boolean))
  };
}

export function formatRuleCalibrationProfileTable(profile = null, limit = 15) {
  if (!profile || !Array.isArray(profile.rules)) return '*暂无 R01-R14 动态校准数据。*';
  const rows = profile.rules.filter(r => r.total > 0 || r.settled > 0).slice(0, limit);
  if (!rows.length) return '*暂无 R01-R14 动态校准数据。*';
  const lines = [];
  lines.push('| 规则 | 样本档 | 有效 | 命中率 | ROI代理 | CLV+率 | 基础星 | 动态权重 | 动作 | 提示 |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---|---|');
  rows.forEach(r => {
    lines.push(`| ${escapeMd(r.ruleId)} | ${escapeMd(r.sampleTierLabel)} | ${r.settled || 0} | ${fmtPct(r.hitRate)} | ${fmtPct(r.roiProxy)} | ${fmtPct(r.clv.positiveRate)} | ${r.baseStars} | ${r.dynamicWeight} | ${escapeMd(actionLabel(r.action))} | ${escapeMd(r.warning)} |`);
  });
  return lines.join('\n');
}

function actionLabel(action) {
  if (action === 'promote') return '增强参考';
  if (action === 'downgrade') return '降权复核';
  if (action === 'neutral') return '维持';
  return '观察';
}

function escapeMd(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export default {
  buildRuleCalibrationProfile,
  getRuleCalibration,
  annotateRuleWithCalibration,
  formatRuleCalibrationProfileTable
};
