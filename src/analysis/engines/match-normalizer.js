/**
 * match-normalizer.js — 知识库字段归一层
 *
 * 目标：把采集到的 titan007 原始结构归一为规则引擎、量化引擎、AI Prompt
 * 可共同消费的稳定字段。此层只做字段提取、缺失标注与轻量派生，不直接下结论。
 */

function num(v) {
  if (v === null || v === undefined) return NaN;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[^0-9.+\-]/g, '');
  if (!s || s === '+' || s === '-' || s === '.') return NaN;
  return parseFloat(s);
}

function isFiniteNum(v) {
  return Number.isFinite(num(v));
}

function asText(v, fallback = '') {
  if (v === null || v === undefined) return fallback;
  return String(v).trim() || fallback;
}

function firstDefined(...values) {
  for (const v of values) {
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

function pctToNumber(v) {
  const n = num(v);
  return Number.isFinite(n) ? n : null;
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function pickKeyCompany(section) {
  if (!section || section.error) return null;
  if (section.keyOdds?.ao) return section.keyOdds.ao;
  if (section.companies?.[0]?.mainLine) return { name: section.companies[0].name, ...section.companies[0].mainLine };
  if (section.companies?.[0]) return section.companies[0];
  return null;
}

function pickAsianCompany(section) {
  if (!section || section.error) return null;
  if (section.keyOdds?.ao) return section.keyOdds.ao;
  if (section.companies?.[0]?.mainLine) return { name: section.companies[0].name, ...section.companies[0].mainLine };
  if (section.companies?.[0]) return section.companies[0];
  if (section.keyOdds?.allCurrent?.[0]) return section.keyOdds.allCurrent[0];
  return null;
}

function pickOverUnderCompany(section) {
  if (!section || section.error) return null;
  if (section.keyOdds?.ao) return section.keyOdds.ao;
  if (section.companies?.[0]?.mainLine) return { name: section.companies[0].name, ...section.companies[0].mainLine };
  if (section.companies?.[0]) return section.companies[0];
  if (section.allOdds?.[0]) return section.allOdds[0];
  if (section.keyOdds?.allCurrent?.[0]) return section.keyOdds.allCurrent[0];
  return null;
}

function consensusLine(consensus = {}, validator = () => false) {
  const entries = Object.entries(consensus || {}).filter(([line]) => validator(line));
  if (!entries.length) return null;
  return entries.sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))[0][0];
}

function buildLineConsensus(companies = [], getter = () => null, validator = () => false) {
  const counts = {};
  safeArray(companies).forEach(c => {
    const line = getter(c);
    if (validator(line)) counts[String(line)] = (counts[String(line)] || 0) + 1;
  });
  return counts;
}

function buildAsianFromComparativeOdds(comparativeOdds = []) {
  const companies = safeArray(comparativeOdds).map((co, idx) => {
    const current = co.current || co;
    const initial = co.initial || {};
    const currentLine = firstDefined(current.actualLine, current.handicap, current.line);
    if (!isAsianLineValue(currentLine)) return null;
    return {
      name: asText(co.name, `比较${idx + 1}`),
      mainLine: {
        initialHome: firstDefined(initial.actualHome, initial.home),
        initialHandicap: firstDefined(initial.actualLine, initial.handicap, initial.line, currentLine),
        initialAway: firstDefined(initial.actualAway, initial.away),
        currentHome: firstDefined(current.actualHome, current.home),
        currentHandicap: currentLine,
        currentAway: firstDefined(current.actualAway, current.away)
      },
      subLines: []
    };
  }).filter(Boolean);
  if (!companies.length) return null;
  const lineConsensus = buildLineConsensus(companies, c => c.mainLine?.currentHandicap, isAsianLineValue);
  return {
    companies,
    summary: { mainLine: consensusLine(lineConsensus, isAsianLineValue), lineConsensus, source: 'analysis.comparativeOdds' },
    keyOdds: {
      ao: companies[0] ? { name: companies[0].name, ...companies[0].mainLine } : null,
      crown: companies[1] ? { name: companies[1].name, ...companies[1].mainLine } : null,
      allCurrent: companies.map(c => ({ name: c.name, home: c.mainLine.currentHome, line: c.mainLine.currentHandicap, away: c.mainLine.currentAway }))
    },
    source: 'analysis.comparativeOdds'
  };
}

function buildOverUnderFromComparativeOdds(comparativeOdds = []) {
  const companies = safeArray(comparativeOdds).map((co, idx) => {
    const current = co.current || co;
    const initial = co.initial || {};
    const currentLine = firstDefined(current.ouLine, current.currentLine, current.line);
    if (!isOuLineValue(currentLine)) return null;
    const line = {
      initialOver: firstDefined(initial.ouOver, initial.over),
      initialLine: firstDefined(initial.ouLine, initial.initialLine, initial.line, currentLine),
      initialUnder: firstDefined(initial.ouUnder, initial.under),
      currentOver: firstDefined(current.ouOver, current.over),
      currentLine,
      currentUnder: firstDefined(current.ouUnder, current.under)
    };
    return { name: asText(co.name, `比较${idx + 1}`), mainLine: line, subLines: [] };
  }).filter(Boolean);
  if (!companies.length) return null;
  const lineConsensus = buildLineConsensus(companies, c => c.mainLine?.currentLine, isOuLineValue);
  return {
    companies,
    allOdds: companies.map(c => c.mainLine),
    summary: { mainLine: consensusLine(lineConsensus, isOuLineValue), lineConsensus, source: 'analysis.comparativeOdds' },
    keyOdds: {
      ao: companies[0] ? { name: companies[0].name, ...companies[0].mainLine } : null,
      crown: companies[1] ? { name: companies[1].name, ...companies[1].mainLine } : null,
      allCurrent: companies.map(c => ({ name: c.name, over: c.mainLine.currentOver, line: c.mainLine.currentLine, under: c.mainLine.currentUnder }))
    },
    source: 'analysis.comparativeOdds'
  };
}

function waterToDecimal(v) {
  const n = num(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1.3 ? n : n + 1;
}

function parseOuLineValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  const parts = text.split('/').map(v => Number(String(v).trim()));
  if (!parts.length || parts.some(v => !Number.isFinite(v))) return null;
  return parts.reduce((sum, v) => sum + v, 0) / parts.length;
}

function isOuLineValue(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?$/.test(text)) return false;
  if (/^[01]\.\d{2}$/.test(text)) return false;
  const parts = text.split('/').map(v => Number(v));
  if (!parts.length || parts.some(v => !Number.isFinite(v) || v < 1.5 || v > 5.5 || Math.abs(v * 4 - Math.round(v * 4)) > 1e-6)) return false;
  return parts.length === 1 || (parts.length === 2 && Math.abs(parts[1] - parts[0] - 0.5) < 1e-6);
}

