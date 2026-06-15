/**
 * portfolio-orchestrator.js
 * 今日组合总控：从单场盘口总控结果上升到“今日组合风险/集中度/仓位纪律”。
 *
 * 设计原则：
 * - 不替代单场 marketCommand，只做组合层约束。
 * - 优先识别同联赛、同盘口剧本、同 R01-R14 主规则、同风险桶集中。
 * - 输出可解释的 keep/reduce/watch 组合动作，供 AI 提示词、popup 展示和保存记录使用。
 */

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value, fallback = '') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

function num(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[^0-9.+\-]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isCloudMarketCommand(command = null) {
  return command?.version === 'market-command-v4' && command?._source === 'cloud';
}

function isProfessionalMarketDangerLevel(level = '') {
  return ['range_mismatch_deep', 'range_mismatch_shallow', 'water_distorted', 'asian_inducement_risk', 'severe_shallow', 'shallow'].includes(String(level || ''));
}

function isProfessionalHardBlock({ euroAsianLevel = '', valueAdmission = null, humanArbitration = null } = {}) {
  const blockers = safeArray(valueAdmission?.blockers);
  const admissionLevel = String(valueAdmission?.level || '');
  const resultStatus = String(humanArbitration?.resultStatus || '');
  const coverStatus = String(humanArbitration?.handicapCoverStatus || '');
  return euroAsianLevel === 'asian_inducement_risk'
    || blockers.length > 0
    || ['blocked', 'none'].includes(admissionLevel)
    || resultStatus === 'watch_only'
    || coverStatus === 'blocked';
}

function normalizeItem(item = {}, index = 0) {
  const match = item.match || item;
  const rawMarketCommand = item.marketCommand || item.localPrediction?.marketCommand || item.ruleDecision?.marketCommand || item.marketVerdict?.marketCommand || null;
  const marketCommand = isCloudMarketCommand(rawMarketCommand) ? rawMarketCommand : null;
  const marketVerdict = item.marketVerdict || item.marketCoreDecision || item.localPrediction?.marketVerdict || item.ruleDecision?.marketVerdict || null;
  const professionalMarket = item.professionalMarket || item.localPrediction?.professionalMarket || item.prediction?.professionalMarket || item.ruleDecision?.professionalMarket || null;
  const valueAdmission = professionalMarket?.valueAdmission || item.valueAdmission || item.localPrediction?.valueAdmission || item.ruleDecision?.valueAdmission || null;
  const humanArbitration = professionalMarket?.humanArbitration || null;
  const euroAsianLevel = text(professionalMarket?.euroAsianGap?.level, '');
  const valueAdmissionBlockers = safeArray(valueAdmission?.blockers);
  const proMarketDanger = isProfessionalMarketDangerLevel(euroAsianLevel);
  const proMarketHardBlock = isProfessionalHardBlock({ euroAsianLevel, valueAdmission, humanArbitration });
  const scenario = marketCommand?.primaryScenario || {};
  const trial = marketCommand?.counterEvidenceTrial || {};
  const exec = marketCommand?.executionCommand || {};
  const topRule = marketCommand?.currentMarketRead?.topRule || marketVerdict?.marketResonance?.topRule || item.resonanceTopRule || null;
  const riskProfile = item.riskProfile || item.risk || {};
  const profitability = item.profitability || {};
  const score = num(profitability?.scores?.finalScore ?? profitability?.score, 50);
  const riskScore = num(riskProfile?.score, 35);

  return {
    index,
    raw: item,
    matchId: text(match.id || item.matchId || item.id, `match_${index}`),
    league: text(match.league || item.league, '未知联赛'),
    leagueTier: text(match.leagueTier || item.leagueTier, '其他'),
    home: text(match.home || item.home, '主队'),
    away: text(match.away || item.away, '客队'),
    time: text(match.time || item.time, ''),
    marketCommand,
    marketVerdict,
    scenarioCode: text(scenario.code, 'unknown'),
    scenarioLabel: text(scenario.label, scenario.code || '盘口剧本未记录'),
    counterVerdict: text(trial.verdict, 'unknown'),
    counterLabel: text(trial.label, trial.verdict || '反证未记录'),
    stake: text(exec.stake, '仓位未记录'),
    bestMarket: text(exec.bestMarket, '未给出最优玩法'),
    topRuleId: text(topRule?.ruleId, 'no_rule'),
    topRuleLabel: text(topRule?.conclusion || topRule?.label, topRule?.ruleId || 'R01-R14未命中'),
    riskBucket: text(riskProfile?.bucket, 'unknown'),
    riskBucketLabel: text(riskProfile?.bucketLabel || riskProfile?.levelLabel, riskProfile?.bucket || '风险未记录'),
    riskLevel: text(riskProfile?.level, 'unknown'),
    riskScore,
    score,
    hasMarketCommand: !!marketCommand,
    marketCommandSource: rawMarketCommand?._source || '',
    euroAsianLevel,
    euroAsianPlain: text(professionalMarket?.euroAsianGap?.plain || professionalMarket?.euroAsianGap?.plainSummary, ''),
    valueAdmissionLevel: text(valueAdmission?.level, ''),
    valueAdmissionBlockers,
    valueAllowHigh: !!valueAdmission?.allowHigh,
    valueAllowMediumHigh: !!valueAdmission?.allowMediumHigh,
    valueAllowMediumHighWatch: !!valueAdmission?.allowMediumHighWatch,
    valueNearMissMediumHigh: !!valueAdmission?.nearMissMediumHigh,
    valueStrongSignal: !!valueAdmission?.strongValueSignal,
    humanResultStatus: text(humanArbitration?.resultStatus, ''),
    humanCoverStatus: text(humanArbitration?.handicapCoverStatus, ''),
    proMarketDanger,
    proMarketHardBlock
  };
}

function groupBy(items, keyFn, labelFn = null) {
  const groups = {};
  items.forEach(item => {
    const key = text(keyFn(item), 'unknown');
    if (!groups[key]) groups[key] = { key, label: labelFn ? labelFn(item) : key, count: 0, matchIds: [] };
    groups[key].count += 1;
    groups[key].matchIds.push(item.matchId);
  });
  return groups;
}

function sortedGroups(groups) {
  return Object.values(groups || {}).sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label), 'zh-CN'));
}

