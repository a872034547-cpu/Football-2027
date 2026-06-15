/**
 * 爆冷风险引擎：基于归一化数据、知识规则、量化结果与情报，输出风险分层与对冲建议。
 */

const RISK_LEVELS = [
  { level: 'extreme', label: '极高风险', color: '#f85149', min: 78 },
  { level: 'high', label: '高风险', color: '#f0883e', min: 58 },
  { level: 'medium', label: '中风险', color: '#d29922', min: 35 },
  { level: 'low', label: '低风险', color: '#3fb950', min: 0 }
];

const BUCKETS = {
  focus: { bucket: 'focus', label: '重点关注' },
  observe: { bucket: 'observe', label: '低仓观察' },
  avoid: { bucket: 'avoid', label: '高风险提示' }
};

/**
 * 爆冷风险主入口。
 * @param {object} input
 * @returns {object}
 */
export function analyzeUpsetRisk(input = {}) {
  const safe = input && typeof input === 'object' ? input : {};
  const normalized = safe.normalized || null;
  const matchData = safe.matchData || safe.data || {};
  const knowledge = safe.knowledge || null;
  const quant = safe.quant || null;
  const profitability = safe.profitability || null;
  const intel = safe.intel || null;
  const professionalMarket = safe.professionalMarket || safe.proMarket || matchData?.professionalMarket || null;
  const matchInfo = buildMatchInfo(safe.matchInfo, normalized, matchData);
  const teamProfiles = safe.teamProfiles || safe.profileContext || matchData?.teamProfiles || null;
  const timeContext = normalized?.derived?.timeContext || buildTimeContext(matchInfo);
  const odds = getOddsSnapshot(normalized, matchData);
  const asian = getAsianSnapshot(normalized, matchData);
  const overunder = getOuSnapshot(normalized, matchData);
  const completeness = getCompleteness(normalized, matchData);
  const favorite = detectFavorite(odds, asian, matchInfo);
  const factors = [];

  addStrongFavoriteFragility(factors, favorite, odds, asian, overunder);
  addPopularityRisk(factors, normalized, knowledge, profitability, favorite);
  addDrawProtectionRisk(factors, odds, overunder, knowledge);
  addMarketConflictRisk(factors, favorite, odds, asian, overunder, knowledge);
  addLowGoalRisk(factors, favorite, overunder, knowledge, quant);
  addDataCompletenessRisk(factors, completeness, odds, asian, overunder);
  addIntelRisk(factors, intel, matchInfo);
  addQuantKnowledgeConflictRisk(factors, knowledge, quant, favorite);
  addTeamProfileRisk(factors, teamProfiles, favorite, matchInfo);
  addProfessionalMarketRisk(factors, professionalMarket);

  const baseScore = factors.reduce((sum, f) => sum + num(f.points, 0), 0);
  const synergy = calcSynergy(factors);
  const protection = calcProtectionCredit(favorite, odds, asian, overunder, knowledge, factors, professionalMarket);
  const rawScore = Math.round(baseScore + synergy - protection);
  const euroAsianLevel = String(professionalMarket?.euroAsianGap?.level || '');
  const professionalFloorMap = {
    asian_inducement_risk: 58,
    range_mismatch_deep: 50,
    range_mismatch_shallow: 50,
    water_distorted: 46,
    severe_shallow: 46,
    shallow: 42
  };
  const professionalFloor = professionalFloorMap[euroAsianLevel] || 0;
  const score = clamp(Math.max(rawScore, professionalFloor), 0, 100);
  const levelInfo = classifyRiskLevel(score);
  const marketStakeAdvice = buildMarketStakeAdvice(score, factors, favorite, odds, asian, overunder, knowledge, timeContext);
  const bucketInfo = classifyDailyBucket(score, profitability?.score || safe.profitabilityScore || 0, marketStakeAdvice);
  const upsetCandidate = buildUpsetCandidate({ score, levelInfo, factors, favorite, odds, asian, overunder, quant, knowledge, marketStakeAdvice });
  const protectivePlan = buildHedgePlan(score, levelInfo, bucketInfo, factors, favorite, odds, asian, overunder, marketStakeAdvice, upsetCandidate);
  const stakeAdvice = buildStakeAdvice(score, levelInfo, bucketInfo, marketStakeAdvice);
  const tags = buildTags(factors, levelInfo, bucketInfo, marketStakeAdvice, upsetCandidate);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    matchInfo,
    score,
    level: levelInfo.level,
    levelLabel: levelInfo.label,
    levelColor: levelInfo.color,
    bucket: bucketInfo.bucket,
    bucketLabel: bucketInfo.label,
    bucketReason: bucketInfo.reason,
    summary: buildSummary(score, levelInfo, bucketInfo, factors, favorite, marketStakeAdvice),
    timeContext,
    marketStakeAdvice,
    favorite,
    teamProfiles,
    factors,
    upsetCandidate,
    protectivePlan,
    stakeAdvice,
    tags,
    debug: {
      baseScore,
      synergy,
      protection,
      rawScore,
      professionalFloor,
      profitabilityScore: profitability?.score ?? null,
      completeness,
      teamProfileMatched: !!teamProfiles?.matched,
      teamProfileCoverage: teamProfiles?.coverage || teamProfiles?.meta?.coverage || null,
      marketStakeAdvice,
      professionalMarketRisk: professionalMarket?.euroAsianGap?.level || null
    }
  };
}

/**
 * 风险等级分层。
 * @param {number} score
 * @returns {{level: string, label: string, color: string}}
 */
export function classifyRiskLevel(score) {
  const s = clamp(Math.round(num(score, 0)), 0, 100);
  const found = RISK_LEVELS.find(x => s >= x.min) || RISK_LEVELS[RISK_LEVELS.length - 1];
  return { level: found.level, label: found.label, color: found.color };
}

/**
 * 今日比赛筛选桶。
 * @param {number} score
 * @param {number} profitabilityScore
 * @returns {{bucket: string, label: string, reason: string}}
 */
