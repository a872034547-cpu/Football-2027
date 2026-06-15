/**
 * Predictor - 内置预测算法（支持赛前 + 滚球实时预测）
 */
import { normalizeMatch } from './match-normalizer.js';
import { analyzeKnowledge } from './knowledge-engine.js';
import { buildMarketCommand } from './market-orchestrator.js';

function summarizeProfileSide(side = {}) {
  const profile = side?.profile || null;
  const name = profile?.country || profile?.name || profile?.club || side?.name || '';
  const tier = profile?.powerTier || profile?.baseTier || profile?.tier || '';
  const rank = profile?.fifaRank || profile?.rank || '';
  const value = profile?.marketValue || profile?.squadValue || '';
  const style = Array.isArray(profile?.styleTags) ? profile.styleTags : (Array.isArray(profile?.tacticalStyle) ? profile.tacticalStyle : []);
  const corePlayers = Array.isArray(profile?.corePlayers) ? profile.corePlayers : [];
  return {
    name,
    matched: !!side?.matched,
    score: side?.score || 0,
    type: side?.type || profile?.type || '',
    verificationStatus: profile?.verificationStatus || '',
    tier,
    rank,
    marketValue: value,
    styleTags: style.slice(0, 4),
    corePlayers: corePlayers.slice(0, 5)
  };
}

function buildTeamProfileSummary(context = null) {
  if (!context || typeof context !== 'object') {
    return { loaded: false, matched: false, note: '未加载球队画像库' };
  }
  const home = summarizeProfileSide(context.home);
  const away = summarizeProfileSide(context.away);
  const homeTier = Number(home.tier || 0);
  const awayTier = Number(away.tier || 0);
  const tierGap = homeTier && awayTier ? awayTier - homeTier : 0;
  return {
    loaded: !!context.loaded,
    matched: !!context.matched,
    sourceUrl: context.sourceUrl || '',
    pageUrl: context.pageUrl || '',
    updatedAt: context.meta?.updatedAt || context.updatedAt || '',
    stale: !!context.stale,
    coverage: context.coverage || context.meta?.coverage || {},
    leagueHint: context.leagueHint || '',
    home,
    away,
    tierGap,
    discipline: '球队画像只作基本面/风格/热度的20%辅助修正，不得覆盖 MARKET_COMMAND_JSON 盘口总控。'
  };
}

export class Predictor {

  predict(stored, extras = {}) {
    const { data, fetchTime } = stored;
    const liveData = data?.live || null;
    const isLive = liveData && liveData.minute > 0;

    const teamProfiles = extras.teamProfiles || data?.teamProfiles || stored.teamProfiles || null;
    const teamProfileMarkdown = extras.teamProfileMarkdown || data?.teamProfileMarkdown || stored.teamProfileMarkdown || '';
    const professionalMarket = extras.professionalMarket || data?.professionalMarket || stored.professionalMarket || null;
    const teamProfileSummary = buildTeamProfileSummary(teamProfiles);

    const result = {
      matchId: stored.matchId,
      generatedAt: new Date().toISOString(),
      fetchTime,
      isLive,
      confidence: 0,
      recommendations: [],
      liveRecommendations: [],
      analysis: {},
      alerts: [], // 重要提示
      teamProfiles,
      teamProfileMarkdown,
      teamProfileMatched: !!teamProfileSummary.matched,
      teamProfileSummary,
      professionalMarket
    };

    if (!data) { result.error = '无数据'; return result; }

    const { analysis, asian, overunder, corner } = data;

    // 知识库字段归一 + 规则引擎（增强层，不破坏原有启发式模型）
    let normalized = null;
    let knowledge = null;
    try {
      normalized = normalizeMatch(stored);
      // 优先使用注入的云端 knowledge（云端规则引擎），否则降级本地存根
      if (extras.cloudKnowledge && extras.cloudKnowledge.ok) {
        knowledge = extras.cloudKnowledge;
      } else {
        knowledge = analyzeKnowledge(normalized);
      }
    } catch (e) {
      knowledge = {
        ok: false,
        error: e.message,
        hits: [],
        candidates: [],
        conflicts: [],
        blockedBy: [{ code: 'knowledge_engine_error', level: 'high', msg: `知识规则引擎异常：${e.message}` }],
        summary: { mainDirection: 'watch', recommendationLevel: '观望', riskLevel: 'high', confidence: 35 }
      };
    }

    // 盘口分析
    const asianAnalysis = this._analyzeAsian(asian);
    const ouAnalysis = this._analyzeOverUnder(overunder);
    const cornerAnalysis = this._analyzeCorner(corner);
    const statsAnalysis = this._analyzeStats(analysis);

    result.normalized = normalized;
    result.knowledge = knowledge;
    result.analysis = { asian: asianAnalysis, overunder: ouAnalysis, corner: cornerAnalysis, stats: statsAnalysis, knowledge, teamProfiles: teamProfileSummary, professionalMarket };
    result.marketTimeline = stored.marketTimeline || data.marketTimeline || null;

    const predictionGate = normalized?.derived?.predictionGate;
    if (predictionGate?.canPredict === false) {
      const hardBlocks = predictionGate.hardBlocks || [];
      result.confidence = 0;
      result.error = `数据可信度阻断：${hardBlocks.join('；') || '关键字段疑似错误'}；本场只允许观察/重新采集，禁止输出预测方向`;
      result.summary = result.error;
      result.recommendations = [{
        market: '数据质量门禁',
        line: '-',
        suggestion: '禁止输出预测方向，先重新采集并核对网页盘口',
        trend: 'observe_only',
        weightShare: 0,
        evidence: hardBlocks,
        risk: ['输入数据疑似错误会放大后续规则/AI误判']
      }];
      result.alerts = [{ level: 'high', msg: result.error, playSound: false }];
      return result;
    }

    // 综合评分 + v3.4/v3.5 规则裁决合同
    const composite = this._compositeScore(asianAnalysis, ouAnalysis, statsAnalysis, analysis, knowledge);
    const injectedMarketCommand = extras.cloudMarketCommand
      && extras.cloudMarketCommand.version === 'market-command-v4'
      && extras.cloudMarketCommand._source === 'cloud'
      ? extras.cloudMarketCommand
      : null;
    const marketCommand = injectedMarketCommand || buildMarketCommand({
      normalized,
      knowledge,
      quant: null,
      riskProfile: null,
      marketTimeline: result.marketTimeline,
      prediction: {
        ...result,
        confidence: composite.confidence,
        marketCoreDecision: composite.marketCoreDecision,
        marketVerdict: composite.marketVerdict
      }
    });
    const ruleDecision = this._buildRuleDecision(knowledge, normalized, composite);
    ruleDecision.marketCommand = marketCommand;
    const candidatePredictions = this._buildCandidatePredictions(knowledge, composite, ruleDecision);
    result.confidence = composite.confidence;
    result.recommendations = composite.recommendations;
    if (marketCommand?.executionCommand?.headline) {
      result.recommendations.unshift({
        market: '盘口总控v4',
        line: marketCommand.primaryScenario?.label || '-',
        suggestion: marketCommand.executionCommand.headline,
        trend: marketCommand.primaryScenario?.code || 'watch_only',
        weightShare: 80,
        evidence: [marketCommand.plainSummary, ...(marketCommand.currentMarketRead?.topRule?.evidence || []).slice(0, 3)].filter(Boolean),
        risk: marketCommand.counterEvidenceTrial?.reasons || []
      });
    }
    result.summary = marketCommand?.plainSummary ? `【盘口总控v4】${marketCommand.plainSummary}` : composite.summary;
    result.alerts = composite.alerts;
    result.weightPolicy = composite.weightPolicy;
    result.marketCoreDecision = composite.marketCoreDecision;
    result.marketVerdict = composite.marketVerdict;
    result.marketResonance = knowledge?.resonance || null;
    result.marketCommand = marketCommand;
    result.professionalMarket = professionalMarket;
    result.professionalMarketScore = professionalMarket?.score || null;
    result.professionalMarketRiskFlags = professionalMarket?.riskFlags || [];
    if (knowledge?.summary && composite.marketVerdict) {
      knowledge.summary.marketVerdict = composite.marketVerdict;
      knowledge.summary.marketCoreDecision = composite.marketVerdict;
      knowledge.summary.marketResonance = knowledge?.resonance || null;
      knowledge.summary.marketCommand = marketCommand;
      knowledge.summary.bookmakerIntent = composite.marketVerdict.bookmakerIntent || null;
      knowledge.summary.executionPlan = composite.marketVerdict.executionPlan || null;
      knowledge.summary.counterEvidence = composite.marketVerdict.counterEvidence || [];
    }
    result.ruleDecision = ruleDecision;
    result.candidatePredictions = candidatePredictions;
    result.triggeredRuleIds = ruleDecision.triggeredRuleIds;
    result.missingFields = ruleDecision.missingFields;
    result.unanalysableFlags = ruleDecision.unanalysableFlags;
    result.whyNotTop2 = ruleDecision.whyNotTop2;
    result.confidenceBreakdown = ruleDecision.confidenceBreakdown;

    // 滚球预测
    if (isLive) {
      result.liveRecommendations = this._livePredict(liveData, asianAnalysis, ouAnalysis, data);
    }

    return result;
  }

