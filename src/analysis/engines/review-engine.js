/**
 * 战绩复盘统计引擎：聚合投注记录命中率、风险分层和改进提醒。
 */

import { calculateClv, clvToLabel } from './clv-engine.js';
import { buildRuleCalibrationProfile, formatRuleCalibrationProfileTable } from './rule-calibration.js';

const RISK_LEVEL_LABELS = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
  extreme: '极高风险',
  unknown: '未知风险'
};

const ODDS_BAND_LABELS = {
  low: '低赔(<1.60)',
  mid: '中赔(1.60-2.20)',
  high: '高赔(2.20-4.00)',
  longshot: '长赔(>=4.00)',
  unknown: '赔率未标注'
};

const RISK_LEVEL_ORDER = ['low', 'medium', 'high', 'extreme', 'unknown'];
const ODDS_BAND_ORDER = ['low', 'mid', 'high', 'longshot', 'unknown'];
const COMPLETENESS_BAND_ORDER = ['high', 'mid', 'low', 'unknown'];
const CONFIDENCE_BAND_ORDER = ['80+', '70-79', '60-69', '50-59', '<50', 'unknown'];
const CLV_STATUS_ORDER = ['positive', 'negative', 'flat', 'missing'];
const VALUE_ADMISSION_ORDER = ['high', 'medium_high', 'medium_high_watch', 'blocked', 'watch', 'missing'];
const VALUE_ADMISSION_LABELS = {
  high: '高价值准入',
  medium_high: '中高价值准入',
  medium_high_watch: '中高价值待确认',
  blocked: '准入阻断',
  watch: '准入观察',
  missing: '准入未记录'
};

/**
 * 解析赔率文本中的第一个十进制赔率，并映射到赔率区间。
 * @param {string|number} oddsText
 * @returns {{band: string, label: string, odds: number|null}}
 */
export function classifyOddsBand(oddsText) {
  if (oddsText === null || oddsText === undefined || oddsText === '') {
    return { band: 'unknown', label: ODDS_BAND_LABELS.unknown, odds: null };
  }

  const text = String(oddsText).replace(/,/g, '.');
  const matches = text.match(/\d+(?:\.\d+)?/g) || [];
  let odds = null;

  for (const raw of matches) {
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n >= 1.01) {
      odds = n;
      break;
    }
  }

  if (odds === null) return { band: 'unknown', label: ODDS_BAND_LABELS.unknown, odds: null };
  if (odds < 1.6) return { band: 'low', label: ODDS_BAND_LABELS.low, odds };
  if (odds < 2.2) return { band: 'mid', label: ODDS_BAND_LABELS.mid, odds };
  if (odds < 4) return { band: 'high', label: ODDS_BAND_LABELS.high, odds };
  return { band: 'longshot', label: ODDS_BAND_LABELS.longshot, odds };
}

/**
 * 汇总战绩记录。
 * @param {Array<object>} records
 * @returns {object}
 */