export function classifyDailyBucket(score, profitabilityScore = 0, marketStakeAdvice = null) {
  const s = clamp(Math.round(num(score, 0)), 0, 100);
  const p = clamp(Math.round(num(profitabilityScore, 0)), 0, 100);
  const mainPlayable = !!marketStakeAdvice?.mainMarketPlayable;

  if (s >= 78) {
    return { ...BUCKETS.avoid, reason: '爆冷风险极高，请强提示谨慎参与；系统不自动替用户放弃' };
  }
  if (s >= 58 && p < 75 && !mainPlayable) {
    return { ...BUCKETS.avoid, reason: '高风险且价值分不足，请提示用户降仓、保护或自行决定是否参与' };
  }
  if (s >= 58) {
    return { ...BUCKETS.observe, reason: mainPlayable ? '总体风险偏高，即使赛前主判断窗口内亚盘/胜负有候选，也只能观察/低仓保护并等待临场确认；大小球不得随之升仓' : '高风险但仍有价值信号，只能低仓并加保护' };
  }
  if (mainPlayable && s < 58 && p >= 55) {
    return { ...BUCKETS.focus, reason: '赛前主判断窗口内亚盘/胜负证据较强，可进入重点复核；大小球不随之升仓' };
  }
  if (s >= 35 || p < 60) {
    return { ...BUCKETS.observe, reason: mainPlayable ? '亚盘/胜负有候选价值，但部分风险未完全消除，只能轻仓复核，临场反向立即降级' : '风险或价值条件未完全达标，先观察并降低仓位' };
  }
  return { ...BUCKETS.focus, reason: '风险可控且基础价值分达标，可进入重点复核清单' };
}

/**
 * 风险结果转 Markdown，供 AI 深度提示词和报告使用。
 * @param {object} profile
 * @returns {string}
 */
export function riskProfileToMarkdown(profile) {
  if (!profile || typeof profile !== 'object') {
    return '### 🧯 爆冷风险与对冲建议\n> 暂无可用风险画像。';
  }
  const lines = [];
  lines.push('### 🧯 爆冷风险与对冲建议');
  lines.push(`- 风险分：${profile.score ?? '-'} / 100（${profile.levelLabel || profile.level || '-'}）`);
  lines.push(`- 今日筛选：${profile.bucketLabel || '-'}${profile.bucketReason ? '｜' + profile.bucketReason : ''}`);
  if (profile.favorite?.label) {
    lines.push(`- 热门侧：${profile.favorite.label}${profile.favorite.odds ? '，欧赔约 ' + profile.favorite.odds : ''}${profile.favorite.asianLineText ? '，亚盘 ' + profile.favorite.asianLineText : ''}`);
  }
  if (profile.summary) lines.push(`- 核心结论：${profile.summary}`);
  if (profile.upsetCandidate?.plain) {
    const uc = profile.upsetCandidate;
    lines.push(`- 冷门候选：${uc.plain}`);
    if (Array.isArray(uc.triggers) && uc.triggers.length) lines.push(`- 冷门触发条件：${uc.triggers.slice(0, 4).join('；')}`);
    if (uc.valueGuard) lines.push(`- 冷门纪律：${uc.valueGuard}`);
  }
  if (profile.marketStakeAdvice) {
    const ms = profile.marketStakeAdvice;
    lines.push(`- 分玩法仓位：${ms.timeLabel || ms.timePhase || '-'}｜亚盘=${ms.asian || '-'}｜大小球=${ms.overunder || '-'}`);
  }
  lines.push('');
  lines.push('#### 主要风险因子');
  const factors = Array.isArray(profile.factors) ? profile.factors : [];
  if (factors.length) {
    factors.slice(0, 8).forEach(f => {
      const ev = Array.isArray(f.evidence) && f.evidence.length ? `（证据：${f.evidence.join('；')}）` : '';
      lines.push(`- ${f.label || f.code || '风险因子'}：+${f.points ?? 0}｜${f.msg || ''}${ev}`);
    });
  } else {
    lines.push('- 暂未触发明显爆冷风险因子。');
  }
  lines.push('');
  lines.push('#### 冷门/防冷双轨');
  const uc = profile.upsetCandidate || null;
  if (uc) {
    lines.push(`- 主方向保护：${uc.mainProtection || '-'}`);
    lines.push(`- 可能冷门路径：${(uc.paths || []).join('、') || '-'}`);
    lines.push(`- 冷门价值状态：${uc.valueStatus || '-'}｜${uc.valueLabel || '-'}`);
    if (Array.isArray(uc.evidence) && uc.evidence.length) lines.push(`- 冷门证据：${uc.evidence.slice(0, 6).join('；')}`);
    if (Array.isArray(uc.invalidIf) && uc.invalidIf.length) lines.push(`- 冷门失效条件：${uc.invalidIf.slice(0, 4).join('；')}`);
    if (Array.isArray(uc.forbiddenInferences) && uc.forbiddenInferences.length) lines.push(`- 禁止误推：${uc.forbiddenInferences.slice(0, 4).join('；')}`);
  } else {
    lines.push('- 暂无结构化冷门候选；只按风险因子做保护。');
  }
  lines.push('');
  lines.push('#### 对冲/仓位');
  const plan = Array.isArray(profile.protectivePlan) ? profile.protectivePlan : [];
  if (plan.length) plan.forEach(p => lines.push(`- ${p}`));
  else lines.push('- 无需额外对冲，但仍需控制单场风险。');
  if (profile.stakeAdvice?.text) lines.push(`- 仓位建议：${profile.stakeAdvice.text}`);
  if (Array.isArray(profile.tags) && profile.tags.length) lines.push(`- 复盘标签：${profile.tags.join('、')}`);
  return lines.join('\n');
}

function buildMatchInfo(input, normalized, matchData) {
  const mi = input || normalized?.matchInfo || matchData?.analysis?.matchInfo || {};
  return {
    home: text(mi.home, '主队'),
    away: text(mi.away, '客队'),
    league: text(mi.league, ''),
    time: text(mi.time, ''),
    weather: text(mi.weather, ''),
    venue: text(mi.venue, '')
  };
}

function getOddsSnapshot(normalized, matchData) {
  const no = normalized?.odds || {};
  const raw = matchData?.winDrawWin || {};
  const summary = raw.summary || {};
  const avg = no.averageCurrent || summary.averageCurrent || raw.averageCurrent || raw.keyOdds?.averageCurrent || null;
  const initial = no.averageInitial || summary.averageInitial || raw.averageInitial || null;
  const implied = summary.impliedAverage || no.impliedAverage || null;
  const movement = summary.movement || raw.movement || null;
  return {
    win: num(first(avg?.win, avg?.home, raw.win), null),
    draw: num(first(avg?.draw, raw.draw, no.drawOdds), null),
    loss: num(first(avg?.loss, avg?.away, raw.loss), null),
    initialWin: num(first(initial?.win, initial?.home), null),
    initialDraw: num(initial?.draw, null),
    initialLoss: num(first(initial?.loss, initial?.away), null),
    implied,
    movement,
    returnRate: num(first(summary.averageReturnRate, raw.averageReturnRate), null)
  };
}

