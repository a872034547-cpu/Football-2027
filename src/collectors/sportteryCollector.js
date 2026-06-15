/**
 * sportteryCollector.js
 * 从体彩竞足公开接口采集 HAD + HHAD 投票率/赔率数据
 * 直接 fetch 接口，无需 Playwright
 * 失败时直接抛出错误（商业运营项目）
 */

const SPORTTERY_API = 'https://webapi.sporttery.cn/gateway/uniform/football/getVoteV1.qry';
const FETCH_TIMEOUT_MS = 20000;

/**
 * 竞彩业务日期：11:00 开始到次日 11:00，凌晨 < 11:00 时使用前一天
 * @param {string} [timezone] - 时区
 * @returns {string} YYYY-MM-DD
 */
export function sportteryBusinessDate(timezone = 'Asia/Shanghai') {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map(p => [p.type, p.value]));
  const hour = parseInt(parts.hour, 10);

  if (hour < 11) {
    // 凌晨 0-10 点，业务日归为昨天
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(yesterday);
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * @typedef {Object} SportteryMatch
 * @property {string}   lotteryNo       竞彩编号（归一化后）
 * @property {string}   matchId         对应的 Titan 比赛 ID（通过 lotteryNo 匹配，可能为空）
 * @property {string}   home
 * @property {string}   away
 * @property {string}   league
 * @property {string}   matchTime       ISO 格式（来自接口，可能不含秒）
 * @property {Object}   had             HAD 胜平负数据
 * @property {Object}   hhad            HHAD 让球胜平负数据
 * @property {boolean}  hasDeviation    是否存在竞彩偏差信号
 */

/**
 * 采集指定日期的竞彩数据
 * @param {Object} options
 * @param {string} [options.date]       YYYY-MM-DD，默认竞彩业务日
 * @param {string} [options.timezone]
 * @returns {Promise<{matches: SportteryMatch[], date: string, fetchedAt: string}>}
 * @throws {Error} 接口完全不可达或格式解析失败时抛出
 */
export async function collectSporttery({
  date,
  timezone = 'Asia/Shanghai',
} = {}) {
  const businessDate = date || sportteryBusinessDate(timezone);
  const fetchedAt = new Date().toISOString();

  const [hadList, hhadList] = await Promise.all([
    fetchPool(businessDate, 'HAD'),
    fetchPool(businessDate, 'HHAD'),
  ]);

  if (hadList.length === 0 && hhadList.length === 0) {
    throw new Error(`竞彩接口返回空数据（date=${businessDate}），可能今日无竞彩赛事或接口异常`);
  }

  const matches = mergeHadHhad(hadList, hhadList, businessDate);

  console.log(`[Sporttery] 采集完成 date=${businessDate} HAD=${hadList.length} HHAD=${hhadList.length} merged=${matches.length}`);

  return { matches, date: businessDate, fetchedAt };
}

/**
 * 将竞彩数据按 lotteryNo 合并到已有比赛列表
 * 用于 daily pipeline 中，把竞彩偏差信号注入到 Titan 比赛条目
 * @param {SportteryMatch[]} sportteryMatches
 * @param {import('./titanTodayCollector.js').TodayMatch[]} titanMatches
 * @returns {import('./titanTodayCollector.js').TodayMatch[]} 注入了 jingcai 字段的 titan 比赛列表
 */
export function injectSportteryIntoMatches(sportteryMatches, titanMatches) {
  // 建索引：lotteryNo → sportteryMatch
  const byLotteryNo = new Map();
  for (const sm of sportteryMatches) {
    if (sm.lotteryNo) byLotteryNo.set(sm.lotteryNo, sm);
  }

  return titanMatches.map(m => {
    const ln = normalizeLotteryNo(m.lotteryNo);
    const sp = ln ? byLotteryNo.get(ln) : null;

    if (!sp) return { ...m, jingcai: null };

    // 计算竞彩偏差：投票率与公平概率的差值
    const deviation = calcDeviation(sp);

    return {
      ...m,
      jingcai: {
        lotteryNo: sp.lotteryNo,
        had: sp.had,
        hhad: sp.hhad,
        deviation,
        hasDeviation: Math.abs(deviation.homeEdge || 0) > 0.05 || Math.abs(deviation.awayEdge || 0) > 0.05,
      },
    };
  });
}

// ─── 内部函数 ────────────────────────────────────────────────

async function fetchPool(date, pool) {
  const url = `${SPORTTERY_API}?poolCode=${pool}&pageSize=100&pageNo=1&businessDate=${encodeURIComponent(date)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.sporttery.cn/',
        'Origin': 'https://www.sporttery.cn',
      },
    });

    clearTimeout(timer);

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} 请求 ${pool} 池失败`);
    }

    const json = await resp.json();
    if (!json?.success || !Array.isArray(json?.value?.matches?.list)) {
      return [];
    }

    return json.value.matches.list;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`竞彩接口请求超时（pool=${pool} date=${date} timeout=${FETCH_TIMEOUT_MS}ms）`);
    }
    throw new Error(`竞彩接口请求失败（pool=${pool}）: ${err.message}`);
  }
}