function isAsianLineValue(line) {
  const text = asText(line);
  if (!text || /^[01]\.\d{2}$/.test(text)) return false;
  const allowed = new Set([
    '受让两球半', '受让两球/两球半', '受让两球', '受让球半/两球', '受让球半', '受让一球/球半',
    '受让一球', '受让半球/一球', '受让半球', '受让平手/半球',
    '平手', '平手/半球', '半球', '半球/一球', '一球', '一球/球半', '球半', '球半/两球',
    '两球', '两球/两球半', '两球半', '两球半/三球', '三球'
  ]);
  return allowed.has(text);
}

function handicapValue(line) {
  if (typeof line === 'number') return line;
  const s = asText(line);
  const map = {
    '受让两球半': -2.5, '受让两球/两球半': -2.25, '受让两球': -2, '受让球半/两球': -1.75, '受让球半': -1.5, '受让一球/球半': -1.25,
    '受让一球': -1, '受让半球/一球': -0.75, '受让半球': -0.5, '受让平手/半球': -0.25,
    '平手': 0, '平手/半球': 0.25, '半球': 0.5, '半球/一球': 0.75,
    '一球': 1, '一球/球半': 1.25, '球半': 1.5, '球半/两球': 1.75,
    '两球': 2, '两球/两球半': 2.25, '两球半': 2.5, '两球半/三球': 2.75, '三球': 3
  };
  if (Object.prototype.hasOwnProperty.call(map, s)) return map[s];
  const n = num(s);
  return Number.isFinite(n) ? n : null;
}

function parseMatchDateTime(timeText, now = new Date()) {
  const text = asText(timeText);
  if (!text) return null;

  let m = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (m) {
    const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
    return Number.isFinite(dt.getTime()) ? dt : null;
  }

  m = text.match(/(\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (m) {
    const dt = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]), 0, 0);
    return Number.isFinite(dt.getTime()) ? dt : null;
  }

  m = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m) {
    const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2]), 0, 0);
    if (dt.getTime() < now.getTime() - 12 * 3600 * 1000) dt.setDate(dt.getDate() + 1);
    return Number.isFinite(dt.getTime()) ? dt : null;
  }

  return null;
}