  _analyzeAsian(asian) {
    if (!asian || asian.error) return { valid: false, reason: '数据缺失', signals: [] };

    const res = { valid: true, signals: [] };
    const { summary, companies } = asian;

    // 升降盘分析
    const up = parseInt(summary?.up || 0);
    const down = parseInt(summary?.down || 0);
    if (up > down * 2 && up >= 3) {
      res.signals.push({ signal: 'bullish_home', desc: `升盘${up}家>降盘${down}家，主队被看好`, weight: 2 });
    } else if (down > up * 2 && down >= 3) {
      res.signals.push({ signal: 'bullish_away', desc: `降盘${down}家>升盘${up}家，客队被看好`, weight: 2 });
    }

    // 高低水分析
    const high = parseInt(summary?.highWater || 0);
    const low = parseInt(summary?.lowWater || 0);
    if (high > 8) {
      res.signals.push({ signal: 'high_water', desc: `高水${high}家，资金流向客队`, weight: 1 });
    }

    // 主流盘口
    res.mainLine = summary?.mainLine || '';

    // 澳门/第一家公司盘口分析
    const aoCompany = companies?.[0];
    if (aoCompany?.mainLine) {
      const ml = aoCompany.mainLine;
      const initHome = parseFloat(ml.initialHome || 0);
      const currHome = parseFloat(ml.currentHome || 0);
      const initAway = parseFloat(ml.initialAway || 0);
      const currAway = parseFloat(ml.currentAway || 0);

      res.aoInitial = { line: ml.initialHandicap, home: initHome, away: initAway };
      res.aoCurrent = { line: ml.currentHandicap, home: currHome, away: currAway };

      // 水位变化
      if (initHome - currHome > 0.05) {
        res.signals.push({ signal: 'ao_home_water_down', desc: `澳门主队水位降(${initHome}→${currHome})，主队受欢迎`, weight: 2 });
      } else if (currHome - initHome > 0.05) {
        res.signals.push({ signal: 'ao_home_water_up', desc: `澳门主队水位升(${initHome}→${currHome})，主队不受欢迎`, weight: -1 });
      }

      if (initAway - currAway > 0.05) {
        res.signals.push({ signal: 'ao_away_water_down', desc: `澳门客队水位降(${initAway}→${currAway})，客队受欢迎`, weight: 2 });
      }

      // 盘口变动
      if (ml.initialHandicap !== ml.currentHandicap) {
        res.signals.push({ signal: 'handicap_changed', desc: `澳门盘口变动: ${ml.initialHandicap}→${ml.currentHandicap}`, weight: 1 });
      }

      res.handicapLine = ml.currentHandicap;
      res.homeGiving = this._handicapValue(ml.currentHandicap) <= 0;
    }

    // 多家公司一致性分析
    if (Array.isArray(companies) && companies.length >= 5) {
      const lines = companies.map(c => c.mainLine?.currentHandicap).filter(Boolean);
      const lineCount = {};
      lines.forEach(l => { lineCount[l] = (lineCount[l] || 0) + 1; });
      const mainLineEntry = Object.entries(lineCount).sort((a, b) => b[1] - a[1])[0];
      if (mainLineEntry && mainLineEntry[1] >= companies.length * 0.6) {
        res.signals.push({ signal: 'consensus', desc: `${companies.length}家公司中${mainLineEntry[1]}家给${mainLineEntry[0]}，盘口高度一致`, weight: 1 });
      }
    }

    return res;
  }

  _analyzeOverUnder(overunder) {
    if (!overunder || overunder.error) return { valid: false, signals: [] };
    const res = { valid: true, signals: [] };
    const { summary, companies } = overunder;

    res.mainLine = summary?.mainLine || '';

    const aoCompany = companies?.[0];
    if (aoCompany?.mainLine) {
      const ml = aoCompany.mainLine;
      const initLine = parseFloat(ml.initialLine || 0);
      const currLine = parseFloat(ml.currentLine || 0);
      const initOver = parseFloat(ml.initialOver || 0);
      const currOver = parseFloat(ml.currentOver || 0);

      res.initialLine = ml.initialLine;
      res.currentLine = ml.currentLine;

      if (currLine > initLine) {
        res.signals.push({ signal: 'line_up', desc: `大球线上移(${initLine}→${currLine})，预期进球增多`, weight: 1 });
        res.trend = 'over';
      } else if (currLine < initLine) {
        res.signals.push({ signal: 'line_down', desc: `大球线下移(${initLine}→${currLine})，预计低分`, weight: 1 });
        res.trend = 'under';
      }

      if (initOver - currOver > 0.05) {
        res.signals.push({ signal: 'over_water_down', desc: `大球水位降(${initOver}→${currOver})，资金流向大球`, weight: 1 });
        res.moneyFlow = 'over';
      } else if (currOver - initOver > 0.05) {
        res.signals.push({ signal: 'over_water_up', desc: `大球水位升(${initOver}→${currOver})，资金流向小球`, weight: 1 });
        res.moneyFlow = 'under';
      }
    }

    // 降盘统计
    const down = parseInt(summary?.down || 0);
    if (down >= 10) {
      res.signals.push({ signal: 'many_down', desc: `${down}家降盘，主流线从高线降至${res.mainLine}，预期小球`, weight: 1 });
      res.trend = res.trend || 'under';
    }

    return res;
  }

  _analyzeCorner(corner) {
    if (!corner || corner.error) return { valid: false };
    const companies = corner.companies || [];
    const mainLine = corner.mainLine || companies[0]?.currentLine || companies[0]?.mainLine?.currentLine;
    const ml = companies[0]?.mainLine || {};
    const overWater = parseFloat(ml.currentOver || ml.currentOverPay || 0);
    const underWater = parseFloat(ml.currentUnder || ml.currentUnderPay || 0);
    const line = parseFloat(mainLine);

    let recommendation = '角球待观察';
    let direction = 'neutral';
    let confidence = 45;
    let signals = [];

    if (!isNaN(line)) {
      // 线值判断
      if (line >= 11) { direction = 'over'; signals.push(`角球线${line}偏高`); }
      else if (line <= 9) { direction = 'under'; signals.push(`角球线${line}偏低`); }
      else { signals.push(`角球线${line}中性`); }

      // 水位判断（<0.85低水=真实防护；>0.98高水=诱买）
      if (overWater > 0 && underWater > 0) {
        if (overWater <= 0.85) { direction = 'over'; signals.push(`大角球低水${overWater}=真实大球`); confidence += 8; }
        else if (overWater >= 0.98) { signals.push(`大角球高水${overWater}=可能诱买`); confidence -= 5; }
        if (underWater <= 0.85) { direction = 'under'; signals.push(`小角球低水${underWater}=真实小球`); confidence += 8; }
      }

      // 多家公司一致性
      const overLines = companies.map(c => parseFloat(c.mainLine?.currentLine || c.currentLine || 0)).filter(v => v > 0);
      if (overLines.length >= 2) {
        const maxLine = Math.max(...overLines), minLine = Math.min(...overLines);
        if (maxLine - minLine <= 0.5) signals.push(`${overLines.length}家公司角球线一致(${minLine}-${maxLine})`);
        else signals.push(`公司角球线分歧(${minLine}-${maxLine})，置信降低`);
      }

      if (direction === 'over') recommendation = `大角球 ${line}`;
      else if (direction === 'under') recommendation = `小角球 ${line}`;
      else recommendation = `角球线${line}，待临场确认`;
    }

    return {
      valid: true,
      mainLine,
      line: isNaN(line) ? null : line,
      direction,
      recommendation,
      confidence: Math.min(85, Math.max(30, confidence)),
      signals,
      overWater: overWater || null,
      underWater: underWater || null,
      companies: companies.slice(0, 4)
    };
  }

