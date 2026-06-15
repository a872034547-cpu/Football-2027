/**
 * knowledge-engine.js — 发布版（存根）
 *
 * 核心规则（R-MR-01~R-MR-14, R-ODDS-010~R-ODDS-071, R-OU-020~R-OU-111）
 * 已迁移至服务器端 football-api/analyze.php，本地版本为轻量兜底。
 * background.js 会优先调用云端 analyze.knowledge，云端超时/失败时
 * 自动降级到此本地存根（返回 watch/低置信结果，不影响流程运行）。
 */

import { arbitrateCandidates, finalCandidatesToMarkdown } from './candidate-arbitrator.js';

function safeArray(v) { return Array.isArray(v) ? v.filter(x => x !== undefined && x !== null && x !== '') : (v ? [v] : []); }
function unique(list) { return Array.from(new Set(safeArray(list).map(x => String(x)).filter(Boolean))); }

export function theoreticalOuLine(expectedGoals) {
  if (!Number.isFinite(expectedGoals)) return null;
  if (expectedGoals < 1.9)  return 2.0;
  if (expectedGoals < 2.25) return 2.25;
  if (expectedGoals < 2.55) return 2.5;
  if (expectedGoals < 2.85) return 2.75;
  if (expectedGoals < 3.15) return 3.0;
  return 3.25;
}

