/**
 * titanMatchCollector.js
 * 使用 Playwright 从 Titan007/球探 采集单场比赛详情
 * 包括：基本面、欧赔、亚盘、大小球等页面数据
 * 失败时直接抛出错误（商业运营项目，不做样例降级）
 */
import { chromium } from '@playwright/test';

const LAUNCH_TIMEOUT_MS = 30000;
const NAV_TIMEOUT_MS = 30000;
const WAIT_AFTER_NAV_MS = 3000;

/**
 * @typedef {Object} MatchSnapshot
 * @property {string}   matchId
 * @property {string}   snapshotType     'full' | 'partial'
 * @property {number}   completenessScore  0.0 – 1.0
 * @property {Object}   analysis         基本面与胜平负赔率
 * @property {Object}   asian            亚盘数据
 * @property {Object}   overunder        大小球数据
 * @property {string[]} errors           非致命错误列表（页面局部失败）
 * @property {string}   collectedAt      ISO 时间戳
 * @property {string}   source
 */

/**
 * 采集单场详情
 * @param {string} matchId
 * @param {Object} options
 * @returns {Promise<MatchSnapshot>}
 * @throws {Error} 当基本面页面采集完全失败时抛出，由调用方决定是否重试
 */
export async function collectMatchDetail(matchId, {
  titanBaseUrl = 'https://live.titan007.com',
} = {}) {
  if (!matchId) throw new Error('matchId is required');

  const collectedAt = new Date().toISOString();
  const errors = [];

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

    // 并发采集基本面和盘口页面
    const [analysisResult, asianResult, ouResult] = await Promise.allSettled([
      fetchAnalysisPage(context, matchId, titanBaseUrl),
      fetchAsianPage(context, matchId, titanBaseUrl),
      fetchOverUnderPage(context, matchId, titanBaseUrl),
    ]);

    await browser.close();
    browser = null;

    // 基本面页面失败为致命错误（无数据无法分析）
    if (analysisResult.status === 'rejected') {
      throw new Error(`基本面页面采集失败 [matchId=${matchId}]: ${analysisResult.reason?.message || analysisResult.reason}`);
    }

    const analysis = analysisResult.value;

    if (asianResult.status === 'rejected') {
      errors.push(`亚盘页面: ${asianResult.reason?.message || asianResult.reason}`);
    }
    if (ouResult.status === 'rejected') {
      errors.push(`大小球页面: ${ouResult.reason?.message || ouResult.reason}`);
    }

    const asian = asianResult.status === 'fulfilled' ? asianResult.value : { companies: [], dataQuality: 'error' };
    const overunder = ouResult.status === 'fulfilled' ? ouResult.value : { companies: [], dataQuality: 'error' };

    // 基本面无实质内容也视为错误
    if (!analysis.text || analysis.text.length < 100) {
      throw new Error(`基本面页面内容过少 [matchId=${matchId}]，疑似页面结构变化或比赛不存在`);
    }

    const completenessScore = calcCompletenessScore({ analysis, asian, overunder });

    console.log(`[TitanMatch] matchId=${matchId} 采集完成 completeness=${completenessScore} errors=${errors.length}`);

    return {
      matchId,
      snapshotType: errors.length === 0 ? 'full' : 'partial',
      completenessScore,
      analysis,
      asian,
      overunder,
      winDrawWin: analysis.winDrawWin || {},
      history: analysis.history || {},
      errors,
      collectedAt,
      source: 'titan007',
    };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    throw err;
  }
}

// ─── 子页面采集 ──────────────────────────────────────────────

