/**
 * 本地集成测试：snapshotToStored + normalizeMatch + quantAnalyze + proMarket + risk + report
 * 运行：node server/tests/test-snapshot-to-stored.mjs
 */
import { snapshotToStored } from '../src/analysis/snapshotToStored.js';
import { loadModule } from '../src/analysis/jsModuleLoader.js';

let pass = 0;
let fail = 0;

function assert(condition, label, actual) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.error(`  ❌ ${label}${actual !== undefined ? ` (actual: ${JSON.stringify(actual)})` : ''}`);
    fail++;
  }
}

// ─── 测试数据 ────────────────────────────────────────────────

const snapshot = {
  matchId: '3001234',
  completenessScore: 0.75,
  source: 'titan007',
  collectedAt: new Date().toISOString(),
  errors: [],
  analysis: {
    text: '曼城 vs 阿森纳 近10场主场胜7平2负1，阿森纳客场胜5平3负2，历史交锋曼城近3次主场全胜。',
    homeTeam: '曼城',
    awayTeam: '阿森纳',
    pageTitle: '曼城 vs 阿森纳 - 欧赔走势',
    winDrawWin: {
      companies: [
        { name: '威廉希尔', win: 1.85, draw: 3.50, lose: 3.80 },
        { name: 'Bet365', win: 1.87, draw: 3.60, lose: 3.75 },
        { name: '澳门', win: 1.90, draw: 3.45, lose: 3.70 },
      ],
    },
    history: { excerpt: '历史交锋曼城近3次主场全胜' },
  },
  asian: {
    companies: [
      { name: '澳门', homeWater: 0.88, line: '-0.5', awayWater: 0.92 },
      { name: '皇冠', homeWater: 0.86, line: '-0.5', awayWater: 0.94 },
    ],
    mainLine: '-0.5',
    mainHomeWater: 0.88,
    mainAwayWater: 0.92,
  },
  overunder: {
    companies: [
      { name: '澳门', overWater: 0.92, line: '2.5', underWater: 0.88 },
      { name: '皇冠', overWater: 0.90, line: '2.5', underWater: 0.90 },
    ],
    mainLine: '2.5',
    mainOverWater: 0.92,
    mainUnderWater: 0.88,
  },
};

const todayMatch = {
  matchId: '3001234',
  home: '曼城',
  away: '阿森纳',
  league: '英超',
  matchTime: '2026-06-15 19:30',
  lotteryNo: '001',
  status: 'pre_match',
  jingcai: {
    lotteryNo: '001',
    had: { winRate: 55, drawRate: 25, loseRate: 20, winOdds: 1.85, drawOdds: 3.50, loseOdds: 3.80 },
    hhad: null,
    hasDeviation: true,
    deviation: { homeEdge: 5.2, drawEdge: -2.1, awayEdge: -3.1 },
  },
};

// ─── Test 1: snapshotToStored 格式 ───────────────────────────

console.log('\n=== Test 1: snapshotToStored ===');

const stored = snapshotToStored(snapshot, todayMatch);

assert(stored.matchId === '3001234', 'matchId 正确');
// normalizeMatch 从 data.analysis.matchInfo 读队名
assert(stored.data.analysis.matchInfo.home === '曼城', 'analysis.matchInfo.home 正确', stored.data.analysis.matchInfo.home);
assert(stored.data.analysis.matchInfo.away === '阿森纳', 'analysis.matchInfo.away 正确');
assert(stored.data.analysis.matchInfo.league === '英超', 'analysis.matchInfo.league 正确');
assert(stored.data.analysis.matchInfo.time === '2026-06-15 19:30', 'analysis.matchInfo.time 正确（time字段）');
assert(stored.data.winDrawWin.companies.length === 3, '欧赔公司数量正确 (3)');
const avgWin = parseFloat(stored.data.winDrawWin.summary?.averageCurrent?.win || '0');
assert(avgWin > 1.8 && avgWin < 2.0, `欧赔均值合理 (${avgWin})`);
assert(stored.data.asian.companies.length === 2, '亚盘公司数量正确 (2)');
// isAsianLineValue 期望中文盘口名称
assert(stored.data.asian.keyOdds?.ao?.currentHandicap === '受让半球', `亚盘主盘口转换为中文 (${stored.data.asian.keyOdds?.ao?.currentHandicap})`);
assert(stored.data.overunder.companies.length === 2, '大小球公司数量正确 (2)');
assert(stored.data.overunder.keyOdds?.ao?.currentLine === '2.5', `大小球主盘口正确 (${stored.data.overunder.keyOdds?.ao?.currentLine})`);
assert(stored.data.jingcai?.hasDeviation === true, '竞彩偏差数据注入正确');

// ─── Test 2: normalizeMatch ───────────────────────────────────

console.log('\n=== Test 2: normalizeMatch ===');

const { normalizeMatch } = await loadModule('match-normalizer.js');
const norm = normalizeMatch(stored);