  _analyzeStats(analysis) {
    if (!analysis || analysis.error) return { valid: false };
    const res = { valid: true };
    const home = analysis.homeStats;
    const away = analysis.awayStats;

    if (home?.total) {
      res.homeWinRate = home.total.winRate;
      res.homePoints = home.total.points;
      res.homeRank = home.total.rank;
      res.homePlayed = home.total.played;
      res.homeGoalsFor = home.total.goalsFor;
      res.homeGoalsAgainst = home.total.goalsAgainst;
    }
    if (away?.total) {
      res.awayWinRate = away.total.winRate;
      res.awayPoints = away.total.points;
      res.awayRank = away.total.rank;
      res.awayPlayed = away.total.played;
      res.awayGoalsFor = away.total.goalsFor;
      res.awayGoalsAgainst = away.total.goalsAgainst;
    }
    if (home?.last6 && away?.last6) {
      res.homeForm = `${home.last6.win}胜${home.last6.draw}平${home.last6.loss}负`;
      res.awayForm = `${away.last6.win}胜${away.last6.draw}平${away.last6.loss}负`;
    }

    // 伤停情况
    const homeInjuries = analysis.injuries?.home?.length || 0;
    const awayInjuries = analysis.injuries?.away?.length || 0;
    res.homeInjuries = homeInjuries;
    res.awayInjuries = awayInjuries;

    // 赛前简报
    res.preBriefing = analysis.preBriefing || '';

    return res;
  }

  _compositeScore(asian, ou, stats, analysis, knowledge = null) {
    const recommendations = [];
    let confidence = 50;
    const factors = [];
    const alerts = [];

    // === 亚让盘 ===
    if (asian.valid) {
      asian.signals.forEach(s => {
        if (s.weight > 0) factors.push({ direction: 'home', weight: s.weight, reason: s.desc });
        else if (s.weight < 0) factors.push({ direction: 'away', weight: Math.abs(s.weight), reason: s.desc });
      });

      if (asian.aoCurrent) {
        const { home, away, line } = asian.aoCurrent;
        recommendations.push({
          market: '亚让盘',
          line: line,
          suggestion: `当前盘口 ${line}`,
          homePay: home,
          awayPay: away,
          edge: this._calcEdge(home, away)
        });
      }
    }

    // === 大小球 ===
    if (ou.valid) {
      const trend = ou.moneyFlow || ou.trend || 'neutral';
      recommendations.push({
        market: '大小球',
        line: ou.currentLine || ou.mainLine,
        suggestion: trend === 'over' ? `推荐大球(>${ou.currentLine})` :
                    trend === 'under' ? `推荐小球(<${ou.currentLine})` :
                    `盘口${ou.currentLine}，暂无明显倾向`,
        trend
      });
    }

    // === 角球 ===
    if (analysis?.corner?.mainLine) {
      recommendations.push({
        market: '角球',
        line: analysis.corner.mainLine,
        suggestion: `角球线 ${analysis.corner.mainLine}，${parseFloat(analysis.corner.mainLine) > 10 ? '倾向大角球' : '倾向小角球'}`
      });
    }

    // 主客综合倾向
    const homeScore = factors.filter(f => f.direction === 'home').reduce((s, f) => s + f.weight, 0);
    const awayScore = factors.filter(f => f.direction === 'away').reduce((s, f) => s + f.weight, 0);

    let mainSuggestion = '暂无明确信号，建议观望';
    if (homeScore > awayScore + 1) {
      mainSuggestion = '盘口信号倾向【主队】';
      confidence = Math.min(75, 55 + (homeScore - awayScore) * 5);
    } else if (awayScore > homeScore + 1) {
      mainSuggestion = '盘口信号倾向【客队】';
      confidence = Math.min(75, 55 + (awayScore - homeScore) * 5);
    }

    // 战绩加成
    if (stats.valid) {
      const homeWR = parseFloat(stats.homeWinRate) || 50;
      const awayWR = parseFloat(stats.awayWinRate) || 50;
      if (homeWR > awayWR + 15) confidence = Math.min(confidence + 3, 80);
      if (awayWR > homeWR + 15) confidence = Math.min(confidence + 3, 80);
    }

    const heuristicConfidence = confidence;
    const weightPolicy = {
      marketCore: 80,
      auxiliary: 20,
      label: '知识库规则 + 欧赔核心/庄家盘口 = 80%；战绩、伤停、量化与其它信息 = 20%修正',
      principle: '庄家盘口是最高优先级预测参考，先读懂欧赔/亚盘/大小球三盘，再用其它信息修正。'
    };
    const marketCoreDecision = this._buildMarketCoreDecision(knowledge, asian, ou);
    const marketVerdict = marketCoreDecision;

    // 知识库规则引擎增强：知识库 + 欧赔核心/庄家盘口占 80%，传统启发式/战绩/伤停只做 20% 修正。
    if (knowledge?.summary) {
      const ks = knowledge.summary;
      const kConfidence = Number(ks.confidence || 0);
      if (kConfidence > 0) {
        confidence = Math.round((heuristicConfidence * 0.20) + (kConfidence * 0.80));
      }
      if (ks.shouldAvoid) confidence = Math.min(confidence, 58);
      else if (ks.riskLevel === 'high') confidence = Math.min(confidence, 65);

      if (marketCoreDecision?.headline) {
        mainSuggestion = `【80%权重·庄家盘口优先】${marketCoreDecision.headline}；辅助修正：${mainSuggestion}`;
      } else if (ks.mainDirection && ks.mainDirection !== 'watch') {
        mainSuggestion = `【80%权重·知识库+欧赔核心】${this._formatKnowledgeDirection(ks.mainDirection)}（${ks.recommendationLevel}）；辅助修正：${mainSuggestion}`;
      } else if (ks.recommendationLevel) {
        mainSuggestion = `${mainSuggestion}；知识规则建议：${ks.recommendationLevel}`;
      }

      if (marketCoreDecision?.headline) {
        recommendations.unshift({
          market: '欧赔核心/庄家读盘',
          line: marketCoreDecision.line || '-',
          suggestion: marketCoreDecision.headline,
          trend: ks.mainDirection,
          weightShare: 80,
          evidence: marketCoreDecision.evidence || [],
          risk: marketCoreDecision.risk || []
        });
      }

      if (Array.isArray(knowledge.candidates) && knowledge.candidates.length) {
        knowledge.candidates.slice(0, 3).forEach(c => {
          recommendations.push({
            market: c.market || '知识规则',
            line: c.label || c.direction || '-',
            suggestion: `知识库候选：${c.label || this._formatKnowledgeDirection(c.direction)}（score=${c.score || 0}）`,
            trend: c.direction,
            ruleIds: c.ruleIds || [],
            evidence: c.evidence || [],
            risk: c.risk || []
          });
        });
      }
    }

    // 伤停警报
    if (stats.homeInjuries >= 3) {
      alerts.push({ level: 'warn', msg: `主队${stats.homeInjuries}人缺阵，影响战力` });
    }
    if (stats.awayInjuries >= 3) {
      alerts.push({ level: 'warn', msg: `客队${stats.awayInjuries}人缺阵，影响战力` });
    }

    // 知识规则风险提示
    if (Array.isArray(knowledge?.blockedBy)) {
      knowledge.blockedBy.slice(0, 4).forEach(r => {
        alerts.push({ level: r.level === 'high' ? 'warn' : 'info', msg: `知识规则风险：${r.msg || r.code}` });
      });
    }
    if (Array.isArray(knowledge?.conflicts) && knowledge.conflicts.length) {
      alerts.push({ level: 'warn', msg: `知识规则冲突：${knowledge.conflicts[0].msg}`, playSound: false });
    }

    // 高信心提醒
    if (confidence >= 70 && knowledge?.summary?.riskLevel !== 'high') {
      alerts.push({ level: 'high', msg: `⚡ 高信心推荐(${confidence}%)：${mainSuggestion}`, playSound: true });
    }

    return {
      confidence: Math.round(confidence),
      summary: mainSuggestion,
      recommendations,
      factors,
      alerts,
      weightPolicy,
      marketCoreDecision,
      marketVerdict,
      confidenceBreakdown: {
        ...(knowledge?.summary?.confidenceBreakdown || {
          base: 50,
          knowledgeDelta: Math.round(confidence - 50),
          riskPenalty: knowledge?.summary?.riskLevel === 'high' ? 8 : 0,
          completenessPenalty: 0,
          final: Math.round(confidence)
        }),
        weightPolicy,
        heuristic20: Math.round(heuristicConfidence),
        marketCore80: Math.round(Number(knowledge?.summary?.confidence || confidence)),
        final: Math.round(confidence)
      }
    };
  }

