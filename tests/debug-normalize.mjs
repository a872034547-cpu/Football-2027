import { snapshotToStored } from '../src/analysis/snapshotToStored.js';
import { loadModule } from '../src/analysis/jsModuleLoader.js';

const snapshot = {
  matchId: '3001234', completenessScore: 0.75, source: 'titan007',
  collectedAt: new Date().toISOString(), errors: [],
  analysis: {
    text: '曼城 vs 阿森纳 近10场主场胜7平2负1',
    homeTeam: '曼城', awayTeam: '阿森纳',
    winDrawWin: { companies: [{ name: 'Bet365', win: 1.87, draw: 3.60, lose: 3.75 }] },
    history: { excerpt: '历史交锋' }
  },
  asian: { companies: [{ name: '澳门', homeWater: 0.88, line: '-0.5', awayWater: 0.92 }], mainLine: '-0.5', mainHomeWater: 0.88, mainAwayWater: 0.92 },
  overunder: { companies: [{ name: '澳门', overWater: 0.92, line: 2.5, underWater: 0.88 }], mainLine: 2.5 }
};
const todayMatch = {
  matchId: '3001234', home: '曼城', away: '阿森纳',
  league: '英超', matchTime: '2026-06-15T19:30:00+08:00', status: 'pre_match'
};

const stored = snapshotToStored(snapshot, todayMatch);
console.log('=== stored.data keys:', Object.keys(stored.data));
console.log('=== stored.data.matchInfo:', JSON.stringify(stored.data.matchInfo, null, 2));
console.log('=== stored.data.winDrawWin.companies[0]:', JSON.stringify(stored.data.winDrawWin.companies[0], null, 2));
console.log('=== stored.data.asian.keyOdds?.ao:', JSON.stringify(stored.data.asian.keyOdds?.ao, null, 2));

const { normalizeMatch } = await loadModule('match-normalizer.js');
const norm = normalizeMatch(stored);

console.log('\n=== norm top-level keys:', Object.keys(norm || {}));
console.log('=== norm.matchInfo:', JSON.stringify(norm?.matchInfo));
console.log('=== norm.winDrawWin type:', typeof norm?.winDrawWin);
console.log('=== norm.winDrawWin keys:', Object.keys(norm?.winDrawWin || {}));
console.log('=== norm.asian.currentLineValue:', norm?.asian?.currentLineValue);
console.log('=== norm.overunder.currentLineValue:', norm?.overunder?.currentLineValue);
console.log('=== norm.dataQuality:', JSON.stringify(norm?.dataQuality));

// proMarket调试
const { analyzeProfessionalMarket } = await loadModule('pro-market-engine.js');
const proResult = analyzeProfessionalMarket({ normalized: norm });
console.log('\n=== proResult top-level keys:', Object.keys(proResult || {}));
console.log('=== proResult.signals:', proResult?.signals);
console.log('=== proResult.summary:', proResult?.summary);

// riskEngine调试
const { analyzeUpsetRisk } = await loadModule('risk-engine.js');
const riskResult = analyzeUpsetRisk({ normalized: norm, quant: null, proMarket: proResult });
console.log('\n=== riskResult top-level keys:', Object.keys(riskResult || {}));
console.log('=== riskResult.totalScore:', riskResult?.totalScore);
console.log('=== riskResult.score:', riskResult?.score);
