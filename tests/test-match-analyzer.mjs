/**
 * 本地集成测试：matchAnalyzer.analyzeMatch + buildDailyPortfolio
 * 运行：node server/tests/test-match-analyzer.mjs
 */
import { analyzeMatch, buildDailyPortfolio, analyzeDailyMatches } from '../src/analysis/matchAnalyzer.js';

let pass = 0, fail = 0;

function assert(condition, label, actual) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.error(`  ❌ ${label}${actual !== undefined ? ` (actual: ${JSON.stringify(actual)?.slice(0, 100)})` : ''}`);
    fail++;
  }
}

// ─── 测试数据 ─────────────────────────────────────────────────

const snapshot1 = {
  matchId: '3001001', completenessScore: 0.85, source: 'titan007',
  collectedAt: new Date().toISOString(), errors: [],
  analysis: {
    text: '曼城 vs 阿森纳 近10场主场胜7平2负1，历史交锋曼城近3次全胜。',
    homeTeam: '曼城', awayTeam: '阿森纳', pageTitle: '曼城 vs 阿森纳',
    winDrawWin: { companies: [
      { name: '威廉希尔', win: 1.85, draw: 3.50, lose: 3.80 },
      { name: 'Bet365', win: 1.87, draw: 3.60, lose: 3.75 },
      { name: '澳门', win: 1.90, draw: 3.45, lose: 3.70 },
    ]},
    history: { excerpt: '历史交锋曼城近3次全胜' }
  },
  asian: {
    companies: [
      { name: '澳门', homeWater: 0.88, line: '-0.5', awayWater: 0.92 },
      { name: '皇冠', homeWater: 0.86, line: '-0.5', awayWater: 0.94 },
    ],
    mainLine: '-0.5', mainHomeWater: 0.88, mainAwayWater: 0.92
  },
  overunder: {
    companies: [
      { name: '澳门', overWater: 0.92, line: '2.5', underWater: 0.88 },
    ],
    mainLine: '2.5'
  }
};

const todayMatch1 = {
  matchId: '3001001', home: '曼城', away: '阿森纳', league: '英超',
  matchTime: '2026-06-15 19:30', status: 'pre_match', lotteryNo: '001',
  jingcai: {
    lotteryNo: '001',
    had: { winRate: 55, drawRate: 25, loseRate: 20, winOdds: 1.85, drawOdds: 3.50, loseOdds: 3.80 },
    hasDeviation: true,
    deviation: { homeEdge: 5.2, drawEdge: -2.1, awayEdge: -3.1 }
  }
};

// 第二场比赛：数据较差
const snapshot2 = {
  matchId: '3001002', completenessScore: 0.30, source: 'titan007',
  collectedAt: new Date().toISOString(), errors: ['大小球页面未找到'],
  analysis: {
    text: '巴黎圣日耳曼 vs 马赛 比赛预告', homeTeam: '巴黎', awayTeam: '马赛',
    winDrawWin: { companies: [{ name: 'Bet365', win: 1.65, draw: 3.80, lose: 4.50 }] },
    history: { excerpt: '' }
  },
  asian: { companies: [{ name: '澳门', homeWater: 0.82, line: '-1', awayWater: 0.98 }], mainLine: '-1' },
  overunder: { companies: [] }
};

const todayMatch2 = {
  matchId: '3001002', home: '巴黎', away: '马赛', league: '法甲',
  matchTime: '2026-06-15 21:00', status: 'pre_match', lotteryNo: '002'
};

// ─── Test 1: analyzeMatch 单场 ────────────────────────────────

console.log('\n=== Test 1: analyzeMatch (曼城 vs 阿森纳) ===');

const result1 = await analyzeMatch(snapshot1, todayMatch1);