  _buildMarketCoreDecision(knowledge, asianAnalysis, ouAnalysis) {
    const summary = knowledge?.summary || {};
    const normalized = knowledge?.normalized || {};
    const candidates = Array.isArray(knowledge?.candidates) ? knowledge.candidates : [];
    const hits = Array.isArray(knowledge?.hits) ? knowledge.hits : [];
    const conflicts = Array.isArray(knowledge?.conflicts) ? knowledge.conflicts : [];
    const blockedBy = Array.isArray(knowledge?.blockedBy) ? knowledge.blockedBy : [];
    const topCore = candidates.find(c => ['盘赔共振', '亚盘+大小球', '胜负+大小球', '下盘+大小球', '下盘+小球', '亚盘', '胜平负', '亚让盘'].includes(c.market)) || candidates[0] || null;
    const resonance = knowledge?.resonance || null;
    const resonanceTop = resonance?.topRule || null;
    const line = asianAnalysis?.mainLine || asianAnalysis?.handicapLine || asianAnalysis?.aoCurrent?.line || '-';
    const ouLine = ouAnalysis?.currentLine || ouAnalysis?.mainLine || '-';
    const avg = normalized?.odds?.averageCurrent || null;
    const init = normalized?.odds?.averageInitial || null;
    const probs = this._noVigProbabilities(avg);
    const w = this._num(avg?.win), d = this._num(avg?.draw), l = this._num(avg?.loss);
    const iw = this._num(init?.win), id = this._num(init?.draw), il = this._num(init?.loss);
    const favoriteSide = Number.isFinite(w) && Number.isFinite(l)
      ? (w < l - 0.12 ? 'home' : l < w - 0.12 ? 'away' : 'balanced')
      : 'balanced';
    const favoriteOdds = Number.isFinite(w) && Number.isFinite(l) ? Math.min(w, l) : null;
    const skeleton = this._classifyOddsSkeleton(w, d, l);
    const oddsZone = this._classifyOddsZone(favoriteOdds);
    const drawHit = hits.find(h => ['R-ODDS-023', 'R-ODDS-020'].includes(h.ruleId));
    const movementHit = hits.find(h => h.ruleId === 'R-ODDS-053');
    const hasRule = (id) => hits.some(h => h.ruleId === id);
    const hasDirection = (dir) => hits.some(h => h.direction === dir) || candidates.some(c => c.direction === dir);
    const avgText = avg ? `即时均赔 ${avg.win}/${avg.draw}/${avg.loss}` : '';
    const initText = init ? `初赔 ${init.win}/${init.draw}/${init.loss}` : '';

    const scores = this._buildMarketScores({
      avg, init, probs, favoriteSide, favoriteOdds, skeleton,
      asianAnalysis, ouAnalysis, hits, conflicts, blockedBy, normalized
    });
    const bookmakerIntent = this._inferBookmakerIntent({
      summary, hits, conflicts, blockedBy, favoriteSide, scores, drawHit, topCore
    });
    const counterEvidence = this._buildCounterEvidence({
      hits, conflicts, blockedBy, scores, asianAnalysis, ouAnalysis, drawHit, bookmakerIntent
    });
    const executionPlan = this._buildExecutionPlan({
      summary, topCore, bookmakerIntent, counterEvidence, scores, line, ouLine
    });

    const headline = executionPlan.headline || (topCore
      ? `${topCore.market || '盘口'}：${topCore.label || this._formatKnowledgeDirection(topCore.direction)}（score=${Math.round(Number(topCore.score || 0))}）`
      : (summary.mainDirection && summary.mainDirection !== 'watch'
        ? `规则主方向：${this._formatKnowledgeDirection(summary.mainDirection)}（${summary.recommendationLevel || '待复核'}）`
        : '欧赔/亚盘尚未形成强一致，按观望或低仓处理'));
    const oddsHits = hits.filter(h => ['odds', 'draw'].includes(h.module)).slice(0, 4);
    const evidence = [
      avgText,
      initText,
      skeleton ? `欧赔骨架=${skeleton}` : '',
      oddsZone ? `赔率区间=${oddsZone}` : '',
      probs ? `去水概率=${probs.win}%/${probs.draw}%/${probs.loss}%` : '',
      line !== '-' ? `亚盘主流=${line}` : '',
      ouLine !== '-' ? `大小球主流=${ouLine}` : '',
      bookmakerIntent?.label ? `庄家意图=${bookmakerIntent.label}` : '',
      resonanceTop ? `盘赔共振=${resonanceTop.ruleId} ${resonanceTop.conclusion}` : '',
      resonanceTop?.plain ? `白话读盘=${resonanceTop.plain}` : '',
      ...(resonanceTop?.evidence || []).slice(0, 3),
      ...(topCore?.evidence || []).slice(0, 3),
      ...oddsHits.flatMap(h => h.evidence || []).slice(0, 3)
    ].filter(Boolean);
    const risk = [
      ...(topCore?.risk || []),
      ...counterEvidence.map(x => x.msg),
      ...(conflicts || []).slice(0, 2).map(c => c.msg || c.ruleId),
      ...(blockedBy || []).slice(0, 2).map(b => b.msg || b.code)
    ].filter(Boolean);

    return {
      version: 'market-verdict-v1',
      weightShare: 80,
      auxiliaryShare: 20,
      headline,
      line,
      overunderLine: ouLine,
      weightPolicy: {
        marketCore: 80,
        auxiliary: 20,
        principle: '盘口核心优先，基本面、伤停、量化与AI情报只做20%修正。'
      },
      summary: {
        headline,
        mainDirection: summary.mainDirection || 'watch',
        protection: executionPlan.protection || '',
        confidence: Number(summary.confidence || 0),
        stake: executionPlan.stake,
        shouldSkip: executionPlan.shouldSkip,
        skipReason: executionPlan.skipReason || ''
      },
      euroCore: {
        initialOdds: init ? `${init.win}/${init.draw}/${init.loss}` : '',
        currentOdds: avg ? `${avg.win}/${avg.draw}/${avg.loss}` : '',
        favoriteSide,
        favoriteOdds,
        skeleton,
        oddsZone,
        noVigProbability: probs,
        movementType: movementHit?.direction || this._classifyMovement(iw, id, il, w, d, l),
        movementInterpretation: movementHit?.evidence?.join('；') || ''
      },
      drawCore: {
        role: drawHit?.direction || 'normal_draw',
        label: drawHit?.label || this._formatKnowledgeDirection(drawHit?.direction || 'normal_draw'),
        riskLevel: hasDirection('draw_guard') || hasRule('R-ODDS-023') ? 'medium_high' : 'low',
        interpretation: drawHit?.evidence?.join('；') || '平赔未形成强保护信号，按普通缓冲处理。'
      },
      companyStructure: this._buildCompanyStructure(normalized?.odds?.keyCompanies || [], favoriteSide),
      crossMarket: {
        asian: {
          line,
          supportSide: scores.euroAsianSupportSide,
          supportLevel: scores.euroAsian.level,
          interpretation: scores.euroAsian.reason
        },
        overunder: {
          line: ouLine,
          goalShape: scores.goalShape.level,
          interpretation: scores.goalShape.reason
        },
        consistencyScore: scores.euroAsian.score,
        conflicts: counterEvidence.filter(x => ['asian_insufficient', 'market_conflict', 'goal_shape_limit'].includes(x.code)).map(x => x.msg)
      },
      bookmakerIntent,
      marketResonance: resonance,
      counterEvidence,
      executionPlan,
      scores,
      topCandidate: topCore ? { market: topCore.market, label: topCore.label || topCore.direction, score: topCore.score || 0, ruleIds: topCore.ruleIds || [] } : null,
      evidence,
      risk,
      aiContract: {
        mustUse: true,
        marketCoreWeight: 80,
        auxiliaryWeight: 20,
        resonanceRules: 'R01-R14 盘赔共振/背离/水位过程规则为最高优先级读盘经验模块，背离陷阱优先于普通正向共振。',
        cannotOverrideWithout: ['核心伤停', '首发重大轮换', '战意结构反转', '临场盘口反向变动', '数据采集错误'],
        mustAnswer: ['盘口裁决是否成立', 'R01-R14盘赔共振命中是否成立', '最大反证是否足以推翻', '最优玩法', '回避玩法', '仓位与临场复核点']
      },
      principle: '先以欧赔核心、亚盘水位、大小球联动读懂庄家意图，再用战绩/伤停/量化做20%修正。'
    };
  }