assert(norm.matchInfo?.home === '曼城', `matchInfo.home 正确 (${norm.matchInfo?.home})`);
assert(norm.matchInfo?.away === '阿森纳', 'matchInfo.away 正确');
assert(norm.matchInfo?.league === '英超', 'matchInfo.league 正确');
// norm.odds 是欧赔（不是 winDrawWin）
assert(typeof norm.odds === 'object', 'norm.odds 是对象');
assert(norm.odds?.averageCurrent?.win !== undefined, `norm.odds.averageCurrent.win 存在 (${norm.odds?.averageCurrent?.win})`);
// 亚盘盘口合法性
assert(norm.asian?.currentLineValue !== undefined, `asian.currentLineValue 存在 (${norm.asian?.currentLineValue})`);
assert(norm.asian?.lineQuality?.valid === true, `asian.lineQuality.valid 为 true (${norm.asian?.lineQuality?.valid})`);
// 大小球
assert(norm.overunder?.currentLine !== undefined, `overunder.currentLine 存在 (${norm.overunder?.currentLine})`);
assert(norm.overunder?.lineQuality?.valid === true, `overunder.lineQuality.valid 为 true (${norm.overunder?.lineQuality?.valid})`);
// derived 数据质量
assert(typeof norm.derived?.dataQuality === 'object', 'derived.dataQuality 是对象');
assert(['high', 'medium', 'low'].includes(norm.derived?.dataQuality?.level), `dataQuality.level 合法 (${norm.derived?.dataQuality?.level})`);

// ─── Test 3: quantAnalyze ────────────────────────────────────

console.log('\n=== Test 3: quantAnalyze ===');

const { analyze: quantAnalyze, toMarkdown: quantToMarkdown } = await loadModule('quant-engine.js');

const recentStats = {
  home: { 进球: { n10: 1.8 }, 失球: { n10: 1.0 } },
  away: { 进球: { n10: 1.2 }, 失球: { n10: 1.4 } },
  leagueAvg: 1.35,
};

const quantResult = quantAnalyze(stored.data, recentStats);

assert(quantResult.deMargin?.ok === true, `去水概率计算成功 (${quantResult.deMargin?.ok})`);
assert(quantResult.poisson?.ok === true, `泊松模型计算成功 (${quantResult.poisson?.ok})`);
assert(Array.isArray(quantResult.valueBets), '价值评估列表存在');
const quantMd = quantToMarkdown(quantResult);
assert(quantMd.length > 100, `量化报告 Markdown 非空 (${quantMd.length} chars)`);

// ─── Test 4: analyzeProfessionalMarket ───────────────────────

console.log('\n=== Test 4: analyzeProfessionalMarket ===');

const { analyzeProfessionalMarket } = await loadModule('pro-market-engine.js');
const proResult = analyzeProfessionalMarket({
  normalized: norm,
  quant: quantResult,
  jingcaiDeviation: stored.data.jingcai?.deviation || null,
});

assert(typeof proResult === 'object', 'proMarket 结果是对象');
// proResult.score 实际是 { edgeScore, riskScore, clvReadiness, confidenceDelta } 对象
assert(typeof proResult.score === 'object' && proResult.score !== null, `proMarket.score 是对象 (keys: ${Object.keys(proResult.score || {}).join(',')})`);
assert(typeof proResult.score?.edgeScore === 'number', `proMarket.score.edgeScore 是数字 (${proResult.score?.edgeScore})`);
assert(typeof proResult.plainSummary === 'string', 'proMarket.plainSummary 是字符串');

// ─── Test 5: analyzeUpsetRisk ─────────────────────────────────

console.log('\n=== Test 5: analyzeUpsetRisk ===');

const { analyzeUpsetRisk } = await loadModule('risk-engine.js');
const riskResult = analyzeUpsetRisk({
  normalized: norm,
  quant: quantResult,
  proMarket: proResult,
});

assert(typeof riskResult === 'object', 'riskResult 是对象');
// 实际字段是 riskResult.score（不是 totalScore）
assert(typeof riskResult.score === 'number', `风险分值 riskResult.score 存在 (${riskResult.score})`);
assert(['low', 'medium_low', 'medium', 'medium_high', 'high'].includes(riskResult.level), `风险等级合法 (${riskResult.level})`);

// ─── Test 6: ReportGenerator ──────────────────────────────────

console.log('\n=== Test 6: ReportGenerator.generate ===');

const { ReportGenerator } = await loadModule('report.js');
const reportGen = new ReportGenerator();
const report = reportGen.generate(stored, {
  normalized: norm,
  quant: quantResult,
  proMarket: proResult,
  riskProfile: riskResult,
});

assert(typeof report === 'object', 'report 是对象');
assert(typeof report.markdown === 'string', '报告 markdown 是字符串');
assert(report.markdown.length > 200, `报告 Markdown 内容充足 (${report.markdown.length} chars)`);
assert(typeof report.structured === 'object', '结构化报告 structured 存在');

// ─── 汇总 ─────────────────────────────────────────────────────

console.log(`\n=== 测试完成：✅ ${pass} 通过  ❌ ${fail} 失败 ===`);

if (fail > 0) {
  process.exit(1);
}
