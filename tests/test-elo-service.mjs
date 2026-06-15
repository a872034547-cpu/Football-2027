/**
 * test-elo-service.mjs - Elo Rating 服务单元测试
 * 
 * 测试内容：
 * - 队名规范化
 * - 预期得分计算
 * - 球队评分初始化与查询
 * - 比赛结果处理与 Elo 更新
 * - 对阵预测查询
 */

import assert from 'assert';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 动态导入 Elo 服务模块
const eloServiceModule = await import('../src/ratings/eloService.js');
const {
  normalizeTeamName,
  calculateExpectedScore,
  calculateActualScore,
  calculateGoalMarginMultiplier,
  getCompetitionWeight,
  getOrInitTeamRating,
  processMatchResult,
  getTeamRatingsForMatch,
} = eloServiceModule;

// 测试数据库路径
const TEST_DB_PATH = path.resolve(__dirname, '../data/__test_elo_service__.sqlite');

// 清理旧测试数据库
if (fs.existsSync(TEST_DB_PATH)) {
  fs.unlinkSync(TEST_DB_PATH);
}

// 初始化测试数据库
const db = new Database(TEST_DB_PATH);
db.pragma('journal_mode = WAL');

// 创建表结构
const schemaPath = path.resolve(__dirname, '../src/db/schema-elo.sql');
const schema = fs.readFileSync(schemaPath, 'utf-8');
db.exec(schema);

// 注入数据库到 eloService（通过设置全局）
global.__test_db__ = db;

// ─────────────────────────────────────────────────────────────────
// 测试工具函数
// ─────────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    pass++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    fail++;
  }
}

function round(num, digits = 2) {
  return Math.round(num * Math.pow(10, digits)) / Math.pow(10, digits);
}

// ─────────────────────────────────────────────────────────────────
// 测试用例
// ─────────────────────────────────────────────────────────────────

console.log('\n=== Test: Elo Service 核心功能 ===\n');

// 1. 测试队名规范化
test('normalizeTeamName 正确规范化队名', () => {
  // 实际实现：移除空格、转小写，移除特殊符号
  assert.strictEqual(normalizeTeamName('Manchester United'), 'manchesterunited');
  assert.strictEqual(normalizeTeamName('皇家马德里'), '皇家马德里');
  assert.strictEqual(normalizeTeamName('  Real Madrid  '), 'realmadrid');
  assert.strictEqual(normalizeTeamName(''), '');
});

// 2. 测试预期得分计算
test('calculateExpectedScore 计算预期得分', () => {
  const expected1 = calculateExpectedScore(1500, 1500, 0); // 同等实力，无主场优势
  assert.strictEqual(round(expected1, 2), 0.5);

  const expected2 = calculateExpectedScore(1600, 1400, 100); // 主队强 + 主场优势
  assert(expected2 > 0.75, 'Expected score should be > 0.75');

  const expected3 = calculateExpectedScore(1400, 1600, 0); // 主队弱
  assert(expected3 < 0.5, 'Expected score should be < 0.5');
});

// 3. 测试实际得分计算
test('calculateActualScore 计算实际得分', () => {
  assert.strictEqual(calculateActualScore(2, 1), 1); // 主队胜
  assert.strictEqual(calculateActualScore(1, 1), 0.5); // 平局
  assert.strictEqual(calculateActualScore(0, 2), 0); // 主队负
});

// 4. 测试净胜球倍数（修正期望值：sqrt公式）
test('calculateGoalMarginMultiplier 计算净胜球倍数', () => {
  assert.strictEqual(calculateGoalMarginMultiplier(2, 1), 1); // 1球，sqrt(1)=1
  assert.strictEqual(round(calculateGoalMarginMultiplier(3, 1), 2), 1.41); // 2球，sqrt(2)≈1.41
  assert.strictEqual(round(calculateGoalMarginMultiplier(5, 2), 2), 1.73); // 3球，sqrt(3)≈1.73
  assert.strictEqual(calculateGoalMarginMultiplier(1, 1), 1); // 平局
});

// 5. 测试赛事权重（根据实际COMPETITION_WEIGHTS常量）
test('getCompetitionWeight 返回正确赛事权重', () => {
  assert.strictEqual(getCompetitionWeight('friendly'), 0.6);
  assert.strictEqual(getCompetitionWeight('友谊赛'), 0.6);
  assert.strictEqual(getCompetitionWeight('cup'), 0.9);
  assert.strictEqual(getCompetitionWeight('league'), 1.0);
  assert.strictEqual(getCompetitionWeight('未知联赛'), 1.0);
});