  _num(v) {
    if (v === null || v === undefined || v === '') return NaN;
    if (typeof v === 'number') return v;
    const n = parseFloat(String(v).replace(/[^0-9.+\-]/g, ''));
    return Number.isFinite(n) ? n : NaN;
  }

  _noVigProbabilities(odds) {
    const w = this._num(odds?.win), d = this._num(odds?.draw), l = this._num(odds?.loss);
    if (![w, d, l].every(Number.isFinite) || w <= 0 || d <= 0 || l <= 0) return null;
    const rw = 1 / w, rd = 1 / d, rl = 1 / l;
    const sum = rw + rd + rl;
    return {
      win: Math.round((rw / sum) * 1000) / 10,
      draw: Math.round((rd / sum) * 1000) / 10,
      loss: Math.round((rl / sum) * 1000) / 10,
      overround: Math.round(sum * 1000) / 1000
    };
  }

  _classifyOddsSkeleton(w, d, l) {
    if (![w, d, l].every(Number.isFinite)) return '欧赔骨架未知';
    const fav = Math.min(w, l);
    if (fav < 1.45) return '超强低赔骨架';
    if (fav < 1.75) return '强弱低赔骨架';
    if (fav < 2.15) return '浅强势骨架';
    if (Math.abs(w - l) <= 0.25) return '均势对称骨架';
    return '均势/中庸骨架';
  }

  _classifyOddsZone(favOdds) {
    if (!Number.isFinite(favOdds)) return '未知区间';
    if (favOdds < 1.4) return '6区以下：大强弱低赔区';
    if (favOdds < 1.6) return '5区：强势低赔区';
    if (favOdds < 1.8) return '4区：明显优势承压区';
    if (favOdds < 2.0) return '3区：优势加强区';
    if (favOdds < 2.2) return '2区：优势明确但需辨实阻';
    if (favOdds < 2.4) return '1区：略占优区';
    if (favOdds <= 2.7) return '0区：均势心理区';
    return '高赔/弱势区';
  }

  _classifyMovement(iw, id, il, w, d, l) {
    if (![iw, id, il, w, d, l].every(Number.isFinite)) return 'movement_unknown';
    const dw = w - iw, dd = d - id, dl = l - il;
    if (dw < -0.08 && dd > 0.08 && dl > 0.08) return 'favorite_down_draw_away_up';
    if (dw < -0.08 && dd < -0.05 && dl > 0.08) return 'favorite_down_draw_guard';
    if (dw > 0.08 && (dd < -0.05 || dl < -0.08)) return 'favorite_retreat_or_opposite_protection';
    return 'movement_mild_or_mixed';
  }

  _buildMarketScores({ probs, favoriteSide, favoriteOdds, asianAnalysis, ouAnalysis, hits, conflicts, blockedBy, normalized }) {
    const hasRule = (id) => hits.some(h => h.ruleId === id);
    const probGap = probs ? Math.abs(Number(probs.win || 0) - Number(probs.loss || 0)) : 0;
    const euroExpressionScore = Math.max(25, Math.min(92,
      45
      + (favoriteSide !== 'balanced' ? 10 : -8)
      + (Number.isFinite(favoriteOdds) && favoriteOdds < 1.75 ? 10 : Number.isFinite(favoriteOdds) && favoriteOdds < 2.15 ? 6 : 0)
      + (probGap > 12 ? 10 : probGap > 6 ? 5 : 0)
      + (hasRule('R-ODDS-010') ? 4 : 0)
      - (favoriteSide === 'balanced' ? 6 : 0)
    ));
    const lineValue = this._handicapValue(asianAnalysis?.mainLine || asianAnalysis?.handicapLine || asianAnalysis?.aoCurrent?.line);
    const favWater = favoriteSide === 'home' ? asianAnalysis?.aoCurrent?.home : favoriteSide === 'away' ? asianAnalysis?.aoCurrent?.away : null;
    const euroAsianScore = Math.max(20, Math.min(92,
      48
      + (hasRule('R-ODDS-040') ? 16 : 0)
      - (hasRule('R-ODDS-041') ? 14 : 0)
      + (favoriteSide !== 'balanced' && Math.abs(Number(lineValue || 0)) >= 0.5 ? 8 : 0)
      + (Number.isFinite(Number(favWater)) && Number(favWater) <= 0.92 ? 8 : 0)
      - (Number.isFinite(favoriteOdds) && favoriteOdds < 1.85 && Math.abs(Number(lineValue || 0)) < 0.5 ? 12 : 0)
    ));
    const drawRisk = hasRule('R-ODDS-023') ? 72 : hasRule('R-ODDS-020') ? 58 : 38;
    const goalLine = this._num(ouAnalysis?.currentLine || ouAnalysis?.mainLine);
    const goalShapeScore = Math.max(25, Math.min(88,
      55
      + (Number.isFinite(goalLine) && goalLine >= 2.75 ? 7 : 0)
      - (Number.isFinite(goalLine) && goalLine <= 2.25 && favoriteSide !== 'balanced' ? 8 : 0)
      + ((ouAnalysis?.trend === 'over' || ouAnalysis?.moneyFlow === 'over') ? 5 : 0)
      - ((ouAnalysis?.trend === 'under' || ouAnalysis?.moneyFlow === 'under') ? 5 : 0)
    ));
    const resonanceTrapRuleIds = ['R-MR-04', 'R-MR-05', 'R-MR-06', 'R-MR-07', 'R-MR-11'];
    const hasResonanceTrap = resonanceTrapRuleIds.some(hasRule);
    const trapRisk = Math.max(0, Math.min(95,
      (hasRule('R-ODDS-071') ? 38 : 0)
      + (hasRule('R-ODDS-041') ? 24 : 0)
      + (hasResonanceTrap ? 42 : 0)
      + (favoriteSide !== 'balanced' && normalized?.derived?.popularitySide === favoriteSide ? 12 : 0)
      + (drawRisk >= 70 ? 8 : 0)
    ));
    const companyConsensus = this._buildCompanyStructure(normalized?.odds?.keyCompanies || [], favoriteSide);
    const companyConsensusScore = companyConsensus.score || 50;
    const movementScore = hasRule('R-ODDS-053') ? 64 : 52;
    const marketCoreScore = Math.round(
      euroExpressionScore * 0.22
      + euroAsianScore * 0.24
      + (100 - Math.min(drawRisk, 85)) * 0.16
      + goalShapeScore * 0.12
      + companyConsensusScore * 0.16
      + movementScore * 0.10
    );
    const riskPenalty = Math.round((trapRisk >= 70 ? 8 : trapRisk >= 45 ? 5 : 0) + conflicts.length * 6 + blockedBy.filter(b => b.level === 'high').length * 6);
    return {
      euroExpression: { score: Math.round(euroExpressionScore), level: euroExpressionScore >= 70 ? 'clear' : euroExpressionScore >= 55 ? 'partial' : 'weak', reason: '欧赔低赔侧、去水概率差与骨架清晰度综合评分' },
      euroAsian: { score: Math.round(euroAsianScore), level: euroAsianScore >= 72 ? 'strong_support' : euroAsianScore >= 58 ? 'partial_support' : 'weak_or_conflict', reason: euroAsianScore >= 72 ? '欧赔低赔与亚盘让步/水位形成较强闭环' : euroAsianScore >= 58 ? '欧赔方向获得部分亚盘支持，玩法需降级复核' : '欧赔与亚盘承载不足或存在背离' },
      euroAsianSupportSide: favoriteSide,
      drawRisk: { score: drawRisk, level: drawRisk >= 70 ? 'medium_high' : drawRisk >= 55 ? 'medium' : 'low', reason: drawRisk >= 70 ? '平赔存在保护/防平角色' : '平赔未形成强保护或只作普通缓冲' },
      goalShape: { score: Math.round(goalShapeScore), level: goalShapeScore >= 65 ? 'supports_open_game' : goalShapeScore >= 50 ? 'neutral_or_limited' : 'limits_handicap_covering', reason: goalShapeScore < 50 ? '大小球偏低或小球信号限制穿盘空间' : '大小球与胜负/让球剧本未出现硬冲突' },
      trapRisk: { score: trapRisk, level: trapRisk >= 70 ? 'high' : trapRisk >= 45 ? 'medium' : 'low', reason: trapRisk >= 70 ? '热门过热/低赔诱导风险高' : trapRisk >= 45 ? '热门存在承压，需降仓' : '暂未形成强热门陷阱' },
      companyConsensus,
      movement: { score: movementScore, level: movementScore >= 60 ? 'tracked' : 'limited', reason: hasRule('R-ODDS-053') ? '已记录初赔到即时赔方向变化' : '缺少显著变赔路径证据' },
      marketCoreScore: Math.max(25, Math.min(90, marketCoreScore - riskPenalty)),
      riskPenalty
    };
  }