function exposureScore(items, groups) {
  const scenarioMax = sortedGroups(groups.byScenario)[0]?.count || 0;
  const ruleMax = sortedGroups(groups.byTopRule)[0]?.count || 0;
  const leagueMax = sortedGroups(groups.byLeague)[0]?.count || 0;
  const risky = items.filter(i => ['avoid', 'high', 'extreme'].includes(i.riskBucket) || ['high', 'extreme'].includes(i.riskLevel) || i.counterVerdict === 'overturn' || i.proMarketHardBlock).length;
  const proDanger = items.filter(i => i.proMarketDanger && !i.proMarketHardBlock).length;
  const missingCommand = items.filter(i => !i.hasMarketCommand).length;
  return clamp(scenarioMax * 10 + ruleMax * 9 + leagueMax * 6 + risky * 12 + proDanger * 8 + missingCommand * 10, 0, 100);
}

function buildConflicts(items, groups) {
  const conflicts = [];
  sortedGroups(groups.byScenario).forEach(g => {
    if (g.key !== 'unknown' && g.count >= 3) {
      conflicts.push({
        type: 'scenario_concentration',
        severity: g.count >= 4 ? 'high' : 'medium',
        label: `盘口剧本集中：${g.label}`,
        plain: `${g.count} 场同属「${g.label}」，禁止全部进入重仓，最多保留2场主推。`,
        matchIds: g.matchIds
      });
    }
  });
  sortedGroups(groups.byTopRule).forEach(g => {
    if (g.key !== 'no_rule' && g.key !== 'unknown' && g.count >= 3) {
      conflicts.push({
        type: 'rule_concentration',
        severity: g.count >= 4 ? 'high' : 'medium',
        label: `R01-R14规则集中：${g.key}`,
        plain: `${g.count} 场命中 ${g.key}，若该规则误判会形成同因子回撤，需分散或降仓。`,
        matchIds: g.matchIds
      });
    }
  });
  sortedGroups(groups.byLeague).forEach(g => {
    if (g.key !== '未知联赛' && g.count >= 4) {
      conflicts.push({
        type: 'league_concentration',
        severity: 'medium',
        label: `联赛集中：${g.label}`,
        plain: `${g.count} 场来自同一联赛/赛事环境，需防同天气、赛程、战意或裁判尺度共振。`,
        matchIds: g.matchIds
      });
    }
  });
  const risky = items.filter(i => ['avoid', 'high', 'extreme'].includes(i.riskBucket) || ['high', 'extreme'].includes(i.riskLevel) || i.counterVerdict === 'overturn' || i.proMarketHardBlock);
  if (risky.length >= 2) {
    conflicts.push({
      type: 'risk_bucket_concentration',
      severity: 'high',
      label: '高风险场次集中',
      plain: `${risky.length} 场存在高风险/推翻/回避/专业盘口硬阻断信号，高风险项不得进入TOP3主推。`,
      matchIds: risky.map(i => i.matchId)
    });
  }
  const proDanger = items.filter(i => i.proMarketDanger || i.proMarketHardBlock);
  if (proDanger.length) {
    conflicts.push({
      type: 'professional_market_guard',
      severity: proDanger.some(i => i.proMarketHardBlock || i.euroAsianLevel === 'asian_inducement_risk') ? 'high' : 'medium',
      label: '专业盘口准入/欧亚风险门控',
      plain: `${proDanger.length} 场存在欧亚范围/水位/价值准入风险；硬阻断项只能观望，其余不得进入组合TOP主推。`,
      matchIds: proDanger.map(i => i.matchId)
    });
  }
  return conflicts.slice(0, 8);
}