// 6. 测试球队评分初始化与查询（需要异步）
console.log('\n--- 异步测试：数据库操作 ---\n');

(async () => {
  try {
    // 测试初始化球队评分（使用规范化后的 team_key）
    const team1 = await getOrInitTeamRating('global', 'manchesterunited', 'Manchester United', '英超');
    test('getOrInitTeamRating 初始化球队评分', () => {
      assert.strictEqual(team1.team_key, 'manchesterunited');
      assert.strictEqual(team1.rating, 1500);
      assert.strictEqual(team1.matches_played, 0);
    });

    // 测试重复初始化（应返回现有记录）
    const team1Again = await getOrInitTeamRating('global', 'manchesterunited');
    test('getOrInitTeamRating 不重复初始化', () => {
      assert.strictEqual(team1Again.team_key, 'manchesterunited');
      assert.strictEqual(team1Again.rating, 1500);
    });

    // 7. 测试比赛结果处理与 Elo 更新
    const matchResult = {
      matchId: 'TEST_MATCH_001',
      businessDate: '2026-06-15',
      homeTeam: 'Manchester United',
      awayTeam: 'Liverpool',
      homeScore: 2,
      awayScore: 1,
      league: '英超',
    };

    const result = await processMatchResult(matchResult, 'global');
    test('processMatchResult 处理比赛结果', () => {
      assert(result.home, 'home rating should exist');
      assert(result.away, 'away rating should exist');
      assert(result.home.newRating > result.home.oldRating, 'winner rating should increase');
      assert(result.away.newRating < result.away.oldRating, 'loser rating should decrease');
      assert(result.expected.homeAdvantage >= 0, 'home advantage should be non-negative');
    });

    // 验证评分已更新
    const updatedHome = await getOrInitTeamRating('global', 'manchesterunited');
    test('processMatchResult 更新数据库评分', () => {
      assert.strictEqual(updatedHome.matches_played, 1);
      assert(updatedHome.rating > 1500, 'rating should increase after win');
    });

    // 8. 测试对阵预测查询
    const prediction = await getTeamRatingsForMatch('Manchester United', 'Liverpool', '英超', 'global');
    test('getTeamRatingsForMatch 查询对阵预测', () => {
      assert(prediction, 'prediction should exist');
      assert(prediction.home, 'home team rating should exist');
      assert(prediction.away, 'away team rating should exist');
      assert(prediction.expected, 'expected values should exist');
      assert(prediction.expected.homeWinProb > 0 && prediction.expected.homeWinProb < 1, 'win prob in range');
      assert.strictEqual(round(prediction.expected.homeWinProb + prediction.expected.awayWinProb, 2), 1.0, 'probs sum to 1');
    });

    // 9. 测试 namespace 隔离
    const team2 = await getOrInitTeamRating('test_ns', 'realmadrid', 'Real Madrid', '西甲');
    test('namespace 隔离：不同 namespace 独立存储', () => {
      assert.strictEqual(team2.namespace, 'test_ns');
      assert.strictEqual(team2.team_key, 'realmadrid');
      assert.strictEqual(team2.rating, 1500);
    });

    // 10. 测试多场比赛累积
    const match2Result = {
      matchId: 'TEST_MATCH_002',
      businessDate: '2026-06-16',
      homeTeam: 'Manchester United',
      awayTeam: 'Chelsea',
      homeScore: 3,
      awayScore: 0,
      league: '英超',
    };

    await processMatchResult(match2Result, 'global');
    const finalHome = await getOrInitTeamRating('global', 'manchesterunited');
    test('多场比赛累积更新评分', () => {
      assert.strictEqual(finalHome.matches_played, 2);
      assert(finalHome.rating > updatedHome.rating, 'rating continues to increase');
    });

    // ─────────────────────────────────────────────────────────────────
    // 测试总结
    // ─────────────────────────────────────────────────────────────────

    console.log(`\n=== 测试完成：✅ ${pass} 通过  ❌ ${fail} 失败 ===\n`);

    // 清理
    db.close();
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }

    process.exit(fail > 0 ? 1 : 0);
  } catch (err) {
    console.error('\n❌ 异步测试执行失败:', err);
    db.close();
    process.exit(1);
  }
})();