export function summarizeBetRecords(records = []) {
  const list = Array.isArray(records) ? records : [];
  const stats = createCounter('全部记录');

  stats.byRiskLevel = {};
  stats.byRiskBucket = {};
  stats.byBetType = {};
  stats.byValueLevel = {};
  stats.byOddsBand = {};
  stats.byRuleId = {};
  stats.byCandidateLabel = {};
  stats.byCompletenessBand = {};
  stats.byConfidenceBand = {};
  stats.byRiskTag = {};
  stats.byErrorTag = {};
  stats.byScreeningBucket = {};
  stats.byMarketScenario = {};
  stats.byCounterEvidenceVerdict = {};
  stats.byMarketCommandStake = {};
  stats.byResonanceTopRule = {};
  stats.byClvStatus = {};
  stats.byValueAdmission = {};
  stats.byValueAdmissionClvStatus = {};
  stats.clv = createClvStats();
  stats.ruleCalibrationProfile = null;

  const normalizedList = [];
  list.forEach((record, index) => {
    const normalized = normalizeRecord(record, index);
    normalizedList.push(normalized);
    addRecord(stats, normalized);
    addGroupRecord(stats.byRiskLevel, normalized.riskLevel, RISK_LEVEL_LABELS[normalized.riskLevel] || normalized.riskLevel, normalized);
    addGroupRecord(stats.byRiskBucket, normalized.riskBucket, normalized.riskBucketLabel, normalized);
    addGroupRecord(stats.byBetType, normalized.betType, normalized.betType, normalized);
    addGroupRecord(stats.byValueLevel, normalized.valueLevel, normalized.valueLevel, normalized);
    addGroupRecord(stats.byOddsBand, normalized.oddsBand.band, normalized.oddsBand.label, normalized);
    addGroupRecord(stats.byCompletenessBand, normalized.completenessBand.key, normalized.completenessBand.label, normalized);
    addGroupRecord(stats.byConfidenceBand, normalized.confidenceBand.key, normalized.confidenceBand.label, normalized);
    addGroupRecord(stats.byScreeningBucket, normalized.screeningBucket, normalized.screeningLabel, normalized);
    addGroupRecord(stats.byMarketScenario, normalized.marketScenario.code, normalized.marketScenario.label, normalized);
    addGroupRecord(stats.byCounterEvidenceVerdict, normalized.counterEvidenceVerdict.key, normalized.counterEvidenceVerdict.label, normalized);
    addGroupRecord(stats.byMarketCommandStake, normalized.marketCommandStake.key, normalized.marketCommandStake.label, normalized);
    if (normalized.resonanceTopRuleId) addGroupRecord(stats.byResonanceTopRule, normalized.resonanceTopRuleId, normalized.resonanceTopRuleId, normalized);
    addGroupRecord(stats.byClvStatus, normalized.clv.status, normalized.clv.label, normalized);
    addGroupRecord(stats.byValueAdmission, normalized.valueAdmission.key, normalized.valueAdmission.label, normalized);
    addGroupRecord(stats.byValueAdmissionClvStatus, `${normalized.valueAdmission.key}:${normalized.clv.status}`, `${normalized.valueAdmission.label} / ${normalized.clv.label}`, normalized);
    addClvStats(stats.clv, normalized.clv);
    normalized.ruleIds.forEach(ruleId => addGroupRecord(stats.byRuleId, ruleId, ruleId, normalized));
    if (normalized.candidateLabel) addGroupRecord(stats.byCandidateLabel, normalized.candidateLabel, normalized.candidateLabel, normalized);
    normalized.riskTags.forEach(tag => addGroupRecord(stats.byRiskTag, tag, tag, normalized));
    normalized.errorTags.forEach(tag => addGroupRecord(stats.byErrorTag, tag, tag, normalized));
  });

  finalizeCounter(stats);
  finalizeGroups(stats.byRiskLevel, RISK_LEVEL_ORDER);
  finalizeGroups(stats.byRiskBucket);
  finalizeGroups(stats.byBetType);
  finalizeGroups(stats.byValueLevel);
  finalizeGroups(stats.byOddsBand, ODDS_BAND_ORDER);
  finalizeGroups(stats.byRuleId);
  finalizeGroups(stats.byCandidateLabel);
  finalizeGroups(stats.byCompletenessBand, COMPLETENESS_BAND_ORDER);
  finalizeGroups(stats.byConfidenceBand, CONFIDENCE_BAND_ORDER);
  finalizeGroups(stats.byRiskTag);
  finalizeGroups(stats.byErrorTag);
  finalizeGroups(stats.byScreeningBucket);
  finalizeGroups(stats.byMarketScenario);
  finalizeGroups(stats.byCounterEvidenceVerdict, ['keep', 'downgrade', 'overturn', 'unknown']);
  finalizeGroups(stats.byMarketCommandStake);
  finalizeGroups(stats.byResonanceTopRule);
  finalizeGroups(stats.byClvStatus, CLV_STATUS_ORDER);
  finalizeGroups(stats.byValueAdmission, VALUE_ADMISSION_ORDER);
  finalizeGroups(stats.byValueAdmissionClvStatus, VALUE_ADMISSION_ORDER.flatMap(level => CLV_STATUS_ORDER.map(status => `${level}:${status}`)));
  finalizeClvStats(stats.clv);

  stats.calibration = buildCalibrationStats(normalizedList);
  stats.ruleCalibrationProfile = buildRuleCalibrationProfile(normalizedList, { includeEmpty: true });
  stats.topWarnings = buildTopWarnings(stats, normalizedList);
  return stats;
}

/**
 * 将复盘统计结果输出为中文 Markdown。
 * @param {object} stats
 * @returns {string}
 */
