/**
 * titanTodayCollector.js
 * 使用 Playwright 从 Titan007/球探 采集当天全量赛事列表
 * 失败时直接抛出错误，不降级为样例数据（商业运营项目）
 */
import { chromium } from '@playwright/test';
import { todayInTimezone } from './sampleData.js';

const LAUNCH_TIMEOUT_MS = 30000;
const NAV_TIMEOUT_MS = 45000;
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 15;
const MIN_MATCH_COUNT = 3;

/**
 * @typedef {Object} TodayMatch
 * @property {string} matchId        比赛 ID（6-8 位数字字符串）
 * @property {string} businessDate   赛事日期 YYYY-MM-DD
 * @property {string} league         联赛名称
 * @property {string} home           主队名称
 * @property {string} away           客队名称
 * @property {string} matchTime      ISO 8601 开赛时间
 * @property {string} status         'pre_match' | 'live' | 'finished' | 'unknown'
 * @property {string} source         数据来源标识
 * @property {string} sourceUrl      原始页面 URL
 * @property {string} lotteryNo      竞彩编号（可能为空）
 * @property {Object} raw            页面原始字段快照
 */

/**
 * 采集今日全量赛事
 * @param {Object} options
 * @param {string} [options.date]          指定日期 YYYY-MM-DD，默认今天
 * @param {string} [options.titanBaseUrl]  Titan007 基础 URL
 * @param {string} [options.timezone]      时区
 * @returns {Promise<{matches: TodayMatch[], source: string}>}
 * @throws {Error} 采集失败时抛出，调用方负责处理
 */
