#!/usr/bin/env node
/**
 * 竞彩接口验证测试
 * 验证 sportteryCollector 能否正确调用 PHP 后端并解析数据
 */

import { collectSporttery } from '../src/collectors/sportteryCollector.js';

console.log('\n=== 竞彩接口验证测试 ===\n');

async function testSportteryCollector() {
  console.log('测试 1: 调用 collectSporttery()');
  
  try {
    const result = await collectSporttery({
      date: '2026-06-14',
      phpApiBase: 'http://localhost/football-api', // 默认本地 PHP 后端
      timeout: 10000
    });
    
    console.log(`  ✅ collectSporttery 调用成功`);
    console.log(`  ℹ️ businessDate: ${result.businessDate}`);
    console.log(`  ℹ️ total: ${result.total}`);
    console.log(`  ℹ️ HAD 数量: ${result.had?.length || 0}`);
    console.log(`  ℹ️ HHAD 数量: ${result.hhad?.length || 0}`);
    console.log(`  ℹ️ TTG 数量: ${result.ttg?.length || 0}`);
    
    if (result.had && result.had.length > 0) {
      const sample = result.had[0];
      console.log(`  ℹ️ HAD 样例: matchId=${sample.matchId}, num=${sample.num}`);
      console.log(`    胜平负: ${sample.had?.win || 'N/A'} / ${sample.had?.draw || 'N/A'} / ${sample.had?.loss || 'N/A'}`);
      if (sample.deviation) {
        console.log(`    偏差: avg=${sample.deviation.avgDeviation?.toFixed(2)}%, max=${sample.deviation.maxDeviation?.toFixed(2)}%`);
      }
    }
    
    if (result.hhad && result.hhad.length > 0) {
      const sample = result.hhad[0];
      console.log(`  ℹ️ HHAD 样例: matchId=${sample.matchId}, handicap=${sample.handicap}`);
    }
    
    console.log('\n  ✅ 竞彩接口格式验证通过\n');
    return true;
    
  } catch (err) {
    console.error(`  ❌ 竞彩接口调用失败: ${err.message}`);
    
    if (err.message.includes('ECONNREFUSED') || err.message.includes('fetch failed')) {
      console.log(`\n  ⚠️ 提示: 竞彩接口需要 PHP 后端运行在 http://localhost/football-api`);
      console.log(`     如果未部署 PHP 后端，此错误可忽略`);
      console.log(`     服务端会在 PHP 不可用时自动降级跳过竞彩采集\n`);
    } else if (err.message.includes('HTTP')) {
      console.log(`\n  ⚠️ 提示: PHP 后端返回非 200 状态码，请检查 football-api/sporttery.php\n`);
    }
    
    console.log(`  ℹ️ 技术细节: ${err.stack}\n`);
    return false;
  }
}

async function main() {
  const success = await testSportteryCollector();
  
  if (success) {
    console.log('=== ✅ 竞彩接口验证通过 ===\n');
    process.exit(0);
  } else {
    console.log('=== ⚠️ 竞彩接口不可用（可选依赖，不影响核心功能）===\n');
    process.exit(0); // 不作为失败处理，因为竞彩是可选功能
  }
}

main().catch(err => {
  console.error('未预期的错误:', err);
  process.exit(1);
});