  _buildCompanyStructure(keyCompanies, favoriteSide) {
    const list = Array.isArray(keyCompanies) ? keyCompanies : [];
    const coreNames = [/威廉|william/i, /立博|ladbrokes/i, /bet365|365/i, /澳门|澳彩|macau/i, /interwetten|易胜博/i];
    const core = list.filter(c => coreNames.some(re => re.test(String(c.name || '')))).slice(0, 6);
    const sample = core.length ? core : list.slice(0, 6);
    let aligned = 0;
    sample.forEach(c => {
      const cur = c.current || {};
      const win = this._num(cur.win), loss = this._num(cur.loss);
      const side = Number.isFinite(win) && Number.isFinite(loss) ? (win < loss - 0.12 ? 'home' : loss < win - 0.12 ? 'away' : 'balanced') : 'balanced';
      if (side === favoriteSide && side !== 'balanced') aligned += 1;
    });
    const score = sample.length ? Math.round((aligned / sample.length) * 40 + 45) : 50;
    return {
      sampleSize: sample.length,
      coreCompanyCount: core.length,
      consensusSide: favoriteSide,
      score: Math.max(35, Math.min(85, score)),
      level: score >= 70 ? 'mainstream_aligned' : score >= 55 ? 'partial_aligned' : 'weak_sample',
      companies: sample.map(c => ({ name: c.name, initial: c.initial, current: c.current, returnRate: c.returnRate, changeTime: c.changeTime })),
      interpretation: sample.length ? `主流/样本公司中 ${aligned}/${sample.length} 与低赔侧一致` : '缺少可用公司分层样本，均赔为主、公司结构降权'
    };
  }

  _inferBookmakerIntent({ summary, hits, conflicts, blockedBy, scores, drawHit, topCore }) {
    const hasRule = (id) => hits.some(h => h.ruleId === id);
    let type = 'balanced_risk';
    if (conflicts.some(c => c.level === 'high') || blockedBy.some(b => b.code === 'rule_conflict')) type = 'market_conflict';
    else if (hasRule('R-ODDS-023') || drawHit?.direction === 'draw_guard') type = 'draw_protection';
    else if (['R-MR-04', 'R-MR-05', 'R-MR-06', 'R-MR-07', 'R-MR-11'].some(hasRule)) type = 'favorite_trap';
    else if (hasRule('R-ODDS-071') && scores.euroAsian.score < 68) type = 'favorite_trap';
    else if (hasRule('R-ODDS-031')) type = 'underdog_protection';
    else if (hasRule('R-ODDS-041')) type = 'favorite_pressure';
    else if (hasRule('R-ODDS-040')) type = 'real_support';
    else if (summary?.shouldAvoid) type = 'balanced_risk';
    const map = {
      real_support: ['实盘支持', '欧赔低赔与亚盘/水位形成闭环，庄家愿意承压该方向。'],
      favorite_pressure: ['热门承压', '热门是盘口主线，但承载和水位仍要求降仓保护。'],
      favorite_trap: ['热门诱导/安全感陷阱', '表面热门过顺，亚盘承载或风险信号不足，需防诱盘。'],
      hidden_strength: ['韬光隐藏', '强势方没有被欧赔直接暴露，需等待临场确认。'],
      draw_protection: ['防平保护', '平赔承担保护或分散角色，主方向必须防平。'],
      underdog_protection: ['冷门/下盘保护', '市场热方与赔率处理不一致，弱方或客队方向被保护。'],
      market_conflict: ['三盘冲突/规则冲突', '欧赔、亚盘、大小球或规则出现硬冲突，不宜强推。'],
      balanced_risk: ['中庸多向风险', '盘口没有形成强闭环，按观察或低仓处理。']
    };
    const [label, primaryIntent] = map[type] || map.balanced_risk;
    return {
      type,
      label,
      primaryIntent,
      protectedResult: type === 'draw_protection' ? 'draw' : type === 'underdog_protection' ? 'underdog_or_draw' : '',
      trapRisk: scores.trapRisk.level,
      confidence: scores.marketCoreScore,
      sourceCandidate: topCore ? { market: topCore.market, label: topCore.label || topCore.direction, score: topCore.score || 0 } : null
    };
  }

  _buildCounterEvidence({ hits, conflicts, blockedBy, scores, ouAnalysis, drawHit, bookmakerIntent }) {
    const out = [];
    const push = (code, severity, msg, against = '') => out.push({ code, severity, msg, against });
    if (drawHit?.direction === 'draw_guard' || scores.drawRisk.score >= 70) push('draw_guard', 'high', '平赔保护明显，主胜/客胜单选需防平', 'single_1x2');
    if (scores.euroAsian.score < 58) push('asian_insufficient', 'high', '欧赔方向未获得亚盘让步/水位充分承载，深让或热门重仓降级', 'favorite_handicap');
    if (scores.goalShape.score < 50 || ouAnalysis?.trend === 'under') push('goal_shape_limit', 'medium', '大小球形态限制穿盘空间，强队小胜/平局风险上升', 'deep_handicap');
    if (scores.trapRisk.score >= 70) push('favorite_overheated', 'high', '热门过热或低赔安全感陷阱风险高，只能禁止热门重仓，不能自动反打高价值', 'favorite_heavy_stake');
    if (['R-MR-04', 'R-MR-05', 'R-MR-06', 'R-MR-07', 'R-MR-11'].some(id => hits.some(h => h.ruleId === id))) push('resonance_trap_gate', 'high', 'R-MR陷阱/高波动规则触发价值门控：下盘或大小球只作保护观察，不得包装为高/中高价值', 'high_value_entry');
    conflicts.slice(0, 3).forEach(c => push('market_conflict', c.level === 'high' ? 'high' : 'medium', c.msg || c.ruleId || '规则冲突', 'all_markets'));
    blockedBy.filter(b => b.level === 'high').slice(0, 3).forEach(b => push(b.code || 'blocked', 'high', b.msg || b.code, 'confidence'));
    if (!out.length && bookmakerIntent.type === 'real_support') push('normal_risk', 'low', '暂未发现足以推翻盘口主线的强反证，但仍需临场复核', 'late_market');
    return out;
  }

  _buildExecutionPlan({ summary, topCore, bookmakerIntent, counterEvidence, scores, line, ouLine }) {
    const highRisk = counterEvidence.some(x => x.severity === 'high');
    const trapGate = counterEvidence.some(x => ['favorite_overheated', 'resonance_trap_gate'].includes(x.code)) || bookmakerIntent.type === 'favorite_trap';
    const shouldSkip = trapGate || bookmakerIntent.type === 'market_conflict' || (summary?.shouldAvoid && scores.marketCoreScore < 58);
    const protection = counterEvidence.some(x => x.code === 'draw_guard') ? 'draw_guard' : '';
    let stake = scores.marketCoreScore >= 76 && !highRisk ? '中仓' : scores.marketCoreScore >= 62 ? '中低仓' : scores.marketCoreScore >= 52 ? '轻仓/保护' : '观望';
    if (trapGate) stake = '观察/极低仓（0~0.3u，需临场/CLV确认）';
    else if (shouldSkip) stake = '观望/等待临场';
    const avoidMarkets = [];
    if (counterEvidence.some(x => ['asian_insufficient', 'goal_shape_limit'].includes(x.code))) avoidMarkets.push('热门深让重仓');
    if (counterEvidence.some(x => x.code === 'favorite_overheated')) avoidMarkets.push('低回报热门重仓');
    if (shouldSkip) avoidMarkets.push('强行给胆材');
    const bestMarket = shouldSkip
      ? (trapGate ? '反热门重仓门控：只做保护观察，不自动下盘高价值' : '等待临场/只做风险观察')
      : protection
        ? '胜平负主方向防平 / 不败保护优于深让'
        : (bookmakerIntent.type === 'real_support' ? `亚盘/胜平负主方向复核执行（盘口 ${line}）` : '主方向轻仓，优先保护玩法');
    const headline = shouldSkip
      ? `【盘口裁决】${bookmakerIntent.label}，盘口无闭环，建议观望`
      : `【盘口裁决】${bookmakerIntent.label}：${topCore?.label || this._formatKnowledgeDirection(summary?.mainDirection)}；最优玩法=${bestMarket}；仓位=${stake}`;
    return {
      headline,
      bestMarket,
      secondaryMarket: ouLine && ouLine !== '-' ? `大小球${ouLine}仅作联动复核` : '大小球待数据补强',
      avoidMarkets,
      protection,
      stake,
      confidence: scores.marketCoreScore,
      shouldSkip,
      skipReason: shouldSkip ? (trapGate ? 'R-MR陷阱/高风险门控未解除，禁止高/中高价值' : '盘口/规则冲突或高风险未解除') : '',
      liveChecklist: ['临场主流亚盘是否升/退盘', '低赔侧水位是否反向升高', '平赔是否继续压低', '首发/核心伤停是否改变比赛形态']
    };
  }

