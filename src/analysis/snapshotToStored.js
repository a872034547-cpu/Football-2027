/**
 * snapshotToStored.js
 * 将 titanMatchCollector 采集的 Playwright 快照转换为
 * background.js `stored` / `storeData` 兼容格式
 *
 * normalizeMatch(stored) 期望：
 *   stored.data.analysis.matchInfo.home / away / league / time
 *   stored.data.winDrawWin   → { companies, keyOdds, summary.averageCurrent }
 *   stored.data.asian        → { companies, keyOdds.ao.currentHandicap(中文盘口), summary }
 *   stored.data.overunder    → { companies, keyOdds.ao.currentLine(数字), summary }
 *
 * 关键约束：
 *   - asian.keyOdds.ao.currentHandicap 必须是 isAsianLineValue 接受的中文名称
 *   - overunder.keyOdds.ao.currentLine 必须是 isOuLineValue 接受的数字（1.5~5.5，0.25步长）
 */

// ─── 亚盘中文盘口映射 ─────────────────────────────────────────

/** 数字让球值 → 中文标准盘口名称（match-normalizer.js isAsianLineValue 期望值） */
const HANDICAP_NUM_TO_CN = {
  '-2.5': '受让两球半',
  '-2.25': '受让两球/两球半',
  '-2': '受让两球',
  '-2.0': '受让两球',
  '-1.75': '受让球半/两球',
  '-1.5': '受让球半',
  '-1.25': '受让一球/球半',
  '-1': '受让一球',
  '-1.0': '受让一球',
  '-0.75': '受让半球/一球',
  '-0.5': '受让半球',
  '-0.25': '受让平手/半球',
  '0': '平手',
  '0.0': '平手',
  '0.25': '平手/半球',
  '0.5': '半球',
  '0.75': '半球/一球',
  '1': '一球',
  '1.0': '一球',
  '1.25': '一球/球半',
  '1.5': '球半',
  '1.75': '球半/两球',
  '2': '两球',
  '2.0': '两球',
  '2.25': '两球/两球半',
  '2.5': '两球半',
  '2.75': '两球半/三球',
  '3': '三球',
  '3.0': '三球',
};

/**
 * 将数字或字符串让球值转换为中文盘口名称
 * 优先直接查映射，回退到四舍五入到最近的 0.25 步长
 * @param {string|number} line
 * @returns {string|null}
 */
function numToCnHandicap(line) {
  if (!line && line !== 0) return null;
  const s = String(line).trim();

  // 直接映射命中
  if (HANDICAP_NUM_TO_CN[s]) return HANDICAP_NUM_TO_CN[s];

  // 尝试解析为数字
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;

  // 四舍五入到 0.25 步长
  const rounded = Math.round(n * 4) / 4;
  const roundedStr = String(rounded);
  if (HANDICAP_NUM_TO_CN[roundedStr]) return HANDICAP_NUM_TO_CN[roundedStr];

  // 再试正负号变体
  const variants = [
    String(Math.round(rounded * 10) / 10),
    rounded.toFixed(1),
    rounded.toFixed(2),
  ];
  for (const v of variants) {
    if (HANDICAP_NUM_TO_CN[v]) return HANDICAP_NUM_TO_CN[v];
  }

  return null;
}

/**
 * 验证大小球盘口是否合法（1.5~5.5，0.25步长，或 "X/Y" 格式）
 */
function isValidOuLine(line) {
  if (line === null || line === undefined) return false;
  const s = String(line).trim();
  if (!/^\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?$/.test(s)) return false;
  if (/^[01]\.\d{2}$/.test(s)) return false;
  const parts = s.split('/').map(v => Number(v));
  if (!parts.length || parts.some(v => !Number.isFinite(v) || v < 1.5 || v > 5.5)) return false;
  const validStep = v => Math.abs(v * 4 - Math.round(v * 4)) < 1e-6;
  return parts.every(validStep) && (parts.length === 1 || (parts.length === 2 && Math.abs(parts[1] - parts[0] - 0.5) < 1e-6));
}

