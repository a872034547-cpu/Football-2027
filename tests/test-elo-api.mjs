/**
 * test-elo-api.mjs - Elo Rating API 集成测试
 * 
 * 测试内容：
 * - GET /api/elo/teams - 查询球队列表
 * - GET /api/elo/teams/:teamKey - 查询单个球队
 * - GET /api/elo/match-prediction - 查询对阵预测
 * - GET /api/elo/events - 查询 Elo 事件
 */

import assert from 'assert';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, options);
  const data = await response.json();
  return { status: response.status, data };
}

let pass = 0;
let fail = 0;

function test(name, fn) {
  return fn()
    .then(() => {
      console.log(`  ✅ ${name}`);
      pass++;
    })
    .catch((err) => {
      console.error(`  ❌ ${name}`);
      console.error(`     ${err.message}`);
      fail++;
    });
}

console.log('\n=== Test: Elo Rating API 集成测试 ===\n');
console.log(`测试服务器: ${BASE_URL}`);
console.log('提示：确保服务器已启动（npm run dev）\n');

(async () => {
  try {
    // 1. 测试获取球队列表
    await test('GET /api/elo/teams - 获取球队列表', async () => {
      const { status, data } = await request('/api/elo/teams?limit=10');
      assert.strictEqual(status, 200, 'status should be 200');
      assert.strictEqual(data.ok, true, 'ok should be true');
      assert(Array.isArray(data.ratings), 'ratings should be array');
      assert.strictEqual(data.namespace, 'global', 'namespace should be global');
    });

    // 2. 测试获取单个球队（假设数据库为空时返回404）
    await test('GET /api/elo/teams/:teamKey - 球队不存在返回404', async () => {
      const { status, data } = await request('/api/elo/teams/nonexistent');
      assert.strictEqual(status, 404, 'status should be 404');
      assert.strictEqual(data.ok, false, 'ok should be false');
    });

    // 3. 测试对阵预测（缺少参数时返回400）
    await test('GET /api/elo/match-prediction - 缺少参数返回400', async () => {
      const { status, data } = await request('/api/elo/match-prediction');
      assert.strictEqual(status, 400, 'status should be 400');
      assert.strictEqual(data.ok, false, 'ok should be false');
    });

    // 4. 测试对阵预测（带参数）
    await test('GET /api/elo/match-prediction - 正常查询', async () => {
      const { status, data } = await request('/api/elo/match-prediction?homeTeam=Manchester United&awayTeam=Liverpool&league=英超');
      // 可能返回404（数据不存在）或200（有数据）
      assert([200, 404].includes(status), 'status should be 200 or 404');
    });

    // 5. 测试获取 Elo 事件
    await test('GET /api/elo/events - 获取事件列表', async () => {
      const { status, data } = await request('/api/elo/events?limit=10');
      assert.strictEqual(status, 200, 'status should be 200');
      assert.strictEqual(data.ok, true, 'ok should be true');
      assert(Array.isArray(data.events), 'events should be array');
    });

    // 6. 测试按 matchId 获取事件
    await test('GET /api/elo/events/:matchId - 按比赛ID查询', async () => {
      const { status, data } = await request('/api/elo/events/TEST_MATCH_001');
      assert.strictEqual(status, 200, 'status should be 200');
      assert.strictEqual(data.ok, true, 'ok should be true');
      assert(Array.isArray(data.events), 'events should be array');
    });

    console.log(`\n=== API 测试完成：✅ ${pass} 通过  ❌ ${fail} 失败 ===\n`);

    if (fail > 0) {
      console.log('提示：部分测试失败可能是因为服务器未启动或数据库为空\n');
    }

    process.exit(fail > 0 ? 1 : 0);
  } catch (err) {
    console.error('\n❌ API 测试执行失败:', err.message);
    console.error('\n提示：请确保服务器正在运行（npm run dev）\n');
    process.exit(1);
  }
})();