export function reviewStatsToMarkdown(stats) {
  const s = stats && typeof stats === 'object' ? stats : summarizeBetRecords([]);
  const lines = [];

  lines.push('# 战绩复盘统计');
  lines.push('');
  lines.push('## 一、总览');
  lines.push('| 指标 | 数值 |');
  lines.push('|---|---:|');
  lines.push(`| 总推荐 | ${num(s.total)} |`);
  lines.push(`| 待验证 | ${num(s.pending)} |`);
  lines.push(`| 有效验证 | ${num(s.settled)} |`);
  lines.push(`| 命中 / 半赢 / 半输 / 未中 / 走盘 | ${num(s.hit)} / ${num(s.halfWin)} / ${num(s.halfLoss)} / ${num(s.miss)} / ${num(s.push)} |`);
  lines.push(`| 命中率 | ${formatPercent(s.hitRate)} |`);
  lines.push(`| ROI代理 | ${formatPercent(s.roiProxy)} |`);
  lines.push(`| 平均置信 | ${formatPercent(s.avgConfidence)} |`);
  lines.push(`| Brier校准分 | ${Number.isFinite(s.brierScore) ? round3(s.brierScore) : '-'} |`);
  lines.push('');
  lines.push('> 口径：✓=1，◐=0.5，◑=0.5，✗=0；➖走盘不计入有效验证。ROI代理按等额本金估算，优先使用记录中的十进制赔率。Brier 分数越低代表概率校准越好。');
  lines.push('');

  lines.push('## 二、风险分层');
  lines.push('### 风险等级');
  lines.push(groupTable(s.byRiskLevel, RISK_LEVEL_ORDER));
  lines.push('');
  lines.push('### 风险桶');
  lines.push(groupTable(s.byRiskBucket));
  lines.push('');

  lines.push('## 三、盘口类型');
  lines.push(groupTable(s.byBetType));
  lines.push('');

  lines.push('## 四、赔率区间');
  lines.push(groupTable(s.byOddsBand, ODDS_BAND_ORDER));
  lines.push('');

  lines.push('## 五、价值评级');
  lines.push(groupTable(s.byValueLevel));
  lines.push('');

  lines.push('## 六、v3.6 规则与校准分层');
  lines.push('### 规则ID命中率');
  lines.push(groupTable(s.byRuleId));
  lines.push('');
  lines.push('### 候选结论');
  lines.push(groupTable(s.byCandidateLabel));
  lines.push('');
  lines.push('### 数据完整度分层');
  lines.push(groupTable(s.byCompletenessBand, COMPLETENESS_BAND_ORDER));
  lines.push('');
  lines.push('### 置信度分层');
  lines.push(groupTable(s.byConfidenceBand, CONFIDENCE_BAND_ORDER));
  lines.push('');
  if (s.calibration) {
    lines.push('### 校准摘要');
    lines.push(`- 样本：${num(s.calibration.count)}；平均预测概率：${formatPercent(s.calibration.avgPredicted)}；实际命中等效：${formatPercent(s.calibration.actualRate)}；Brier：${Number.isFinite(s.calibration.brierScore) ? round3(s.calibration.brierScore) : '-'}`);
    lines.push(`- CLV：已统计 ${num(s.clv?.count)} 单；CLV+ ${num(s.clv?.positive)} 单；CLV- ${num(s.clv?.negative)} 单；持平 ${num(s.clv?.flat)} 单；缺收盘线 ${num(s.clv?.missing)} 单；CLV+率 ${formatPercent(s.clv?.positiveRate)}；平均分 ${Number.isFinite(s.clv?.avgScore) ? round3(s.clv.avgScore) : '-'}`);
    lines.push('');
  }

  lines.push('## 七、盘口总控 v4 复盘');
  lines.push('### 盘口剧本命中率');
  lines.push(groupTable(s.byMarketScenario));
  lines.push('');
  lines.push('### 反证审判命中率');
  lines.push(groupTable(s.byCounterEvidenceVerdict, ['keep', 'downgrade', 'overturn', 'unknown']));
  lines.push('');
  lines.push('### 总控仓位执行效果');
  lines.push(groupTable(s.byMarketCommandStake));
  lines.push('');
  lines.push('### R01-R14主规则复盘');
  lines.push(groupTable(s.byResonanceTopRule));
  lines.push('');
  lines.push('### R01-R14动态规则权重');
  if (s.ruleCalibrationProfile?.summary?.plain) lines.push(`- ${s.ruleCalibrationProfile.summary.plain}`);
  lines.push(formatRuleCalibrationProfileTable(s.ruleCalibrationProfile));
  lines.push('');
  lines.push('### CLV收盘线复盘');
  lines.push(groupTable(s.byClvStatus, CLV_STATUS_ORDER));
  lines.push('');
  lines.push('### 中高价值准入命中率');
  lines.push(groupTable(s.byValueAdmission, VALUE_ADMISSION_ORDER));
  lines.push('');
  lines.push('### 准入等级 × CLV 交叉复盘');
  lines.push(groupTable(s.byValueAdmissionClvStatus, VALUE_ADMISSION_ORDER.flatMap(level => CLV_STATUS_ORDER.map(status => `${level}:${status}`))));
  lines.push('');

  lines.push('## 八、风险标签与错误标签');
  lines.push('### 风险标签');
  lines.push(groupTable(s.byRiskTag));
  lines.push('');
  lines.push('### 错误/弱分析标签');
  lines.push(groupTable(s.byErrorTag));
  lines.push('');

  lines.push('## 九、改进提醒');
  const warnings = Array.isArray(s.topWarnings) ? s.topWarnings : [];
  if (warnings.length) {
    warnings.forEach(w => lines.push(`- ${w}`));
  } else {
    lines.push('- 暂无明显分层风险，建议继续积累样本并记录赔率、风险等级、盘口类型等字段。');
  }

  return lines.join('\n');
}