async function fetchAnalysisPage(context, matchId, baseUrl) {
  const url = `${baseUrl}/analysis/${matchId}cn.htm`;
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(WAIT_AFTER_NAV_MS);

    const result = await page.evaluate(() => {
      const text = document.body?.innerText || document.body?.textContent || '';

      // 标题提取队名
      const titleMatch = document.title?.match(/^(.+?)\s*[vVvsVS－\-]\s*(.+?)(?:\s*[-|]|$)/);
      const homeTeam = titleMatch?.[1]?.trim() || '';
      const awayTeam = titleMatch?.[2]?.trim() || '';

      // 欧赔/胜平负赔率表格解析
      const winDrawWin = { companies: [] };
      document.querySelectorAll('table tr').forEach(tr => {
        const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
        if (cells.length >= 4) {
          const [name, win, draw, lose] = cells;
          if (name && /^[\u4e00-\u9fff\w\s]{2,20}$/.test(name)) {
            const w = parseFloat(win), d = parseFloat(draw), l = parseFloat(lose);
            if (w > 1 && w < 30 && d > 1 && d < 30 && l > 1 && l < 30) {
              winDrawWin.companies.push({ name, win: w, draw: d, lose: l });
            }
          }
        }
      });

      // 历史交锋关键词摘录
      const histMatch = text.match(/(历史交锋|近期\w+场|主场胜\d+|近\d+次)/g);

      return {
        text: text.slice(0, 8000),
        homeTeam,
        awayTeam,
        winDrawWin,
        history: { excerpt: histMatch?.join('; ') || '' },
        pageTitle: document.title || '',
      };
    });

    await page.close();
    return result;
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

async function fetchAsianPage(context, matchId, baseUrl) {
  const url = `${baseUrl}/detail/${matchId}sb.htm`;
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(WAIT_AFTER_NAV_MS);

    const result = await page.evaluate(() => {
      const companies = [];

      document.querySelectorAll('table tr').forEach(tr => {
        const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
        if (cells.length >= 4) {
          const name = cells[0];
          if (!name || name.length < 2 || name.length > 25) return;
          const hw = parseFloat(cells[1]);
          const line = cells[2];
          const aw = parseFloat(cells[3]);
          if (hw >= 0.5 && hw <= 1.2 && aw >= 0.5 && aw <= 1.2) {
            companies.push({ name, homeWater: hw, line, awayWater: aw });
          }
        }
      });

      return {
        companies,
        mainLine: companies[0]?.line || '',
        mainHomeWater: companies[0]?.homeWater ?? null,
        mainAwayWater: companies[0]?.awayWater ?? null,
        dataQuality: companies.length > 0 ? 'ok' : 'empty',
      };
    });

    await page.close();
    return result;
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

async function fetchOverUnderPage(context, matchId, baseUrl) {
  const url = `${baseUrl}/goalline/${matchId}ou.htm`;
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(WAIT_AFTER_NAV_MS);

    const result = await page.evaluate(() => {
      const companies = [];

      document.querySelectorAll('table tr').forEach(tr => {
        const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
        if (cells.length >= 4) {
          const name = cells[0];
          if (!name || name.length < 2 || name.length > 25) return;
          const ow = parseFloat(cells[1]);
          const line = cells[2];
          const uw = parseFloat(cells[3]);
          if (ow >= 0.5 && ow <= 1.2 && uw >= 0.5 && uw <= 1.2) {
            companies.push({ name, overWater: ow, line, underWater: uw });
          }
        }
      });

      return {
        companies,
        mainLine: companies[0]?.line || '',
        mainOverWater: companies[0]?.overWater ?? null,
        mainUnderWater: companies[0]?.underWater ?? null,
        dataQuality: companies.length > 0 ? 'ok' : 'empty',
      };
    });

    await page.close();
    return result;
  } catch (err) {
    await page.close().catch(() => {});
    // 大小球页面不一定存在，作为非致命错误处理
    return { companies: [], mainLine: '', dataQuality: 'unavailable' };
  }
}

// ─── 完整度评分 ──────────────────────────────────────────────

function calcCompletenessScore({ analysis, asian, overunder }) {
  let score = 0;
  if (analysis?.text?.length > 500) score += 0.3;
  if (analysis?.winDrawWin?.companies?.length > 0) score += 0.2;
  if (analysis?.history?.excerpt?.length > 0) score += 0.1;
  if (asian?.companies?.length > 0) score += 0.25;
  if (overunder?.companies?.length > 0) score += 0.15;
  return Math.min(1, Math.round(score * 100) / 100);
}
