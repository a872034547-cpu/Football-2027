/**
 * resultCollector.js
 * 使用 Playwright 从 Titan007 赛果页采集已结束比赛的最终比分。
 *
 * 设计原则：
 * - 采集失败时返回 { ok: false } 而不是抛出，由调用方决定重试/跳过。
 * - 不阻断批量任务，失败只记录 reason。
 * - 支持单场采集和批量采集（并发限制）。
 * - URL 模式与 titanMatchCollector 一致，共用同一 baseUrl 配置。
 */
import { chromium } from '@playwright/test';

const LAUNCH_TIMEOUT_MS = 30000;
const NAV_TIMEOUT_MS = 30000;
const WAIT_AFTER_NAV_MS = 2500;
const DEFAULT_CONCURRENCY = 3;

/**
 * @typedef {Object} MatchResultRaw
 * @property {boolean}  ok
 * @property {string}   matchId
 * @property {number|null} homeScore
 * @property {number|null} awayScore
 * @property {string|null} result1x2     'home' | 'draw' | 'away' | null
 * @property {number|null} totalGoals
 * @property {string}   source
 * @property {string}   collectedAt
 * @property {string|null} reason        失败原因（ok=false 时）
 * @property {string}   pageTitle
 * @property {string}   scoreText        原始比分字符串（调试用）
 */

/**
 * 采集单场已结束比赛的最终比分
 * @param {string} matchId
 * @param {Object} options
 * @param {string} [options.titanBaseUrl]
 * @returns {Promise<MatchResultRaw>}   永不抛出
 */
export async function collectMatchResult(matchId, {
  titanBaseUrl = 'https://live.titan007.com',
} = {}) {
  if (!matchId) {
    return { ok: false, matchId, reason: 'missing_match_id', source: 'titan007', collectedAt: new Date().toISOString() };
  }

  const collectedAt = new Date().toISOString();
  let browser = null;

  try {
    browser = await chromium.launch({
      headless: true,
      timeout: LAUNCH_TIMEOUT_MS,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });

    // 优先使用基本面分析页（包含比分、队名、状态）
    const url = `${titanBaseUrl}/analysis/${matchId}cn.htm`;
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(WAIT_AFTER_NAV_MS);

    const raw = await page.evaluate(() => {
      const title = document.title || '';
      const body = document.body?.innerText || document.body?.textContent || '';

      // 策略1：标题中提取比分，如 "曼城 2-1 阿森纳 - 球探比赛分析" 或 "曼城2-1阿森纳"
      const titleScorePatterns = [
        /[\u4e00-\u9fff\w\s]+\s+(\d+)\s*[-\-–—]\s*(\d+)\s+[\u4e00-\u9fff\w]/,
        /(\d+)\s*[-\-–—]\s*(\d+)/,
      ];
      for (const pattern of titleScorePatterns) {
        const m = title.match(pattern);
        if (m) {
          const idx = m.index !== undefined ? title.indexOf(m[0]) : -1;
          const before = idx >= 0 ? title.slice(0, idx) : '';
          return {
            source: 'title',
            homeScore: Number(m[1]),
            awayScore: Number(m[2]),
            scoreText: m[0],
            pageTitle: title,
            bodyExcerpt: body.slice(0, 200),
            beforeScore: before.trim(),
          };
        }
      }

      // 策略2：正文中查找比赛状态和比分（完场 X-X）
      const bodyPatterns = [
        /(?:完场|全场|FT|结束).*?(\d+)\s*[-\-–—]\s*(\d+)/,
        /(?:半场|HT).*?(\d+)\s*[-\-–—]\s*(\d+)/,
        /比分[：:]\s*(\d+)\s*[-\-–—]\s*(\d+)/,
        /(\d+)\s*[-\-–—]\s*(\d+)\s*(?:完|结束|FT)/,
      ];
      for (const pattern of bodyPatterns) {
        const m = body.match(pattern);
        if (m) {
          return {
            source: 'body_pattern',
            homeScore: Number(m[1]),
            awayScore: Number(m[2]),
            scoreText: m[0],
            pageTitle: title,
            bodyExcerpt: body.slice(0, 200),
            beforeScore: '',
          };
        }
      }

      // 策略3：从页面结构化数据（某些 Titan 页面有 window.score 或 data 属性）
      try {
        if (typeof window.homeGoal !== 'undefined' && typeof window.awayGoal !== 'undefined') {
          return {
            source: 'window_goal',
            homeScore: Number(window.homeGoal),
            awayScore: Number(window.awayGoal),
            scoreText: `${window.homeGoal}-${window.awayGoal}`,
            pageTitle: title,
            bodyExcerpt: body.slice(0, 200),
            beforeScore: '',
          };
        }
      } catch (_) {}

      // 策略4：通用数字对匹配（置信度低，需要后续验证）
      const genericM = body.slice(0, 1000).match(/\b(\d{1,2})\s*[-\-–—]\s*(\d{1,2})\b/);
      if (genericM && Number(genericM[1]) <= 20 && Number(genericM[2]) <= 20) {
        return {
          source: 'body_generic',
          homeScore: Number(genericM[1]),
          awayScore: Number(genericM[2]),
          scoreText: genericM[0],
          pageTitle: title,
          bodyExcerpt: body.slice(0, 200),
          beforeScore: '',
        };
      }

      return {
        source: 'not_found',
        homeScore: null,
        awayScore: null,
        scoreText: '',
        pageTitle: title,
        bodyExcerpt: body.slice(0, 200),
        beforeScore: '',
      };
    });

    await page.close();
    await browser.close();
    browser = null;

    if (raw.source === 'not_found' || raw.homeScore === null || raw.awayScore === null) {
      return {
        ok: false,
        matchId,
        homeScore: null,
        awayScore: null,
        result1x2: null,
        totalGoals: null,
        source: 'titan007',
        collectedAt,
        reason: `score_not_found (title="${raw.pageTitle?.slice(0, 60)}")`,
        pageTitle: raw.pageTitle,
        scoreText: '',
        bodyExcerpt: raw.bodyExcerpt,
      };
    }

    // 低置信度的 body_generic 来源需要额外确认比赛是否真正结束
    if (raw.source === 'body_generic') {
      const finished = /完场|全场|FT|结束/.test(raw.bodyExcerpt || '');
      if (!finished) {
        return {
          ok: false,
          matchId,
          homeScore: null,
          awayScore: null,
          result1x2: null,
          totalGoals: null,
          source: 'titan007',
          collectedAt,
          reason: `score_low_confidence_match_not_finished`,
          pageTitle: raw.pageTitle,
          scoreText: raw.scoreText,
          bodyExcerpt: raw.bodyExcerpt,
        };
      }
    }

    const homeScore = Math.floor(Number(raw.homeScore));
    const awayScore = Math.floor(Number(raw.awayScore));
    const result1x2 = homeScore > awayScore ? 'home' : homeScore < awayScore ? 'away' : 'draw';

    console.log(`[ResultCollector] matchId=${matchId} 比分=${homeScore}-${awayScore} result=${result1x2} source=${raw.source}`);

    return {
      ok: true,
      matchId,
      homeScore,
      awayScore,
      result1x2,
      totalGoals: homeScore + awayScore,
      source: 'titan007',
      collectedAt,
      reason: null,
      pageTitle: raw.pageTitle,
      scoreText: raw.scoreText,
      bodyExcerpt: raw.bodyExcerpt,
      rawSource: raw.source,
    };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.warn(`[ResultCollector] matchId=${matchId} 采集失败: ${err.message}`);
    return {
      ok: false,
      matchId,
      homeScore: null,
      awayScore: null,
      result1x2: null,
      totalGoals: null,
      source: 'titan007',
      collectedAt,
      reason: err.message?.slice(0, 200) || 'unknown_error',
      pageTitle: '',
      scoreText: '',
    };
  }
}