function normalizeRecord(record, index) {
  const r = record && typeof record === 'object' ? record : {};
  const betResult = normalizeBetResult(pickFirst(r.betResult, r.result, r.outcome, r.status));
  const oddsText = pickFirst(r.odds, r.oddsText, r.price, r.odd, r.oddsRange, r.betOdds);
  const oddsBand = classifyOddsBand(oddsText);
  const risk = normalizeRisk(r);

  const confidence = normalizePercent(pickFirst(
    r.knowledgeConfidence,
    r.confidence,
    r.confidenceScore,
    r.confidenceBreakdown?.final,
    r.ruleDecision?.confidenceBreakdown?.final
  ));
  const dataCompletenessScore = normalizePercent(pickFirst(
    r.dataCompletenessScore,
    r.dataCompleteness?.score,
    r.ruleDecision?.dataCompleteness?.score
  ));
  const resonanceTopRuleId = normalizeText(pickFirst(
    r.resonanceTopRuleId,
    r.resonanceTopRule?.ruleId,
    r.marketCommand?.currentMarketRead?.topRule?.ruleId,
    r.marketVerdict?.marketResonance?.topRule?.ruleId,
    r.ruleDecision?.marketResonance?.topRule?.ruleId
  ), '');
  const ruleIds = unique([
    resonanceTopRuleId,
    ...toArray(r.topRuleIds),
    ...toArray(r.triggeredRuleIds),
    ...toArray(r.ruleIds),
    ...toArray(r.candidateRuleIds),
    ...toArray(r.ruleDecision?.triggeredRuleIds)
  ].map(String).filter(Boolean)).slice(0, 20);
  const riskTags = unique(toArray(r.riskTags).map(String).filter(Boolean)).slice(0, 20);
  const errorTags = unique([
    ...toArray(r.unanalysableFlags),
    ...toArray(r.errorTags),
    ...toArray(r.whyNotTop2),
    ...toArray(r.missingFields).map(x => `缺失:${x}`)
  ].map(String).filter(Boolean)).slice(0, 20);
  const candidateLabel = normalizeText(pickFirst(r.candidateLabel, r.topCandidateLabel, r.ruleDecision?.topCandidateLabel), '');
  const screeningLabel = normalizeText(pickFirst(r.screeningLabel, r.screening?.label, r.screeningBucket), '未标注');
  const screeningBucket = normalizeText(pickFirst(r.screeningBucket, r.screening?.bucket, screeningLabel), '未标注');
  const scenarioCode = normalizeText(pickFirst(
    r.primaryScenarioCode,
    r.primaryScenario?.code,
    r.marketCommand?.primaryScenario?.code
  ), 'unknown');
  const scenarioLabel = normalizeText(pickFirst(
    r.primaryScenarioLabel,
    r.primaryScenario?.label,
    r.marketCommand?.primaryScenario?.label
  ), scenarioCode === 'unknown' ? '盘口剧本未记录' : scenarioCode);
  const counterVerdict = normalizeText(pickFirst(
    r.counterEvidenceVerdict,
    r.marketCommand?.counterEvidenceTrial?.verdict
  ), 'unknown');
  const counterLabel = normalizeText(pickFirst(
    r.counterEvidenceLabel,
    r.marketCommand?.counterEvidenceTrial?.label
  ), counterVerdict === 'keep' ? '保留盘口裁决' : counterVerdict === 'downgrade' ? '降仓执行' : counterVerdict === 'overturn' ? '推翻或观望' : '反证未记录');
  const commandStakeText = normalizeText(pickFirst(
    r.marketCommandStake,
    r.executionCommand?.stake,
    r.marketCommand?.executionCommand?.stake,
    r.position
  ), '仓位未记录');
  const clv = normalizeClv(r);
  const valueAdmission = normalizeValueAdmission(r);

  return {
    raw: r,
    index,
    id: pickFirst(r.id, r.recordId, r.matchId, `record_${index}`),
    betResult,
    odds: oddsBand.odds,
    oddsBand,
    riskLevel: risk.level,
    riskBucket: risk.bucket,
    riskBucketLabel: risk.bucketLabel,
    betType: normalizeText(pickFirst(r.betType, r.type, r.market, r.playType, r.handicapType, r.category), '未标注盘口'),
    valueLevel: normalizeText(pickFirst(r.valueLevel, r.valueText, r.valueRating, r.rating, r.recommendationLevel), '未标注价值'),
    ruleIds,
    candidateLabel,
    confidence,
    confidenceBand: classifyConfidenceBand(confidence),
    dataCompletenessScore,
    completenessBand: classifyCompletenessBand(dataCompletenessScore),
    riskTags,
    errorTags,
    screeningBucket,
    screeningLabel,
    marketScenario: { code: scenarioCode, label: scenarioLabel },
    counterEvidenceVerdict: { key: counterVerdict, label: counterLabel },
    marketCommandStake: { key: normalizeBucketKey(commandStakeText), label: commandStakeText },
    resonanceTopRuleId,
    clv,
    valueAdmission,
    timeKey: getRecordTime(r)
  };
}