  _buildRuleDecision(knowledge, normalized, composite) {
    const summary = knowledge?.summary || {};
    const dc = normalized?.derived?.dataCompleteness || null;
    const blockedBy = Array.isArray(knowledge?.blockedBy) ? knowledge.blockedBy.slice(0, 12) : [];
    const conflicts = Array.isArray(knowledge?.conflicts) ? knowledge.conflicts.slice(0, 10) : [];
    const triggeredRuleIds = summary.triggeredRuleIds || [...new Set((knowledge?.hits || []).map(h => h.ruleId).filter(Boolean))];
    const missingFields = [...new Set([
      ...(summary.missingFields || []),
      ...(dc?.missing || []),
      ...blockedBy.filter(b => /^missing_/.test(b.code || '')).map(b => b.code)
    ].filter(Boolean))];
    const trapRuleIds = ['R-MR-04', 'R-MR-05', 'R-MR-06', 'R-MR-07', 'R-MR-11'];
    const trapGate = triggeredRuleIds.some(id => trapRuleIds.includes(id));
    const riskLevel = summary.riskLevel || (blockedBy.some(b => b.level === 'high') || trapGate ? 'high' : 'low');
    const shouldWarnOnly = trapGate || riskLevel === 'high' || blockedBy.some(b => b.level === 'high') || conflicts.some(c => c.level === 'high');
    const confidenceBreakdown = summary.confidenceBreakdown || composite.confidenceBreakdown || { base: 50, final: composite.confidence };
    const whyNotTop2 = Array.isArray(summary.whyNotTop2) ? summary.whyNotTop2.slice(0, 5) : [];
    if (trapGate) whyNotTop2.push('命中 R-MR陷阱/高波动门控：该信号只禁止热门重仓，不允许自动包装为下盘/大小球高价值。');
    if (shouldWarnOnly && !whyNotTop2.length) whyNotTop2.push('爆冷/冲突风险较高，系统仅提示降级和仓位风险，不替用户放弃。');
    const unanalysableFlags = Array.isArray(summary.unanalysableFlags) ? [...summary.unanalysableFlags] : [];
    if (dc && Number(dc.score || 0) < 55) unanalysableFlags.push(`数据完整度偏低(${dc.score}%)，结论需弱化`);

    return {
      mainDirection: summary.mainDirection || 'watch',
      secondaryDirection: summary.secondaryDirection || null,
      recommendationLevel: summary.recommendationLevel || '观望',
      marketStakeAdvice: summary.marketStakeAdvice || null,
      weightPolicy: composite.weightPolicy || summary.weightPolicy || null,
      marketCoreDecision: composite.marketCoreDecision || summary.marketCoreDecision || null,
      marketVerdict: composite.marketVerdict || composite.marketCoreDecision || summary.marketVerdict || null,
      marketResonance: knowledge?.resonance || summary.marketResonance || null,
      riskLevel,
      shouldAvoid: !!summary.shouldAvoid,
      shouldWarnOnly,
      blockedBy,
      conflicts,
      confidenceBreakdown,
      triggeredRuleIds,
      missingFields,
      unanalysableFlags: [...new Set(unanalysableFlags)],
      whyNotTop2,
      valueGate: trapGate ? { noHighValue: true, stakeCap: '0~0.3u', requiresClosingConfirm: true, reasons: ['R-MR陷阱/高波动规则触发'] } : summary.valueGate || null,
      dataCompleteness: dc,
      topCandidateLabel: summary.topCandidateLabel || ''
    };
  }