function groupCount(groups, key, matchId) {
  const g = groups?.[key];
  return g?.matchIds?.includes(matchId) ? g.count : 0;
}

function priorityScore(item, groups) {
  let score = item.score;
  if (item.hasMarketCommand) score += 8;
  if (item.counterVerdict === 'keep') score += 8;
  if (item.counterVerdict === 'downgrade') score -= 8;
  if (item.counterVerdict === 'overturn') score -= 25;
  if (/观望|极低/.test(item.stake)) score -= 18;
  if (/低仓/.test(item.stake)) score -= 8;
  if (/中低|中仓/.test(item.stake)) score += 4;
  if (['avoid', 'high', 'extreme'].includes(item.riskBucket) || ['high', 'extreme'].includes(item.riskLevel)) score -= 20;
  if (item.proMarketHardBlock) score -= 35;
  else if (item.proMarketDanger) score -= 18;
  const mediumHighWatchOnly = (item.valueAllowMediumHighWatch || item.valueNearMissMediumHigh || item.valueAdmissionLevel === 'medium_high_watch')
    && !item.valueAllowMediumHigh
    && !item.valueAllowHigh
    && !item.valueStrongSignal;
  if (mediumHighWatchOnly) score -= 14;
  if (groupCount(groups.byScenario, item.scenarioCode, item.matchId) >= 3) score -= 8;
  if (groupCount(groups.byTopRule, item.topRuleId, item.matchId) >= 3) score -= 7;
  if (groupCount(groups.byLeague, item.league, item.matchId) >= 4) score -= 5;
  return clamp(Math.round(score), 0, 100);
}

