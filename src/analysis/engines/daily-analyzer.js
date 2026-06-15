/**
 * daily-analyzer.js
 * 今日比赛分析模块 - 联赛热门排序、盈利性评估、持久化记录
 */
import { getExpertKnowledgeDoctrine } from './expert-doctrine.js';

// 联赛热门优先级配置
const LEAGUE_PRIORITY = {
  // 顶级: 世界杯/欧冠/欧联/亚冠 = 100
  tier1: {
    score: 100,
    patterns: ['世界杯', 'FIFA', '欧冠', '冠军联赛', '欧洲杯', '美洲杯', '非洲杯', '亚洲杯', '金杯赛', 'Champions', 'Europa League', '欧联']
  },
  // 五大联赛 = 80
  tier2: {
    score: 80,
    patterns: ['英超', '西甲', '德甲', '意甲', '法甲', 'Premier League', 'La Liga', 'Bundesliga', 'Serie A', 'Ligue 1']
  },
  // 热门联赛 = 60
  tier3: {
    score: 60,
    patterns: ['葡超', '荷甲', '比甲', '土超', '俄超', '苏超', '英冠', '西乙', '意乙', '德乙', '法乙', '欧洲联盟杯', 'MLS', 'J联赛', 'K联赛', '中超', '澳超', '巴西', '阿根廷', '国际', '友谊']
  }
  // 其他 = 20
};

/**
 * 根据联赛名称获取优先级分数
 */
function getLeaguePriority(leagueName) {
  if (!leagueName) return 20;
  const name = String(leagueName);
  for (const tier of [LEAGUE_PRIORITY.tier1, LEAGUE_PRIORITY.tier2, LEAGUE_PRIORITY.tier3]) {
    if (tier.patterns.some(p => name.includes(p))) return tier.score;
  }
  return 20;
}

/**
 * 获取联赛分类标签
 */
function getLeagueTierLabel(leagueName) {
  if (!leagueName) return '其他';
  const name = String(leagueName);
  if (LEAGUE_PRIORITY.tier1.patterns.some(p => name.includes(p))) return '顶级赛事';
  if (LEAGUE_PRIORITY.tier2.patterns.some(p => name.includes(p))) return '五大联赛';
  if (LEAGUE_PRIORITY.tier3.patterns.some(p => name.includes(p))) return '热门联赛';
  return '其他';
}

function clamp(n, min = 0, max = 100) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
}

function calcCompletenessScore(matchData) {
  if (!matchData) return 0;
  const checks = [
    !!matchData.winDrawWin && !matchData.winDrawWin.error,
    !!matchData.asian && !matchData.asian.error,
    !!matchData.overunder && !matchData.overunder.error,
    !!matchData.analysis && !matchData.analysis.error,
    !!(matchData.winDrawWin?.summary?.averageCurrent || matchData.winDrawWin?.keyOdds),
    !!matchData.asian?.keyOdds?.ao,
    !!matchData.overunder?.keyOdds?.ao,
    !!(matchData.analysis?.recentStats || matchData.recentStats || matchData.analysis?.seasonComparison)
  ];
  return clamp(checks.filter(Boolean).length / checks.length * 100);
}

/**
 * 计算比赛可投注盈利性评分 (0-100)
 * v3.5：输出价值/风险/清晰度/可交易性/完整度多维评分，兼容旧的 score 字段。
 */
