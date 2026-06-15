/**
 * 服务端独立增强层测试：校准 / CLV / 评级先验 / 确定性 Monte Carlo / 回测门禁。
 * 运行：node tests/test-enhancement-engine.mjs
 */

import { buildServerEnhancement, enhancementToMarkdown } from '../src/analysis/enhancementEngine.js';

let pass = 0;
let fail = 0;

function assert(condition, label, actual) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.error(`  ❌ ${label}${actual !== undefined ? ` (actual: ${JSON.stringify(actual)?.slice(0, 160)})` : ''}`);
    fail++;
  }
}

console.log('\n=== Test: server-only enhancementEngine ===');

const input = {
  matchId: 'enhancement-001',
  probabilities: { home: 0.49, draw: 0.26, away: 0.25, source: 'deMargin' },
  rankScore: 66,
  snapshot: { completenessScore: 0.85 },
  normalized: {
    matchInfo: { home: '曼城', away: '阿森纳', league: '英超', time: '2026-06-15 19:30' },
    odds: {
      averageCurrent: { win: 1.87, draw: 3.52, loss: 3.75 },
      companyCount: 3,
    },
    asian: {
      currentLine: '受让半球',
      currentLineValue: -0.5,
      currentHomeWater: 0.88,
      currentAwayWater: 0.92,
      lineQuality: { valid: true },
      movementPath: [{}, {}],
    },
    overunder: {
      currentLine: 2.5,
      currentOverWater: 0.92,
      currentUnderWater: 0.88,
      lineQuality: { valid: true },
      movementPath: [{}],
    },
    stats: {
      recentStats: {
        home: { '进球': { n10: 1.8 }, '失球': { n10: 1.0 } },
        away: { '进球': { n10: 1.2 }, '失球': { n10: 1.4 } },
      },
    },
    derived: {
      missingFields: [],
      dataQuality: { score: 82, level: 'high' },
      dataCompleteness: { overallScore: 86 },
    },
  },
  quant: {
    poisson: { ok: true, lambdaHome: 1.55, lambdaAway: 1.05, expectedGoals: 2.6 },
    valueBets: [
      { label: '主胜', edge: 0.03, ev: 0.04, tier: '中edge参考' },
    ],
  },
  proMarket: {
    score: { edgeScore: 58, confidenceDelta: 8 },
  },
  riskProfile: { level: 'medium', score: 50 },
};

(async () => {
  const result = await buildServerEnhancement(input);

  assert(result.version === 'server-enhancement-v1', '版本号正确', result.version);
  assert(typeof result.generatedAt === 'string', 'generatedAt 存在');
  assert(typeof result.calibration?.reliabilityScore === 'number', '校准可靠度为数字', result.calibration);
  assert(['usable_with_audit', 'bootstrap', 'needs_history'].includes(result.calibration?.status), '校准状态合法', result.calibration?.status);
  assert(typeof result.clv?.readinessScore === 'number', 'CLV 准备度为数字', result.clv);
  assert(result.clv?.baseline?.wdw === true, 'CLV 胜平负基线正确', result.clv?.baseline?.wdw);
  assert(typeof result.ratingPrior?.ratingDiff === 'number', '评级先验 ratingDiff 为数字', result.ratingPrior);
  assert(result.monteCarlo?.ok === true, 'Monte Carlo 执行成功', result.monteCarlo);
  assert(result.monteCarlo?.simulations === 5000, 'Monte Carlo 模拟次数正确', result.monteCarlo?.simulations);
  assert(result.monteCarlo?.topScores?.length > 0, 'Monte Carlo 高频比分存在', result.monteCarlo?.topScores);
  assert(['blocked_until_verified', 'paper_trade_ready'].includes(result.backtest?.status), '回测门禁状态合法', result.backtest?.status);
  assert(['observe_only', 'balanced_candidate', 'trusted_candidate'].includes(result.decision?.candidateTier), '增强决策分层合法', result.decision?.candidateTier);
  assert(result.decision?.enhancedScore >= 0 && result.decision?.enhancedScore <= 100, '增强分在 0-100 范围', result.decision?.enhancedScore);

  const result2 = await buildServerEnhancement(input);
  assert(
    JSON.stringify(result.monteCarlo.outcome) === JSON.stringify(result2.monteCarlo.outcome),
    'Monte Carlo 对同一 matchId 确定性可复现',
    { first: result.monteCarlo.outcome, second: result2.monteCarlo.outcome },
  );

  const md = enhancementToMarkdown(result);
  assert(typeof md === 'string' && md.includes('服务端独立增强层'), '增强层 Markdown 可生成', md);
  assert(md.includes('Monte Carlo'), '增强层 Markdown 包含 Monte Carlo 摘要', md);

  console.log(`\n=== 测试完成：✅ ${pass} 通过  ❌ ${fail} 失败 ===`);
  process.exit(fail > 0 ? 1 : 0);
})();

if (fail > 0) process.exit(1);