/**
 * 批量采集多场已结束比赛的最终比分
 * @param {string[]} matchIds
 * @param {Object} options
 * @param {string} [options.titanBaseUrl]
 * @param {number} [options.concurrency]
 * @returns {Promise<{results: MatchResultRaw[], summary: Object}>}
 */
export async function collectMatchResults(matchIds = [], {
  titanBaseUrl = 'https://live.titan007.com',
  concurrency = DEFAULT_CONCURRENCY,
} = {}) {
  const results = [];
  const batchSize = Math.max(1, Math.min(concurrency, 5));

  for (let i = 0; i < matchIds.length; i += batchSize) {
    const batch = matchIds.slice(i, i + batchSize);
    const settled = await Promise.allSettled(
      batch.map((matchId) => collectMatchResult(matchId, { titanBaseUrl })),
    );
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        // collectMatchResult 本身不抛出，但 Promise.allSettled 仍兜底
        results.push({
          ok: false,
          matchId: 'unknown',
          homeScore: null,
          awayScore: null,
          result1x2: null,
          totalGoals: null,
          source: 'titan007',
          collectedAt: new Date().toISOString(),
          reason: r.reason?.message || 'promise_rejected',
        });
      }
    }
  }

  const successCount = results.filter((r) => r.ok).length;
  const failCount = results.length - successCount;

  console.log(`[ResultCollector] 批量采集完成 total=${results.length} success=${successCount} fail=${failCount}`);

  return {
    results,
    summary: {
      total: results.length,
      success: successCount,
      fail: failCount,
      successRate: results.length > 0 ? Math.round((successCount / results.length) * 100) : 0,
    },
  };
}

export default { collectMatchResult, collectMatchResults };