function buildTimeContext(matchInfo, fetchTime) {
  const now = fetchTime ? new Date(fetchTime) : new Date();
  const kickoff = parseMatchDateTime(matchInfo?.time, now);
  if (!kickoff || !Number.isFinite(kickoff.getTime()) || !Number.isFinite(now.getTime())) {
    return {
      phase: 'unknown',
      phaseLabel: '时间未知',
      hoursToKickoff: null,
      minutesToKickoff: null,
      kickoffAt: '',
      note: '未识别开赛时间，胜负/亚盘按盘口证据判断，大小球需临场复核'
    };
  }

  const minutes = Math.round((kickoff.getTime() - now.getTime()) / 60000);
  const hours = Math.round((minutes / 60) * 10) / 10;
  let phase = 'early';
  let phaseLabel = '早盘观察';
  let note = '距离开赛较远，方向只作候选，等待盘口继续发酵';

  if (minutes <= 0) {
    phase = 'live_or_closed';
    phaseLabel = '已开赛/赛后';
    note = '赛前模型不再适用，应切换滚球或赛后复盘口径';
  } else if (minutes <= 30) {
    phase = 'closing';
    phaseLabel = '临场执行窗口';
    note = '临场水位已接近最终形态，胜负/亚盘/大小球都可做最终升降级';
  } else if (minutes <= 90) {
    phase = 'lineup';
    phaseLabel = '首发确认窗口';
    note = '首发与伤停是核心变量，大小球可开始从候选转执行';
  } else if (minutes <= 6 * 60) {
    phase = 'main_market';
    phaseLabel = '胜负/亚盘主判断窗口';
    note = '赛前4-6小时附近，胜负盘/亚盘若证据闭环可维持中高；大小球仍需临场确认';
  } else if (minutes <= 24 * 60) {
    phase = 'preheat';
    phaseLabel = '赛前预热窗口';
    note = '可建立基准方向，但不宜把大小球和临场变量定死';
  }

  return {
    phase,
    phaseLabel,
    hoursToKickoff: hours,
    minutesToKickoff: minutes,
    kickoffAt: kickoff.toISOString(),
    note
  };
}