/**
 * 将大小球盘口标准化为合法字符串（数字精度对齐到 0.25 步长）
 */
function normalizeOuLineSafe(line) {
  if (line === null || line === undefined || line === '') return null;
  const s = String(line).trim();

  // 已是合法格式
  if (isValidOuLine(s)) return s;

  // 尝试纯数字
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;

  // 四舍五入到 0.25 步长
  const rounded = Math.round(n * 4) / 4;
  if (rounded < 1.5 || rounded > 5.5) return null;

  // 尝试常见大小球盘口格式
  const candidates = [
    String(rounded),
    rounded.toFixed(1),
    rounded.toFixed(0),
  ];
  for (const c of candidates) {
    if (isValidOuLine(c)) return c;
  }

  // 尝试区间格式：2.5 → "2.5"，2.75 → "2.5/3"
  if (Math.abs(rounded - Math.floor(rounded)) === 0.75) {
    const lo = Math.floor(rounded) + 0.5;
    const hi = Math.floor(rounded) + 1;
    const frac = `${lo}/${hi}`;
    if (isValidOuLine(frac)) return frac;
  }
  if (Math.abs(rounded - Math.floor(rounded)) === 0.25) {
    const lo = Math.floor(rounded);
    const hi = lo + 0.5;
    const frac = `${lo}/${hi}`;
    if (isValidOuLine(frac)) return frac;
  }

  return null;
}

// ─── 主转换函数 ───────────────────────────────────────────────

/**
 * 将 titanMatchCollector 快照和 titanToday 比赛信息转换为 stored 格式
 * @param {Object} snapshot   来自 titanMatchCollector.collectMatchDetail
 * @param {Object} todayMatch 来自 titanTodayCollector 的今日比赛条目
 * @returns {Object} stored 兼容对象（normalizeMatch 可消费）
 */
export function snapshotToStored(snapshot, todayMatch = {}) {
  const matchId = snapshot?.matchId || todayMatch?.matchId || '';
  const now = new Date().toISOString();

  const homeFromAnalysis = snapshot?.analysis?.homeTeam || '';
  const awayFromAnalysis = snapshot?.analysis?.awayTeam || '';

  // ── 基本信息 ────────────────────────────────────────────────
  // normalizeMatch 从 data.analysis.matchInfo 取队名和时间
  const internalMatchInfo = {
    home: homeFromAnalysis || todayMatch?.home || '',
    away: awayFromAnalysis || todayMatch?.away || '',
    league: todayMatch?.league || '',
    time: todayMatch?.matchTime || '',   // 注意：是 time 而非 matchTime
    venue: '',
    weather: '',
    temperature: '',
  };

  // ── 欧赔/胜平负 ─────────────────────────────────────────────
  const winDrawWin = buildWinDrawWin(snapshot?.analysis?.winDrawWin || {});

  // ── 亚盘 ────────────────────────────────────────────────────
  const asian = buildAsian(snapshot?.asian || {});

  // ── 大小球 ──────────────────────────────────────────────────
  const overunder = buildOverUnder(snapshot?.overunder || {});

  // ── 基本面 ──────────────────────────────────────────────────
  const analysis = buildAnalysis(snapshot?.analysis || {}, internalMatchInfo);

  // ── 竞彩 ────────────────────────────────────────────────────
  const jingcai = todayMatch?.jingcai || null;

  return {
    matchId,
    fetchTime: now,
    completenessScore: snapshot?.completenessScore ?? 0,
    errors: snapshot?.errors || [],
    data: {
      matchInfo: internalMatchInfo,        // 顶层 matchInfo（部分旧代码可能读这里）
      analysis: {
        ...analysis,
        matchInfo: internalMatchInfo,      // normalizeMatch 从这里读！
      },
      winDrawWin,
      asian,
      overunder,
      corner: null,
      jingcai,
      marketTimeline: null,
    },
  };
}

// ─── 子格式构建函数 ───────────────────────────────────────────

/**
 * 欧赔（胜平负）归一化
 * normalizeOdds 期望：companies[].currentWin/Draw/Loss，summary.averageCurrent
 */