export function drawExclusionScore(n) {
  const homeRows = n.stats?.homeRecentMatches || [];
  const awayRows = n.stats?.awayRecentMatches || [];
  const home8 = homeRows.slice(0, 8);
  const away8 = awayRows.slice(0, 8);
  if (home8.length < 4 || away8.length < 4) return null;
  const parseScore = (s) => {
    const m = String(s || '').match(/(\d+)\s*[:\-]\s*(\d+)/);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const all = [...home8, ...away8];
  let draws = 0, scoreless = 0, decisive = 0;
  all.forEach(r => {
    const sc = parseScore(r.score);
    if (!sc) return;
    if (sc[0] === sc[1]) draws++;
    if (sc[0] === 0 || sc[1] === 0) scoreless++;
    if (sc[0] !== sc[1]) decisive++;
  });
  return { value: scoreless + decisive - draws, draws, scoreless, decisive, sample: all.length };
}

/**
 * analyzeKnowledge — 本地轻量存根
 * 核心规则由云端执行，本地仅做字段检查，返回 watch 兜底结果。
 * background.js 调用云端成功时会覆盖此结果。
 */
export function analyzeKnowledge(normalized) {
  const missingFields = [];
  if (!normalized?.odds?.averageCurrent) missingFields.push('odds.averageCurrent');
  if (!normalized?.asian?.currentLine)   missingFields.push('asian.currentLine');
  if (!normalized?.overunder?.currentLine) missingFields.push('overunder.currentLine');

  return {
    ok: true,
    _source: 'local_stub',
    generatedAt: new Date().toISOString(),
    hits: [],
    candidates: [],
    conflicts: [],
    blockedBy: missingFields.length
      ? [{ code: 'local_stub', level: 'medium', msg: '本地存根模式：核心规则由云端执行，请确认网络和授权码正常' }]
      : [],
    confidenceAdjustments: [],
    resonance: null,
    modules: { odds: { hits: [], candidates: [] }, overunder: { hits: [], candidates: [] }, draw: { hits: [], candidates: [] }, resonance: { hits: [], candidates: [] }, risk: { hits: [], candidates: [] } },
    summary: {
      mainDirection: 'watch',
      secondaryDirection: null,
      recommendationLevel: '等待云端规则结果',
      weightPolicy: { marketCore: 80, auxiliary: 20, label: '庄家盘口/欧赔核心 80% + 其它修正 20%', principle: '庄家盘口是最高优先级预测参考，先读懂欧赔/亚盘/大小球三盘，再用其它信息修正。' },
      riskLevel: 'medium',
      shouldAvoid: false,
      shouldWarnOnly: false,
      confidence: 50,
      marketStakeAdvice: { timePhase: 'unknown', timeLabel: '时间未知', asian: '等待云端规则分析', overunder: '等待云端规则分析', overall: '本地存根模式，等待云端规则结果' },
      confidenceBreakdown: { base: 50, knowledgeDelta: 0, riskPenalty: 0, conflictPenalty: 0, completenessPenalty: 0, cap: 86, final: 50 },
      triggeredRuleIds: [],
      missingFields,
      marketResonance: null,
      topCandidateLabel: '',
      topCandidates: [],
      whyNotTop2: ['本地存根：核心规则由云端执行'],
      unanalysableFlags: [],
      hitCount: 0,
      candidateCount: 0,
    }
  };
}

export function knowledgeToMarkdown(result) {
  if (!result) return '';
  const L = [];
  L.push('### 🧠 知识库规则引擎结论');
  const src = result._source === 'cloud' ? '☁️ 云端' : (result._source === 'local_stub' ? '⚠️ 本地存根' : '💻 本地');
  L.push(`- 来源：${src} | 规则命中：${result.hits?.length || 0} 条 | 候选：${result.candidates?.length || 0} 条 | 风险：${result.blockedBy?.length || 0} 条`);
  if (result.summary) {
    L.push(`- 主方向：${result.summary.mainDirection} | 建议级别：${result.summary.recommendationLevel} | 风险：${result.summary.riskLevel} | 本地置信：${result.summary.confidence}%`);
    if (result.summary.weightPolicy) {
      L.push(`- 权重策略：${result.summary.weightPolicy.label}`);
      L.push(`- 读盘原则：${result.summary.weightPolicy.principle}`);
    }
    if (result.summary.marketStakeAdvice) {
      const ms = result.summary.marketStakeAdvice;
      L.push(`- 分玩法仓位：${ms.timeLabel || ms.timePhase}｜亚盘=${ms.asian}｜大小球=${ms.overunder}`);
    }
    if (result.resonance?.topRule) {
      const r = result.resonance.topRule;
      L.push(`- 盘赔共振R01-R14：${r.ruleId} ${r.conclusion}｜${r.stars}星｜${r.plain}`);
      if (r.evidence?.length) L.push(`- 共振证据：${r.evidence.slice(0, 4).join('；')}`);
    }
  }
  if (result.candidates?.length) {
    L.push('');
    const finalMd = finalCandidatesToMarkdown(arbitrateCandidates(result), '**最终候选仲裁排序**');
    if (finalMd) L.push(finalMd);
    L.push('');
    L.push('**原始规则候选（供复核，不等同最终推荐）**');
    result.candidates.slice(0, 6).forEach((c, i) => {
      L.push(`${i + 1}. ${c.market}：${c.label || c.direction}（score=${c.score}，规则=${(c.ruleIds || []).join('+') || '-'}）`);
      if (c.evidence?.length) L.push(`   - 证据：${c.evidence.join('；')}`);
    });
  }
  if (result.resonance?.rulesMatched?.length) {
    L.push('');
    L.push('**盘赔共振 R01-R14 命中**');
    result.resonance.rulesMatched.slice(0, 6).forEach(r => {
      L.push(`- ${r.ruleId}｜${r.label}｜${r.stars}星：${r.conclusion}`);
      if (r.plain) L.push(`  - 白话：${r.plain}`);
    });
  }
  if (result.hits?.length) {
    L.push('');
    L.push('**规则命中明细**');
    result.hits.slice(0, 16).forEach(h => {
      L.push(`- ${h.ruleId} [${h.strength}] ${h.direction}：${(h.evidence || []).filter(Boolean).join('；')}`);
      if (h.risk?.length) L.push(`  - 风险：${h.risk.join('；')}`);
    });
  }
  if (result.conflicts?.length) {
    L.push('');
    L.push('**冲突降级**');
    result.conflicts.forEach(c => L.push(`- ${c.ruleId || 'CONFLICT'}：${c.msg}`));
  }
  if (result.blockedBy?.length) {
    L.push('');
    L.push('**风险过滤/观望条件**');
    result.blockedBy.forEach(b => L.push(`- [${b.level}] ${b.msg}`));
  }
  return L.join('\n');
}