function inferPopularitySide(normalized) {
  const ac = normalized.odds.averageCurrent;
  if (ac && isFiniteNum(ac.win) && isFiniteNum(ac.loss)) {
    const w = num(ac.win), l = num(ac.loss);
    if (w + 0.18 < l) return 'home';
    if (l + 0.18 < w) return 'away';
  }
  const asian = normalized.asian;
  if (asian.currentHomeWater != null && asian.currentAwayWater != null) {
    if (asian.currentHomeWater + 0.08 < asian.currentAwayWater) return 'home';
    if (asian.currentAwayWater + 0.08 < asian.currentHomeWater) return 'away';
  }
  return 'balanced_or_unknown';
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function hasUsableRecentStats(rs) {
  if (!rs) return false;
  const values = [rs.homeFor, rs.homeAgainst, rs.awayFor, rs.awayAgainst].map(v => num(v));
  if (!values.every(Number.isFinite)) return false;
  if (values.every(v => v === 0)) return false;
  return values.every(v => v >= 0 && v <= 8);
}

function noVigFromAverageOdds(odds = {}) {
  const w = num(odds.win), d = num(odds.draw), l = num(odds.loss);
  if (!(w > 1 && d > 1 && l > 1)) return null;
  const iw = 1 / w, id = 1 / d, il = 1 / l;
  const sum = iw + id + il;
  if (!(sum > 0)) return null;
  return { win: iw / sum, draw: id / sum, loss: il / sum };
}

function buildMarketImpliedRecentStats(normalized) {
  const totalGoals = Number.isFinite(normalized?.overunder?.currentLine) ? normalized.overunder.currentLine : NaN;
  const probs = noVigFromAverageOdds(normalized?.odds?.averageCurrent || {});
  if (!Number.isFinite(totalGoals) || !probs) return null;
  const decisive = probs.win + probs.loss;
  if (!(decisive > 0)) return null;
  const homeShareRaw = probs.win / decisive;
  const asianBias = Number.isFinite(normalized?.asian?.currentLineValue) ? clamp(normalized.asian.currentLineValue * 0.035, -0.08, 0.08) : 0;
  const homeGoalShare = clamp(homeShareRaw * 0.72 + 0.14 + asianBias, 0.22, 0.84);
  const safeTotal = clamp(totalGoals, 1.6, 4.5);
  const homeFor = Number((safeTotal * homeGoalShare).toFixed(2));
  const awayFor = Number((safeTotal - homeFor).toFixed(2));
  return {
    homeFor,
    homeAgainst: awayFor,
    awayFor,
    awayAgainst: homeFor,
    leagueAvg: 1.35,
    source: 'market-implied-recentStats',
    confidence: 'fallback_low',
    method: '源站近期进失球缺失时，用欧赔去水强弱 + 大小球主线推导泊松模型可用的低置信攻防先验',
    warning: '该字段不是源站实采近期战绩，只用于避免模型无输入；预测置信必须降级并等待真实近期数据补采。'
  };
}

function buildCompleteness(n) {
  const fieldDefs = [
    {
      key: 'matchInfo',
      label: '主客队/赛事信息',
      tier: 'core',
      source: '分析页 analysis matchInfo',
      impact: '没有队名会导致球队画像、盘口方向和报告对阵全部错位。',
      repair: '重新采集分析页；若页面仍是默认主队/客队，先核对比赛ID是否正确。',
      ok: !!n.matchInfo.home && !!n.matchInfo.away && !['主队', '客队'].includes(n.matchInfo.home) && !['主队', '客队'].includes(n.matchInfo.away)
    },
    {
      key: 'winDrawWin.averageCurrent',
      label: '欧赔即时均赔',
      tier: 'core',
      source: '欧赔页 oddslist / winDrawWin.summary.averageCurrent',
      impact: '缺欧赔会削弱去水概率、热门侧、人气侧和平赔防冷判断。',
      repair: '补采欧赔页；若公司表缺失，等待欧赔开盘后重采。',
      ok: !!n.odds.averageCurrent
    },
    {
      key: 'winDrawWin.companies',
      label: '欧赔公司明细',
      tier: 'core',
      source: '欧赔页公司列表 / winDrawWin.companies',
      impact: '缺公司明细会丢失初即变化、凯利和公司分歧，影响盘口经验规则。',
      repair: '补采欧赔页并确认页面公司表已加载完成。',
      ok: n.odds.companyCount > 0
    },
    {
      key: 'asian.mainLine',
      label: '亚让主盘口',
      tier: 'core',
      source: '亚盘页 AsianOdds_n.aspx / analysis.comparativeOdds 兜底',
      impact: '这是预测硬门禁字段，缺失或错把水位当盘口时禁止输出方向。',
      repair: '补采亚盘页；若仍缺失，使用后台 fetch 兜底并核对公司名列/盘口列解析。',
      ok: !!n.asian.mainLine && n.asian.lineQuality?.valid !== false
    },
    {
      key: 'overunder.mainLine',
      label: '大小球主盘口',
      tier: 'core',
      source: '大小球页 OverDown_n.aspx / analysis.comparativeOdds 兜底',
      impact: '缺大小球会误判进球环境、平赔保护和比分模板。',
      repair: '补采大小球页；若显示 0.8/1.0 这类水位，必须修解析，不能当进球线。',
      ok: !!n.overunder.mainLine && n.overunder.lineQuality?.valid !== false
    },
    {
      key: 'recentStats',
      label: '近期攻防/走势统计',
      tier: 'core',
      source: '分析页近期战绩/趋势表；源站缺失时使用市场隐含 fallback',
      impact: '缺近期状态会让战绩修正、进球均值和风险画像降级；若使用市场隐含 fallback，只能低置信预测。',
      repair: '补采分析页；若页面没有真实近期进失球，使用欧赔去水强弱 + 大小球主线生成低置信 fallback，并继续等待真实数据。',
      ok: hasUsableRecentStats(n.stats.recentStats)
    },
    {
      key: 'injuries',
      label: '伤停/缺阵信息',
      tier: 'enhancement',
      source: '分析页伤停区或外部情报',
      impact: '影响最后 20% 基本面修正；源站经常无数据，不应单独阻断预测。',
      repair: '优先重新采集分析页；若源站无伤停，使用球队新闻/首发情报人工或联网补强，并标记待确认。',
      ok: n.stats.injuries.home.length > 0 || n.stats.injuries.away.length > 0
    },
    {
      key: 'seasonComparison',
      label: '赛季进失球/主客场对比',
      tier: 'enhancement',
      source: '分析页数据统计比较',
      impact: '影响强弱基准、主客场进失球和 Poisson 先验，不应覆盖盘口核心。',
      repair: '补采分析页赛季统计表；若赛事样本不足，用近期战绩和球队画像降级替代。',
      ok: !!n.stats.seasonComparison
    },
    {
      key: 'headToHead',
      label: '历史交锋',
      tier: 'enhancement',
      source: '分析页交锋往绩表',
      impact: '只作为风格/心理/ matchup 辅助，样本老旧时权重应低。',
      repair: '补采分析页交锋表；若两队无交锋，不应硬凑数据，只标记“无可用交锋样本”。',
      ok: n.stats.headToHead.length > 0
    }
  ];
  const details = fieldDefs.map(def => ({
    key: def.key,
    label: def.label,
    tier: def.tier,
    source: def.source,
    impact: def.impact,
    repair: def.repair,
    ok: !!def.ok
  }));
  const checks = details.map(d => [d.key, d.ok]);
  const coreDetails = details.filter(d => d.tier === 'core');
  const enhancementDetails = details.filter(d => d.tier === 'enhancement');
  const present = details.filter(d => d.ok).map(d => d.key);
  const missing = details.filter(d => !d.ok).map(d => d.key);
  const corePresent = coreDetails.filter(d => d.ok).map(d => d.key);
  const coreMissing = coreDetails.filter(d => !d.ok).map(d => d.key);
  const enhancementPresent = enhancementDetails.filter(d => d.ok).map(d => d.key);
  const enhancementMissing = enhancementDetails.filter(d => !d.ok).map(d => d.key);
  const score = Math.round((corePresent.length / Math.max(1, coreDetails.length)) * 100);
  const overallScore = Math.round((present.length / Math.max(1, details.length)) * 100);
  const enhancementScore = Math.round((enhancementPresent.length / Math.max(1, enhancementDetails.length)) * 100);
  const level = score >= 84 ? 'high' : score >= 67 ? 'medium' : 'low';
  const overallLevel = overallScore >= 78 ? 'high' : overallScore >= 55 ? 'medium' : 'low';
  const repairActions = details
    .filter(d => !d.ok)
    .map(d => `${d.label}：${d.repair}`);
  const coreReady = coreMissing.length === 0;
  const summary = coreReady
    ? `核心预测字段完整${enhancementMissing.length ? `；增强字段缺 ${enhancementMissing.length} 项，不应硬凑 100%，需补强后提高置信。` : '；全量增强字段也完整。'}`
    : `核心字段缺 ${coreMissing.length} 项，必须补采后再输出预测方向。`;
  return {
    score,
    level,
    present,
    missing,
    checks,
    details,
    coreScore: score,
    coreReady,
    corePresent,
    coreMissing,
    enhancementScore,
    enhancementPresent,
    enhancementMissing,
    overallScore,
    overallLevel,
    repairActions,
    summary
  };
}

function buildDataQuality(n) {
  const issues = [];
  const hardBlocks = [];
  if (!n.matchInfo.home || !n.matchInfo.away || ['主队', '客队'].includes(n.matchInfo.home) || ['主队', '客队'].includes(n.matchInfo.away)) {
    hardBlocks.push('主客队信息缺失或疑似默认值');
  }
  if (!n.asian.lineQuality?.valid || !n.asian.mainLine || n.asian.currentLineValue === null) {
    hardBlocks.push(`亚盘主盘口异常：${n.asian.lineQuality?.rawCurrentLine || n.asian.mainLine || 'missing'}，禁止输出方向`);
  }
  if (n.asian.lineQuality?.flags?.length) {
    issues.push(...n.asian.lineQuality.flags);
  }
  if (!n.overunder.lineQuality?.valid) {
    hardBlocks.push(`大小球进球线异常：${n.overunder.lineQuality?.rawCurrentLine || 'missing'}，禁止输出方向`);
  }
  if (n.overunder.lineQuality?.flags?.length) {
    issues.push(...n.overunder.lineQuality.flags);
  }
  if (n.overunder.currentLine !== null && (n.overunder.currentLine < 1.5 || n.overunder.currentLine > 5.5)) {
    hardBlocks.push(`大小球进球线超出职业赛前范围：${n.overunder.currentLine}`);
  }
  const completeness = n.derived?.dataCompleteness;
  if (completeness && completeness.score < 55) issues.push(`数据完整度过低：${completeness.score}%`);
  if (n.stats?.recentStats?.source === 'market-implied-recentStats') {
    issues.push('近期攻防缺真实源站数据，已使用欧赔/大小球市场隐含 fallback，预测置信降级');
  }
  if (n.stats?.recentStatsStatus?.status === 'invalid_or_placeholder') {
    issues.push(n.stats.recentStatsStatus.reason || '分析页近期攻防疑似占位数据，已拒绝作为真实近期状态');
  }
  const scorePenalty = hardBlocks.length * 35 + issues.length * 10;
  const score = Math.max(0, Math.min(100, 100 - scorePenalty));
  const level = hardBlocks.length ? 'blocked' : score >= 80 ? 'high' : score >= 60 ? 'medium' : 'low';
  return {
    score,
    level,
    issues,
    hardBlocks,
    canPredict: hardBlocks.length === 0,
    blockPrediction: hardBlocks.length > 0,
    action: hardBlocks.length ? 'block_direction_observe_only' : issues.length ? 'downgrade_confidence' : 'allow'
  };
}

function normalizeOdds(winDrawWin = {}) {
  const sum = winDrawWin.summary || {};
  const key = winDrawWin.keyOdds?.ao || winDrawWin.keyOdds?.allCurrent?.[0] || winDrawWin.companies?.[0] || null;
  const avgCur = sum.averageCurrent || null;
  const avgInit = sum.averageInitial || null;
  const current = avgCur || (key ? {
    win: firstDefined(key.currentWin, key.currentHome, key.win, key.home),
    draw: firstDefined(key.currentDraw, key.draw),
    loss: firstDefined(key.currentLoss, key.currentAway, key.loss, key.away)
  } : null);
  const initial = avgInit || (key ? {
    win: firstDefined(key.initialWin, key.initialHome),
    draw: key.initialDraw,
    loss: firstDefined(key.initialLoss, key.initialAway)
  } : null);
  const movement = sum.movement || {};
  return {
    averageInitial: initial,
    averageCurrent: current,
    movement,
    companyCount: Number(sum.count || winDrawWin.companies?.length || 0),
    impliedAverage: sum.impliedAverage || null,
    averageReturnRate: sum.averageReturnRate || null,
    drawOdds: current?.draw != null ? num(current.draw) : null,
    keyCompanies: safeArray(winDrawWin.companies).slice(0, 8).map(c => ({
      name: c.name,
      initial: { win: c.initialWin, draw: c.initialDraw, loss: c.initialLoss },
      current: { win: c.currentWin, draw: c.currentDraw, loss: c.currentLoss },
      returnRate: c.currentReturnRate || c.returnRate,
      probabilities: c.currentProbabilities,
      kelly: c.kelly,
      changeTime: c.changeTime,
      recent30: !!c.recent30
    }))
  };
}

function normalizeAsian(asian = {}) {
  const key = pickAsianCompany(asian);
  const ml = key?.mainLine || key || {};
  const summaryLine = firstDefined(asian.summary?.mainLine, consensusLine(asian.summary?.lineConsensus, isAsianLineValue));
  const currentHomeWater = num(firstDefined(ml.currentHome, ml.currentHomePay, ml.home, ml.homeWater));
  const currentAwayWater = num(firstDefined(ml.currentAway, ml.currentAwayPay, ml.away, ml.awayWater));
  const initialHomeWater = num(firstDefined(ml.initialHome, ml.initialHomePay));
  const initialAwayWater = num(firstDefined(ml.initialAway, ml.initialAwayPay));
  const rawCurrentLine = firstDefined(ml.currentHandicap, ml.handicap, ml.line, ml.currentLine, summaryLine);
  const rawInitialLine = firstDefined(ml.initialHandicap, ml.initialLine);
  const currentLineValid = isAsianLineValue(rawCurrentLine);
  const initialLineValid = rawInitialLine === null || rawInitialLine === undefined || rawInitialLine === '' || isAsianLineValue(rawInitialLine);
  const mainLine = currentLineValid ? String(rawCurrentLine) : null;
  const currentLineValue = currentLineValid ? handicapValue(rawCurrentLine) : null;
  const initialLineValue = initialLineValid ? handicapValue(rawInitialLine) : null;
  const flags = [];
  if (rawCurrentLine && !currentLineValid) flags.push(`亚盘即时盘口疑似错字段：${rawCurrentLine}`);
  if (rawInitialLine && !initialLineValid) flags.push(`亚盘初始盘口疑似错字段：${rawInitialLine}`);
  if (/^[01]\.\d{2}$/.test(String(rawCurrentLine || ''))) flags.push('亚盘即时盘口命中水位格式，疑似把水位当盘口');
  return {
    mainLine,
    initialLine: initialLineValid ? rawInitialLine || null : null,
    currentLine: currentLineValid ? String(rawCurrentLine) : null,
    initialLineValue,
    currentLineValue,
    currentHomeWater: Number.isFinite(currentHomeWater) ? currentHomeWater : null,
    currentAwayWater: Number.isFinite(currentAwayWater) ? currentAwayWater : null,
    initialHomeWater: Number.isFinite(initialHomeWater) ? initialHomeWater : null,
    initialAwayWater: Number.isFinite(initialAwayWater) ? initialAwayWater : null,
    companyConsensus: isAsianLineValue(asian.summary?.mainLine) ? asian.summary.mainLine : null,
    lineQuality: {
      valid: currentLineValid,
      initialValid: initialLineValid,
      rawCurrentLine: rawCurrentLine ?? '',
      rawInitialLine: rawInitialLine ?? '',
      flags
    },
    summary: asian.summary || {},
    movementPath: safeArray(asian.history).slice(0, 30),
    companies: safeArray(asian.companies).slice(0, 8)
  };
}

function normalizeOverUnder(overunder = {}) {
  const key = pickOverUnderCompany(overunder);
  const ml = key?.mainLine || key || {};
  const summaryLine = firstDefined(overunder.summary?.mainLine, consensusLine(overunder.summary?.lineConsensus, isOuLineValue));
  const rawCurrentLine = firstDefined(ml.currentLine, ml.line, ml.goalLine, summaryLine);
  const rawInitialLine = firstDefined(ml.initialLine);
  const currentLineValid = isOuLineValue(rawCurrentLine);
  const initialLineValid = rawInitialLine === null || isOuLineValue(rawInitialLine);
  const currentLine = currentLineValid ? parseOuLineValue(rawCurrentLine) : null;
  const initialLine = initialLineValid ? parseOuLineValue(rawInitialLine) : null;
  const overWater = num(firstDefined(ml.currentOver, ml.currentOverPay, ml.over, ml.overWater));
  const underWater = num(firstDefined(ml.currentUnder, ml.currentUnderPay, ml.under, ml.underWater));
  const initOverWater = num(firstDefined(ml.initialOver, ml.initialOverPay));
  const initUnderWater = num(firstDefined(ml.initialUnder, ml.initialUnderPay));
  const flags = [];
  if (rawCurrentLine && !currentLineValid) flags.push(`大小球即时进球线疑似错字段：${rawCurrentLine}`);
  if (rawInitialLine && !initialLineValid) flags.push(`大小球初始进球线疑似错字段：${rawInitialLine}`);
  if (/^[01]\.\d{2}$/.test(String(rawCurrentLine || ''))) flags.push('大小球即时进球线命中水位格式，疑似把水位当盘口线');
  return {
    mainLine: currentLineValid ? String(rawCurrentLine) : null,
    initialLine: Number.isFinite(initialLine) ? initialLine : null,
    currentLine: Number.isFinite(currentLine) ? currentLine : null,
    currentOverWater: Number.isFinite(overWater) ? overWater : null,
    currentUnderWater: Number.isFinite(underWater) ? underWater : null,
    initialOverWater: Number.isFinite(initOverWater) ? initOverWater : null,
    initialUnderWater: Number.isFinite(initUnderWater) ? initUnderWater : null,
    overDecimalOdds: waterToDecimal(firstDefined(ml.currentOver, ml.currentOverPay)),
    underDecimalOdds: waterToDecimal(firstDefined(ml.currentUnder, ml.currentUnderPay)),
    lineConsensus: overunder.summary?.lineConsensus || null,
    lineQuality: {
      valid: currentLineValid,
      initialValid: initialLineValid,
      rawCurrentLine: rawCurrentLine ?? '',
      rawInitialLine: rawInitialLine ?? '',
      flags
    },
    summary: overunder.summary || {},
    movementPath: safeArray(overunder.history).slice(0, 30),
    companies: safeArray(overunder.companies).slice(0, 8)
  };
}

function normalizeStats(analysis = {}) {
  return {
    homeStats: analysis.homeStats || null,
    awayStats: analysis.awayStats || null,
    homeHalfStats: analysis.homeHalfStats || null,
    awayHalfStats: analysis.awayHalfStats || null,
    handicapTrend: analysis.handicapTrend || null,
    seasonComparison: analysis.seasonComparison || null,
    recentStats: hasUsableRecentStats(analysis.recentStats) ? analysis.recentStats : null,
    recentStatsStatus: analysis.recentStatsStatus || null,
    recentGoalDistribution: analysis.recentGoalDistribution || null,
    goalSingleDouble: analysis.goalSingleDouble || null,
    halfFull: analysis.halfFull || null,
    goalTimeDistribution: analysis.goalTimeDistribution || null,
    injuries: {
      home: safeArray(analysis.injuries?.home),
      away: safeArray(analysis.injuries?.away)
    },
    headToHead: safeArray(analysis.headToHead),
    homeRecentMatches: safeArray(analysis.homeRecentMatches),
    awayRecentMatches: safeArray(analysis.awayRecentMatches),
    preBriefing: analysis.preBriefing || ''
  };
}

export function normalizeMatch(stored) {
  const data = stored?.data || {};
  const analysis = data.analysis || {};
  const matchInfo = analysis.matchInfo || {};
  let normalizedAsian = normalizeAsian(data.asian || {});
  if (!normalizedAsian.lineQuality?.valid) {
    const fromComparative = buildAsianFromComparativeOdds(analysis.comparativeOdds);
    if (fromComparative) {
      const fallbackAsian = normalizeAsian(fromComparative);
      if (fallbackAsian.lineQuality?.valid) normalizedAsian = { ...fallbackAsian, recoveredFrom: 'analysis.comparativeOdds' };
    }
  }

  let normalizedOverUnder = normalizeOverUnder(data.overunder || {});
  if (!normalizedOverUnder.lineQuality?.valid) {
    const fromComparative = buildOverUnderFromComparativeOdds(analysis.comparativeOdds);
    if (fromComparative) {
      const fallbackOverUnder = normalizeOverUnder(fromComparative);
      if (fallbackOverUnder.lineQuality?.valid) normalizedOverUnder = { ...fallbackOverUnder, recoveredFrom: 'analysis.comparativeOdds' };
    }
  }

  const normalized = {
    generatedAt: new Date().toISOString(),
    matchId: stored?.matchId || data.matchId || null,
    fetchTime: stored?.fetchTime || data.fetchTime || null,
    matchInfo: {
      home: asText(matchInfo.home, '主队'),
      away: asText(matchInfo.away, '客队'),
      league: asText(matchInfo.league),
      time: asText(matchInfo.time),
      venue: asText(matchInfo.venue),
      weather: asText(matchInfo.weather),
      temperature: asText(matchInfo.temperature)
    },
    odds: normalizeOdds(data.winDrawWin || {}),
    asian: normalizedAsian,
    overunder: normalizedOverUnder,
    corner: {
      mainLine: data.corner?.mainLine || data.corner?.companies?.[0]?.currentLine || null,
      companies: safeArray(data.corner?.companies).slice(0, 5)
    },
    stats: normalizeStats(analysis),
    derived: {
      popularitySide: 'balanced_or_unknown',
      dataCompleteness: null,
      dataQuality: null,
      predictionGate: null,
      missingFields: [],
      timeContext: null
    },
    rawRefs: {
      hasAnalysis: !!data.analysis,
      hasWinDrawWin: !!data.winDrawWin && !data.winDrawWin.error,
      hasAsian: !!data.asian && !data.asian.error,
      hasOverunder: !!data.overunder && !data.overunder.error,
      hasCorner: !!data.corner && !data.corner.error
    }
  };

  if (!hasUsableRecentStats(normalized.stats.recentStats)) {
    const recentFallback = buildMarketImpliedRecentStats(normalized);
    if (recentFallback) normalized.stats.recentStats = recentFallback;
  }

  normalized.derived.popularitySide = inferPopularitySide(normalized);
  normalized.derived.dataCompleteness = buildCompleteness(normalized);
  normalized.derived.missingFields = normalized.derived.dataCompleteness.missing;
  normalized.derived.dataQuality = buildDataQuality(normalized);
  normalized.derived.predictionGate = {
    canPredict: normalized.derived.dataQuality.canPredict,
    action: normalized.derived.dataQuality.action,
    hardBlocks: normalized.derived.dataQuality.hardBlocks
  };
  normalized.derived.timeContext = buildTimeContext(normalized.matchInfo, normalized.fetchTime);
  return normalized;
}

export function normalizedToMarkdown(normalized) {
  if (!normalized) return '';
  const L = [];
  const dc = normalized.derived?.dataCompleteness;
  L.push('### 🧱 字段归一快照（知识库口径）');
  L.push(`- 对阵：${normalized.matchInfo.home} vs ${normalized.matchInfo.away}${normalized.matchInfo.league ? ' | ' + normalized.matchInfo.league : ''}`);
  L.push(`- 核心完整度：${dc?.coreScore ?? dc?.score ?? '-'}%（${dc?.level || 'unknown'}）；增强完整度：${dc?.enhancementScore ?? '-'}%；全量字段：${dc?.overallScore ?? dc?.score ?? '-'}%（${dc?.overallLevel || dc?.level || 'unknown'}）`);
  if (dc?.summary) L.push(`- 完整度结论：${dc.summary}`);
  if (dc?.coreMissing?.length) L.push(`- 核心缺失：${dc.coreMissing.join('、')}`);
  if (dc?.enhancementMissing?.length) L.push(`- 增强缺失：${dc.enhancementMissing.join('、')}`);
  if (dc?.repairActions?.length) L.push(`- 补全动作：${dc.repairActions.slice(0, 5).join('；')}`);
  if (normalized.derived?.dataQuality) {
    const dq = normalized.derived.dataQuality;
    L.push(`- 数据可信度：${dq.score ?? '-'}%（${dq.level || 'unknown'}）；预测门禁=${dq.action || '-'}`);
    if (dq.hardBlocks?.length) L.push(`- 预测阻断：${dq.hardBlocks.join('；')}`);
    if (dq.issues?.length) L.push(`- 数据质量提示：${dq.issues.join('；')}`);
  }
  if (normalized.derived?.timeContext) {
    const tc = normalized.derived.timeContext;
    L.push(`- 赛前窗口：${tc.phaseLabel || tc.phase}${tc.hoursToKickoff !== null ? `（距开赛约${tc.hoursToKickoff}小时）` : ''}；${tc.note || ''}`);
  }
  if (normalized.odds.averageCurrent) {
    const o = normalized.odds.averageCurrent;
    L.push(`- 即时均赔：${o.win ?? '-'} / ${o.draw ?? '-'} / ${o.loss ?? '-'}，平赔=${normalized.odds.drawOdds ?? '-'}`);
  }
  L.push(`- 亚盘主流：${normalized.asian.mainLine || '-'}，主水=${normalized.asian.currentHomeWater ?? '-'}，客水=${normalized.asian.currentAwayWater ?? '-'}`);
  L.push(`- 大小球主流：${normalized.overunder.mainLine || '-'}，大水=${normalized.overunder.currentOverWater ?? '-'}，小水=${normalized.overunder.currentUnderWater ?? '-'}`);
  if (normalized.stats?.recentStats?.source) L.push(`- 近期攻防来源：${normalized.stats.recentStats.source}${normalized.stats.recentStats.confidence ? `（${normalized.stats.recentStats.confidence}）` : ''}`);
  L.push(`- 人气侧代理：${normalized.derived.popularitySide}`);
  if (normalized.derived.missingFields?.length) L.push(`- 缺失字段：${normalized.derived.missingFields.join('、')}`);
  return L.join('\n');
}

export { num, handicapValue, waterToDecimal, isOuLineValue, parseOuLineValue, isAsianLineValue };