function normalizeLotteryNo(value) {
  const s = String(value ?? '').replace(/\s+/g, '').trim();
  if (!s || s === '0' || s === '00' || s === '000' || s === '-' || s === '--') return '';
  const m = s.match(/^0*(\d{1,4})$/);
  if (!m) return '';
  const n = Number(m[1]);
  if (n < 1 || n > 9999) return '';
  return String(n).padStart(3, '0');
}

function mergeHadHhad(hadList, hhadList, businessDate) {
  const map = new Map();

  // 处理 HAD 列表
  for (const item of hadList) {
    const lotteryNo = normalizeLotteryNo(item.lotteryNo || item.matchId);
    if (!lotteryNo) continue;

    const had = parseVoteData(item);

    map.set(lotteryNo, {
      lotteryNo,
      matchId: '',
      home: item.homeTeamName || item.homeName || '',
      away: item.awayTeamName || item.awayName || '',
      league: item.leagueName || item.competitionName || '',
      matchTime: parseMatchTime(item),
      had,
      hhad: null,
      hasDeviation: false,
    });
  }

  // 合并 HHAD 列表
  for (const item of hhadList) {
    const lotteryNo = normalizeLotteryNo(item.lotteryNo || item.matchId);
    if (!lotteryNo) continue;

    const hhad = parseVoteData(item);

    if (map.has(lotteryNo)) {
      map.get(lotteryNo).hhad = hhad;
    } else {
      map.set(lotteryNo, {
        lotteryNo,
        matchId: '',
        home: item.homeTeamName || item.homeName || '',
        away: item.awayTeamName || item.awayName || '',
        league: item.leagueName || item.competitionName || '',
        matchTime: parseMatchTime(item),
        had: null,
        hhad,
        hasDeviation: false,
      });
    }
  }

  return Array.from(map.values());
}

function parseVoteData(item) {
  // 体彩接口返回字段示例：
  //   winRate: "45%", drawRate: "30%", loseRate: "25%"
  //   winOdds: "1.85", drawOdds: "3.40", loseOdds: "3.60"
  //   handicap: "-0.5" (HHAD 时)
  const toNum = v => {
    if (v == null || v === '') return null;
    return parseFloat(String(v).replace('%', '')) || null;
  };

  return {
    winRate: toNum(item.winRate),
    drawRate: toNum(item.drawRate),
    loseRate: toNum(item.loseRate),
    winOdds: toNum(item.winOdds),
    drawOdds: toNum(item.drawOdds),
    loseOdds: toNum(item.loseOdds),
    handicap: item.handicap || item.handicapValue || null,
    totalSales: item.totalSales || null,
    // 原始字段备份
    _raw: {
      fixedBonusRate: item.fixedBonusRate,
      singleBetCount: item.singleBetCount,
    },
  };
}

function parseMatchTime(item) {
  const raw = item.matchDate || item.matchTime || item.startTime || '';
  if (!raw) return '';
  // 接口通常返回 "2026-06-14 20:00:00" 或 "2026-06-14T20:00:00"
  try {
    const d = new Date(raw.replace(' ', 'T') + (raw.includes('+') ? '' : '+08:00'));
    return d.toISOString();
  } catch (_) {
    return raw;
  }
}

function calcDeviation(sp) {
  // 计算竞彩偏差：投票率 vs 赔率隐含公平概率
  const had = sp.had;
  if (!had?.winOdds || !had?.drawOdds || !had?.loseOdds) {
    return { homeEdge: null, drawEdge: null, awayEdge: null };
  }

  const overround = 1 / had.winOdds + 1 / had.drawOdds + 1 / had.loseOdds;
  const fairHome = (1 / had.winOdds) / overround * 100;
  const fairDraw = (1 / had.drawOdds) / overround * 100;
  const fairAway = (1 / had.loseOdds) / overround * 100;

  return {
    homeEdge: had.winRate != null ? Math.round((had.winRate - fairHome) * 100) / 100 : null,
    drawEdge: had.drawRate != null ? Math.round((had.drawRate - fairDraw) * 100) / 100 : null,
    awayEdge: had.loseRate != null ? Math.round((had.loseRate - fairAway) * 100) / 100 : null,
    fairHome: Math.round(fairHome * 100) / 100,
    fairDraw: Math.round(fairDraw * 100) / 100,
    fairAway: Math.round(fairAway * 100) / 100,
  };
}