function getAsianSnapshot(normalized, matchData) {
  const na = normalized?.asian || {};
  const raw = matchData?.asian || {};
  const ao = raw.keyOdds?.ao || raw.companies?.[0]?.mainLine || raw.companies?.[0] || {};
  const lineText = first(na.mainLine, ao.currentHandicap, ao.initialHandicap, ao.currentLine, ao.initialLine, '');
  const lineValue = parseHandicap(lineText);
  return {
    lineText: text(lineText, ''),
    lineValue,
    absLine: Math.abs(num(lineValue, 0)),
    homeWater: num(first(na.currentHomeWater, ao.currentHomePay, ao.homeWater, ao.currentHomeWater), null),
    awayWater: num(first(na.currentAwayWater, ao.currentAwayPay, ao.awayWater, ao.currentAwayWater), null),
    initialLineValue: parseHandicap(first(ao.initialHandicap, ao.initialLine, na.initialLine, '')),
    companyCount: Array.isArray(raw.companies) ? raw.companies.length : (Array.isArray(na.keyCompanies) ? na.keyCompanies.length : 0)
  };
}

function getOuSnapshot(normalized, matchData) {
  const no = normalized?.overunder || {};
  const raw = matchData?.overunder || {};
  const ao = raw.keyOdds?.ao || raw.companies?.[0]?.mainLine || raw.companies?.[0] || {};
  const lineText = first(no.mainLine, ao.currentLine, ao.initialLine, '');
  return {
    lineText: text(lineText, ''),
    lineValue: parseLine(lineText),
    overWater: num(first(no.currentOverWater, ao.currentOverPay, ao.overWater, ao.currentOverWater), null),
    underWater: num(first(no.currentUnderWater, ao.currentUnderPay, ao.underWater, ao.currentUnderWater), null),
    companyCount: Array.isArray(raw.companies) ? raw.companies.length : 0
  };
}

function getCompleteness(normalized, matchData) {
  const dc = normalized?.derived?.dataCompleteness || {};
  const missing = Array.isArray(dc.missing) ? dc.missing : (Array.isArray(normalized?.derived?.missingFields) ? normalized.derived.missingFields : []);
  let score = num(dc.score, null);
  if (score === null) {
    const checks = [matchData?.analysis, matchData?.winDrawWin, matchData?.asian, matchData?.overunder];
    const ok = checks.filter(x => x && !x.error).length;
    score = Math.round(ok / checks.length * 100);
  }
  return { score, level: dc.level || (score >= 80 ? 'good' : score >= 55 ? 'medium' : 'low'), missing };
}

function detectFavorite(odds, asian, matchInfo) {
  const values = [
    { side: 'home', label: matchInfo.home || '主队', odds: odds.win },
    { side: 'away', label: matchInfo.away || '客队', odds: odds.loss }
  ].filter(x => Number.isFinite(x.odds) && x.odds > 1);
  if (!values.length) {
    return { side: 'unknown', label: '未知热门', odds: null, strength: 'unknown', asianLine: asian.lineValue, asianLineText: asian.lineText };
  }
  values.sort((a, b) => a.odds - b.odds);
  const fav = values[0];
  const strength = fav.odds <= 1.35 ? 'strong' : fav.odds <= 1.7 ? 'normal' : fav.odds <= 2.05 ? 'slight' : 'weak';
  return { ...fav, strength, asianLine: asian.lineValue, asianLineText: asian.lineText };
}

function addStrongFavoriteFragility(factors, favorite, odds, asian, overunder) {
  if (!favorite || favorite.side === 'unknown' || !Number.isFinite(favorite.odds)) return;
  const evidence = [];
  let points = 0;

  if (favorite.odds <= 1.7) {
    evidence.push(`热门欧赔${favorite.odds}`);
    if (asian.absLine < 0.75) {
      points += favorite.odds <= 1.45 ? 16 : 12;
      evidence.push(`亚盘让步偏浅(${asian.lineText || asian.lineValue || '-'})`);
    } else if (asian.absLine < 1.25 && favorite.odds <= 1.45) {
      points += 8;
      evidence.push(`低赔热门未见深盘支撑(${asian.lineText || '-'})`);
    }
    if (overunder.lineValue && overunder.lineValue <= 2.25) {
      points += 5;
      evidence.push(`总进球线偏低(${overunder.lineText})`);
    }
  }

  if (points > 0) {
    factors.push(makeFactor('RISK_LOW_ODDS_WEAK_LINE', '强队低赔但盘口支撑不足', points >= 14 ? 'high' : 'medium', points, '热门方向赔率偏低，但让步或进球环境不足，存在赢球不穿或赛果冷门风险。', evidence));
  }
}

function addPopularityRisk(factors, normalized, knowledge, profitability, favorite) {
  const popularity = normalized?.derived?.popularitySide || '';
  const hits = knowledgeHits(knowledge);
  const hasHotRule = hits.some(h => /R-ODDS-071|热门|过热|人气|热/.test(`${h.code || ''} ${h.msg || ''} ${h.label || ''}`));
  const evidence = [];
  let points = 0;

  if (hasHotRule) {
    points += 12;
    evidence.push('知识库命中热门过热/人气陷阱规则');
  }
  if (favorite?.side && popularity && popularity !== 'balanced_or_unknown' && String(popularity).includes(favorite.side)) {
    points += 6;
    evidence.push(`人气侧代理偏向热门(${popularity})`);
  }
  if (profitability?.score && profitability.score < 55 && favorite?.odds && favorite.odds < 1.8) {
    points += 5;
    evidence.push(`价值评分不足(${profitability.score})但热门赔率偏低`);
  }

  if (points > 0) {
    factors.push(makeFactor('RISK_HOT_FAVORITE', '热门过热', points >= 14 ? 'high' : 'medium', points, '市场热度可能集中在热门侧，若盘口没有同步强化，应降低热门信心。', evidence));
  }
}

function addDrawProtectionRisk(factors, odds, overunder, knowledge) {
  if (!Number.isFinite(odds.draw)) return;
  const favoriteOdds = Math.min(num(odds.win, 99), num(odds.loss, 99));
  const hits = knowledgeHits(knowledge);
  const drawRule = hits.some(h => /R-ODDS-020|R-ODDS-023|R-OU-060|R-OU-061|平赔|真平|防平|防冷/.test(`${h.code || ''} ${h.msg || ''} ${h.label || ''}`));
  const evidence = [];
  let points = 0;

  if (drawRule) {
    points += 10;
    evidence.push('知识库命中平赔/真平/防平相关规则');
  }
  if (odds.draw <= 3.25 && favoriteOdds <= 1.9) {
    points += 8;
    evidence.push(`热门低赔同时平赔偏低(${odds.draw})`);
  } else if (odds.draw <= 3.45 && overunder.lineValue && overunder.lineValue <= 2.25) {
    points += 6;
    evidence.push(`平赔${odds.draw}叠加低总进球${overunder.lineText}`);
  }

  if (points > 0) {
    factors.push(makeFactor('RISK_DRAW_PROTECTION', '平赔防冷/平局保护', points >= 12 ? 'high' : 'medium', points, '平赔位置对热门胜出形成阻挡，需考虑平局保险或双重机会。', evidence));
  }
}