function normalizeBetResult(value) {
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

function normalizeRisk(record) {
  const rawLevel = pickFirst(record.riskLevel, record.riskLabel, record.riskScore, record.riskBucket, record.riskBucketLabel);
  const rawBucket = pickFirst(record.riskBucket, record.riskBucketLabel);
  const level = classifyRiskLevel(rawLevel);
  const hasAnyRisk = rawLevel !== undefined && rawLevel !== null && rawLevel !== '';
  const bucketLabel = hasAnyRisk ? normalizeText(rawBucket !== undefined ? rawBucket : rawLevel, '未标注') : '未标注';
  const bucket = hasAnyRisk ? normalizeBucketKey(bucketLabel) : '未标注';

  return { level, bucket, bucketLabel };
}

function classifyRiskLevel(value) {
  if (value === null || value === undefined || value === '') return 'unknown';

  if (typeof value === 'number' && Number.isFinite(value)) {
    const score = value > 1 ? value / 100 : value;
    if (score >= 0.78) return 'extreme';
    if (score >= 0.58) return 'high';
    if (score >= 0.35) return 'medium';
    if (score >= 0) return 'low';
  }

  const text = String(value).trim().toLowerCase();
  const numeric = parseFloat(text.replace('%', ''));
  if (Number.isFinite(numeric) && /^\d+(?:\.\d+)?%?$/.test(text)) {
    const score = text.includes('%') || numeric > 1 ? numeric / 100 : numeric;
    return classifyRiskLevel(score);
  }

  if (/extreme|very\s*high|极高|極高|严重|嚴重/.test(text)) return 'extreme';
  if (/high|高|危险|危險|激进|激進|爆冷|冷门|冷門|回避|观望|觀望|慎入/.test(text)) return 'high';
  if (/medium|middle|mid|中|一般|谨慎|謹慎|适中|適中/.test(text)) return 'medium';
  if (/low|低|稳|穩|安全|保守|可控/.test(text)) return 'low';
  return 'unknown';
}

function normalizeValueAdmission(record = {}) {
  const admission = record.valueAdmission
    || record.professionalMarket?.valueAdmission
    || record.aiResult?.professionalMarket?.valueAdmission
    || record.localPrediction?.professionalMarket?.valueAdmission
    || {};
  const allowHigh = boolish(record.valueAllowHigh) || boolish(admission.allowHigh);
  const allowMediumHigh = boolish(record.valueAllowMediumHigh) || boolish(admission.allowMediumHigh) || allowHigh;
  const allowMediumHighWatch = boolish(record.valueAllowMediumHighWatch) || boolish(record.valueNearMissMediumHigh) || boolish(admission.allowMediumHighWatch) || boolish(admission.nearMissMediumHigh);
  const rawLevel = normalizeText(pickFirst(record.valueAdmissionLevel, admission.level), 'missing');
  const normalizedLevel = rawLevel === 'medium-high' ? 'medium_high'
    : rawLevel === 'medium-high-watch' ? 'medium_high_watch'
    : rawLevel === 'none' ? 'missing'
    : rawLevel;
  const key = allowHigh ? 'high'
    : allowMediumHigh ? 'medium_high'
    : allowMediumHighWatch ? 'medium_high_watch'
    : VALUE_ADMISSION_ORDER.includes(normalizedLevel) ? normalizedLevel
    : 'missing';
  const label = VALUE_ADMISSION_LABELS[key] || VALUE_ADMISSION_LABELS.missing;
  return {
    key,
    label,
    level: rawLevel,
    allowMediumHigh,
    allowMediumHighWatch,
    allowHigh,
    evidenceCount: toArray(admission.evidence).length,
    missingCount: toArray(admission.missing).length,
    softMissingCount: toArray(pickFirst(record.valueSoftMissing, admission.softMissing)).length,
    promotionHintCount: toArray(pickFirst(record.valuePromotionHints, admission.promotionHints)).length,
    blockerCount: toArray(admission.blockers).length,
    plain: normalizeText(admission.plain, '')
  };
}

function normalizeClv(record = {}) {
  const calculated = calculateClv(record);
  const rawStatus = normalizeText(pickFirst(record.clvStatus, record.clv?.status, calculated.status), 'missing');
  const status = CLV_STATUS_ORDER.includes(rawStatus) ? rawStatus : 'missing';
  const scoreRaw = pickFirst(record.clvScore, record.clv?.score, calculated.score);
  const oddsDeltaRaw = pickFirst(record.clv?.oddsDelta, calculated.oddsDelta);
  const lineDeltaRaw = pickFirst(record.clv?.lineDelta, calculated.lineDelta);
  return {
    status,
    score: Number.isFinite(Number(scoreRaw)) ? Number(scoreRaw) : null,
    oddsDelta: Number.isFinite(Number(oddsDeltaRaw)) ? Number(oddsDeltaRaw) : null,
    lineDelta: Number.isFinite(Number(lineDeltaRaw)) ? Number(lineDeltaRaw) : null,
    label: normalizeText(pickFirst(record.clvLabel, record.clv?.label, clvToLabel(status)), clvToLabel(status)),
    explanation: normalizeText(pickFirst(record.clv?.explanation, calculated.explanation), '')
  };
}

function createClvStats() {
  return {
    count: 0,
    positive: 0,
    negative: 0,
    flat: 0,
    missing: 0,
    scoreSum: 0,
    avgScore: null,
    positiveRate: null
  };
}

function addClvStats(stats, clv) {
  const status = clv?.status || 'missing';
  if (stats[status] === undefined) stats[status] = 0;
  stats[status] += 1;
  if (status !== 'missing') stats.count += 1;
  if (Number.isFinite(clv?.score)) stats.scoreSum += clv.score;
}

function finalizeClvStats(stats) {
  stats.avgScore = stats.count > 0 ? round3(stats.scoreSum / stats.count) : null;
  stats.positiveRate = stats.count > 0 ? round1(stats.positive / stats.count * 100) : null;
  delete stats.scoreSum;
}

function createCounter(label) {
  return {
    label,
    total: 0,
    pending: 0,
    settled: 0,
    hit: 0,
    miss: 0,
    halfWin: 0,
    halfLoss: 0,
    push: 0,
    hitScore: 0,
    profitProxy: 0,
    stakeProxy: 0,
    hitRate: null,
    roiProxy: null,
    confidenceSum: 0,
    confidenceCount: 0,
    brierSum: 0,
    brierCount: 0,
    avgConfidence: null,
    brierScore: null
  };
}

function addRecord(counter, record) {
  counter.total += 1;

  if (record.betResult === 'pending') {
    counter.pending += 1;
    return;
  }

  if (record.betResult === 'push') {
    counter.push += 1;
    return;
  }

  counter.settled += 1;
  counter.stakeProxy += 1;

  if (Number.isFinite(record.confidence)) {
    counter.confidenceSum += record.confidence;
    counter.confidenceCount += 1;
    const y = record.betResult === 'hit' ? 1 : record.betResult === 'miss' ? 0 : (record.betResult === 'halfWin' || record.betResult === 'halfLoss') ? 0.5 : null;
    if (y !== null) {
      const p = Math.max(0, Math.min(1, record.confidence / 100));
      counter.brierSum += Math.pow(p - y, 2);
      counter.brierCount += 1;
    }
  }

  if (record.betResult === 'hit') {
    counter.hit += 1;
    counter.hitScore += 1;
    counter.profitProxy += record.odds ? record.odds - 1 : 1;
  } else if (record.betResult === 'miss') {
    counter.miss += 1;
    counter.profitProxy -= 1;
  } else if (record.betResult === 'halfWin') {
    counter.halfWin += 1;
    counter.hitScore += 0.5;
    counter.profitProxy += record.odds ? (record.odds - 1) * 0.5 : 0.5;
  } else if (record.betResult === 'halfLoss') {
    counter.halfLoss += 1;
    counter.hitScore += 0.5;
    counter.profitProxy -= 0.5;
  }
}

function addGroupRecord(groups, key, label, record) {
  const groupKey = normalizeText(key, '未标注');
  if (!groups[groupKey]) groups[groupKey] = createCounter(label || groupKey);
  addRecord(groups[groupKey], record);
}

function finalizeGroups(groups, order = []) {
  Object.keys(groups).forEach(key => finalizeCounter(groups[key]));

  if (!order.length) return groups;

  const ordered = {};
  order.forEach(key => {
    if (groups[key]) ordered[key] = groups[key];
  });
  Object.keys(groups).forEach(key => {
    if (!ordered[key]) ordered[key] = groups[key];
  });

  Object.keys(groups).forEach(key => delete groups[key]);
  Object.assign(groups, ordered);
  return groups;
}

function finalizeCounter(counter) {
  counter.hitRate = counter.settled > 0 ? round1(counter.hitScore / counter.settled * 100) : null;
  counter.roiProxy = counter.stakeProxy > 0 ? round1(counter.profitProxy / counter.stakeProxy * 100) : null;
  counter.avgConfidence = counter.confidenceCount > 0 ? round1(counter.confidenceSum / counter.confidenceCount) : null;
  counter.brierScore = counter.brierCount > 0 ? round3(counter.brierSum / counter.brierCount) : null;
  counter.profitProxy = round2(counter.profitProxy);
  delete counter.hitScore;
  delete counter.stakeProxy;
  delete counter.confidenceSum;
  delete counter.confidenceCount;
  delete counter.brierSum;
  delete counter.brierCount;
  return counter;
}

function buildTopWarnings(stats, records) {
  const warnings = [];
  const highRisk = stats.byRiskLevel?.high;
  const longshot = stats.byOddsBand?.longshot;
  const highOdds = stats.byOddsBand?.high;

  if (highRisk && highRisk.settled >= 3) {
    const missRate = 100 - (highRisk.hitRate || 0);
    if (missRate >= 60) {
      warnings.push(`高风险样本未中率偏高：有效${highRisk.settled}单，命中率${formatPercent(highRisk.hitRate)}，建议高风险方向降仓或只保留强信号。`);
    }
  }

  if (longshot && longshot.settled >= 2 && (longshot.hitRate || 0) < 25) {
    warnings.push(`长赔区间命中率较低：有效${longshot.settled}单，命中率${formatPercent(longshot.hitRate)}，建议减少长赔单关或改为小仓试错。`);
  }

  if (highOdds && highOdds.settled >= 3 && (highOdds.hitRate || 0) < 35) {
    warnings.push(`高赔区间表现偏弱：有效${highOdds.settled}单，命中率${formatPercent(highOdds.hitRate)}，需要复盘赔率抬升是否对应真实风险。`);
  }

  Object.keys(stats.byBetType || {}).forEach(type => {
    const group = stats.byBetType[type];
    if (group.settled >= 3 && (group.hitRate || 0) < 35) {
      warnings.push(`${group.label || type} 盘口命中率偏低：有效${group.settled}单，命中率${formatPercent(group.hitRate)}，建议复核该盘口筛选条件。`);
    }
  });

  Object.keys(stats.byRuleId || {}).forEach(ruleId => {
    const group = stats.byRuleId[ruleId];
    if (group.settled >= 3 && (group.hitRate || 0) < 35) {
      warnings.push(`规则 ${ruleId} 近期表现偏弱：有效${group.settled}单，命中率${formatPercent(group.hitRate)}，建议降低该规则权重或增加触发前置条件。`);
    }
  });

  Object.keys(stats.byCompletenessBand || {}).forEach(key => {
    const group = stats.byCompletenessBand[key];
    if (key === 'low' && group.settled >= 3 && (group.hitRate || 0) < 45) {
      warnings.push(`低完整度样本命中率偏低：有效${group.settled}单，命中率${formatPercent(group.hitRate)}，建议缺字段时只提示风险并降低仓位。`);
    }
  });

  Object.keys(stats.byMarketScenario || {}).forEach(key => {
    const group = stats.byMarketScenario[key];
    if (key !== 'unknown' && group.settled >= 3 && (group.hitRate || 0) < 40) {
      warnings.push(`盘口剧本「${group.label || key}」命中率偏低：有效${group.settled}单，命中率${formatPercent(group.hitRate)}，建议复盘该剧本触发条件与临场反证。`);
    }
  });

  Object.keys(stats.byResonanceTopRule || {}).forEach(ruleId => {
    const group = stats.byResonanceTopRule[ruleId];
    if (group.settled >= 3 && (group.hitRate || 0) < 35) {
      warnings.push(`R01-R14主规则 ${ruleId} 在总控复盘中表现偏弱：有效${group.settled}单，命中率${formatPercent(group.hitRate)}，建议检查该规则是否被盘口剧本误用。`);
    }
  });

  const highAdmission = stats.byValueAdmission?.high;
  const mediumHighAdmission = stats.byValueAdmission?.medium_high;
  const blockedAdmission = stats.byValueAdmission?.blocked;
  const watchAdmission = stats.byValueAdmission?.watch;
  [highAdmission, mediumHighAdmission].filter(Boolean).forEach(group => {
    if (group.settled >= 3 && (group.hitRate || 0) < 45) {
      warnings.push(`${group.label} 后验命中率不足：有效${group.settled}单，命中率${formatPercent(group.hitRate)}，应复核 valueAdmission 准入阈值或降低该档仓位。`);
    }
  });
  if ((blockedAdmission?.total || 0) > 0 || (watchAdmission?.total || 0) > 0) {
    warnings.push(`仍有准入阻断/观察样本进入战绩：阻断${blockedAdmission?.total || 0}单，观察${watchAdmission?.total || 0}单，应检查 AI 入库门控或历史旧数据。`);
  }

  getRecentMissStreaks(records).forEach(item => {
    warnings.push(`${item.type} 近期连续${item.count}单失误，建议暂停同类盘口并回看临场水位/基本面冲突。`);
  });

  Object.keys(stats.byRiskBucket || {}).forEach(key => {
    const group = stats.byRiskBucket[key];
    if (group.settled >= 4 && (group.hitRate || 0) < 40) {
      warnings.push(`风险桶「${group.label || key}」命中率偏低：有效${group.settled}单，命中率${formatPercent(group.hitRate)}，应下调该分层权重。`);
    }
  });

  if (!warnings.length && stats.settled > 0 && (stats.hitRate || 0) < 45) {
    warnings.push(`整体命中率低于45%：当前${formatPercent(stats.hitRate)}，建议先收缩推荐范围，只保留高价值且低/中风险样本。`);
  }

  return unique(warnings).slice(0, 6);
}

function getRecentMissStreaks(records) {
  const byType = {};
  const list = Array.isArray(records) ? records : [];

  list.map((record, index) => normalizeRecord(record, index))
    .filter(r => r.betResult !== 'pending' && r.betResult !== 'push')
    .sort((a, b) => b.timeKey - a.timeKey)
    .forEach(record => {
      const type = record.betType || '未标注盘口';
      if (!byType[type]) byType[type] = [];
      byType[type].push(record);
    });

  return Object.keys(byType).map(type => {
    const arr = byType[type];
    let count = 0;
    for (const r of arr) {
      if (r.betResult === 'miss' || r.betResult === 'halfLoss') count += 1;
      else break;
    }
    return { type, count };
  }).filter(item => item.count >= 3).slice(0, 3);
}

function groupTable(groups, order = []) {
  const keys = orderedKeys(groups, order);
  if (!keys.length) return '*暂无数据。*';

  const lines = [];
  lines.push('| 分组 | 总数 | 待验证 | 有效 | 命中 | 半赢 | 半输 | 未中 | 走盘 | 命中率 | ROI代理 |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  keys.forEach(key => {
    const g = groups[key];
    lines.push(`| ${escapeMd(g.label || key)} | ${num(g.total)} | ${num(g.pending)} | ${num(g.settled)} | ${num(g.hit)} | ${num(g.halfWin)} | ${num(g.halfLoss)} | ${num(g.miss)} | ${num(g.push)} | ${formatPercent(g.hitRate)} | ${formatPercent(g.roiProxy)} |`);
  });
  return lines.join('\n');
}