function calcProfitabilityScore(matchData) {
  if (!matchData) return {
    score: 0,
    signals: [],
    recommendation: '数据不足',
    scores: { valueScore: 0, riskScore: 100, clarityScore: 0, tradabilityScore: 0, completenessScore: 0, finalScore: 0 },
    screening: { bucket: 'observe', label: '数据不足', reasons: ['缺少比赛盘口数据'], warnings: ['请先采集盘口数据'] }
  };

  const signals = [];
  const warnings = [];
  let valueScore = 50;
  let clarityScore = 45;
  let tradabilityScore = 45;
  let riskScore = 35;

  const { asian, overunder, winDrawWin, analysis } = matchData;
  const completenessScore = calcCompletenessScore(matchData);

  // === 亚盘分析 ===
  if (asian && !asian.error && asian.companies?.length > 0) {
    const ao = asian.keyOdds?.ao;
    if (ao) {
      const homePay = parseFloat(ao.currentHomePay || ao.initialHomePay);
      const awayPay = parseFloat(ao.currentAwayPay || ao.initialAwayPay);
      const handicap = parseFloat(ao.currentHandicap || ao.initialHandicap);

      if (isFinite(homePay) && isFinite(awayPay)) {
        const diff = Math.abs(homePay - awayPay);
        if (diff < 0.03) {
          signals.push({ type: 'asian', level: 'high', msg: '亚盘水位平衡，盘口清晰但需防平局' });
          valueScore += 7;
          clarityScore += 8;
        } else if (diff > 0.1) {
          const favorSide = homePay > awayPay ? '客' : '主';
          signals.push({ type: 'asian', level: 'medium', msg: `亚盘水位倾向${favorSide}队` });
          valueScore += 5;
          clarityScore += 5;
        }
        if (homePay > 1.08 || awayPay > 1.08) {
          riskScore += 8;
          warnings.push('亚盘出现高水侧，注意赔付风险或诱盘');
        }
      }

      if (isFinite(handicap)) {
        if (handicap === 0) {
          signals.push({ type: 'asian', level: 'high', msg: '亚盘平手盘，高关注但方向需二次确认' });
          tradabilityScore += 6;
          riskScore += 4;
        } else if (Math.abs(handicap) <= 0.5) {
          signals.push({ type: 'asian', level: 'medium', msg: `亚盘浅盘，让${handicap > 0 ? '主' : '客'}${Math.abs(handicap)}球` });
          tradabilityScore += 5;
        } else if (Math.abs(handicap) >= 1.25) {
          riskScore += 8;
          warnings.push('深盘穿盘难度较高，需结合大小球与欧赔保护');
        }
      }
    }

    if (asian.companies.length >= 8) tradabilityScore += 8;
    else if (asian.companies.length >= 5) tradabilityScore += 5;
  } else {
    valueScore -= 12;
    clarityScore -= 10;
    tradabilityScore -= 10;
    warnings.push('缺少亚盘数据');
  }

  // === 欧赔分析 ===
  if (winDrawWin && !winDrawWin.error && winDrawWin.summary) {
    const sum = winDrawWin.summary;
    if (sum.averageReturnRate) {
      const rr = parseFloat(sum.averageReturnRate);
      if (rr >= 93) {
        signals.push({ type: 'europe', level: 'high', msg: `欧赔返还率高(${sum.averageReturnRate})，市场效率高` });
        valueScore += 8;
        tradabilityScore += 6;
      }
    }
    if (sum.impliedAverage) {
      const winP = parseFloat(sum.impliedAverage.win);
      const drawP = parseFloat(sum.impliedAverage.draw);
      const lossP = parseFloat(sum.impliedAverage.loss);
      const maxP = Math.max(winP, drawP, lossP);
      if (maxP > 60) {
        const dominant = winP > drawP && winP > lossP ? '主胜' : lossP > winP && lossP > drawP ? '客胜' : '平局';
        signals.push({ type: 'europe', level: 'medium', msg: `欧赔市场偏向${dominant}(${maxP.toFixed(0)}%)` });
        valueScore += 5;
        clarityScore += 8;
      } else if (maxP < 45) {
        riskScore += 5;
        signals.push({ type: 'europe', level: 'low', msg: '欧赔三项接近，胜平负方向不清晰' });
      }
    }
    if (sum.movement) {
      const m = sum.movement;
      if (m.winDown > m.winUp * 2) {
        signals.push({ type: 'europe', level: 'high', msg: '主胜赔率普遍下降，主队被看好' });
        valueScore += 6;
        clarityScore += 5;
      } else if (m.lossDown > m.lossUp * 2) {
        signals.push({ type: 'europe', level: 'high', msg: '客胜赔率普遍下降，客队被看好' });
        valueScore += 6;
        clarityScore += 5;
      }
    }
  } else {
    valueScore -= 8;
    clarityScore -= 8;
    warnings.push('缺少欧赔数据');
  }

  // === 大小球分析 ===
  if (overunder && !overunder.error && overunder.companies?.length > 0) {
    const ao = overunder.keyOdds?.ao;
    if (ao) {
      const line = parseFloat(ao.currentLine || ao.initialLine);
      if (isFinite(line)) {
        if (line >= 2.5 && line <= 3) {
          signals.push({ type: 'ou', level: 'medium', msg: `大小球标准盘口(${line})，进球预测适中` });
          valueScore += 3;
          tradabilityScore += 4;
        } else if (line <= 2.25) {
          riskScore += 5;
          signals.push({ type: 'ou', level: 'medium', msg: `低大小球线(${line})，注意低比分/平局` });
        }
      }
    }
  } else {
    clarityScore -= 6;
    warnings.push('缺少大小球数据');
  }

  // === 历史战绩 ===
  if (analysis && !analysis.error) {
    const home = analysis.homeStats;
    const away = analysis.awayStats;
    if (home?.winRate || away?.winRate || analysis.recentStats || matchData.recentStats) {
      valueScore += 5;
      clarityScore += 5;
      signals.push({ type: 'stats', level: 'low', msg: '有历史战绩/近期数据参考' });
    }
    const homeInjuries = analysis.injuries?.home?.length || 0;
    const awayInjuries = analysis.injuries?.away?.length || 0;
    if (homeInjuries + awayInjuries >= 4) {
      riskScore += 8;
      warnings.push(`伤停较多：主${homeInjuries}/客${awayInjuries}`);
    }
  } else {
    valueScore -= 6;
    clarityScore -= 8;
    warnings.push('缺少基本面/战绩数据');
  }

  if (completenessScore < 55) riskScore += 14;
  else if (completenessScore < 75) riskScore += 7;

  valueScore = clamp(valueScore);
  clarityScore = clamp(clarityScore);
  tradabilityScore = clamp(tradabilityScore);
  riskScore = clamp(riskScore);
  const finalScore = clamp(valueScore * 0.36 + clarityScore * 0.22 + tradabilityScore * 0.20 + completenessScore * 0.14 - riskScore * 0.18 + 8);

  let recommendation;
  if (finalScore >= 75) recommendation = '强烈推荐';
  else if (finalScore >= 60) recommendation = '推荐';
  else if (finalScore >= 45) recommendation = '一般';
  else recommendation = '观望';

  const bucket = finalScore >= 68 && riskScore < 58 ? 'focus' : riskScore >= 70 || completenessScore < 45 ? 'avoid' : 'observe';
  const label = bucket === 'focus' ? '重点关注' : bucket === 'avoid' ? '高风险提示' : '低仓观察';

  return {
    score: finalScore,
    signals,
    recommendation,
    scores: { valueScore, riskScore, clarityScore, tradabilityScore, completenessScore, finalScore },
    screening: {
      bucket,
      label,
      reasons: signals.slice(0, 5).map(s => s.msg),
      warnings: warnings.slice(0, 6)
    }
  };
}

/**
 * 从今日比赛列表页面提取比赛
 * 解析 oldIndexall.aspx 页面中的比赛信息
 */