function addMarketConflictRisk(factors, favorite, odds, asian, overunder, knowledge) {
  const hits = knowledgeHits(knowledge);
  const conflictHit = hits.some(h => /R-ODDS-072|R-OU-111|冲突|背离|降级|逆分布/.test(`${h.code || ''} ${h.msg || ''} ${h.label || ''}`));
  const evidence = [];
  let points = 0;

  if (conflictHit) {
    points += 15;
    evidence.push('知识库提示欧亚/大小球冲突或多规则降级');
  }
  if (favorite?.odds && favorite.odds <= 1.8 && asian.absLine < 0.75) {
    points += 8;
    evidence.push('欧赔热门明显但亚盘让步不足');
  }
  if (favorite?.odds && favorite.odds <= 1.75 && overunder.lineValue && overunder.lineValue <= 2.25) {
    points += 6;
    evidence.push('胜负倾向与低进球环境不完全匹配');
  }

  if (points > 0) {
    factors.push(makeFactor('RISK_MARKET_CONFLICT', '欧亚/大小球冲突', points >= 15 ? 'high' : 'medium', points, '盘口、欧赔或大小球之间未形成同向支持，应先降级主推。', evidence));
  }
}

function addLowGoalRisk(factors, favorite, overunder, knowledge, quant) {
  const hits = knowledgeHits(knowledge);
  const ouHit = hits.some(h => /R-OU-031|R-OU-040|R-OU-043|R-OU-052|小球|低进球|降盘/.test(`${h.code || ''} ${h.msg || ''} ${h.label || ''}`));
  const evidence = [];
  let points = 0;

  if (overunder.lineValue && overunder.lineValue <= 2.25) {
    points += favorite?.odds && favorite.odds <= 1.9 ? 9 : 5;
    evidence.push(`总进球线偏低(${overunder.lineText})`);
  }
  if (overunder.underWater !== null && overunder.underWater <= 0.86) {
    points += 4;
    evidence.push(`小球低水(${overunder.underWater})`);
  }
  if (ouHit) {
    points += 7;
    evidence.push('知识库命中大小球反向/低比分风险规则');
  }
  const topScores = quant?.poisson?.topScores || quant?.topScores || [];
  if (Array.isArray(topScores) && topScores.some(s => /0-0|1-1|0:0|1:1/.test(`${s.score || s.label || ''}`))) {
    points += 4;
    evidence.push('量化比分候选包含平局小比分');
  }

  if (points > 0) {
    factors.push(makeFactor('RISK_LOW_GOAL_PATH', '低总进球/小比分冷门路径', points >= 12 ? 'high' : 'medium', points, '低进球环境降低热门容错率，容易出现小胜输盘、平局或一球冷门。', evidence));
  }
}

function addDataCompletenessRisk(factors, completeness, odds, asian, overunder) {
  const evidence = [];
  let points = 0;
  if (completeness.score < 55) {
    points += 14;
    evidence.push(`数据完整度偏低(${completeness.score}%)`);
  } else if (completeness.score < 75) {
    points += 7;
    evidence.push(`数据完整度一般(${completeness.score}%)`);
  }
  if (!Number.isFinite(odds.win) || !Number.isFinite(odds.loss)) {
    points += 6;
    evidence.push('缺少欧赔均值');
  }
  if (!asian.lineText) {
    points += 5;
    evidence.push('缺少主流亚盘');
  }
  if (!overunder.lineText) {
    points += 3;
    evidence.push('缺少大小球盘口');
  }
  if (Array.isArray(completeness.missing) && completeness.missing.length) {
    evidence.push(`缺失字段：${completeness.missing.slice(0, 4).join('、')}`);
  }

  if (points > 0) {
    factors.push(makeFactor('RISK_DATA_GAP', '数据完整度不足', points >= 12 ? 'high' : 'medium', points, '关键字段缺失会放大误判概率，不应在低置信数据上重仓。', evidence));
  }
}

function addIntelRisk(factors, intel, matchInfo) {
  const textBlob = collectIntelText(intel).toLowerCase();
  const evidence = [];
  let points = 0;
  const injuryRe = /伤停|受伤|缺阵|停赛|injur|suspend|doubt|缺席/;
  const rotateRe = /轮换|替补|休息|rotation|rotate|rested|rest/;
  const motiveRe = /战意|保级|晋级|出线|无欲无求|motivation|must win|relegation|qualif/;
  const fatigueRe = /疲劳|密集|连续客场|远征|一周双赛|congestion|fatigue|travel/;

  if (injuryRe.test(textBlob)) { points += 7; evidence.push('联网情报包含伤停/停赛关键词'); }
  if (rotateRe.test(textBlob)) { points += 6; evidence.push('联网情报包含轮换/休息关键词'); }
  if (motiveRe.test(textBlob)) { points += 5; evidence.push('联网情报包含战意关键词，需确认双方动机'); }
  if (fatigueRe.test(textBlob)) { points += 5; evidence.push('联网情报包含赛程疲劳关键词'); }

  if (!intel || intel.ok === false) {
    points += 4;
    evidence.push('缺少可靠联网情报复核');
  }

  if (points > 0) {
    factors.push(makeFactor('RISK_LINEUP_MOTIVATION', '伤停轮换/战意赛程不确定', points >= 12 ? 'high' : 'medium', points, `${matchInfo.home} vs ${matchInfo.away} 需要临场确认阵容、战意和体能信息。`, evidence));
  }
}

function addQuantKnowledgeConflictRisk(factors, knowledge, quant, favorite) {
  const evidence = [];
  let points = 0;
  const summaryDirection = `${knowledge?.summary?.direction || knowledge?.summary?.mainDirection || ''}`;
  const quantPick = `${quant?.prediction?.main || quant?.bestPick || quant?.recommendation || quant?.summary || ''}`;
  const conflicts = Array.isArray(knowledge?.conflicts) ? knowledge.conflicts.length : 0;

  if (conflicts > 0) {
    points += Math.min(12, conflicts * 4);
    evidence.push(`知识规则冲突${conflicts}项`);
  }
  if (summaryDirection && quantPick && favorite?.label) {
    const blob = `${summaryDirection} ${quantPick}`;
    const hasFav = blob.includes(favorite.label) || (favorite.side === 'home' && /主/.test(blob)) || (favorite.side === 'away' && /客/.test(blob));
    const hasDrawOrOppose = /平|受让|不败|客|主/.test(blob) && !hasFav;
    if (hasDrawOrOppose) {
      points += 8;
      evidence.push('量化/知识方向未一致支持热门侧');
    }
  }
  const blocked = Array.isArray(knowledge?.blockedBy) ? knowledge.blockedBy : [];
  if (blocked.length) {
    points += Math.min(10, blocked.length * 5);
    evidence.push(`知识引擎存在降级/阻断：${blocked.map(x => x.code || x.msg || '风险').slice(0, 2).join('、')}`);
  }

  if (points > 0) {
    factors.push(makeFactor('RISK_MODEL_CONFLICT', '模型/规则方向冲突', points >= 12 ? 'high' : 'medium', points, '本地量化、知识规则或候选方向之间存在分歧，需要降低信心度。', evidence));
  }
}