function orderedKeys(groups, order = []) {
  if (!groups || typeof groups !== 'object') return [];
  const keys = Object.keys(groups).filter(k => groups[k]);
  if (!order.length) {
    return keys.sort((a, b) => {
      const ga = groups[a];
      const gb = groups[b];
      return (gb.total || 0) - (ga.total || 0) || String(ga.label || a).localeCompare(String(gb.label || b), 'zh-CN');
    });
  }
  return order.filter(k => keys.includes(k)).concat(keys.filter(k => !order.includes(k)));
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function normalizeText(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function normalizeBucketKey(label) {
  const text = normalizeText(label, '未标注');
  if (text === '未标注') return text;
  return text.replace(/\s+/g, '_');
}

function getRecordTime(record) {
  const value = pickFirst(record.verifiedAt, record.updatedAt, record.createdAt, record.matchTime, record.date);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function num(value) {
  return Number.isFinite(value) ? value : 0;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${round1(value)}%` : '-';
}

function escapeMd(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function unique(list) {
  return Array.from(new Set(list));
}

function toArray(value) {
  if (Array.isArray(value)) return value.filter(v => v !== undefined && v !== null && v !== '');
  if (value === undefined || value === null || value === '') return [];
  if (typeof value === 'string' && value.includes(',')) return value.split(',').map(x => x.trim()).filter(Boolean);
  return [value];
}

function boolish(value) {
  if (value === true) return true;
  if (value === false || value === undefined || value === null || value === '') return false;
  return /^(true|1|yes|y|allow|allowed|pass|passed)$/i.test(String(value).trim());
}

function normalizePercent(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace('%', ''));
  if (!Number.isFinite(n)) return null;
  if (n <= 1) return round1(n * 100);
  return round1(Math.max(0, Math.min(100, n)));
}

function classifyCompletenessBand(score) {
  if (!Number.isFinite(score)) return { key: 'unknown', label: '完整度未记录' };
  if (score >= 75) return { key: 'high', label: '完整度高(>=75%)' };
  if (score >= 55) return { key: 'mid', label: '完整度中(55-74%)' };
  return { key: 'low', label: '完整度低(<55%)' };
}

function classifyConfidenceBand(confidence) {
  if (!Number.isFinite(confidence)) return { key: 'unknown', label: '置信未记录' };
  if (confidence >= 80) return { key: '80+', label: '80%+' };
  if (confidence >= 70) return { key: '70-79', label: '70-79%' };
  if (confidence >= 60) return { key: '60-69', label: '60-69%' };
  if (confidence >= 50) return { key: '50-59', label: '50-59%' };
  return { key: '<50', label: '<50%' };
}

function buildCalibrationStats(records) {
  const settled = (Array.isArray(records) ? records : []).filter(r => r.betResult !== 'pending' && r.betResult !== 'push' && Number.isFinite(r.confidence));
  if (!settled.length) return { count: 0, avgPredicted: null, actualRate: null, brierScore: null };
  let predSum = 0, actualSum = 0, brierSum = 0;
  settled.forEach(r => {
    const p = Math.max(0, Math.min(1, r.confidence / 100));
    const y = r.betResult === 'hit' ? 1 : r.betResult === 'miss' ? 0 : 0.5;
    predSum += p;
    actualSum += y;
    brierSum += Math.pow(p - y, 2);
  });
  return {
    count: settled.length,
    avgPredicted: round1(predSum / settled.length * 100),
    actualRate: round1(actualSum / settled.length * 100),
    brierScore: round3(brierSum / settled.length)
  };
}