function parseTodayMatchesFromHtml(html, text) {
  const matches = [];

  // 解析"析"字链接，提取比赛ID和名称
  // 链接格式类似 href="detail/2925444sb.htm" 或 href="/zjAnalysis/2925444cn.htm" 
  const analysisLinkRe = /href=['"](?:[^'"]*\/)?(\d{6,8})(?:cn|sb)?\.htm['"]/gi;
  const leagueMatchMap = new Map();

  // 尝试从行中提取比赛信息
  const rows = html.split(/<tr[^>]*>/i).slice(1);
  
  rows.forEach(row => {
    // 提取ID
    const idMatch = row.match(/href=['"][^'"]*?(\d{6,8})(?:cn|sb)?\.htm['"]/i);
    if (!idMatch) return;
    const matchId = idMatch[1];

    // 提取文本内容
    const cellTexts = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cm;
    while ((cm = cellRe.exec(row)) !== null) {
      const t = cm[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      if (t) cellTexts.push(t);
    }

    if (cellTexts.length < 3) return;

    // 比赛时间
    const timeMatch = row.match(/(\d{1,2}:\d{2})/);
    const matchTime = timeMatch ? timeMatch[1] : '';

    // 联赛名（通常在前面的格中）
    let league = '';
    let home = '';
    let away = '';
    let score = '';

    // 简单解析：找球队名（包含vs的行）
    const vsMatch = row.match(/([^\s<>]{2,12})\s*(?:vs|VS|对|－)\s*([^\s<>]{2,12})/);
    if (vsMatch) {
      home = vsMatch[1].trim();
      away = vsMatch[2].trim();
    }

    // 联赛通常是第一个有汉字的单元格，长度2-15
    for (const cell of cellTexts) {
      if (/[\u4e00-\u9fa5]/.test(cell) && cell.length >= 2 && cell.length <= 20 && !cell.includes('vs') && !cell.includes('VS')) {
        if (!league) league = cell;
        break;
      }
    }

    // 比分
    const scoreMatch = row.match(/(\d+)\s*[:\-]\s*(\d+)/);
    if (scoreMatch) score = `${scoreMatch[1]}:${scoreMatch[2]}`;

    if (matchId && !matches.find(m => m.id === matchId)) {
      matches.push({
        id: matchId,
        league: league || '未知',
        home: home || '主队',
        away: away || '客队',
        time: matchTime,
        score: score || '-',
        status: score && score !== '-' ? 'live' : 'upcoming',
        leaguePriority: getLeaguePriority(league),
        leagueTier: getLeagueTierLabel(league)
      });
    }
  });

  // 如果行解析失败，用正则从全文提取ID
  if (matches.length === 0) {
    const allIds = new Set();
    let m;
    while ((m = analysisLinkRe.exec(html)) !== null) {
      const id = m[1];
      if (id && !allIds.has(id)) {
        allIds.add(id);
        matches.push({
          id,
          league: '未知',
          home: '主队',
          away: '客队',
          time: '',
          score: '-',
          status: 'upcoming',
          leaguePriority: 20,
          leagueTier: '其他'
        });
      }
    }
  }

  return matches;
}

/**
 * 评估单场比赛的投注价值建议
 */
function buildAIPromptForDailyMatch(match, matchData) {
  const { id, league, home, away, time } = match;

  // 专家知识体系：与单场AI、深度AI、今日批量共用同一份v4.1完整知识源
  const expertCore = getExpertKnowledgeDoctrine();

  let prompt = expertCore;
  prompt += `请分析以下比赛的投注价值：\n\n`;
  prompt += `比赛：${home} vs ${away}\n`;
  prompt += `联赛：${league}\n`;
  prompt += `时间：${time}\n`;
  prompt += `比赛ID：${id}\n\n`;

  if (matchData) {
    const { asian, overunder, winDrawWin, analysis } = matchData;
    if (winDrawWin?.summary?.averageCurrent) {
      const s = winDrawWin.summary.averageCurrent;
      prompt += `欧赔均值：主${s.win} 平${s.draw} 客${s.loss}\n`;
    }
    if (winDrawWin?.summary?.impliedAverage) {
      const s = winDrawWin.summary.impliedAverage;
      prompt += `欧赔概率：主胜${s.win} 平${s.draw} 客胜${s.loss}\n`;
    }
    if (asian?.keyOdds?.ao) {
      const ao = asian.keyOdds.ao;
      prompt += `亚盘主要盘口：${ao.currentHandicap || ao.initialHandicap} 主水${ao.currentHomePay || ao.initialHomePay} 客水${ao.currentAwayPay || ao.initialAwayPay}\n`;
    }
    if (overunder?.keyOdds?.ao) {
      const ao = overunder.keyOdds.ao;
      prompt += `大小球：${ao.currentLine || ao.initialLine} 大${ao.currentOver || ao.initialOver} 小${ao.currentUnder || ao.initialUnder}\n`;
    }
    if (analysis?.matchInfo) {
      const mi = analysis.matchInfo;
      if (mi.weather) prompt += `天气：${mi.weather} ${mi.temperature || ''}\n`;
    }
  }

  prompt += `\n请按以下格式输出：
▶ 欧赔三态：[实盘/中庸/韬光] | 分布：[顺/逆/缓冲/中庸] | 平赔角色：[真实平局/分散/过渡/缓冲/阻挡/非平平赔]
▶ 主方向：[更可能方向/主推玩法 + 仓位，或"本场观望-原因"]
▶ 冷门/防冷：[平局/受让/不败/小比分/反热门胜等路径；写明是防冷保险还是冷门价值观察]
▶ 触发/失效：[冷门触发条件1-2条；若只是陷阱/风险/数据缺失，必须写不能反向下注]
▶ 理由：[核心依据，必须体现三态判断或平赔角色；大小球须写证据类型]`;
  return prompt;
}

/**
 * 构建批量今日比赛AI推送提示词
 */
function buildBatchAIPrompt(matchItems, portfolioCommand = null) {
  // ===== 专家知识体系：与单场AI、深度AI、今日单场共用同一份v4.1完整知识源 =====
  const expertDoctrine = getExpertKnowledgeDoctrine();

  let prompt = expertDoctrine;
  prompt += `今日足球比赛批量投注分析（${new Date().toLocaleDateString('zh-CN')}）\n\n`;
  prompt += `请对以下${matchItems.length}场比赛逐一分析投注价值，给出推荐方向、置信度和简要理由。最后汇总最高价值的3-5场重点推荐。\n`;
  prompt += `硬性要求：每场只能复核云端返回且 _source=cloud 的 MARKET_COMMAND_JSON 盘口总控 v4；若仅检测到 _source=local_stub/local_stub_error/本地存根/兜底结果，必须视为"云端盘口总控缺失"，不得引用为有效 MARKET_COMMAND_JSON，也不得写"盘口总控存在"。随后再复核 MARKET_VERDICT_JSON 盘口裁决单。\n`;
  prompt += `【动态权重规则（禁止固定80/20）】：三盘完全共振时盘口权重85%；无明显矛盾时保持80%；欧亚背离≥0.25球时降至70%；本地存根/云端缺失时降至55%；盘口异常时降至40%仅观望。辅助修正层：战意分差≥2时提升至25%，否则20%。每场分析必须声明采用哪档权重。知识库+欧赔核心+庄家盘口为最高优先级；有效云端 MARKET_COMMAND_JSON/marketCommand 是最高总裁决层，R01-R14 盘赔共振/背离/水位过程规则是底层最高优先级经验模块。基本面/战绩/名气只做修正层。\n`;
  prompt += `盘口总控纪律：只有云端 MARKET_COMMAND_JSON 存在时，才允许给出盘口剧本（强队穿盘/赢球不穿/下盘小球/大热陷阱/下盘大球/临场高波动/观望局）、反证审判（keep/downgrade/overturn）、最优玩法、回避玩法、仓位纪律和临场复核点；云端缺失时必须写“云端盘口总控缺失，不能采信本地存根”，并降低置信度。若要推翻云端盘口总控，只能用核心伤停、首发重大轮换、战意结构反转、临场盘口反向变动、数据采集错误五类重大反证。\n`;
  prompt += `R01-R14纪律：正向共振（R01-R03）可提高置信；背离/陷阱（R04-R08/R11）只对命中的玩法做局部降级；水位过程（R09-R14）必须结合时间窗口。若要推翻云端/盘口总控给出的盘赔共振，只能用五类重大反证。\n`;
  prompt += `陷阱门控纪律：高风险提示、avoid、downgrade、R-MR-04/R-MR-05/R-MR-06/R-MR-07/R-MR-11、大热陷阱/上盘诱买只允许限制对应玩法的高价值标签和仓位，不是反向下注信号；热门让球风险≠弱队价值，上盘诱买≠小球，downgrade≠反打，overturn默认观望/重算。每场必须读取 PRO_MARKET_JSON.trapDiscipline 并说明 affectedMarkets。\n`;
  prompt += `人工盘口仲裁纪律：每场最终推荐前必须拆成“胜平负方向/亚让穿盘/大小球/价值仓位”。规则命中数不是最终答案，强队胜出≠深让穿盘；让幅≥1.25时，若小球低水、低比分风险、量化与市场概率大幅冲突、riskScore≥65或数据缺失，亚让穿盘至少降一级。每场必须读取 PRO_MARKET_JSON.humanArbitration；若 handicapCoverStatus=downgraded/blocked，禁止把深让盘列入TOP主推。盘口输出必须校验数字与中文：半球=±0.5，球半=±1.5，禁止“-0.5（球半）”。\n`;
  prompt += `欧亚理论范围纪律：禁止用旧“主胜欧赔≈固定亚盘点位”单点映射直接下结论。每场必须读取 PRO_MARKET_JSON.euroAsianGap.lineRange/waterImbalance/inducementRisk/verificationChecklist；range_mismatch_deep/range_mismatch_shallow 只能先降级让球穿盘，不自动反打；water_distorted 只能待临场确认；asian_inducement_risk 必须阻断中高/高价值和TOP主推。\n`;
  prompt += `中高价值准入纪律：每场必须读取 PRO_MARKET_JSON.valueAdmission 的 level/valueTier/strongValueSignal/highValueEvidence/nearMissMediumHigh/softMissing/promotionHints；level=blocked 或 blockers 存在时只能低价值/待临场确认/不入TOP；strongValueSignal=true 时必须给对应玩法“强信号中高价值候选”并列证据，仓位仍受 humanArbitration.stakeCap 限制；allowMediumHigh=true 才允许写正式"中高价值"；allowMediumHighWatch=true/nearMissMediumHigh=true 时允许写"中高价值候选-待临场确认"并列待确认缺口，低/中低仓；allowHigh=true 才允许写"高价值"；trapDiscipline.hasTrap=true 时只降级 affectedMarkets，不得跨玩法外推；未校准量化edge只能作交叉证据，不能单独触发 strong/high value。\n`;
  prompt += `大小球纪律：全场/半场大小球只有在“进球预期/理论盘 + 实际盘口偏差 + 水位路径/升降盘 + 赛前90分钟内首发天气”至少两类同向证据共振时，才允许标高价值/中高价值；若缺少场均进失球、首发或临场水位，只能写低仓观察/待临场确认，禁止把大热陷阱/上盘诱买/普通低比分风险批量写成小球。大球和小球必须同等检查反证，不能为反向而反向。\n`;
  prompt += `进球现实层硬门禁：每场必须读取 PRO_MARKET_JSON.goalReality。若 blocksBlindUnder=true、status=over_reality_supported/under_blocked_by_goal_reality，或原始近期总进球常见3-4球、recentCombinedAvg≥3.0、bigBallAvg≥58%、expectedGoals≥2.85，禁止仅凭小球低水/防平/低比分风险推荐小球；没有退盘、小球连续降水、首发保守、天气恶劣、战意不足等两类反向强证据时，大小球只能写待临场/观望。\n`;
  prompt += `冷门双轨纪律：每场必须同时输出主方向与冷门/防冷路径；优先读取 PRO_MARKET_JSON.upsetRead 的 valueStatus/paths/evidence/triggers/invalidIf/forbiddenInferences。hedge_only/risk_only 只能写防冷保险或降仓，不能反向下注；upset_value_watch 也必须临场触发和独立edge/赔率保护/阵容战意确认后才可低仓尝试。\n`;
  if (portfolioCommand) {
    prompt += `组合总控纪律：必须先复核 PORTFOLIO_COMMAND_JSON 今日组合总控。若同一盘口剧本、同一R01-R14规则、同一联赛或高风险桶集中，TOP3必须分散，单剧本最多2场，高风险/overturn不得进TOP3，降仓项只能低仓或备选。\n`;
    prompt += `组合总控摘要：${portfolioCommand.plainSummary || '-'}｜集中度=${portfolioCommand.exposureScore ?? '-'}｜纪律=${portfolioCommand.verdict?.stakeDiscipline || '-'}\n`;
    if (portfolioCommand.conflicts?.length) prompt += `组合反证：${portfolioCommand.conflicts.slice(0, 5).map(c => `[${c.severity}]${c.label}`).join('；')}\n`;
    prompt += `PORTFOLIO_COMMAND_JSON：${JSON.stringify(portfolioCommand)}\n`;
  }
  prompt += `\n`;

  matchItems.forEach((item, i) => {
    const rawMc = item.marketCommand || item.localPrediction?.marketCommand || item.ruleDecision?.marketCommand || item.marketVerdict?.marketCommand || null;
    const mc = rawMc && rawMc.version === 'market-command-v4' && rawMc._source === 'cloud' ? rawMc : null;
    const invalidMarketCommandSource = rawMc && (!rawMc._source || rawMc._source !== 'cloud') ? (rawMc._source || 'unknown') : '';
    const mv = item.marketVerdict || item.marketCoreDecision || item.localPrediction?.marketVerdict || item.ruleDecision?.marketVerdict || null;
    const scenario = mc?.primaryScenario || {};
    const trial = mc?.counterEvidenceTrial || {};
    const exec = mc?.executionCommand || {};
    const intent = mv?.bookmakerIntent || {};
    const plan = mv?.executionPlan || {};
    const resonance = mv?.marketResonance || item.marketResonance || item.localPrediction?.marketResonance || item.ruleDecision?.marketResonance || mc?.currentMarketRead?.topRule || null;
    const resonanceTop = resonance?.topRule || mc?.currentMarketRead?.topRule || null;
    const pro = item.professionalMarket || item.localPrediction?.professionalMarket || item.marketCommand?.professionalMarket || null;
    prompt += `【${i + 1}】${item.match.league} - ${item.match.home} vs ${item.match.away} (${item.match.time})\n`;
    if (item.matchData) {
      const { winDrawWin, asian, overunder } = item.matchData;
      if (winDrawWin?.summary?.averageCurrent) {
        const s = winDrawWin.summary.averageCurrent;
        prompt += `  欧赔：主${s.win}/平${s.draw}/客${s.loss}`;
        if (winDrawWin.summary.impliedAverage) {
          const imp = winDrawWin.summary.impliedAverage;
          prompt += ` [概率 ${imp.win}/${imp.draw}/${imp.loss}]`;
        }
        prompt += '\n';
      }
      if (asian?.keyOdds?.ao) {
        const ao = asian.keyOdds.ao;
        prompt += `  亚盘：${ao.currentHandicap ?? ao.initialHandicap} 主水${ao.currentHomePay ?? ao.initialHomePay}/客水${ao.currentAwayPay ?? ao.initialAwayPay}\n`;
      }
      if (overunder?.keyOdds?.ao) {
        const ao = overunder.keyOdds.ao;
        prompt += `  大小球：${ao.currentLine ?? ao.initialLine} 大${ao.currentOver ?? ao.initialOver}/小${ao.currentUnder ?? ao.initialUnder}\n`;
      }
    }
    if (mc) {
      prompt += `  盘口总控v4：☁️ 云端有效｜${mc.plainSummary || exec.headline || '-'}\n`;
      prompt += `  盘口剧本：${scenario.label || '-'}｜${scenario.plain || '-'}｜比分模板=${scenario.scoreTemplates || '-'}\n`;
      prompt += `  反证审判：${trial.label || trial.verdict || '-'}｜${trial.plain || '-'}\n`;
      prompt += `  总控执行：最优=${exec.bestMarket || '-'}｜回避=${(exec.avoidMarkets || []).join('、') || '-'}｜仓位=${exec.stake || '-'}\n`;
      if (exec.liveChecklist?.length) prompt += `  临场复核：${exec.liveChecklist.slice(0, 4).join('；')}\n`;
      if (mc.reviewChecklist?.length) prompt += `  赛后复盘：${mc.reviewChecklist.slice(0, 3).join('；')}\n`;
      prompt += `  MARKET_COMMAND_JSON：${JSON.stringify(mc)}\n`;
    } else if (invalidMarketCommandSource) {
      prompt += `  盘口总控v4：云端盘口总控缺失；检测到${invalidMarketCommandSource}本地存根/兜底结果，已判定为无效，不得作为 MARKET_COMMAND_JSON 采信，必须降低置信度并说明云端计算未成功\n`;
    } else {
      prompt += `  盘口总控v4：未生成云端 MARKET_COMMAND_JSON，必须降低置信度并说明缺失原因\n`;
    }
    if (mv) {
      prompt += `  盘口裁决：${mv.headline || mv.summary?.headline || '-'}\n`;
      prompt += `  庄家意图：${intent.label || '-'}｜${intent.primaryIntent || '-'}\n`;
      prompt += `  欧赔核心：${mv.euroCore?.skeleton || '-'}｜${mv.euroCore?.movement || '-'}｜平赔=${mv.drawCore?.role || '-'}\n`;
      prompt += `  执行计划：最优=${plan.bestMarket || '-'}｜回避=${(plan.avoidMarkets || []).join('、') || '-'}｜仓位=${plan.stake || '-'}\n`;
      if (resonanceTop) prompt += `  R01-R14盘赔共振：${resonanceTop.ruleId}｜${resonanceTop.conclusion || resonanceTop.label || '-'}｜${resonanceTop.stars || '-'}星｜白话=${resonanceTop.plain || '-'}\n`;
      if (resonanceTop?.evidence?.length) prompt += `  共振证据：${resonanceTop.evidence.slice(0, 4).join('；')}\n`;
      if (mv.counterEvidence?.length) prompt += `  最大反证：${mv.counterEvidence.slice(0, 3).map(x => `[${x.severity}]${x.msg}`).join('；')}\n`;
      prompt += `  MARKET_VERDICT_JSON：${JSON.stringify(mv)}\n`;
    } else {
      prompt += `  盘口裁决：未生成，必须降低置信度并说明缺失原因\n`;
    }
    if (pro) {
      const admission = pro.valueAdmission || {};
      const trap = pro.trapDiscipline || {};
      const human = pro.humanArbitration || {};
      const goalReality = pro.goalReality || {};
      const crowd = pro.crowdSentimentRead || {};
      const gap = pro.euroAsianGap || {};
      prompt += `  PRO_MARKET_JSON：edge=${pro.score?.edgeScore ?? '-'}｜risk=${pro.score?.riskScore ?? '-'}｜CLV准备=${pro.score?.clvReadiness ?? '-'}｜准入=${admission.level || '-'}｜分层=${admission.valueTier || '-'}｜strongValue=${!!admission.strongValueSignal}｜allowMediumHigh=${!!admission.allowMediumHigh}｜allowMediumHighWatch=${!!admission.allowMediumHighWatch}｜nearMiss=${!!admission.nearMissMediumHigh}｜allowHigh=${!!admission.allowHigh}\n`;
      prompt += `  欧亚理论范围/水位：level=${gap.level || '-'}｜范围=${gap.lineRange?.plain || '-'}｜水位=${gap.waterImbalance?.plain || '-'}｜诱导=${gap.inducementRisk?.plain || '-'}｜复核=${gap.verificationChecklist?.slice(0, 3).join('；') || '-'}\n`;
      if (crowd.ok) {
        prompt += `  竞彩×亚盘情绪：alignment=${crowd.alignment || '-'}｜机构信号=${crowd.institutionSignal || '-'}｜偏离等级=${crowd.biasStrength || '-'}(maxΔ${crowd.maxEdge ?? '-'}%)｜偏向=${crowd.biasedLabel || '-'}(Δ${crowd.biasEdge ?? '-'}%)｜${crowd.plain}\n`;
      }
      prompt += `  进球现实层：status=${goalReality.status || '-'}｜近期总进球=${goalReality.recentCombinedAvg ?? '-'}｜大球率=${goalReality.bigBallAvg ?? '-'}｜模型总进球=${goalReality.expectedGoals ?? '-'}｜阻断盲目小球=${!!goalReality.blocksBlindUnder}｜证据=${goalReality.overEvidence?.slice(0, 2).join('；') || goalReality.underEvidence?.slice(0, 2).join('；') || '-'}\n`;
      prompt += `  人工盘口仲裁：胜负=${human.resultStatus || '-'}｜让球穿盘=${human.handicapCoverStatus || '-'}｜大小球=${human.totalGoalsStatus || '-'}｜进球现实=${human.goalRealityStatus || '-'}｜仓位封顶=${human.stakeCap || '-'}｜触发=${human.gates?.slice(0, 3).join('；') || '-'}｜输出校验=${human.outputGuards?.slice(0, 2).join('；') || '-'}\n`;
      prompt += `  陷阱纪律：hasTrap=${!!trap.hasTrap}｜影响玩法=${trap.affectedMarkets?.join('、') || '-'}｜局部降级=${trap.localDowngrades?.slice(0, 3).join('；') || '-'}｜禁止外推=${trap.forbiddenInferences?.slice(0, 3).join('；') || '-'}\n`;
      const upset = pro.upsetRead || {};
      prompt += `  中高价值准入证据：强信号=${admission.highValueEvidence?.slice(0, 4).join('；') || '-'}｜普通证据=${admission.evidence?.slice(0, 4).join('；') || '-'}｜软缺口=${admission.softMissing?.slice(0, 4).join('；') || '-'}｜升档提示=${admission.promotionHints?.slice(0, 4).join('；') || '-'}｜缺口/阻断=${[...(admission.missing || []), ...(admission.blockers || [])].slice(0, 4).join('；') || '-'}\n`;
      prompt += `  冷门双轨：valueStatus=${upset.valueStatus || '-'}｜标签=${upset.valueLabel || '-'}｜路径=${upset.paths?.slice(0, 4).join('、') || '-'}｜证据=${upset.evidence?.slice(0, 4).join('；') || '-'}｜触发=${upset.triggers?.slice(0, 3).join('；') || '-'}｜失效=${upset.invalidIf?.slice(0, 2).join('；') || '-'}｜禁止误推=${upset.forbiddenInferences?.slice(0, 2).join('；') || '-'}\n`;
      prompt += `  PRO_MARKET_JSON_FULL：${JSON.stringify(pro)}\n`;
    } else {
      prompt += `  PRO_MARKET_JSON：缺失；不得写高/中高价值，只能低价值/待临场确认\n`;
    }
    const portfolioItem = portfolioCommand?.allocationPlan?.items?.find(x => x.matchId === item.match.id) || null;
    if (portfolioItem) prompt += `  组合总控：动作=${portfolioItem.action}｜仓位上限=${portfolioItem.stakeCap}｜优先分=${portfolioItem.priorityScore}｜原因=${portfolioItem.reasons?.slice(0, 3).join('；') || '-'}\n`;
    // 竞彩大众情绪偏差段（若有）
    const jd = item.jingcaiDeviation || null;
    if (jd) {
      const sr = jd.supportRate || {};
      const fp = jd.fairProb || {};
      const edge = jd.edge || {};
      const ef = (v) => (v != null ? (v > 0 ? '+' : '') + v.toFixed(1) + '%' : '-');
      const sf = (v) => (v != null ? v.toFixed(1) + '%' : '-');
      const edgeMax = ['home','draw','away'].reduce((m, k) => Math.abs(edge[k]||0) > Math.abs(m[1]||0) ? [k, edge[k]] : m, ['none', 0]);
      const dirLabel = { home: '主队', draw: '平局', away: '客队' };
      const bias = edgeMax[1] > 8 ? `大众严重偏向${dirLabel[edgeMax[0]]}(Δ${ef(edgeMax[1])})，警惕诱买`
        : edgeMax[1] > 4 ? `大众偏向${dirLabel[edgeMax[0]]}(Δ${ef(edgeMax[1])})，可能存在情绪溢价`
        : `情绪与公允基本吻合(maxΔ${ef(edgeMax[1])})`;
      prompt += `  竞彩大众情绪：偏离=${jd.deviation}(maxΔ${jd.maxEdge ?? '-'}%)｜支持率=主${sf(sr.home)}/平${sf(sr.draw)}/客${sf(sr.away)}｜公允=主${sf(fp.home)}/平${sf(fp.draw)}/客${sf(fp.away)}｜偏差=主${ef(edge.home)}/平${ef(edge.draw)}/客${ef(edge.away)}｜${bias}｜纪律:情绪信号需结合亚盘水位判断诱买/真实方向，不可单独下注\n`;
    }
    prompt += `  价值评分：${item.profitability?.score ?? '-'} 初步判断：${item.profitability?.recommendation ?? '待分析'}\n\n`;
  });

  prompt += `输出格式（每场必须包含以下结构，不能简化跳步）：
[序号] 主队 vs 客队
▶ 主方向/推荐：[方向] [仓位]
▶ 冷门/防冷：[valueStatus + 平局/受让/不败/小比分/反热门胜等路径；必须区分防冷保险与冷门价值观察]
▶ 触发/失效：[冷门触发条件 + 失效条件；若只是风险或陷阱，写明不能反向下注]
▶ 置信度/风险：[A级/B级/C级/D级/E级] | [低/中低/中/中高/高]
▶ 欧赔三态：[实盘/中庸/韬光] | 分布：[顺/逆/缓冲/中庸] | 平赔角色：[真实平局/分散/过渡/缓冲/阻挡/非平平赔]
▶ 盘口剧本：[强队穿盘/赢球不穿/下盘小球/大热陷阱/下盘大球/临场高波动/观望局] | 反证审判：[keep/downgrade/overturn]
▶ R01-R14：[命中规则ID或"无明显共振"] | 盘口总控：[最优玩法] | 组合动作：[组合总控给出的动作]
▶ 陷阱纪律：[hasTrap/affectedMarkets；必须说明是否仅局部降级，禁止写成反向信号]
▶ 中高价值准入：[level/valueTier/strongValueSignal/allowMediumHigh/allowMediumHighWatch/nearMissMediumHigh/allowHigh + 强信号证据/软缺口/硬阻断]
▶ 理由：[50字内核心依据，必须体现三态判断或平赔角色；若推荐大小球，必须写进球现实层+至少两类同向证据+一个反证；历史高进球/blocksBlindUnder 时不得用陷阱或小球低水直接推小球]
▶ 跳过原因（若观望）：[中庸盘/信息不足/盘口矛盾/三盘不一致等]

最后输出：
重点推荐TOP3（按价值排序）：
每条：[序号] 主方向 | 防冷路径=[valueStatus/paths] | 三态=[实盘/中庸/韬光] | 平赔=[角色] | 盘口剧本=[类型] | 陷阱影响玩法=[affectedMarkets] | 仓位=[低/中/高] | 支持证据=[简述]
排除说明：valueAdmission.level=blocked/blockers存在、大小球证据不足、goalReality阻断盲目小球、高风险命中对应玩法、组合降仓项不得进入TOP3；CLV?缺失/CLV- 不得写高价值，但若 allowMediumHighWatch/nearMissMediumHigh=true 可进入“中高价值候选-待临场确认”备选并低仓封顶；若 strongValueSignal=true，不得机械排除，必须列入候选并按仓位封顶；R-MR陷阱门控只排除受影响玩法的重仓/高价值，不得自动转成下盘/小球推荐。`;
  return prompt;
}

/**
 * 解析AI返回的投注建议，提取每场推荐
 * 支持新格式（▶ 主方向/推荐：、▶ 推荐/观望：）和旧格式（[序号] 推荐 - 方向 - 理由）
 */
function parseAIBetAdvice(aiContent, matchItems) {
  const results = [];
  const lines = aiContent.split('\n');

  matchItems.forEach((item, i) => {
    const idx = i + 1;

    // 查找当前场次块的起始行（支持新格式标题和旧格式行）
    const startLineIdx = lines.findIndex(l => {
      const m = l.match(/^[\[【]?(\d+)[\]】]?\s*/);
      return m && parseInt(m[1]) === idx;
    });

    // 找当前场次块结束位置（下一个序号行）
    const nextStartIdx = lines.findIndex((l, li) => {
      if (li <= startLineIdx) return false;
      const m2 = l.match(/^[\[【]?(\d+)[\]】]?\s*/);
      return m2 && parseInt(m2[1]) > idx;
    });
    const blockEnd = nextStartIdx > 0 ? nextStartIdx : startLineIdx + 18;
    const blockSlice = startLineIdx >= 0 ? lines.slice(startLineIdx, blockEnd) : [];

    // 直接在该场次块中搜索 ▶ 主方向/推荐、推荐/观望 行
    const recLine = blockSlice.find(l => /▶\s*(主方向\s*\/\s*推荐|推荐|观望)/.test(l)) || '';
    const oldLine = startLineIdx >= 0 ? lines[startLineIdx] : '';

    let recommendation = '';
    let direction = '';
    let reason = '';
    let confidenceLevel = ''; // A级/B级/C级/D级/E级
    let riskLevel = '';       // 低/中低/中/中高/高
    let oddsMode = '';        // 实盘/中庸/韬光
    let drawRole = '';        // 平赔角色
    let scenario = '';        // 盘口剧本

    if (recLine) {
      // 新格式：▶ 主方向/推荐：[方向] [仓位]，兼容 ▶ 推荐/观望：[方向]
      const recMatch = recLine.match(/▶\s*(主方向\s*\/\s*推荐|推荐|观望)[：:]\s*(.+)/);
      if (recMatch) {
        const label = recMatch[1];
        direction = recMatch[2].trim();
        recommendation = /观望/.test(label) || /^观望/.test(direction) ? '观望' : '推荐';
      }
      // 提取置信度/风险
      const confidenceLine = blockSlice.find(l => /▶\s*置信度\/风险/.test(l)) || '';
      if (confidenceLine) {
        const confidenceMatch = confidenceLine.match(/置信度\/风险[：:]\s*([^|｜]+)[|｜]\s*(.+)/);
        if (confidenceMatch) {
          confidenceLevel = confidenceMatch[1].replace(/[\[\]]/g, '').trim();
          riskLevel = confidenceMatch[2].replace(/[\[\]]/g, '').trim();
        }
      }
      // 提取三态
      const modeLine = blockSlice.find(l => /▶\s*欧赔三态/.test(l)) || '';
      if (modeLine) {
        const modeMatch = modeLine.match(/(实盘|中庸|韬光)/);
        if (modeMatch) oddsMode = modeMatch[1];
        const drawMatch = modeLine.match(/平赔角色[：:]\s*([^\|]+)/);
        if (drawMatch) drawRole = drawMatch[1].trim();
      }
      // 提取盘口剧本
      const scenLine = blockSlice.find(l => /▶\s*盘口剧本/.test(l)) || '';
      if (scenLine) {
        const scenMatch = scenLine.match(/盘口剧本[：:]\s*([^\|]+)/);
        if (scenMatch) scenario = scenMatch[1].trim();
      }
      // 提取理由
      const reasonLine = blockSlice.find(l => /▶\s*理由/.test(l)) || '';
      if (reasonLine) {
        const reasonMatch = reasonLine.match(/▶\s*理由[：:]\s*(.+)/);
        if (reasonMatch) reason = reasonMatch[1].trim().slice(0, 100);
      }
    } else {
      // 旧格式兼容
      const recMatch = oldLine.match(/(推荐|强烈推荐|建议|观望|不推荐)/);
      if (recMatch) recommendation = recMatch[1];
      const dirMatch = oldLine.match(/(主胜|平局|客胜|大球|小球|主让|客让|亚主|亚客)/);
      if (dirMatch) direction = dirMatch[1];
      const dashParts = oldLine.split('-');
      if (dashParts.length >= 3) reason = dashParts.slice(2).join('-').trim().slice(0, 100);
    }

    results.push({
      matchId: item.match.id,
      recommendation: recommendation || (recLine.includes('推荐') || oldLine.includes('推荐') ? '推荐' : '观望'),
      direction,
      reason,
      confidenceLevel,
      riskLevel,
      oddsMode,
      drawRole,
      scenario,
      rawLine: (recLine || oldLine).trim()
    });
  });

  return results;
}

export {
  getLeaguePriority,
  getLeagueTierLabel,
  calcProfitabilityScore,
  parseTodayMatchesFromHtml,
  buildAIPromptForDailyMatch,
  buildBatchAIPrompt,
  parseAIBetAdvice
};