function addTeamProfileRisk(factors, teamProfiles, favorite, matchInfo) {
  if (!teamProfiles || typeof teamProfiles !== 'object') {
    factors.push(makeFactor('RISK_PROFILE_MISSING', '球队画像未加载', 'low', 3, '未能接入线上球队画像库，基本面/风格/热度修正缺失。', ['画像库加载失败或缓存不可用']));
    return;
  }

  const home = teamProfiles.home || {};
  const away = teamProfiles.away || {};
  const homeProfile = home.profile || {};
  const awayProfile = away.profile || {};
  const evidence = [];
  let points = 0;

  if (!teamProfiles.loaded) {
    points += 4;
    evidence.push('画像库未成功加载，仅能依赖盘口与原始数据');
  }
  if (!home.matched || !away.matched) {
    points += (!home.matched && !away.matched) ? 6 : 4;
    evidence.push(`画像匹配不完整：主队=${home.matched ? '已匹配' : '未匹配'}，客队=${away.matched ? '已匹配' : '未匹配'}`);
  }

  const verifyText = `${homeProfile.verificationStatus || ''} ${awayProfile.verificationStatus || ''}`.toLowerCase();
  if (/partial|pending|uncertain|unverified|placeholder|待/.test(verifyText)) {
    points += 3;
    evidence.push(`画像验证状态需弱化：${[homeProfile.verificationStatus, awayProfile.verificationStatus].filter(Boolean).join(' / ')}`);
  }

  const homeTier = num(first(homeProfile.powerTier, homeProfile.baseTier, homeProfile.tier), 0);
  const awayTier = num(first(awayProfile.powerTier, awayProfile.baseTier, awayProfile.tier), 0);
  if (homeTier && awayTier && favorite?.side) {
    const favoriteTier = favorite.side === 'home' ? homeTier : awayTier;
    const dogTier = favorite.side === 'home' ? awayTier : homeTier;
    const tierGap = favoriteTier - dogTier;
    if (tierGap >= 2) {
      points += 5;
      evidence.push(`盘口热门 ${favorite.label || favorite.side} 的画像层级(${favoriteTier})弱于对手(${dogTier})，需防热门名气/盘口错配`);
    } else if (tierGap === 1 && favorite?.odds && favorite.odds <= 1.8) {
      points += 3;
      evidence.push(`低赔热门画像层级仅小幅弱于/接近对手，不能仅凭热度追上盘`);
    }
  }

  const popularityBlob = `${homeProfile.popularityIndex || ''} ${awayProfile.popularityIndex || ''}`;
  if (favorite?.side && /全球顶流|豪门|顶流|热门/.test(popularityBlob)) {
    const favProfile = favorite.side === 'home' ? homeProfile : awayProfile;
    if (/全球顶流|豪门|顶流|热门/.test(`${favProfile.popularityIndex || ''}`) && favorite.odds && favorite.odds <= 1.65) {
      points += 3;
      evidence.push(`热门侧画像热度高且欧赔偏低，需防大众盘过热`);
    }
  }

  if (points > 0) {
    factors.push(makeFactor('RISK_TEAM_PROFILE_CONTEXT', '球队画像辅助风险', points >= 8 ? 'medium' : 'low', Math.min(points, 12), `${matchInfo.home} vs ${matchInfo.away} 的球队画像提示基本面/验证/热度存在需弱化的辅助风险。`, evidence));
  }
}

function addProfessionalMarketRisk(factors, professionalMarket = null) {
  const gap = professionalMarket?.euroAsianGap || null;
  const admission = professionalMarket?.valueAdmission || null;
  const human = professionalMarket?.humanArbitration || null;
  const level = String(gap?.level || '');
  const dangerous = ['range_mismatch_deep', 'range_mismatch_shallow', 'water_distorted', 'asian_inducement_risk', 'severe_shallow', 'shallow'].includes(level);
  const evidence = [];
  let points = 0;

  if (dangerous) {
    evidence.push(`欧亚缺口等级=${level}`);
    if (gap?.lineRange?.plain) evidence.push(`理论范围：${gap.lineRange.plain}`);
    if (gap?.waterImbalance?.plain) evidence.push(`水位：${gap.waterImbalance.plain}`);
    if (gap?.inducementRisk?.plain) evidence.push(`诱导：${gap.inducementRisk.plain}`);
    if (level === 'asian_inducement_risk') points += 18;
    else if (level === 'range_mismatch_deep' || level === 'range_mismatch_shallow') points += 12;
    else if (level === 'water_distorted') points += 10;
    else points += 8;
  }
  if (admission?.blockers?.length) {
    points += Math.min(8, admission.blockers.length * 4);
    evidence.push(`价值准入阻断：${admission.blockers.slice(0, 2).join('；')}`);
  }
  if (human?.handicapCoverStatus && human.handicapCoverStatus !== 'playable') {
    points += human.handicapCoverStatus === 'blocked' ? 8 : 5;
    evidence.push(`人工仲裁限制让球穿盘：${human.handicapCoverStatus}`);
  }

  if (points > 0) {
    factors.push(makeFactor('RISK_PRO_EURO_ASIAN_GUARD', '专业盘口欧亚/水位风险', points >= 16 ? 'high' : 'medium', Math.min(points, 24), '专业盘口增强层已识别欧亚范围不一致、水位畸变或中高价值阻断，风险分不得被低赔深盘保护分抵消。', evidence));
  }
}

function calcSynergy(factors) {
  const highCount = factors.filter(f => f.level === 'high').length;
  const families = new Set(factors.map(f => String(f.code || '').split('_').slice(0, 3).join('_')));
  let points = 0;
  if (factors.length >= 3) points += 6;
  if (highCount >= 2) points += 8;
  if (families.size >= 4) points += 5;
  return points;
}