  _buildCandidatePredictions(knowledge, composite, ruleDecision) {
    const items = [];
    const seen = new Set();
    const push = (item) => {
      const key = `${item.market || ''}_${item.direction || ''}_${item.label || ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push({
        market: item.market || '综合',
        direction: item.direction || 'watch',
        label: item.label || this._formatKnowledgeDirection(item.direction),
        score: Math.round(Number(item.score || 0)),
        confidence: item.confidence ?? null,
        ruleIds: item.ruleIds || [],
        evidence: item.evidence || [],
        risk: item.risk || [],
        source: item.source || 'knowledge',
        weightShare: item.weightShare || (item.source === 'heuristic' ? 20 : 80)
      });
    };

    (knowledge?.candidates || []).forEach(c => push({ ...c, source: 'knowledge' }));
    (composite.recommendations || []).forEach((r, idx) => {
      const trend = r.trend || (r.edge === 'home_value' ? 'home' : r.edge === 'away_value' ? 'away' : 'watch');
      push({
        market: r.market || '盘口',
        direction: trend,
        label: r.suggestion || r.line || r.market,
        score: Math.max(42, 58 - idx * 4),
        evidence: [r.line ? `盘口=${r.line}` : '', r.homePay ? `主水=${r.homePay}/客水=${r.awayPay}` : ''].filter(Boolean),
        source: r.market === '欧赔核心/庄家读盘' ? 'market-core' : 'heuristic',
        weightShare: r.weightShare || (r.market === '欧赔核心/庄家读盘' ? 80 : 20)
      });
    });

    const riskPenalty = ruleDecision.shouldWarnOnly ? (ruleDecision.valueGate?.noHighValue ? 18 : 8) : 0;
    return items
      .map(c => ({ ...c, adjustedScore: Math.max(0, Math.round((c.score || 0) - riskPenalty)) }))
      .sort((a, b) => (b.adjustedScore || 0) - (a.adjustedScore || 0))
      .slice(0, 8);
  }

  // ===== 滚球实时预测 =====
  _livePredict(liveData, asianAnalysis, ouAnalysis, data) {
    const recs = [];
    const { minute, homeScore, awayScore, homeCorners, awayCorners } = liveData;
    const totalGoals = (homeScore || 0) + (awayScore || 0);
    const totalCorners = (homeCorners || 0) + (awayCorners || 0);
    const remaining = 90 - (minute || 0);

    // 进球数预测（当前进球 + 预计剩余进球）
    const ouLine = parseFloat(ouAnalysis.currentLine || ouAnalysis.mainLine || 2.5);
    const projectedGoals = totalGoals + (totalGoals / Math.max(minute, 1)) * remaining;

    if (minute >= 30 && minute <= 75) {
      if (projectedGoals > ouLine + 0.5) {
        recs.push({
          type: 'overunder', timing: `${minute}'`,
          suggestion: `当前${totalGoals}球，预计全场>${ouLine}，倾向大球`,
          confidence: 60, alert: totalGoals >= 2 && minute < 60
        });
      } else if (projectedGoals < ouLine - 0.5) {
        recs.push({
          type: 'overunder', timing: `${minute}'`,
          suggestion: `当前${totalGoals}球，预计全场<${ouLine}，倾向小球`,
          confidence: 60, alert: totalGoals === 0 && minute > 45
        });
      }
    }

    // 角球预测
    const cornerLine = parseFloat(data?.corner?.mainLine || 9.5);
    const projectedCorners = totalCorners + (totalCorners / Math.max(minute, 1)) * remaining;
    if (minute >= 20) {
      if (projectedCorners > cornerLine + 1) {
        recs.push({
          type: 'corner', timing: `${minute}'`,
          suggestion: `当前${totalCorners}角球，预计全场>${cornerLine}，推荐大角球`,
          confidence: 58, alert: false
        });
      } else if (projectedCorners < cornerLine - 1) {
        recs.push({
          type: 'corner', timing: `${minute}'`,
          suggestion: `当前${totalCorners}角球，预计全场<${cornerLine}，推荐小角球`,
          confidence: 58, alert: false
        });
      }
    }

    // 半场投注建议
    if (minute >= 30 && minute < 45) {
      recs.push({
        type: 'halftime', timing: `${minute}'`,
        suggestion: `半场前：当前${homeScore}-${awayScore}，半场进球数${totalGoals}，考虑半场大小球`,
        confidence: 55, alert: false
      });
    }

    // 比分投注建议（极端情况）
    if (totalGoals === 0 && minute >= 60) {
      recs.push({
        type: 'score', timing: `${minute}'`,
        suggestion: `${minute}'仍0-0，考虑进球/无进球盘`,
        confidence: 65, alert: true
      });
    }

    return recs;
  }

  _formatKnowledgeDirection(direction) {
    const map = {
      home: '主队方向',
      away: '客队方向',
      over: '大球方向',
      under: '小球方向',
      draw_guard: '防平/低比分保护',
      draw_protection: '防平保护',
      under_or_low_draw: '小球或低比分平局',
      over_supported: '大球获得支持',
      favorite_hidden_or_risk: '热门韬光或风险',
      avoid_or_reduce: '规避或降仓',
      downgrade_or_avoid: '降级或观望'
    };
    return map[direction] || direction || '观望';
  }

  _handicapValue(line) {
    const raw = String(line || '').trim();
    const map = {
      '受让两球半': -2.5, '受让两球/两球半': -2.25, '受让两球': -2,
      '受让球半/两球': -1.75, '受让球半': -1.5, '受让一球/球半': -1.25, '受让一球': -1,
      '受让半球/一球': -0.75, '受让半球': -0.5, '受让平手/半球': -0.25,
      '平手': 0, '平手/半球': 0.25, '半球': 0.5,
      '半球/一球': 0.75, '一球': 1, '一球/球半': 1.25,
      '球半': 1.5, '球半/两球': 1.75, '两球': 2, '两球/两球半': 2.25, '两球半': 2.5, '两球半/三球': 2.75, '三球': 3
    };
    if (Object.prototype.hasOwnProperty.call(map, raw)) return map[raw];
    const pair = raw.match(/(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
    if (pair) return (parseFloat(pair[1]) + parseFloat(pair[2])) / 2;
    const n = parseFloat(raw.replace(/[^\d+\-.]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  _calcEdge(home, away) {
    if (!home || !away) return 'unknown';
    if (parseFloat(home) < parseFloat(away) - 0.05) return 'home_value';
    if (parseFloat(away) < parseFloat(home) - 0.05) return 'away_value';
    return 'balanced';
  }
}

// ===== 预测记录管理 =====
export class PredictionLogger {
  static async save(prediction, matchInfo) {
    const key = `pred_history`;
    const result = await chrome.storage.local.get(key);
    const history = result[key] || [];

    const entry = {
      id: Date.now(),
      matchId: prediction.matchId,
      matchInfo: matchInfo || {},
      generatedAt: prediction.generatedAt,
      isLive: prediction.isLive,
      confidence: prediction.confidence,
      summary: prediction.summary,
      recommendations: prediction.recommendations,
      liveRecommendations: prediction.liveRecommendations,
      alerts: prediction.alerts,
      marketVerdict: prediction.marketVerdict || prediction.marketCoreDecision || null,
      marketCommand: prediction.marketCommand || null,
      marketCommandSource: prediction.marketCommand?._source || '',
      knowledgeSource: prediction.knowledge?._source || '',
      cloudRuleSource: prediction.cloudRuleSource || null,
      marketCommandVersion: prediction.marketCommand?.version || '',
      primaryScenario: prediction.marketCommand?.primaryScenario || null,
      counterEvidenceVerdict: prediction.marketCommand?.counterEvidenceTrial?.verdict || '',
      executionCommand: prediction.marketCommand?.executionCommand || null,
      reviewChecklist: prediction.marketCommand?.reviewChecklist || [],
      resonanceTopRule: prediction.marketResonance?.topRule || prediction.marketCommand?.currentMarketRead?.topRule || null,
      professionalMarket: prediction.professionalMarket || null,
      valueAdmission: prediction.professionalMarket?.valueAdmission || prediction.valueAdmission || null,
      valueAdmissionLevel: prediction.professionalMarket?.valueAdmission?.level || prediction.valueAdmission?.level || '',
      valueAdmissionTier: prediction.professionalMarket?.valueAdmission?.valueTier || prediction.valueAdmission?.valueTier || '',
      valueStrongSignal: !!(prediction.professionalMarket?.valueAdmission?.strongValueSignal || prediction.valueAdmission?.strongValueSignal),
      valueHighEvidence: prediction.professionalMarket?.valueAdmission?.highValueEvidence || prediction.valueAdmission?.highValueEvidence || [],
      valueAllowMediumHigh: !!(prediction.professionalMarket?.valueAdmission?.allowMediumHigh || prediction.valueAdmission?.allowMediumHigh),
      valueAllowMediumHighWatch: !!(prediction.professionalMarket?.valueAdmission?.allowMediumHighWatch || prediction.valueAdmission?.allowMediumHighWatch),
      valueNearMissMediumHigh: !!(prediction.professionalMarket?.valueAdmission?.nearMissMediumHigh || prediction.valueAdmission?.nearMissMediumHigh),
      valueSoftMissing: prediction.professionalMarket?.valueAdmission?.softMissing || prediction.valueAdmission?.softMissing || [],
      valuePromotionHints: prediction.professionalMarket?.valueAdmission?.promotionHints || prediction.valueAdmission?.promotionHints || [],
      valueAllowHigh: !!(prediction.professionalMarket?.valueAdmission?.allowHigh || prediction.valueAdmission?.allowHigh),
      professionalMarketScore: prediction.professionalMarket?.score || prediction.professionalMarketScore || null,
      professionalMarketRiskFlags: prediction.professionalMarket?.riskFlags || prediction.professionalMarketRiskFlags || [],
      knowledgeSummary: prediction.knowledge?.summary || null,
      knowledgeHits: prediction.knowledge?.hits?.slice(0, 20) || [],
      knowledgeCandidates: prediction.knowledge?.candidates?.slice(0, 10) || [],
      knowledgeRisks: prediction.knowledge?.blockedBy?.slice(0, 10) || [],
      ruleDecision: prediction.ruleDecision || null,
      candidatePredictions: prediction.candidatePredictions?.slice(0, 12) || [],
      triggeredRuleIds: prediction.triggeredRuleIds || [],
      missingFields: prediction.missingFields || [],
      unanalysableFlags: prediction.unanalysableFlags || [],
      whyNotTop2: prediction.whyNotTop2 || [],
      confidenceBreakdown: prediction.confidenceBreakdown || null,
      dataCompleteness: prediction.normalized?.derived?.dataCompleteness || null,
      teamProfileMatched: !!prediction.teamProfileMatched,
      teamProfileSummary: prediction.teamProfileSummary || null,
      teamProfileCoverage: prediction.teamProfileSummary?.coverage || null,
      teamProfileUpdatedAt: prediction.teamProfileSummary?.updatedAt || '',
      // 赛后复盘字段
      actualResult: null,
      review: null,
      reviewTags: [],
      ruleReview: null
    };

    const sameMatchIndexes = [];
    history.forEach((item, idx) => {
      if (String(item.matchId || '') === String(prediction.matchId || '')) sameMatchIndexes.push(idx);
    });
    const isCloudEntry = entry.marketCommandSource === 'cloud' && entry.knowledgeSource === 'cloud';
    if (isCloudEntry) {
      // 云端计算成功后，同场历史里的本地/存根结果全部覆盖，避免用户继续看到旧“本地存根”。
      for (let i = sameMatchIndexes.length - 1; i >= 0; i--) history.splice(sameMatchIndexes[i], 1);
      history.unshift(entry);
    } else {
      const hasCloudSameMatch = history.some(item => String(item.matchId || '') === String(prediction.matchId || '') && item.marketCommandSource === 'cloud' && item.knowledgeSource === 'cloud');
      if (!hasCloudSameMatch) history.unshift(entry);
    }

    // 只保留最近100条
    if (history.length > 100) history.splice(100);

    await chrome.storage.local.set({ [key]: history });
    return history[0];
  }

  static async getAll() {
    const result = await chrome.storage.local.get('pred_history');
    return result['pred_history'] || [];
  }

  static async updateReview(id, actualResult, review) {
    const result = await chrome.storage.local.get('pred_history');
    const history = result['pred_history'] || [];
    const idx = history.findIndex(h => h.id === id);
    if (idx >= 0) {
      history[idx].actualResult = actualResult;
      history[idx].review = review;
      await chrome.storage.local.set({ 'pred_history': history });
    }
  }
}
