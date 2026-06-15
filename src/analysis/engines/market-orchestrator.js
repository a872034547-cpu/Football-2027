/**
 * market-orchestrator.js — 发布版（存根）
 *
 * 核心算法（inferScenario, buildHistoryBaseline, buildCurrentMarketRead,
 * buildCounterEvidenceTrial, buildExecutionCommand, buildReviewChecklist）
 * 已迁移至服务器端 football-api/analyze.php，本地版本为轻量兜底。
 * background.js 优先调用云端 analyze.market，失败时降级至此存根。
 */

function safeArray(v) { return Array.isArray(v) ? v : []; }
function text(v, fallback = '') { return v === null || v === undefined || v === '' ? fallback : String(v); }
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[^0-9.+\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * buildMarketCommand — 轻量存根
 * 云端成功时此函数不会被使用；云端失败时提供基础结构防止下游报错。
 */
export function buildMarketCommand({ normalized = {}, knowledge = {}, quant = null, riskProfile = null, prediction = {}, marketTimeline = null, ruleCalibrationProfile = null } = {}) {
  try {
    const summary = knowledge?.summary || {};
    const resonance = knowledge?.resonance || prediction?.marketResonance || null;
    const topRule = resonance?.topRule || null;
    const verdict = prediction?.marketVerdict || prediction?.marketCoreDecision || null;

    // 基础剧本推断（存根：只做简单方向判断）
    const mainDir = summary?.mainDirection || '';
    const riskLevel = summary?.riskLevel || '';
    const isHighRisk = /high|medium_high/.test(riskLevel);
    const hasDirection = mainDir && mainDir !== 'watch';

    const scenario = hasDirection && !isHighRisk
      ? { code: 'basic_direction', label: '基础盘口方向（本地存根，仅观察）', plain: `当前本地存根只识别到基础方向：${mainDir}。缺少云端盘口总控时不得升为中高价值，只能观察/极低仓等待云端与临场确认。`, scoreTemplates: '需结合云端总控与临场首发确认' }
      : { code: 'watch_only', label: '盘口观望（本地存根）', plain: '核心规则由云端执行，当前为本地轻量结果，建议等待云端分析完成后再判断。', scoreTemplates: '待临场确认' };

    const shouldWatch = true;
    const stake = '观望/极低仓（0~0.2u，云端总控缺失禁止入库）';

    const executionCommand = {
      headline: `【盘口总控】${scenario.label}`,
      bestMarket: '等待云端盘口总控、临场水位和首发确认，暂不入场',
      secondaryMarket: '大小球仅作联动复核',
      avoidMarkets: ['无强共振时回避大仓', '临场反向时立即止损'],
      stake,
      confidence: summary?.confidence || 50,
      liveChecklist: ['临场亚盘水位是否坚挺支持基础方向', '欧赔是否在赛前2小时继续收紧', '大小球是否与方向共振', '首发/核心伤停是否触发五类重大反证'],
      plain: '本地存根不具备推荐准入权，当前只能观察，禁止包装为中高价值。'
    };

    const counterEvidenceTrial = {
      verdict: isHighRisk ? 'downgrade' : 'keep',
      label: isHighRisk ? '降仓执行' : '保留盘口裁决',
      reasons: safeArray(knowledge?.blockedBy).slice(0, 3).map(b => b.msg || b.code),
      categories: { coreInjury: { hit: false, evidence: [] }, lineupRotation: { hit: false, evidence: [] }, motivationReversal: { hit: false, evidence: [] }, lateMarketReverse: { hit: false, evidence: [] }, dataError: { hit: false, evidence: [] } },
      plain: isHighRisk ? '存在风险信号，降仓执行。' : '未发现强反证。'
    };

    return {
      version: 'market-command-v4',
      generatedAt: new Date().toISOString(),
      _source: 'local_stub',
      historyBaseline: {
        label: `${normalized?.matchInfo?.home || '主队'} vs ${normalized?.matchInfo?.away || '客队'}`,
        plain: '本地存根：未获取到云端盘口总控，历史基线未计算。',
        formRead: [], goalBaseline: { lambdaHome: null, lambdaAway: null, expectedGoals: null, topScores: [], recentForm: null }
      },
      currentMarketRead: {
        headline: verdict?.headline || '本地存根：未获取到云端盘口读盘',
        resonance, topRule, plain: resonance?.plainSummary || '本地存根模式，未获取到云端盘口总控。',
        bookmakerIntent: verdict?.bookmakerIntent || null, euroCore: verdict?.euroCore || null,
        asian: verdict?.crossMarket?.asian || null, overunder: verdict?.crossMarket?.overunder || null,
        consistencyScore: null
      },
      marketTimeline: marketTimeline ? { version: 'market-timeline-v1', sampleCount: safeArray(marketTimeline.snapshots).length, summary: marketTimeline.summary || '' } : null,
      ruleCalibration: ruleCalibrationProfile ? { version: 'rule-calibration-v1', hasProfile: true } : null,
      futureScenarios: [
        { ...scenario, probabilityRank: 1, action: executionCommand.bestMarket },
        { code: 'late_reverse', label: '临场反向剧本', plain: '若临场出现退盘/高水/大小球不配合，原方向必须降级。', action: '降仓或观望' },
        { code: 'data_break', label: '数据反证剧本', plain: '若首发、伤停、战意或数据错误触发强反证，盘口裁决可推翻。', action: '推翻或重算' }
      ],
      primaryScenario: scenario,
      counterEvidenceTrial,
      executionCommand,
      reviewChecklist: [
        `复盘盘口剧本是否正确：${scenario.label}`,
        topRule ? `复盘 R01-R14 主规则是否有效：${topRule.ruleId}` : '复盘 R01-R14 未命中时基础盘口裁决是否可靠',
        `复盘反证审判是否正确：${counterEvidenceTrial.label}`,
        `复盘执行仓位是否合理：${executionCommand.stake}`,
        '复盘临场盘口是否出现反向退盘、暴拉高水或大小球不配合',
        '记录赛果、比分、赢盘、大小球结果，并给规则命中/误判打标签'
      ],
      aiDiscipline: {
        mustUse: true,
        mustReview: ['MARKET_COMMAND_JSON', 'MARKET_VERDICT_JSON', 'marketResonance/R01-R14', '五类重大反证'],
        cannotOverrideWithout: ['核心伤停', '首发重大轮换', '战意结构反转', '临场盘口反向变动', '数据采集错误'],
        outputRequired: ['盘口剧本', '反证审判', '最优玩法', '回避玩法', '仓位纪律', '临场复核点']
      },
      plainSummary: `${scenario.label}：${scenario.plain} 执行=${executionCommand.bestMarket}，仓位=${executionCommand.stake}。`
    };
  } catch (e) {
    return {
      version: 'market-command-v4',
      generatedAt: new Date().toISOString(),
      error: e.message,
      _source: 'local_stub_error',
      primaryScenario: { code: 'watch_only', label: '盘口总控异常，观望', plain: '总控模块异常时不强行给结论。' },
      counterEvidenceTrial: { verdict: 'downgrade', label: '异常降级', reasons: [e.message], categories: {}, plain: '总控异常，降级观望。' },
      executionCommand: { headline: '【盘口总控】异常降级观望', bestMarket: '观望', avoidMarkets: ['全部重仓'], stake: '观望', liveChecklist: ['修复总控异常后重算'] },
      reviewChecklist: ['复盘总控异常原因'],
      aiDiscipline: { mustUse: true, cannotOverrideWithout: ['数据采集错误'] },
      plainSummary: '盘口总控异常，按观望处理。'
    };
  }
}

export function marketCommandToMarkdown(command = {}) {
  if (!command || command.version !== 'market-command-v4') return '## 盘口总控 v4\n- 暂无盘口总控命令。';
  const L = [];
  L.push('## 盘口总控 v4（MARKET_COMMAND_JSON）');
  if (command._source === 'local_stub' || command._source === 'local_stub_error') {
    L.push(`> ⚠️ 本地存根模式：核心规则由云端执行，以下为轻量兜底结果`);
  }
  L.push(`- 总控结论：${text(command.plainSummary, '暂无')}`);
  L.push(`- 历史基线：${text(command.historyBaseline?.plain, '-')}`);
  if (command.historyBaseline?.goalBaseline) {
    const g = command.historyBaseline.goalBaseline;
    L.push(`- 进球基线：λ主=${g.lambdaHome ?? '-'} / λ客=${g.lambdaAway ?? '-'} / 预期总球=${g.expectedGoals ?? '-'}`);
  }
  L.push(`- 当前读盘：${text(command.currentMarketRead?.headline, '-')}`);
  if (command.currentMarketRead?.plain) L.push(`- 读盘摘要：${command.currentMarketRead.plain}`);
  if (command.primaryScenario) {
    const s = command.primaryScenario;
    L.push('');
    L.push(`**盘口剧本：${s.label}**`);
    L.push(`- 剧本描述：${text(s.plain, '-')}`);
    if (s.scoreTemplates) L.push(`- 比分参考：${s.scoreTemplates}`);
  }
  if (command.counterEvidenceTrial) {
    const ct = command.counterEvidenceTrial;
    L.push('');
    L.push(`**反证审判：${ct.label}**`);
    L.push(`- 审判结论：${text(ct.plain, '-')}`);
    if (ct.reasons?.length) L.push(`- 主要反证：${ct.reasons.slice(0, 4).join('；')}`);
  }
  if (command.executionCommand) {
    const ec = command.executionCommand;
    L.push('');
    L.push(`**执行命令**`);
    L.push(`- ${ec.headline}`);
    L.push(`- 最优玩法：${text(ec.bestMarket, '-')}`);
    L.push(`- 仓位纪律：${text(ec.stake, '-')}`);
    if (ec.avoidMarkets?.length) L.push(`- 回避玩法：${ec.avoidMarkets.join('、')}`);
    if (ec.liveChecklist?.length) {
      L.push(`- 临场复核：`);
      ec.liveChecklist.forEach(item => L.push(`  * ${item}`));
    }
  }
  if (command.reviewChecklist?.length) {
    L.push('');
    L.push('**复盘清单**');
    command.reviewChecklist.forEach(item => L.push(`- ${item}`));
  }
  return L.join('\n');
}