function calcProtectionCredit(favorite, odds, asian, overunder, knowledge, factors = [], professionalMarket = null) {
  let credit = 0;
  if (favorite?.odds && favorite.odds <= 1.45 && asian.absLine >= 1.25) credit += 8;
  if (favorite?.odds && favorite.odds <= 1.7 && asian.absLine >= 1) credit += 4;
  if (overunder.lineValue && overunder.lineValue >= 2.75 && favorite?.odds && favorite.odds <= 1.7) credit += 4;
  const hits = knowledgeHits(knowledge);
  if (hits.some(h => /顺分布|实盘|强支撑|一致/.test(`${h.msg || ''} ${h.label || ''}`))) credit += 5;

  const factorCodes = factors.map(f => f.code);
  const hasHardConflict = factorCodes.some(c => ['RISK_DATA_GAP', 'RISK_MARKET_CONFLICT', 'RISK_MODEL_CONFLICT', 'RISK_PRO_EURO_ASIAN_GUARD'].includes(c));
  const hasHighConflict = factors.some(f => ['RISK_DATA_GAP', 'RISK_MARKET_CONFLICT', 'RISK_MODEL_CONFLICT', 'RISK_PRO_EURO_ASIAN_GUARD'].includes(f.code) && f.level === 'high');
  const euroAsianLevel = String(professionalMarket?.euroAsianGap?.level || '');
  const inducement = euroAsianLevel === 'asian_inducement_risk';
  const euroAsianSoftDanger = ['range_mismatch_deep', 'range_mismatch_shallow', 'water_distorted', 'severe_shallow', 'shallow'].includes(euroAsianLevel);

  let cap = 18;
  if (hasHardConflict || euroAsianSoftDanger) cap = 6;
  if (hasHighConflict || inducement) cap = 3;
  return Math.min(cap, credit);
}

function buildUpsetCandidate({ score = 0, levelInfo = {}, factors = [], favorite = {}, odds = {}, asian = {}, overunder = {}, quant = null, knowledge = null, marketStakeAdvice = null } = {}) {
  const codes = factors.map(f => f.code);
  const evidence = [];
  const triggers = [];
  const invalidIf = [];
  const forbiddenInferences = [
    '爆冷风险只代表主方向需要降仓/保护，不自动等于反向投注价值',
    '热门让球风险≠弱队胜出价值；赢球不穿优先理解为让球降级或受让保护',
    '平赔/小球低比分风险≠无条件推荐小球，大小球必须独立满足证据门槛',
    '数据缺失、情报不明、模型冲突默认降仓/待临场，不得包装成高价值冷门'
  ];
  const paths = [];
  const addPath = p => { if (p && !paths.includes(p)) paths.push(p); };
  const addEvidence = e => { if (e && !evidence.includes(e)) evidence.push(e); };
  const dogLabel = favorite?.side === 'home' ? '客队' : favorite?.side === 'away' ? '主队' : '受让方';
  const dogWin = favorite?.side === 'home' ? '客胜' : favorite?.side === 'away' ? '主胜' : '反热门胜';
  const dogCover = `${dogLabel}受让/不败保护`;
  const drawPath = '平局/双重机会保护';

  if (codes.includes('RISK_DRAW_PROTECTION')) {
    addPath(drawPath);
    addEvidence('平赔防冷/平局保护触发，主方向需考虑平局保险');
    triggers.push('平赔继续压低或临场平赔不随热门降赔而上抬');
  }
  if (codes.includes('RISK_LOW_GOAL_PATH')) {
    addPath('低比分平局或一球小负/赢球不穿');
    addEvidence('低总进球/小比分路径降低热门穿盘容错率');
    triggers.push('大小球维持低盘、小球低水或首发偏保守');
  }
  if (codes.includes('RISK_LOW_ODDS_WEAK_LINE') || codes.includes('RISK_MARKET_CONFLICT')) {
    addPath(dogCover);
    addEvidence('热门低赔但亚盘/跨盘承载不足，优先防赢球不穿或受让方向');
    triggers.push('热门降赔但亚盘不升或上盘升水');
  }
  if (codes.includes('RISK_MODEL_CONFLICT')) {
    addPath('模型/规则分歧下的反热门保护');
    addEvidence('量化/知识方向存在分歧，主方向不得重仓做胆');
    triggers.push('临场盘口与模型方向继续背离');
  }
  if (codes.includes('RISK_LINEUP_MOTIVATION')) {
    addPath('伤停轮换/战意反转冷门');
    addEvidence('阵容、战意或赛程变量未确认，需保留临场反转路径');
    triggers.push('确认热门核心缺阵、轮换或战意不足');
  }
  if (codes.includes('RISK_DATA_GAP')) {
    addEvidence('关键数据缺失时只能防错，不能把缺失当冷门价值');
    invalidIf.push('后续补齐关键盘口/近期数据后风险消失');
  }

  const topScores = quant?.poisson?.topScores || quant?.topScores || [];
  if (Array.isArray(topScores) && topScores.some(s => /0-0|1-1|0:0|1:1/.test(`${s.score || s.label || ''}`))) {
    addPath('0-0/1-1小比分平局');
    addEvidence('泊松Top比分包含0-0/1-1，支持平局防冷而非直接反打');
  }
  if (Number.isFinite(odds.draw) && odds.draw <= 3.35) {
    addPath(drawPath);
    addEvidence(`平赔${odds.draw}处于保护区间`);
  }
  if (overunder.lineValue && overunder.lineValue <= 2.25) {
    addEvidence(`总进球线${overunder.lineText || overunder.lineValue}偏低，热门穿盘容错下降`);
  }
  if (favorite?.odds && favorite.odds <= 1.75 && asian.absLine < 0.75) {
    addEvidence(`热门欧赔${favorite.odds}但亚盘${asian.lineText || asian.lineValue || '-'}偏浅`);
  }

  invalidIf.push('热门方向临场升盘降水且大小球同步抬升，三盘重新共振');
  invalidIf.push('首发/战意确认支持热门且反证审判保持keep');
  invalidIf.push('冷门方向赔率被过度压低导致价值消失');

  const independentEvidence = evidence.filter(e => !/缺失|不能把缺失/.test(e)).length;
  const hasHighRiskFactor = factors.some(f => f.level === 'high' && !['RISK_DATA_GAP', 'RISK_PROFILE_MISSING'].includes(f.code));
  let valueStatus = 'none';
  let valueLabel = '无明确冷门候选';
  if (paths.length && score >= 35) {
    valueStatus = 'hedge_only';
    valueLabel = '防冷/保护候选，不等于反向投注价值';
  }
  if (paths.length && score >= 58 && independentEvidence >= 3 && hasHighRiskFactor) {
    valueStatus = 'upset_value_watch';
    valueLabel = '冷门价值观察候选，需临场独立证据确认';
  }
  if (codes.includes('RISK_DATA_GAP') && independentEvidence < 3) {
    valueStatus = 'risk_only';
    valueLabel = '仅风险提示：数据缺失不得升级为冷门价值';
  }

  const mainProtection = paths.length
    ? `${favorite?.label && favorite.side !== 'unknown' ? favorite.label : '主方向'}不宜做重仓胆；优先${paths.slice(0, 2).join(' / ')}`
    : '主方向暂未触发明显防冷路径，但仍需按盘口与情报复核';
  const plain = paths.length
    ? `${valueLabel}｜路径=${paths.slice(0, 3).join('、')}｜证据=${evidence.slice(0, 3).join('；') || '-'}｜纪律=风险不等于反打`
    : '暂无明确冷门路径；按主方向价值准入与常规风控执行。';

  return {
    version: 'upset-candidate-v1',
    favoriteSide: favorite?.side || 'unknown',
    favoriteLabel: favorite?.label || '热门侧',
    oppositeSideLabel: dogLabel,
    possibleOppositeWin: dogWin,
    score,
    riskLevel: levelInfo?.level || '',
    valueStatus,
    valueLabel,
    valueAllowed: valueStatus === 'upset_value_watch',
    paths,
    mainProtection,
    evidence: evidence.slice(0, 10),
    triggers: unique(triggers).slice(0, 8),
    invalidIf: unique(invalidIf).slice(0, 8),
    forbiddenInferences,
    marketTiming: marketStakeAdvice?.timeLabel || marketStakeAdvice?.timePhase || '',
    valueGuard: '只有出现量化edge、赔率保护、盘口反向异动、阵容/战意确认等独立证据时，冷门才可从保护候选升级为投注候选；否则只做降仓/对冲。',
    plain
  };
}