function buildAllocationPlan(items, groups) {
  const ranked = items.map(item => {
    const pScore = priorityScore(item, groups);
    let action = 'keep';
    let stakeCap = '中低仓';
    const reasons = [];
    const mediumHighWatchOnly = (item.valueAllowMediumHighWatch || item.valueNearMissMediumHigh || item.valueAdmissionLevel === 'medium_high_watch')
      && !item.valueAllowMediumHigh
      && !item.valueAllowHigh
      && !item.valueStrongSignal;

    if (!item.hasMarketCommand) {
      action = 'watch';
      stakeCap = '观望';
      reasons.push('缺盘口总控，不能进入组合主推');
    }
    if (item.counterVerdict === 'overturn') {
      action = 'watch';
      stakeCap = '观望/极低仓';
      reasons.push('单场反证审判已推翻或观望');
    } else if (item.counterVerdict === 'downgrade' && action !== 'watch') {
      action = 'reduce';
      stakeCap = '低仓';
      reasons.push('单场反证审判要求降仓');
    }
    if (['avoid', 'high', 'extreme'].includes(item.riskBucket) || ['high', 'extreme'].includes(item.riskLevel)) {
      action = action === 'watch' ? 'watch' : 'reduce';
      stakeCap = stakeCap === '观望' ? stakeCap : '低仓/极低仓';
      reasons.push('爆冷/风险桶偏高');
    }
    if (item.proMarketHardBlock) {
      action = 'watch';
      stakeCap = '观望/极低仓';
      const blockerText = item.valueAdmissionBlockers.length ? `，准入阻断=${item.valueAdmissionBlockers.slice(0, 2).join('；')}` : '';
      reasons.push(`专业盘口/价值准入硬阻断：欧亚=${item.euroAsianLevel || '未记录'}，仲裁=${item.humanResultStatus || item.humanCoverStatus || '未记录'}${blockerText}`);
    } else if (item.proMarketDanger) {
      action = action === 'watch' ? 'watch' : 'reduce';
      stakeCap = stakeCap === '观望' ? stakeCap : '低仓/待临场确认';
      reasons.push(`专业盘口欧亚/水位风险=${item.euroAsianLevel}，不得进入组合TOP主推`);
    }
    if (mediumHighWatchOnly) {
      action = action === 'watch' ? 'watch' : 'reduce';
      stakeCap = action === 'watch' ? stakeCap : '低仓/待临场确认';
      reasons.push('价值准入仅为中高待确认/近似候选，未取得正式中高准入，不能进入组合TOP主推');
    }
    if (groupCount(groups.byScenario, item.scenarioCode, item.matchId) >= 3) {
      const wasWatch = action === 'watch';
      action = wasWatch ? 'watch' : 'reduce';
      stakeCap = wasWatch ? stakeCap : '低仓';
      reasons.push('同盘口剧本集中');
    }
    if (groupCount(groups.byTopRule, item.topRuleId, item.matchId) >= 3 && item.topRuleId !== 'no_rule') {
      const wasWatch = action === 'watch';
      action = wasWatch ? 'watch' : 'reduce';
      stakeCap = wasWatch ? stakeCap : '低仓';
      reasons.push('同R01-R14规则集中');
    }

    return {
      matchId: item.matchId,
      label: `${item.home} vs ${item.away}`,
      league: item.league,
      scenarioCode: item.scenarioCode,
      scenarioLabel: item.scenarioLabel,
      topRuleId: item.topRuleId,
      counterVerdict: item.counterVerdict,
      singleStake: item.stake,
      action,
      stakeCap,
      valueAdmissionLevel: item.valueAdmissionLevel,
      valueAllowMediumHighWatch: item.valueAllowMediumHighWatch,
      valueNearMissMediumHigh: item.valueNearMissMediumHigh,
      priorityScore: pScore,
      reasons: reasons.length ? reasons : ['组合层未发现额外集中风险']
    };
  });

  const sorted = ranked.slice().sort((a, b) => b.priorityScore - a.priorityScore);
  const topCandidates = sorted.filter(x => x.action === 'keep').slice(0, 3).map(x => x.matchId);
  const backups = sorted.filter(x => x.action === 'reduce').slice(0, 5).map(x => x.matchId);

  return {
    items: ranked,
    topCandidates,
    backups,
    avoid: sorted.filter(x => x.action === 'watch').map(x => x.matchId)
  };
}