assert(result1.matchId === '3001001', 'matchId 正确');
assert(result1.home === '曼城', 'home 正确');
assert(result1.away === '阿森纳', 'away 正确');
assert(result1.league === '英超', 'league 正确');
assert(result1.probabilities?.home !== null && result1.probabilities?.home > 0, `概率 home 合法 (${result1.probabilities?.home})`);
assert(result1.probabilities?.draw !== null, 'draw 概率存在');
assert(result1.probabilities?.away !== null, 'away 概率存在');
assert(result1.rankScore >= 0 && result1.rankScore <= 100, `rankScore 合法范围 (${result1.rankScore})`);
assert(['low','medium_low','medium','medium_high','high','unknown'].includes(result1.riskLevel), `riskLevel 合法 (${result1.riskLevel})`);
assert(typeof result1.reportMarkdown === 'string' && result1.reportMarkdown.length > 200, `报告 Markdown 充足 (${result1.reportMarkdown.length} chars)`);
assert(typeof result1.reportStructured === 'object', '结构化报告存在');
assert(result1.jingcai?.hasDeviation === true, '竞彩偏差数据存在');
assert(typeof result1.normalizedMd === 'string' && result1.normalizedMd.length > 50, '归一化 Markdown 存在');
assert(typeof result1.quantMd === 'string' && result1.quantMd.length > 50, '量化 Markdown 存在');
assert(typeof result1.analyzedAt === 'string', 'analyzedAt 时间戳存在');

console.log(`  ℹ️ rankScore=${result1.rankScore} riskLevel=${result1.riskLevel} completeness=${result1.completenessScore}`);
console.log(`  ℹ️ 概率: home=${result1.probabilities?.home} draw=${result1.probabilities?.draw} away=${result1.probabilities?.away} source=${result1.probabilities?.source}`);

// ─── Test 2: analyzeMatch (数据较差的比赛) ───────────────────

console.log('\n=== Test 2: analyzeMatch (巴黎 vs 马赛，数据较差) ===');

const result2 = await analyzeMatch(snapshot2, todayMatch2);

assert(result2.matchId === '3001002', 'matchId2 正确');
assert(result2.rankScore < result1.rankScore, `数据差的比赛排名分更低 (${result2.rankScore} < ${result1.rankScore})`);
assert(result2.completenessScore < result1.completenessScore, '完整度分数更低');
assert(typeof result2.reportMarkdown === 'string' && result2.reportMarkdown.length > 0, '低质量数据也能生成报告');

// ─── Test 3: analyzeDailyMatches 批量分析 ────────────────────

console.log('\n=== Test 3: analyzeDailyMatches 批量 ===');

const batchResult = await analyzeDailyMatches([
  { snapshot: snapshot1, todayMatch: todayMatch1 },
  { snapshot: snapshot2, todayMatch: todayMatch2 },
], { concurrency: 2 });

assert(batchResult.results.length === 2, `批量分析返回 2 条 (${batchResult.results.length})`);
assert(batchResult.errors.length === 0, `批量分析无错误 (${batchResult.errors.length})`);
// 结果应按 rankScore 降序
assert(batchResult.results[0].rankScore >= batchResult.results[1].rankScore, `结果已按 rankScore 排序 (${batchResult.results[0].rankScore} >= ${batchResult.results[1].rankScore})`);

// ─── Test 4: buildDailyPortfolio ─────────────────────────────

console.log('\n=== Test 4: buildDailyPortfolio ===');

const portfolio = buildDailyPortfolio(batchResult.results);

assert(typeof portfolio === 'object', 'portfolio 是对象');
assert(Array.isArray(portfolio.stable), 'portfolio.stable 是数组');
assert(Array.isArray(portfolio.balanced), 'portfolio.balanced 是数组');
assert(Array.isArray(portfolio.explore), 'portfolio.explore 是数组');
assert(Array.isArray(portfolio.avoidList), 'portfolio.avoidList 是数组');
assert(typeof portfolio.stats === 'object', 'portfolio.stats 存在');
assert(portfolio.stats.total === 2, `portfolio.stats.total=2 (${portfolio.stats.total})`);
assert(portfolio.explore.length >= 1, `explore 至少1条 (${portfolio.explore.length})`);

// 验证稳健方案中每条都有必要字段
for (const item of portfolio.stable) {
  assert(item.matchId !== undefined, `stable item 有 matchId`);
  assert(item.rankScore >= 0, `stable item rankScore 合法`);
}

console.log(`  ℹ️ stable=${portfolio.stable.length} balanced=${portfolio.balanced.length} explore=${portfolio.explore.length} avoid=${portfolio.avoidList.length}`);

// ─── 汇总 ─────────────────────────────────────────────────────

console.log(`\n=== 测试完成：✅ ${pass} 通过  ❌ ${fail} 失败 ===`);

if (fail > 0) process.exit(1);