function buildHedgePlan(score, levelInfo, bucketInfo, factors, favorite, odds, asian, overunder, marketStakeAdvice = null, upsetCandidate = null) {
  const plan = [];
  const codes = factors.map(f => f.code);

  if (bucketInfo.bucket === 'avoid') {
    plan.push('高风险提示：不自动替用户放弃；如用户仍参与，请避免作为串关胆并优先使用保护方案。');
  }
  if (marketStakeAdvice?.mainMarketPlayable) {
    plan.push(marketStakeAdvice.overall || '亚盘/胜负按主判断窗口复核，大小球单独等待首发与临场水位。');
    if (score >= 58) {
      plan.push('分玩法仓位：高风险下亚盘/胜负仅允许0-0.3u观察复核；大小球不跟随升仓，等待首发、临场水位与CLV确认。');
    } else if (score >= 35) {
      plan.push('分玩法仓位：亚盘/胜负可按0.3-0.5u轻仓复核；大小球0-0.3u或仅观察。');
    } else {
      plan.push('分玩法仓位：主判断玩法0.6-1u内复核，大小球仍需临场确认。');
    }
  } else if (score >= 58) {
    plan.push('若必须参与，只允许 0-0.3u 研究型仓位，并优先选择受让/不败/平局保护。');
  } else if (score >= 35) {
    plan.push('主方案降仓到 0.3-0.6u，保留双重机会或让球保护，避免追低赔。');
  } else {
    plan.push('风险可控但不满仓，单场建议 0.6-1u 内，临场阵容确认后再执行。');
  }
  if (upsetCandidate?.plain && upsetCandidate.valueStatus !== 'none') {
    plan.push(`冷门双轨：${upsetCandidate.mainProtection}；${upsetCandidate.valueGuard}`);
  }
  if (codes.includes('RISK_DRAW_PROTECTION') || (odds.draw && odds.draw <= 3.35)) {
    plan.push('平赔存在保护信号：考虑双重机会覆盖平局，或小比例平局保险。');
  }
  if (codes.includes('RISK_LOW_GOAL_PATH') || (overunder.lineValue && overunder.lineValue <= 2.25)) {
    plan.push('低总进球环境：避免深让穿盘，优先小比分、受让方或热门不败类保护。');
  }
  if (codes.includes('RISK_MARKET_CONFLICT') || codes.includes('RISK_MODEL_CONFLICT')) {
    plan.push('欧亚/模型冲突未消除前，不做重仓和串关，等待临场水位与首发确认。');
  }
  if (favorite?.label && asian.absLine >= 1.25 && score >= 35) {
    plan.push(`若仍看好${favorite.label}，不要直接追深盘，可降级到胜出/不败或分散到让球保护。`);
  }
  return unique(plan);
}

function buildStakeAdvice(score, levelInfo, bucketInfo, marketStakeAdvice = null) {
  if (score >= 78) {
    return { unitRange: '0-0.2u', kellyFraction: '0-0.10 Kelly', text: '极高风险：系统只做强提示，不替用户决策；如仍参与，应极低仓并避免串关。' };
  }
  if (score >= 58) {
    if (marketStakeAdvice?.mainMarketPlayable) {
      return { unitRange: '0-0.3u；大小球待临场/不入TOP', kellyFraction: '0-0.15 Kelly（仅保护复核）', text: '高风险保护：亚盘/胜负进入主判断窗口时也只能极低仓复核；命中高风险的玩法不得写中高价值或串关胆，未命中玩法按价值准入独立判断。' };
    }
    return { unitRange: '0-0.3u', kellyFraction: '0.10-0.20 Kelly', text: '高风险：只允许极低仓位或保护型方案，优先保本金而非追收益。' };
  }
  if (score >= 35) {
    if (marketStakeAdvice?.mainMarketPlayable) {
      return { unitRange: '亚盘/胜负0.3-0.5u；大小球0-0.3u待确认', kellyFraction: '0.20-0.35 Kelly（分玩法）', text: '中风险分玩法：亚盘/胜负证据闭环时也只允许轻仓复核，大小球不随之升仓，等首发/临场确认。' };
    }
    return { unitRange: '0.3-0.6u', kellyFraction: '0.20-0.35 Kelly', text: '中风险：按分数凯利折扣降仓，禁止加码，建议配置保护。' };
  }
  return { unitRange: '0.6-1u', kellyFraction: '0.35-0.70 Kelly', text: '低风险：仍按分数凯利控制单场上限，不因低风险而满仓。' };
}

function buildTags(factors, levelInfo, bucketInfo, marketStakeAdvice = null, upsetCandidate = null) {
  const tags = factors.map(f => f.label).filter(Boolean);
  tags.unshift(levelInfo.label, bucketInfo.label);
  if (marketStakeAdvice?.mainMarketPlayable) tags.push(levelInfo.level === 'high' || bucketInfo.bucket === 'avoid' ? '亚盘待复核/低仓保护' : '亚盘轻仓候选', '大小球待临场');
  if (bucketInfo.bucket === 'avoid') tags.push('高风险提示', '命中风险玩法禁高价值');
  if (upsetCandidate?.valueStatus === 'upset_value_watch') tags.push('冷门价值观察');
  else if (upsetCandidate?.valueStatus === 'hedge_only') tags.push('防冷保护候选');
  if (factors.some(f => /平赔|平局/.test(f.label))) tags.push('平局保险');
  if (factors.some(f => /低总进球|小比分/.test(f.label))) tags.push('小比分冷门路径');
  return unique(tags).slice(0, 12);
}