export async function collectTodayMatches({
  date,
  titanBaseUrl = 'https://live.titan007.com',
  timezone = 'Asia/Shanghai',
} = {}) {
  const targetDate = date || todayInTimezone(timezone);

  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      timeout: LAUNCH_TIMEOUT_MS,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });

    const page = await context.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    const url = `${titanBaseUrl}/oldIndexall.aspx`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // 轮询等待比赛数据加载（Ajax 数据通常需要 3-10 秒）
    let matchCount = 0;
    for (let poll = 0; poll < MAX_POLLS; poll++) {
      await page.waitForTimeout(POLL_INTERVAL_MS);

      const detected = await page.evaluate(() => {
        const aCount = window.A && typeof window.matchcount !== 'undefined'
          ? Number(window.matchcount || 0) : 0;
        const trByMid = document.querySelectorAll('tr[mid]').length;
        const trById = document.querySelectorAll('tr[id^="m_"], tr[id^="tr1_"]').length;
        let euroCount = 0;
        document.querySelectorAll('a').forEach(a => {
          const h = a.getAttribute('href') || '';
          if (/EuropeOdds\(\d+\)/.test(h) || /advices\(\d+\)/.test(h)) euroCount++;
        });
        return Math.max(aCount, trByMid, trById, euroCount);
      }).catch(() => 0);

      matchCount = detected;
      if (matchCount >= MIN_MATCH_COUNT) break;
    }

    if (matchCount < MIN_MATCH_COUNT) {
      await browser.close();
      browser = null;
      throw new Error(`Titan007 页面加载后仅检测到 ${matchCount} 场比赛（低于最小阈值 ${MIN_MATCH_COUNT}），可能页面结构变化或网络异常`);
    }

    // 提取比赛数据
    const rawMatches = await page.evaluate((targetDateStr) => {
      const matches = [];
      const seen = new Set();

      function normalizeLotteryNo(value) {
        const s = String(value ?? '').replace(/\s+/g, '').trim();
        if (!s || s === '0' || s === '00' || s === '000' || s === '-' || s === '--') return '';
        const m = s.match(/^0*(\d{1,4})$/);
        if (!m) return '';
        const n = Number(m[1]);
        if (n < 1 || n > 9999) return '';
        return String(n).padStart(3, '0');
      }

      function inferStatus(rowText) {
        if (/完场|全场|FT/.test(rowText)) return 'finished';
        if (/上半场|下半场|Half|Part|进行中|直播/.test(rowText)) return 'live';
        return 'pre_match';
      }

      function parseRowData(id, tr) {
        const tds = Array.from(tr.querySelectorAll('td'));
        const rowText = tr.textContent || '';

        let home = '', away = '', league = '', matchTime = '', lotteryNo = '';

        // 优先从 window.A 读取结构化数据
        try {
          if (window.A) {
            for (let i = 1; i <= (window.matchcount || 0); i++) {
              if (String(window.A[i]?.[0]) === String(id)) {
                const row = window.A[i];
                home = String(row[2] || '').trim();
                away = String(row[3] || '').trim();
                league = String(row[1] || '').trim();
                // 时间通常在 row[12]（"年,月,日,时,分,秒" 逗号分隔）
                if (row[12]) {
                  const t = String(row[12]).split(',');
                  if (t.length >= 5) {
                    const y = t[0];
                    const mo = String(Number(t[1]) + 1).padStart(2, '0');
                    const d = String(t[2]).padStart(2, '0');
                    const h = String(t[3]).padStart(2, '0');
                    const mi = String(t[4]).padStart(2, '0');
                    matchTime = `${y}-${mo}-${d}T${h}:${mi}:00+08:00`;
                  }
                }
                lotteryNo = normalizeLotteryNo(row[10]) || normalizeLotteryNo(row[11]);
                break;
              }
            }
          }
        } catch (_) {}

        // DOM 回退
        if (!home || !away) {
          const teamTds = tds.filter(td => {
            const t = td.textContent.trim();
            return t.length > 1 && t.length < 20 && !td.querySelector('img, input, select');
          });
          if (teamTds.length >= 2) {
            home = home || teamTds[0]?.textContent.trim() || '';
            away = away || teamTds[1]?.textContent.trim() || '';
          }
        }

        if (!league) {
          const leagEl = tr.querySelector('[class*="leag"], [class*="league"]');
          if (leagEl) league = leagEl.textContent.trim();
        }

        if (!lotteryNo) {
          const lottEl = tr.querySelector('[class*="lotto"], [class*="lottery"], [class*="jc"]');
          if (lottEl) lotteryNo = normalizeLotteryNo(lottEl.textContent);
        }

        return {
          matchId: id,
          businessDate: targetDateStr,
          league: league || '未知联赛',
          home,
          away,
          matchTime: matchTime || `${targetDateStr}T00:00:00+08:00`,
          status: inferStatus(rowText),
          source: 'titan007',
          sourceUrl: window.location.href,
          lotteryNo,
          raw: {
            rowText: rowText.slice(0, 200),
            tdCount: tds.length,
          },
        };
      }

      // 方法1: tr[mid]
      document.querySelectorAll('tr[mid]').forEach(tr => {
        const id = tr.getAttribute('mid');
        if (!id || !/^\d{6,8}$/.test(id) || seen.has(id)) return;
        seen.add(id);
        matches.push(parseRowData(id, tr));
      });

      // 方法2: tr[id^="m_"] 或 tr[id^="tr1_"]
      document.querySelectorAll('tr[id^="m_"], tr[id^="tr1_"]').forEach(tr => {
        const m = String(tr.id || '').match(/(?:m_|tr1_)(\d{6,8})/);
        if (!m || seen.has(m[1])) return;
        seen.add(m[1]);
        matches.push(parseRowData(m[1], tr));
      });

      // 方法3: EuropeOdds(ID) 链接
      document.querySelectorAll('a').forEach(a => {
        const href = a.getAttribute('href') || '';
        const idM = href.match(/EuropeOdds\((\d{6,8})\)/) ||
                    href.match(/advices\((\d{6,8})\)/) ||
                    href.match(/addConcern\((\d{6,8})/);
        if (!idM || seen.has(idM[1])) return;
        seen.add(idM[1]);
        const tr = a.closest('tr');
        if (!tr) return;
        matches.push(parseRowData(idM[1], tr));
      });

      return matches;
    }, targetDate);

    await browser.close();
    browser = null;

    // 过滤无效行（队名为空或为占位符）
    const validMatches = rawMatches.filter(m =>
      m && m.matchId && m.home && m.away &&
      m.home.length >= 2 && m.away.length >= 2
    );

    if (validMatches.length === 0) {
      throw new Error('采集到 0 条有效比赛数据，请检查页面结构是否变化');
    }

    console.log(`[TitanToday] 成功采集 ${validMatches.length} 场比赛（${targetDate}）`);
    return { matches: validMatches, source: 'titan007' };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    throw err;
  }
}