function verdictFromScore(score, conflicts) {
  const high = conflicts.filter(c => c.severity === 'high').length;
  if (high || score >= 70) return { code: 'high_concentration', label: '组合高集中风险', stakeDiscipline: '今日主推最多2场，其余低仓/观望' };
  if (score >= 45) return { code: 'medium_concentration', label: '组合中等集中风险', stakeDiscipline: 'TOP3必须跨剧本/跨规则，单剧本最多2场' };
  return { code: 'balanced', label: '组合风险相对分散', stakeDiscipline: '可按单场总控执行，但仍避免同方向重仓串联' };
}

export function buildPortfolioCommand(matchItems = [], options = {}) {
  const items = safeArray(matchItems).map(normalizeItem);
  const groups = {
    byLeague: groupBy(items, i => i.league, i => i.league),
    byLeagueTier: groupBy(items, i => i.leagueTier, i => i.leagueTier),
    byScenario: groupBy(items, i => i.scenarioCode, i => i.scenarioLabel),
    byTopRule: groupBy(items, i => i.topRuleId, i => i.topRuleId),
    byCounterVerdict: groupBy(items, i => i.counterVerdict, i => i.counterLabel),
    byRiskBucket: groupBy(items, i => i.riskBucket, i => i.riskBucketLabel)
  };
  const conflicts = buildConflicts(items, groups);
  const score = exposureScore(items, groups);
  const verdict = verdictFromScore(score, conflicts);
  const allocationPlan = buildAllocationPlan(items, groups);

  return {
    version: 'portfolio-orchestrator-v1',
    generatedAt: new Date().toISOString(),
    date: options.date || new Date().toLocaleDateString('zh-CN'),
    totalMatches: items.length,
    exposureScore: score,
    verdict,
    exposure: {
      byLeague: sortedGroups(groups.byLeague),
      byLeagueTier: sortedGroups(groups.byLeagueTier),
      byScenario: sortedGroups(groups.byScenario),
      byTopRule: sortedGroups(groups.byTopRule),
      byCounterVerdict: sortedGroups(groups.byCounterVerdict),
      byRiskBucket: sortedGroups(groups.byRiskBucket)
    },
    conflicts,
    allocationPlan,
    plainSummary: `${verdict.label}：${verdict.stakeDiscipline}。主推候选 ${allocationPlan.topCandidates.length} 场，降仓备选 ${allocationPlan.backups.length} 场，观望 ${allocationPlan.avoid.length} 场。`
  };
}

export function portfolioCommandToMarkdown(command = null) {
  if (!command || command.version !== 'portfolio-orchestrator-v1') return '## 今日组合总控\n- 暂无组合总控。';
  const lines = [];
  lines.push('## 今日组合总控（PORTFOLIO_COMMAND_JSON）');
  lines.push(`- 总结：${command.plainSummary || '-'}`);
  lines.push(`- 集中度分：${command.exposureScore ?? '-'}｜结论：${command.verdict?.label || '-'}`);
  lines.push(`- 仓位纪律：${command.verdict?.stakeDiscipline || '-'}`);
  if (command.conflicts?.length) {
    lines.push('- 组合反证：');
    command.conflicts.slice(0, 6).forEach(c => lines.push(`  - [${c.severity}] ${c.label}：${c.plain}`));
  }
  const top = safeArray(command.allocationPlan?.items).slice().sort((a, b) => b.priorityScore - a.priorityScore).slice(0, 8);
  if (top.length) {
    lines.push('- 组合分配：');
    top.forEach(x => lines.push(`  - ${x.label}｜${x.action}｜${x.stakeCap}｜优先分${x.priorityScore}｜${x.reasons.slice(0, 2).join('；')}`));
  }
  lines.push('');
  lines.push('```PORTFOLIO_COMMAND_JSON');
  lines.push(JSON.stringify(command, null, 2));
  lines.push('```');
  return lines.join('\n');
}

export default { buildPortfolioCommand, portfolioCommandToMarkdown };