function buildTimeContext(matchInfo) {
  return {
    phase: 'unknown',
    phaseLabel: '时间未知',
    hoursToKickoff: null,
    minutesToKickoff: null,
    note: matchInfo?.time ? `原始时间=${matchInfo.time}` : '未识别开赛时间'
  };
}

function isMainMarketTiming(timeContext) {
  return ['main_market', 'lineup', 'closing'].includes(timeContext?.phase || 'unknown');
}

function buildMarketStakeAdvice(score, factors, favorite, odds, asian, overunder, knowledge, timeContext) {
  const ms = knowledge?.summary?.marketStakeAdvice || null;
  if (ms) return ms;
  const mainTiming = isMainMarketTiming(timeContext);
  const topMain = knowledge?.summary?.topCandidates?.find(c => ['亚让盘', '胜平负'].includes(c.market)) || null;
  const mainScore = Number(topMain?.score || 0);
  const hardRisk = factors.some(f => ['RISK_DATA_GAP', 'RISK_MARKET_CONFLICT', 'RISK_MODEL_CONFLICT', 'RISK_PRO_EURO_ASIAN_GUARD'].includes(f.code) && f.level === 'high');
  const mainMarketPlayable = mainTiming && !hardRisk && (mainScore >= 58 || (asian.absLine >= 0.5 && favorite?.odds && favorite.odds <= 1.9));
  return {
    timePhase: timeContext?.phase || 'unknown',
    timeLabel: timeContext?.phaseLabel || '时间未知',
    hoursToKickoff: timeContext?.hoursToKickoff ?? null,
    mainMarketPlayable,
    asian: mainMarketPlayable ? '亚盘/胜负进入主判断窗口，也只能按盘口证据轻仓复核' : '亚盘/胜负证据未达主判断条件，先观察',
    overunder: timeContext?.phase === 'main_market' ? '大小球待临场确认，不随亚盘一起升仓' : '大小球按首发和临场水位单独升降级',
    overall: mainMarketPlayable ? '分玩法处理：亚盘/胜负轻仓复核，大小球待临场' : '总体仍以观察/保护为主'
  };
}

function buildSummary(score, levelInfo, bucketInfo, factors, favorite, marketStakeAdvice = null) {
  const top = factors.slice().sort((a, b) => b.points - a.points).slice(0, 3).map(f => f.label);
  const fav = favorite?.label && favorite.side !== 'unknown' ? `${favorite.label}热门侧` : '热门侧';
  const split = marketStakeAdvice?.mainMarketPlayable ? (score >= 58 ? '亚盘/胜负仅低仓复核，大小球待临场；仅命中风险玩法不得进高价值' : '亚盘/胜负仅轻仓复核，大小球待临场') : '';
  const scoreNote = `风险分${score}`;
  if (!top.length) return `${fav}暂未出现明显爆冷共振（${scoreNote}）${split ? '；' + split : ''}。`;
  // 不再重复 bucketLabel（调用方已显示），只说明触发因子和风险分
  return `${fav}触发${top.join('、')}（${scoreNote}）${split ? '；' + split : ''}。`;
}

function makeFactor(code, label, level, points, msg, evidence = []) {
  return { code, label, level, points: Math.max(0, Math.round(num(points, 0))), msg, evidence: evidence.filter(Boolean) };
}

function knowledgeHits(knowledge) {
  if (!knowledge || typeof knowledge !== 'object') return [];
  const hits = [];
  ['hits', 'knowledgeHits', 'rules', 'blockedBy', 'conflicts'].forEach(key => {
    if (Array.isArray(knowledge[key])) hits.push(...knowledge[key]);
  });
  return hits;
}

function collectIntelText(intel) {
  if (!intel) return '';
  if (typeof intel === 'string') return intel;
  const parts = [];
  if (Array.isArray(intel.results)) {
    intel.results.forEach(r => parts.push(r.title || '', r.snippet || '', r.content || '', r.url || ''));
  }
  if (Array.isArray(intel.items)) {
    intel.items.forEach(r => parts.push(r.title || '', r.snippet || '', r.content || ''));
  }
  parts.push(intel.summary || '', intel.markdown || '', intel.error || '');
  return parts.join(' ');
}

function parseHandicap(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const textValue = String(value).trim();
  const exactMap = {
    '受让两球半': -2.5, '受让两球/两球半': -2.25, '受让两球': -2,
    '受让球半/两球': -1.75, '受让球半': -1.5, '受让一球/球半': -1.25, '受让一球': -1,
    '受让半球/一球': -0.75, '受让半球': -0.5, '受让平手/半球': -0.25,
    '平手': 0, '平': 0, '平/半': 0.25, '平手/半球': 0.25,
    '半球': 0.5, '半/一': 0.75, '半球/一球': 0.75,
    '一球': 1, '一/球半': 1.25, '一球/球半': 1.25,
    '球半': 1.5, '球半/两': 1.75, '球半/两球': 1.75,
    '两球': 2, '两/两半': 2.25, '两球/两球半': 2.25,
    '两半': 2.5, '两球半': 2.5, '两半/三': 2.75, '两球半/三球': 2.75,
    '三球': 3
  };
  if (Object.prototype.hasOwnProperty.call(exactMap, textValue)) return exactMap[textValue];
  const positivePhrases = ['两球半/三球', '两半/三', '两球/两球半', '两/两半', '球半/两球', '球半/两', '一球/球半', '一/球半', '半球/一球', '半/一', '平手/半球', '平/半', '三球', '两球半', '两半', '两球', '球半', '一球', '半球', '平手', '平'];
  for (const phrase of positivePhrases) {
    if (textValue.includes(phrase)) return /受让|受/.test(textValue) ? -exactMap[phrase] : exactMap[phrase];
  }
  const cleaned = textValue.replace(/[^\d+\-./]/g, ' ');
  if (/\d+\s*\/\s*\d+/.test(cleaned)) {
    const pair = cleaned.match(/(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
    if (pair) return (parseFloat(pair[1]) + parseFloat(pair[2])) / 2;
  }
  const n = parseFloat(cleaned.replace(/[^\d+\-.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function parseLine(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const textValue = String(value);
  const pair = textValue.match(/(\d+(?:\.\d+)?)\s*[/,]\s*(\d+(?:\.\d+)?)/);
  if (pair) return (parseFloat(pair[1]) + parseFloat(pair[2])) / 2;
  const n = parseFloat(textValue.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function num(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === null || value === undefined || value === '') return fallback;
  const n = parseFloat(String(value).replace('%', '').replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

function first(...values) {
  return values.find(v => v !== undefined && v !== null && v !== '');
}

function text(value, fallback = '') {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value).trim();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function unique(list) {
  return [...new Set((list || []).filter(Boolean))];
}

const RiskEngine = {
  analyzeUpsetRisk,
  classifyRiskLevel,
  classifyDailyBucket,
  riskProfileToMarkdown
};

export default RiskEngine;
