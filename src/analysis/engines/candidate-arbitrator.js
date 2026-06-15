/**
 * candidate-arbitrator.js
 *
 * 将知识库原始 candidates 升级为“最终候选结论排序”。
 * 目标：解决同一市场互斥候选同时出现的问题，例如“大2.75”和“小2.75”同时命中时，
 * 不再机械按 score 展示，而是进行冲突仲裁、压制、降级和临场复核输出。
 */

function safeArray(v) {
  return Array.isArray(v) ? v.filter(x => x !== undefined && x !== null && x !== '') : (v ? [v] : []);
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function textOf(c = {}) {
  return [
    c.market, c.label, c.direction, c.pick, c.selection, c.note, c.msg,
    ...safeArray(c.ruleIds), ...safeArray(c.evidence), ...safeArray(c.risk)
  ].map(x => String(x || '')).join(' ');
}

function normalizeMarket(c = {}) {
  const t = textOf(c).toLowerCase();
  if (/大小|进球|overunder|over\/under|ou|大球|小球|over|under/.test(t)) return 'overunder';
  if (/亚盘|让球|上盘|下盘|受让|handicap|asian|穿盘|输盘/.test(t)) return 'asian';
  if (/胜平负|主胜|平局|客胜|欧赔|1x2|wdw/.test(t)) return 'wdw';
  return String(c.market || 'other');
}

function normalizeSide(c = {}) {
  const t = textOf(c);
  if (/小球|小\s*\d|under|低比分/.test(t)) return 'under';
  if (/大球|大\s*\d|over|开放|进球预期/.test(t)) return 'over';
  if (/下盘|受让|反上盘|上盘输盘|上盘不胜|规避上盘/.test(t)) return 'underdog';
  if (/上盘|让球方|热门|穿盘|favorite/.test(t)) return 'favorite';
  if (/主胜|主队/.test(t)) return 'home';
  if (/客胜|客队/.test(t)) return 'away';
  if (/平局|防平/.test(t)) return 'draw';
  return String(c.direction || c.label || 'unknown');
}

function scoreOf(c = {}) {
  return num(c.score, 0) - num(c.riskPenalty, 0);
}

function uniq(list) {
  return [...new Set(safeArray(list).map(x => String(x)).filter(Boolean))];
}

function asFinal(c = {}, patch = {}) {
  const score = scoreOf(c);
  return {
    market: c.market || patch.market || '候选',
    finalPick: patch.finalPick || c.label || c.direction || c.pick || c.selection || '待确认',
    confidence: patch.confidence ?? Math.max(0, Math.min(95, Math.round(score))),
    grade: patch.grade || (score >= 80 ? '主候选' : score >= 65 ? '次级候选' : '低仓候选'),
    reason: patch.reason || safeArray(c.evidence).slice(0, 3).join('；') || '规则命中但缺少详细证据',
    ruleIds: uniq([...(c.ruleIds || []), ...(patch.ruleIds || [])]),
    evidence: uniq([...(c.evidence || []), ...(patch.evidence || [])]).slice(0, 6),
    blockers: uniq([...(c.risk || []), ...(patch.blockers || [])]).slice(0, 6),
    watchPoints: uniq(patch.watchPoints || []).slice(0, 6),
    source: c,
  };
}

function arbitrateOverUnder(group = []) {
  const over = group.filter(c => normalizeSide(c) === 'over').sort((a, b) => scoreOf(b) - scoreOf(a))[0] || null;
  const under = group.filter(c => normalizeSide(c) === 'under').sort((a, b) => scoreOf(b) - scoreOf(a))[0] || null;
  const others = group.filter(c => !['over', 'under'].includes(normalizeSide(c)));
  if (!over || !under) return group.map(c => asFinal(c));

  const overScore = scoreOf(over);
  const underScore = scoreOf(under);
  const winner = overScore >= underScore ? over : under;
  const loser = winner === over ? under : over;
  const diff = Math.abs(overScore - underScore);
  const winnerSide = winner === over ? '大球' : '小球';
  const loserSide = loser === over ? '大球' : '小球';

  if (diff >= 15) {
    return [
      asFinal(winner, {
        grade: overScore >= underScore ? '主候选' : '主候选',
        finalPick: `${winnerSide}方向胜出`,
        confidence: Math.min(92, Math.round(scoreOf(winner))),
        reason: `${winnerSide}分差领先${diff.toFixed(0)}分，压过${loserSide}反证`,
        blockers: [`已压制${loserSide}候选：score差距${diff.toFixed(0)}分`],
        watchPoints: ['临场盘口是否反向升/降盘', '大小球水位是否继续支持胜出方向']
      }),
      ...others.map(c => asFinal(c, { grade: '低仓候选' }))
    ];
  }

  if (diff >= 8) {
    return [
      asFinal(winner, {
        grade: '低仓候选-待临场确认',
        finalPick: `${winnerSide}略占优，但大小球冲突未完全解除`,
        confidence: Math.min(68, Math.round(scoreOf(winner) - 8)),
        reason: `${winnerSide}仅领先${diff.toFixed(0)}分，${loserSide}存在有效反证，不适合作为TOP主推`,
        blockers: [`大小球互斥冲突：${winnerSide} vs ${loserSide}`, 'score差距不足15分，不能强行定向'],
        watchPoints: ['赛前30分钟复核是否升/降盘', '大/小水位差是否继续扩大', '首发/天气/战术节奏是否支持进球方向']
      }),
      {
        market: '大小球',
        finalPick: '冲突观望',
        confidence: Math.max(45, Math.min(60, Math.round((overScore + underScore) / 2 - 10))),
        grade: '冲突观望',
        reason: `大球score=${overScore}，小球score=${underScore}，分差${diff.toFixed(0)}不足以形成单边优势`,
        ruleIds: uniq([...(over.ruleIds || []), ...(under.ruleIds || [])]),
        evidence: uniq([...(over.evidence || []), ...(under.evidence || [])]).slice(0, 6),
        blockers: ['同市场方向互斥', '不建议把大小球放入主推串子'],
        watchPoints: ['等临场盘口二次确认后再升级或放弃'],
        source: { over, under }
      },
      ...others.map(c => asFinal(c, { grade: '低仓候选' }))
    ];
  }

  return [
    {
      market: '大小球',
      finalPick: '冲突观望',
      confidence: Math.max(40, Math.min(58, Math.round((overScore + underScore) / 2 - 12))),
      grade: '冲突观望',
      reason: `大球score=${overScore}，小球score=${underScore}，分差${diff.toFixed(0)}过小，不能二选一`,
      ruleIds: uniq([...(over.ruleIds || []), ...(under.ruleIds || [])]),
      evidence: uniq([...(over.evidence || []), ...(under.evidence || [])]).slice(0, 6),
      blockers: ['同市场大/小互斥', '单边优势不足', '最终推荐剔除大小球主推'],
      watchPoints: ['临场若升盘且大水降，才重新考虑大球', '临场若继续降盘且小水低，才重新考虑小球'],
      source: { over, under }
    },
    ...others.map(c => asFinal(c, { grade: '低仓候选' }))
  ];
}

function arbitrateAsian(group = []) {
  return group.map(c => {
    const t = textOf(c);
    const score = scoreOf(c);
    if (/R-MR-06|高水诱上|诱上|上盘输盘|上盘不胜|退盘|-1\s*→\s*-0\.75/.test(t)) {
      return asFinal(c, {
        grade: score >= 80 ? '风险候选-低仓待确认' : '风险候选',
        finalPick: '规避上盘穿盘 / 下盘受让低中仓候选',
        confidence: Math.min(74, Math.round(score - 10)),
        reason: '亚盘高水诱上/退盘结构优先解释为上盘穿盘风险上升，不等于自动重仓反打；风险候选不得排成TOP主推',
        blockers: ['禁止把上盘诱买直接外推为客胜或小球', '若欧赔骨架仍支持强队胜出，仅限制让球穿盘玩法', '风险候选只做保护/降仓参考，不参与主候选优先级'],
        watchPoints: ['临场是否回升原盘口', '上盘水是否回落到合理区间', '欧赔主胜是否同步下压']
      });
    }
    return asFinal(c);
  });
}

function gradePriority(grade = '') {
  if (/被陷阱降级|风险候选/.test(grade)) return 3;
  if (/主候选/.test(grade)) return 0;
  if (/次级/.test(grade)) return 1;
  if (/低仓/.test(grade)) return 2;
  if (/冲突观望/.test(grade)) return 4;
  return 5;
}

export function arbitrateCandidates(knowledge = {}, context = {}) {
  const candidates = safeArray(knowledge?.candidates);
  if (!candidates.length) return [];

  const groups = {};
  candidates.forEach(c => {
    const k = normalizeMarket(c);
    (groups[k] = groups[k] || []).push(c);
  });

  let finals = [];
  Object.entries(groups).forEach(([market, group]) => {
    if (market === 'overunder') finals.push(...arbitrateOverUnder(group));
    else if (market === 'asian') finals.push(...arbitrateAsian(group));
    else finals.push(...group.map(c => asFinal(c)));
  });

  // 盘口陷阱纪律：若专业盘口层已经声明 favorite_handicap 降级，则压制纯上盘穿盘候选。
  const trap = context?.professionalMarket?.trapDiscipline || context?.trapDiscipline || null;
  const affected = safeArray(trap?.affectedMarkets).join(' ');
  if (/favorite_handicap|deep_handicap|favorite_heavy/.test(affected)) {
    finals = finals.map(f => {
      const t = `${f.market} ${f.finalPick} ${textOf(f.source)}`;
      if (/上盘|穿盘|热门|favorite/.test(t) && !/规避|风险|下盘|受让/.test(t)) {
        return {
          ...f,
          grade: '被陷阱降级',
          confidence: Math.min(f.confidence, 58),
          blockers: uniq([...(f.blockers || []), '陷阱纪律命中 favorite_handicap：上盘穿盘候选降级']),
          watchPoints: uniq([...(f.watchPoints || []), '只有盘口回正且水位回落才可重新升级'])
        };
      }
      return f;
    });
  }

  return finals
    .filter(Boolean)
    .sort((a, b) => gradePriority(a.grade) - gradePriority(b.grade) || num(b.confidence) - num(a.confidence))
    .slice(0, 8);
}

export function finalCandidatesToMarkdown(finals = [], title = '**最终候选仲裁排序**') {
  const list = safeArray(finals);
  if (!list.length) return '';
  const L = [title];
  list.forEach((c, i) => {
    L.push(`${i + 1}. ${c.market}：${c.finalPick}（${c.grade}，confidence=${c.confidence}，规则=${safeArray(c.ruleIds).join('+') || '-'}）`);
    if (c.reason) L.push(`   - 裁决：${c.reason}`);
    if (safeArray(c.evidence).length) L.push(`   - 证据：${safeArray(c.evidence).slice(0, 3).join('；')}`);
    if (safeArray(c.blockers).length) L.push(`   - 压制/风险：${safeArray(c.blockers).slice(0, 3).join('；')}`);
    if (safeArray(c.watchPoints).length) L.push(`   - 临场复核：${safeArray(c.watchPoints).slice(0, 3).join('；')}`);
  });
  return L.join('\n');
}

export default { arbitrateCandidates, finalCandidatesToMarkdown };