function buildWinDrawWin(raw) {
  if (!raw || !Array.isArray(raw.companies) || raw.companies.length === 0) {
    return { companies: [], error: '欧赔数据未采集', keyOdds: null, summary: null };
  }

  const companies = raw.companies.map(c => {
    const w = parseFloat(c.win), d = parseFloat(c.draw), l = parseFloat(c.lose);
    if (!isValidOdds(w) || !isValidOdds(d) || !isValidOdds(l)) return null;
    return {
      name: c.name || '未知',
      currentWin: w,
      currentDraw: d,
      currentLoss: l,
      initialWin: null,
      initialDraw: null,
      initialLoss: null,
    };
  }).filter(Boolean);

  if (companies.length === 0) {
    return { companies: [], error: '欧赔数据解析失败', keyOdds: null, summary: null };
  }

  const avgWin = avg(companies.map(c => c.currentWin));
  const avgDraw = avg(companies.map(c => c.currentDraw));
  const avgLoss = avg(companies.map(c => c.currentLoss));

  return {
    companies,
    keyOdds: {
      ao: {
        name: companies[0].name,
        currentWin: companies[0].currentWin,
        currentDraw: companies[0].currentDraw,
        currentLoss: companies[0].currentLoss,
      },
    },
    summary: {
      averageCurrent: {
        win: String(avgWin.toFixed(2)),
        draw: String(avgDraw.toFixed(2)),
        loss: String(avgLoss.toFixed(2)),
      },
      companyCount: companies.length,
    },
  };
}

/**
 * 亚盘归一化
 * 关键：currentHandicap 必须是 isAsianLineValue 认可的中文盘口名称
 */
function buildAsian(raw) {
  if (!raw || (!Array.isArray(raw.companies) && !raw.mainLine)) {
    return { companies: [], error: '亚盘数据未采集', keyOdds: null, summary: null };
  }

  const companies = (Array.isArray(raw.companies) ? raw.companies : []).map(c => {
    const hw = parseFloat(c.homeWater), aw = parseFloat(c.awayWater);
    if (!isValidWater(hw) || !isValidWater(aw)) return null;
    const cnLine = numToCnHandicap(c.line);
    return {
      name: c.name || '未知',
      mainLine: {
        currentHome: hw,
        currentHandicap: cnLine,
        currentAway: aw,
        initialHome: null,
        initialHandicap: cnLine,
        initialAway: null,
      },
      subLines: [],
    };
  }).filter(Boolean);

  if (companies.length === 0) {
    // 只有汇总数据时
    if (raw.mainLine && isValidWater(raw.mainHomeWater) && isValidWater(raw.mainAwayWater)) {
      const cnLine = numToCnHandicap(raw.mainLine);
      companies.push({
        name: '主要盘口',
        mainLine: {
          currentHome: parseFloat(raw.mainHomeWater),
          currentHandicap: cnLine,
          currentAway: parseFloat(raw.mainAwayWater),
          initialHome: null,
          initialHandicap: cnLine,
          initialAway: null,
        },
        subLines: [],
      });
    }
  }

  if (companies.length === 0) {
    return { companies: [], error: '亚盘数据解析失败（盘口格式无法识别）', keyOdds: null, summary: null };
  }

  const mainLine = companies[0].mainLine;
  const cnHandicap = mainLine.currentHandicap;

  // 计算盘口共识
  const lineConsensus = {};
  for (const c of companies) {
    const l = c.mainLine.currentHandicap;
    if (l) lineConsensus[l] = (lineConsensus[l] || 0) + 1;
  }
  const consensusLine = Object.entries(lineConsensus).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  return {
    companies,
    keyOdds: {
      ao: {
        name: companies[0].name,
        currentHome: mainLine.currentHome,
        currentHandicap: cnHandicap,
        currentAway: mainLine.currentAway,
        initialHome: null,
        initialHandicap: cnHandicap,
        initialAway: null,
      },
      allCurrent: companies.map(c => ({
        name: c.name,
        home: c.mainLine.currentHome,
        line: c.mainLine.currentHandicap,
        away: c.mainLine.currentAway,
      })),
    },
    summary: {
      mainLine: consensusLine,
      lineConsensus,
      companyCount: companies.length,
    },
  };
}

/**
 * 大小球归一化
 * 关键：currentLine 必须是 isOuLineValue 认可的数字字符串格式
 */
function buildOverUnder(raw) {
  if (!raw || (!Array.isArray(raw.companies) && !raw.mainLine)) {
    return { companies: [], error: '大小球数据未采集', keyOdds: null, summary: null };
  }

  const companies = (Array.isArray(raw.companies) ? raw.companies : []).map(c => {
    const ow = parseFloat(c.overWater), uw = parseFloat(c.underWater);
    if (!isValidWater(ow) || !isValidWater(uw)) return null;
    const validLine = normalizeOuLineSafe(c.line);
    return {
      name: c.name || '未知',
      mainLine: {
        currentOver: ow,
        currentLine: validLine,
        currentUnder: uw,
        initialOver: null,
        initialLine: validLine,
        initialUnder: null,
      },
      subLines: [],
    };
  }).filter(Boolean);

  if (companies.length === 0 && raw.mainLine !== undefined) {
    const validLine = normalizeOuLineSafe(raw.mainLine);
    if (validLine) {
      companies.push({
        name: '主要盘口',
        mainLine: {
          currentOver: parseFloat(raw.mainOverWater) || null,
          currentLine: validLine,
          currentUnder: parseFloat(raw.mainUnderWater) || null,
          initialOver: null,
          initialLine: validLine,
          initialUnder: null,
        },
        subLines: [],
      });
    }
  }

  if (companies.length === 0) {
    return { companies: [], error: '大小球数据解析失败（进球线格式无法识别）', keyOdds: null, summary: null };
  }

  const mainLine = companies[0].mainLine;
  const lineConsensus = {};
  for (const c of companies) {
    const l = c.mainLine.currentLine;
    if (l) lineConsensus[l] = (lineConsensus[l] || 0) + 1;
  }

  return {
    companies,
    allOdds: companies.map(c => c.mainLine),
    keyOdds: {
      ao: {
        name: companies[0].name,
        currentOver: mainLine.currentOver,
        currentLine: mainLine.currentLine,
        currentUnder: mainLine.currentUnder,
        initialOver: mainLine.initialOver,
        initialLine: mainLine.initialLine,
        initialUnder: mainLine.initialUnder,
      },
      allCurrent: companies.map(c => ({
        name: c.name,
        over: c.mainLine.currentOver,
        line: c.mainLine.currentLine,
        under: c.mainLine.currentUnder,
      })),
    },
    summary: {
      mainLine: Object.entries(lineConsensus).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      lineConsensus,
      companyCount: companies.length,
    },
  };
}

/**
 * 基本面归一化（analysis 层）
 */
function buildAnalysis(raw, matchInfo) {
  return {
    matchInfo,                             // normalizeMatch 从这里读队名！
    pageTitle: raw.pageTitle || '',
    homeTeam: raw.homeTeam || matchInfo.home,
    awayTeam: raw.awayTeam || matchInfo.away,
    text: raw.text || '',
    headToHead: raw.history?.excerpt
      ? [{ source: 'text_excerpt', excerpt: raw.history.excerpt }]
      : [],
    recentStats: null,
    seasonComparison: null,
    injuries: { home: [], away: [] },
    homeRecentMatches: [],
    awayRecentMatches: [],
    preBriefing: '',
    error: (!raw || !raw.text || raw.text.length < 50) ? '基本面数据未采集或内容过少' : null,
  };
}

// ─── 辅助函数 ────────────────────────────────────────────────

function isValidOdds(v) {
  return typeof v === 'number' && isFinite(v) && v > 1.0 && v < 50;
}

function isValidWater(v) {
  return typeof v === 'number' && isFinite(v) && v >= 0.5 && v <= 1.3;
}

function avg(arr) {
  const valid = arr.filter(v => typeof v === 'number' && isFinite(v));
  if (!valid.length) return 0;
  return valid.reduce((s, v) => s + v, 0) / valid.length;
}
