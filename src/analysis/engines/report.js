/**
 * ReportGenerator - 将采集的完整数据整理为结构化 Markdown 报告
 * 适合直接发送给 AI 进行分析预测
 */
import { marketCommandToMarkdown } from './market-orchestrator.js';
import { professionalMarketToMarkdown } from './pro-market-engine.js';
import { arbitrateCandidates, finalCandidatesToMarkdown } from './candidate-arbitrator.js';

export class ReportGenerator {

  generate(stored, extras = {}) {
    const { matchId, fetchTime, data } = stored;
    if (!data) return { text: '无数据', markdown: '# 无数据', structured: {} };

    const { analysis, winDrawWin, asian, overunder, corner } = data;
    const home = analysis?.matchInfo?.home || '主队';
    const away = analysis?.matchInfo?.away || '客队';
    const matchTime = analysis?.matchInfo?.time || '';
    const normalized = extras.normalized || null;
    const knowledge = extras.knowledge || null;
    const marketVerdict = extras.marketVerdict || extras.marketCoreDecision || extras.ruleDecision?.marketVerdict || null;
    const ruleDecision = extras.ruleDecision || null;
    const localPrediction = extras.localPrediction || null;
    const rawMarketCommand = extras.marketCommand || localPrediction?.marketCommand || ruleDecision?.marketCommand || knowledge?.summary?.marketCommand || null;
    const invalidMarketCommandSource = rawMarketCommand && rawMarketCommand.version === 'market-command-v4' && rawMarketCommand._source !== 'cloud'
      ? (rawMarketCommand._source || 'unknown')
      : '';
    const marketCommand = rawMarketCommand && rawMarketCommand.version === 'market-command-v4' && rawMarketCommand._source === 'cloud'
      ? rawMarketCommand
      : null;
    const marketVerdictJson = marketVerdict ? JSON.stringify(marketVerdict, null, 2) : '';
    const marketCommandJson = marketCommand ? JSON.stringify(marketCommand, null, 2) : '';
    const professionalMarket = extras.professionalMarket || localPrediction?.professionalMarket || marketCommand?.professionalMarket || null;
    const professionalMarketJson = professionalMarket ? JSON.stringify(professionalMarket, null, 2) : '';
    const teamProfiles = extras.teamProfiles || localPrediction?.teamProfiles || data?.teamProfiles || null;
    const teamProfileMarkdown = extras.teamProfileMarkdown || localPrediction?.teamProfileMarkdown || data?.teamProfileMarkdown || '';

    const sections = [];

    // ========== 标题 ==========
    sections.push(`# ⚽ 足球比赛数据分析报告`);
    sections.push(`> 比赛ID: ${matchId} | 数据采集: ${new Date(fetchTime).toLocaleString('zh-CN')}`);
    sections.push('');

    // ========== 基本信息 ==========
    sections.push(`## 一、比赛信息`);
    sections.push(`| 项目 | 内容 |`);
    sections.push(`|------|------|`);
    sections.push(`| 对阵 | **${home}** VS **${away}** |`);
    if (matchTime) sections.push(`| 时间 | ${matchTime} |`);
    if (analysis?.matchInfo?.league) sections.push(`| 赛事 | ${analysis.matchInfo.league} |`);
    if (analysis?.matchInfo?.venue) sections.push(`| 场地 | ${analysis.matchInfo.venue} |`);
    if (analysis?.matchInfo?.weather) sections.push(`| 天气 | ${analysis.matchInfo.weather} ${analysis.matchInfo.temperature || ''} |`);
    sections.push('');

    // ========== 球队画像库 ==========
    if (teamProfileMarkdown || teamProfiles) {
      sections.push(`## 🧬 球队画像库（基础实力/风格/验证状态，20%辅助修正）`);
      if (teamProfileMarkdown) {
        sections.push(teamProfileMarkdown.replace(/^#+\s*/gm, '### '));
      } else {
        const homeProfile = teamProfiles?.home?.profile || {};
        const awayProfile = teamProfiles?.away?.profile || {};
        sections.push(`- 主队画像：${homeProfile.country || homeProfile.name || teamProfiles?.home?.name || home}｜匹配=${teamProfiles?.home?.matched ? '是' : '否'}｜验证=${homeProfile.verificationStatus || '-'}`);
        sections.push(`- 客队画像：${awayProfile.country || awayProfile.name || teamProfiles?.away?.name || away}｜匹配=${teamProfiles?.away?.matched ? '是' : '否'}｜验证=${awayProfile.verificationStatus || '-'}`);
      }
      sections.push('> 使用纪律：球队画像只作为长期实力、风格、热度、基本面的20%辅助修正，不能绕过 MARKET_COMMAND_JSON 盘口总控。');
      sections.push('');
    }

    // ========== 赛前简报 ==========
    sections.push(`## 二、赛前简报（系统分析）`);
    if (analysis?.preBriefing) {
      sections.push(`> ${analysis.preBriefing.replace(/\n/g, '\n> ')}`);
    } else {
      sections.push(`> 暂无赛前简报数据。可点击“调试”查看原始页面文本长度，确认球探网分析页是否已完整加载。`);
    }
    sections.push('');

    // ========== 联赛战绩 ==========
    sections.push(`## 三、联赛战绩统计`);
    sections.push(this._formatFullStats(home, analysis?.homeStats, analysis?.homeHalfStats, 'home'));
    sections.push(this._formatFullStats(away, analysis?.awayStats, analysis?.awayHalfStats, 'away'));

    // ========== 盘路走势 ==========
    sections.push(`## 四、联赛盘路走势`);
    const ht = analysis?.handicapTrend || {};
    sections.push(this._formatTrendBlock(home, ht.home, '🏠'));
    sections.push(this._formatTrendBlock(away, ht.away, '✈️'));
    sections.push('');

    // ========== 相同盘路历史 ==========
    sections.push(`## 五、相同盘口历史走势`);
    if (analysis?.sameHandicapHistory?.length > 0) {
      analysis.sameHandicapHistory.forEach(block => {
        if (!block.handicap) return;
        sections.push(`**初盘: ${block.handicap}**`);
        if (block.total) {
          sections.push(`- 历史: 赢${block.total.win} 走${block.total.draw} 输${block.total.loss} → 赢盘率 **${block.total.rate}**`);
        }
        if (block.last6) sections.push(`- 近6场: \`${block.last6}\``);
      });
    } else {
      sections.push(`*暂无相同盘口历史数据。*`);
    }
    sections.push('');

    // ========== 进球数据 ==========
    sections.push(`## 六、进球数据分析`);

    const fmtObjRow = (label, obj, keys) => `| ${label} | ${keys.map(k => obj?.[k] || '-').join(' | ')} |`;
    const fmtPct = v => v ? `${v.games || '-'}场/${v.pct || '-'}%` : '-';

    // 入球数/上下半场入球分布
    if (analysis?.recentGoalDistribution?.home || analysis?.recentGoalDistribution?.away) {
      const goalKeys = ['0球','1球','2球','3球','4+','上半场','下半场'];
      sections.push(`### 入球数 / 上下半场入球分布`);
      sections.push(`| 队伍 | 0球 | 1球 | 2球 | 3球 | 4+ | 上半场入球 | 下半场入球 |`);
      sections.push(`|------|-----|-----|-----|-----|----|------------|------------|`);
      [['总', '总'], ['主', '主'], ['客', '客']].forEach(([label, key]) => {
        sections.push(fmtObjRow(`${home}${label}`, analysis.recentGoalDistribution.home?.[key], goalKeys));
      });
      [['总', '总'], ['主', '主'], ['客', '客']].forEach(([label, key]) => {
        sections.push(fmtObjRow(`${away}${label}`, analysis.recentGoalDistribution.away?.[key], goalKeys));
      });
      sections.push('');
    }

    // 半全场
    if (analysis?.halfFull?.home || analysis?.halfFull?.away) {
      const hfKeys = ['胜胜','胜和','胜负','和胜','和和','和负','负胜','负和','负负'];
      sections.push(`### 半全场分布`);
      sections.push(`| 队伍 | 胜胜 | 胜和 | 胜负 | 和胜 | 和和 | 和负 | 负胜 | 负和 | 负负 |`);
      sections.push(`|------|------|------|------|------|------|------|------|------|------|`);
      ['总','主','客'].forEach(k => sections.push(fmtObjRow(`${home}${k}`, analysis.halfFull.home?.[k], hfKeys)));
      ['总','主','客'].forEach(k => sections.push(fmtObjRow(`${away}${k}`, analysis.halfFull.away?.[k], hfKeys)));
      sections.push('');
    }

    // 进球数/单双
    if (analysis?.goalSingleDouble?.homeTotal || analysis?.goalSingleDouble?.home || analysis?.goalSingleDouble?.away) {
      const sd = analysis.goalSingleDouble;
      const sdKeys = ['大','小','走','单','双'];
      sections.push(`### 进球大小 / 单双`);
      sections.push(`| 队伍 | 大 | 小 | 走 | 单 | 双 |`);
      sections.push(`|------|---|---|---|---|---|`);
      if (sd.home || sd.away) {
        ['总','主','客'].forEach(k => sections.push(`| ${home}${k} | ${sdKeys.map(x => fmtPct(sd.home?.[k]?.[x])).join(' | ')} |`));
        ['总','主','客'].forEach(k => sections.push(`| ${away}${k} | ${sdKeys.map(x => fmtPct(sd.away?.[k]?.[x])).join(' | ')} |`));
      } else {
        const fmtSD = (obj) => obj ? `${obj.big?.pct||'-'}% | ${obj.small?.pct||'-'}% | ${obj.draw?.pct||'-'}% | ${obj.odd?.pct||'-'}% | ${obj.even?.pct||'-'}%` : '- | - | - | - | -';
        sections.push(`| ${home}总 | ${fmtSD(sd.homeTotal)} |`);
        sections.push(`| ${away}总 | ${fmtSD(sd.awayTotal)} |`);
      }
      sections.push('');
    }

    // 进球时间分布
    const gt = analysis?.goalTimeDistribution || {};
    if (gt.home || gt.away || gt.homeFirst || gt.awayFirst || gt.rows?.length > 0 || gt.firstRows?.length > 0) {
      const timeKeys = ['1-10','11-20','21-30','31-40','41-45','46-50','51-60','61-70','71-80','81-90+'];
      if (gt.home || gt.away || gt.rows?.length > 0) {
        sections.push(`### 进球时间分布`);
        sections.push(`| 队伍 | 1-10 | 11-20 | 21-30 | 31-40 | 41-45 | 46-50 | 51-60 | 61-70 | 71-80 | 81-90+ |`);
        sections.push(`|------|------|-------|-------|-------|-------|-------|-------|-------|-------|--------|`);
        ['总','主','客'].forEach(k => sections.push(fmtObjRow(`${home}${k}`, gt.home?.[k], timeKeys)));
        ['总','主','客'].forEach(k => sections.push(fmtObjRow(`${away}${k}`, gt.away?.[k], timeKeys)));
      }
      if (gt.homeFirst || gt.awayFirst || gt.firstRows?.length > 0) {
        sections.push('');
        sections.push(`**第一个进球时间统计**`);
        sections.push(`| 队伍 | 1-10 | 11-20 | 21-30 | 31-40 | 41-45 | 46-50 | 51-60 | 61-70 | 71-80 | 81-90+ |`);
        sections.push(`|------|------|-------|-------|-------|-------|-------|-------|-------|-------|--------|`);
        ['总','主','客'].forEach(k => sections.push(fmtObjRow(`${home}${k}`, gt.homeFirst?.[k], timeKeys)));
        ['总','主','客'].forEach(k => sections.push(fmtObjRow(`${away}${k}`, gt.awayFirst?.[k], timeKeys)));
      }
      sections.push('');
    }

    // 数据比较（平均进失球）
    const dc = analysis?.dataComparison;
    const sc = analysis?.seasonComparison;
    if (dc?.home?.avgGoal || sc?.home?.goals?.total || sc?.away?.goals?.total) {
      sections.push(`### 本赛季数据统计比较`);
      const fmtGoalBlock = (team, comp) => {
        const g = comp?.goals || {};
        const lines = [];
        if (g.total) lines.push(`- ${team} 总计: 进${g.total.goalsFor}失${g.total.goalsAgainst}，场均进${g.total.avgGoal}/失${g.total.avgLoss}`);
        if (g.venue) lines.push(`- ${team} 主/客场: 进${g.venue.goalsFor}失${g.venue.goalsAgainst}，场均进${g.venue.avgGoal}/失${g.venue.avgLoss}`);
        if (g.last6) lines.push(`- ${team} 近6场: 进${g.last6.goalsFor}失${g.last6.goalsAgainst}，场均进${g.last6.avgGoal}/失${g.last6.avgLoss}`);
        return lines;
      };
      sections.push(...fmtGoalBlock(home, sc?.home));
      sections.push(...fmtGoalBlock(away, sc?.away));
    }
    sections.push('');

    // ========== 阵容情况 ==========
    if (analysis?.injuries?.home?.length > 0 || analysis?.injuries?.away?.length > 0) {
      sections.push(`## 七、阵容缺阵情况`);
      if (analysis.injuries.home.length > 0) {
        sections.push(`### 🏠 ${home} 缺阵 (${analysis.injuries.home.length}人)`);
        analysis.injuries.home.forEach(p => {
          sections.push(`- [${p.number}] ${p.name} — ${p.reason}`);
        });
      }
      if (analysis.injuries.away.length > 0) {
        sections.push(`### ✈️ ${away} 缺阵 (${analysis.injuries.away.length}人)`);
        analysis.injuries.away.forEach(p => {
          sections.push(`- [${p.number}] ${p.name} — ${p.reason}`);
        });
      }
      sections.push('');
    }

    // ========== 球员评分 ==========
    const h10 = analysis?.playerRatings?.home10 || analysis?.playerRatings?.home10AvgScores;
    const a10 = analysis?.playerRatings?.away10 || analysis?.playerRatings?.away10AvgScores;
    if (h10?.length > 0 || a10?.length > 0) {
      sections.push(`## 八、近期球队评分`);
      if (h10?.length > 0) {
        const avg = (h10.reduce((s, v) => s + parseFloat(v), 0) / h10.length).toFixed(2);
        sections.push(`- ${home} 近10场平均: **${avg}** | 走势: ${h10.join(' ')}`);
      }
      if (a10?.length > 0) {
        const avg = (a10.reduce((s, v) => s + parseFloat(v), 0) / a10.length).toFixed(2);
        sections.push(`- ${away} 近10场平均: **${avg}** | 走势: ${a10.join(' ')}`);
      }
      sections.push('');
    }

    // ========== 胜平负 / 欧赔 ==========
    sections.push(`## 九、胜平负盘口（欧赔 / 1x2）`);
    if (winDrawWin && !winDrawWin.error && winDrawWin.companies?.length > 0) {
      const sum = winDrawWin.summary || {};
      sections.push(`**欧赔公司数**: ${sum.count || winDrawWin.companies.length} 家`);
      if (sum.averageInitial || sum.averageCurrent) {
        sections.push(`| 类型 | 主胜 | 平局 | 客胜 | 返还率 |`);
        sections.push(`|------|------|------|------|--------|`);
        if (sum.averageInitial) sections.push(`| 初盘平均 | ${sum.averageInitial.win} | ${sum.averageInitial.draw} | ${sum.averageInitial.loss} | - |`);
        if (sum.averageCurrent) sections.push(`| 即时平均 | **${sum.averageCurrent.win}** | **${sum.averageCurrent.draw}** | **${sum.averageCurrent.loss}** | ${sum.averageReturnRate || '-'} |`);
      }
      if (sum.impliedAverage) {
        sections.push(`**平均隐含概率**: 主胜 ${sum.impliedAverage.win} / 平局 ${sum.impliedAverage.draw} / 客胜 ${sum.impliedAverage.loss}`);
      }
      if (sum.movement) {
        sections.push(`**赔率变化家数**: 主胜降 ${sum.movement.winDown || 0}/升 ${sum.movement.winUp || 0} | 平局降 ${sum.movement.drawDown || 0}/升 ${sum.movement.drawUp || 0} | 客胜降 ${sum.movement.lossDown || 0}/升 ${sum.movement.lossUp || 0}`);
      }
      sections.push('');

      const stats = winDrawWin.statistics;
      if (stats?.rows?.length > 0) {
        sections.push(`### ${stats.company || '36*(英国)'}欧指统计表`);
        sections.push(`| 类型 | 主胜 | 平局 | 客胜 | 返还率 | 概率(主/平/客) | 样本(总/主/平/客) |`);
        sections.push(`|------|------|------|------|--------|----------------|------------------|`);
        stats.rows.forEach(r => {
          const prob = r.probabilities ? `${r.probabilities.win || '-'} / ${r.probabilities.draw || '-'} / ${r.probabilities.loss || '-'}` : '-';
          const sample = r.total ? `${r.total}/${r.winCount || 0}/${r.drawCount || 0}/${r.lossCount || 0}` : '-';
          sections.push(`| ${r.label || r.type} | ${r.win || '-'} | ${r.draw || '-'} | ${r.loss || '-'} | ${r.returnRate || '-'} | ${prob} | ${sample} |`);
        });
        if (stats.summary?.sampleRates) {
          const sr = stats.summary.sampleRates;
          sections.push(`- 样本赛果分布: 主胜 ${sr.win} / 平局 ${sr.draw} / 客胜 ${sr.loss}${stats.summary.sampleTotal ? `（共${stats.summary.sampleTotal}场）` : ''}`);
        }
        if (stats.recent30?.length > 0) sections.push(`- 近30场走势: \`${stats.recent30.join(' ')}\``);
        sections.push('');
      }

      const fmtKelly = c => {
        if (!c.kelly) return '-';
        const one = (v, risk) => risk ? `**${v}⚠️**` : v;
        return `${one(c.kelly.win || '-', c.kellyRisk?.win)} / ${one(c.kelly.draw || '-', c.kellyRisk?.draw)} / ${one(c.kelly.loss || '-', c.kellyRisk?.loss)}`;
      };
      const fmtProb = c => c.currentProbabilities ? `${c.currentProbabilities.win || '-'} / ${c.currentProbabilities.draw || '-'} / ${c.currentProbabilities.loss || '-'}` : '-';
      sections.push(`| 公司 | 初主胜 | 初平 | 初客胜 | 即主胜 | 即平 | 即客胜 | 返还率 | 概率(主/平/客) | 凯利(主/平/客) | 变化时间 |`);
      sections.push(`|------|--------|------|--------|--------|------|--------|--------|----------------|----------------|----------|`);
      winDrawWin.companies.forEach(c => {
        const changed = c.initialWin && (
          c.initialWin !== c.currentWin || c.initialDraw !== c.currentDraw || c.initialLoss !== c.currentLoss
        );
        const time = c.changeTime ? `${c.changeTime}${c.recent30 ? ' 🔴近30分钟' : ''}` : '-';
        sections.push(`| ${c.name} | ${c.initialWin || '-'} | ${c.initialDraw || '-'} | ${c.initialLoss || '-'} | **${c.currentWin || '-'}**${changed ? ' ⚠️' : ''} | **${c.currentDraw || '-'}** | **${c.currentLoss || '-'}** | ${c.currentReturnRate || c.returnRate || '-'} | ${fmtProb(c)} | ${fmtKelly(c)} | ${time} |`);
      });
    } else {
      sections.push('*胜平负盘口数据获取失败*');
      if (winDrawWin?.error) sections.push(`- 错误: ${winDrawWin.error}`);
    }
    sections.push('');

    // ========== 欧转亚比较（欧赔隐含盘口 vs 实际亚盘）==========
    if (analysis?.comparativeOdds?.length > 0) {
      sections.push(`## 十、即时走势比较（欧赔 + 欧转亚盘 + 实际亚盘 + 大小球）`);
      sections.push(`> 欧转亚盘=欧赔隐含的亚盘水位；若欧转亚与实际亚盘差距大，说明欧亚背离，是庄家信号`);
      sections.push(`| 公司 | 类型 | 欧主 | 欧平 | 欧客 | 欧转亚主 | 欧转亚盘 | 欧转亚客 | 实际主 | 实际盘 | 实际客 | 大球水 | 线 | 小球水 |`);
      sections.push(`|------|------|------|------|------|---------|---------|---------|------|------|------|------|---|------|`);
      analysis.comparativeOdds.forEach(co => {
        if (co.initial) {
          const i = co.initial;
          sections.push(`| ${co.name} | 初 | ${i.euroWin} | ${i.euroDraw} | ${i.euroLoss} | ${i.impliedHome} | ${i.impliedLine} | ${i.impliedAway} | ${i.actualHome} | ${i.actualLine} | ${i.actualAway} | ${i.ouOver} | ${i.ouLine} | ${i.ouUnder} |`);
        }
        if (co.current) {
          const c = co.current;
          sections.push(`| ${co.name} | 即时 | **${c.euroWin}** | **${c.euroDraw}** | **${c.euroLoss}** | ${c.impliedHome} | ${c.impliedLine} | ${c.impliedAway} | **${c.actualHome}** | **${c.actualLine}** | **${c.actualAway}** | ${c.ouOver} | ${c.ouLine} | ${c.ouUnder} |`);
        }
      });
      sections.push('');
    }

    // ========== 亚让盘口 ==========
    sections.push(`## 十一、亚让盘口`);
    if (asian && !asian.error) {
      const sum = asian.summary || {};
      sections.push(`**盘口动向**: 升盘 ${sum.up||0} 家 / 降盘 ${sum.down||0} 家 | 高水 ${sum.highWater||0} 家 / 低水 ${sum.lowWater||0} 家`);
      if (sum.mainLine) sections.push(`**主流盘口共识**: ${sum.mainLine}`);
      sections.push('');

      // 各公司完整盘口
      if (asian.companies?.length > 0) {
        sections.push(`> 水位说明：主水低（<0.9）= 主队被看好；客水低 = 客队被看好；水位差越大倾向越明显`);
        sections.push(`| 公司 | 初主水 | 初盘口 | 初客水 | 即主水 | 即盘口 | 即客水 |`);
        sections.push(`|------|--------|--------|--------|--------|--------|--------|`);
        asian.companies.forEach(c => {
          const ml = c.mainLine || c;
          const initChanged = ml.initialHandicap !== ml.currentHandicap;
          sections.push(`| ${c.name} | ${ml.initialHome} | ${ml.initialHandicap} | ${ml.initialAway} | ${ml.currentHome} | **${ml.currentHandicap}**${initChanged ? ' ⚠️' : ''} | ${ml.currentAway} |`);
          // 子盘线
          if (c.subLines?.length > 0) {
            c.subLines.forEach(sub => {
              sections.push(`| └${sub.label} | ${sub.initialHome} | ${sub.initialHandicap} | ${sub.initialAway} | ${sub.currentHome} | ${sub.currentHandicap} | ${sub.currentAway} |`);
            });
          }
        });
      }

      // 历史变化记录
      if (asian.history?.length > 0) {
        sections.push('');
        sections.push(`**盘口变化记录** (最近 ${Math.min(20, asian.history.length)} 条，主水低=主队被看好)`);
        sections.push(`| 时间 | 公司 | 盘口 | 主水 | 客水 |`);
        sections.push(`|------|------|------|------|------|`);
        asian.history.slice(0, 20).forEach(h => {
          sections.push(`| ${h.time} | ${h.company||'-'} | ${h.line} | ${h.v1} | ${h.v2} |`);
        });
      }
    } else {
      sections.push('*亚让盘数据获取失败*');
    }
    sections.push('');

    // ========== 大小球 ==========
    sections.push(`## 十二、大小球（进球数）`);
    if (overunder && !overunder.error) {
      const sum = overunder.summary || {};
      sections.push(`**盘口动向**: 升盘 ${sum.up||0} 家 / 降盘 ${sum.down||0} 家`);
      if (sum.mainLine) sections.push(`**主流进球线共识**: ${sum.mainLine}`);
      if (sum.lineConsensus) {
        const consensusStr = Object.entries(sum.lineConsensus).sort((a,b) => b[1]-a[1])
          .map(([k,v]) => `${k}(${v}家)`).join(' / ');
        sections.push(`**各档进球线分布**: ${consensusStr}`);
      }
      sections.push('');

      if (overunder.companies?.length > 0) {
        sections.push(`| 公司 | 初盘大 | 初盘线 | 初盘小 | 即时大 | 即时线 | 即时小 |`);
        sections.push(`|------|--------|--------|--------|--------|--------|--------|`);
        overunder.companies.forEach(c => {
          const ml = c.mainLine || c;
          const lineChanged = ml.initialLine !== ml.currentLine;
          sections.push(`| ${c.name} | ${ml.initialOver} | ${ml.initialLine} | ${ml.initialUnder} | ${ml.currentOver} | **${ml.currentLine}**${lineChanged ? ' ⚠️' : ''} | ${ml.currentUnder} |`);
          if (c.subLines?.length > 0) {
            c.subLines.forEach(sub => {
              sections.push(`| └${sub.label} | ${sub.initialOver} | ${sub.initialLine} | ${sub.initialUnder} | ${sub.currentOver} | ${sub.currentLine} | ${sub.currentUnder} |`);
            });
          }
        });
      }

      // 历史变化记录
      if (overunder.history?.length > 0) {
        sections.push('');
        sections.push(`**进球线变化记录** (最近 ${Math.min(20, overunder.history.length)} 条，大水低=大球被看好)`);
        sections.push(`| 时间 | 公司 | 盘口 | 大水 | 小水 |`);
        sections.push(`|------|------|------|------|------|`);
        overunder.history.slice(0, 20).forEach(h => {
          sections.push(`| ${h.time} | ${h.company||'-'} | ${h.line} | ${h.v1} | ${h.v2} |`);
        });
      }
    } else {
      sections.push('*大小球数据获取失败*');
    }
    sections.push('');

    // ========== 角球 ==========
    sections.push(`## 十三、角球盘口`);
    if (corner && !corner.error && corner.companies?.length > 0) {
      sections.push(`| 公司 | 初盘大 | 角球线 | 初盘小 | 即时大 | 即时线 | 即时小 |`);
      sections.push(`|------|--------|--------|--------|--------|--------|--------|`);
      corner.companies.forEach(c => {
        const lineChanged = c.initialLine !== c.currentLine;
        sections.push(`| ${c.name} | ${c.initialOver} | ${c.initialLine} | ${c.initialUnder} | ${c.currentOver} | **${c.currentLine}**${lineChanged ? ' ⚠️' : ''} | ${c.currentUnder} |`);
      });
    } else if (corner?.mainLine) {
      sections.push(`**主流角球线**: ${corner.mainLine} | 大球水: ${corner.mainOver} | 小球水: ${corner.mainUnder}`);
    } else {
      sections.push('*角球数据获取失败*');
    }
    sections.push('');

    // ========== 对赛往绩 ==========
    const fmtMatchRows = (rows) => rows.map(r =>
      `| ${r.type} | ${r.date} | ${r.home} | ${r.score}(${r.halfScore}) | ${r.corners||'-'} | ${r.away} | ${r.result} | ${r.handicapResult} | ${r.ouResult} |`
    ).join('\n');
    if (analysis?.headToHead?.length > 0) {
      sections.push(`## 十四、对赛往绩（近${analysis.headToHead.length}场）`);
      sections.push(`| 类型 | 日期 | 主场 | 比分(半) | 角球 | 客场 | 胜负 | 让球 | 大小 |`);
      sections.push(`|------|------|------|---------|------|------|------|------|------|`);
      sections.push(fmtMatchRows(analysis.headToHead));
      sections.push('');
    }
    if (analysis?.homeRecentMatches?.length > 0) {
      sections.push(`## 十五、${home}近期战绩（近${analysis.homeRecentMatches.length}场）`);
      sections.push(`| 类型 | 日期 | 主场 | 比分(半) | 角球 | 客场 | 胜负 | 让球 | 大小 |`);
      sections.push(`|------|------|------|---------|------|------|------|------|------|`);
      sections.push(fmtMatchRows(analysis.homeRecentMatches));
      sections.push('');
    }
    if (analysis?.awayRecentMatches?.length > 0) {
      sections.push(`## 十六、${away}近期战绩（近${analysis.awayRecentMatches.length}场）`);
      sections.push(`| 类型 | 日期 | 主场 | 比分(半) | 角球 | 客场 | 胜负 | 让球 | 大小 |`);
      sections.push(`|------|------|------|---------|------|------|------|------|------|`);
      sections.push(fmtMatchRows(analysis.awayRecentMatches));
      sections.push('');
    }

    // ========== 知识库字段归一与规则引擎 ==========
    if (normalized || knowledge) {
      sections.push(`## 十七、知识库字段归一与规则引擎`);
      if (normalized?.derived?.dataCompleteness) {
        const dc = normalized.derived.dataCompleteness;
        sections.push(`**核心完整度**: ${dc.coreScore ?? dc.score}%（${dc.level}） | **增强完整度**: ${dc.enhancementScore ?? '-'}% | **全量字段**: ${dc.overallScore ?? dc.score}%（${dc.overallLevel || dc.level}）`);
        if (dc.summary) sections.push(`- 完整度结论: ${dc.summary}`);
        if (dc.coreMissing?.length) sections.push(`- ⛔ 核心缺失: ${dc.coreMissing.join('、')}（必须补采，否则禁止输出预测方向）`);
        if (dc.enhancementMissing?.length) sections.push(`- ⚠️ 增强缺失: ${dc.enhancementMissing.join('、')}（影响置信和基本面修正，不应伪造为100%）`);
        if (dc.repairActions?.length) {
          sections.push(`- 补全路径:`);
          dc.repairActions.slice(0, 8).forEach(action => sections.push(`  - ${action}`));
        }
        if (Number(dc.score || 0) < 67) sections.push(`- 完整度影响: 核心盘口/统计缺失较多，本场结论需降低置信并等待补采。`);
      }
      if (normalized?.derived?.dataQuality) {
        const dq = normalized.derived.dataQuality;
        sections.push(`**数据可信度**: ${dq.score}%（${dq.level}） | 预测门禁=${dq.action || '-'}`);
        if (dq.hardBlocks?.length) sections.push(`- ⛔ 预测阻断: ${dq.hardBlocks.join('；')}`);
        if (dq.issues?.length) sections.push(`- 数据质量提示: ${dq.issues.join('；')}`);
      }
      if (normalized) {
        sections.push(`- 归一化即时均赔: ${normalized.odds?.averageCurrent ? `${normalized.odds.averageCurrent.win}/${normalized.odds.averageCurrent.draw}/${normalized.odds.averageCurrent.loss}` : '-'}`);
        sections.push(`- 归一化亚盘: ${normalized.asian?.currentLine || normalized.asian?.mainLine || '-'} | 主水 ${normalized.asian?.currentHomeWater ?? '-'} | 客水 ${normalized.asian?.currentAwayWater ?? '-'}`);
        sections.push(`- 归一化大小球: ${normalized.overunder?.currentLine ?? normalized.overunder?.mainLine ?? '-'} | 大水 ${normalized.overunder?.currentOverWater ?? '-'} | 小水 ${normalized.overunder?.currentUnderWater ?? '-'}`);
        sections.push(`- 人气侧代理: ${normalized.derived?.popularitySide || '-'}`);
      }
      if (knowledge?.summary) {
        const ks = knowledge.summary;
        sections.push(`**规则摘要**: 主方向 ${ks.mainDirection} | 次方向 ${ks.secondaryDirection || '-'} | 建议 ${ks.recommendationLevel} | 风险 ${ks.riskLevel} | 置信 ${ks.confidence}%`);
        const wp = ks.weightPolicy || { marketCore: 80, auxiliary: 20, label: '知识库规则 + 欧赔核心/庄家盘口 = 80%；战绩、伤停、量化与其它信息 = 20%修正' };
        sections.push(`- 权重策略: ${wp.label || `庄家盘口/欧赔核心 ${wp.marketCore || 80}% + 其它修正 ${wp.auxiliary || 20}%`}`);
        sections.push(`- 读盘核心: 先以欧赔去水、欧亚转换、亚盘水位和大小球联动读懂庄家意图，再用战绩/伤停/量化做20%修正。`);
        if (ks.shouldWarnOnly) sections.push(`- 高风险约束: 本场只输出风险提示、降级理由和仓位提醒，不替用户自动放弃或剔除。`);
        if (ks.confidenceBreakdown) {
          const cb = ks.confidenceBreakdown;
          sections.push(`- 置信拆解: base=${cb.base ?? '-'} + knowledge=${cb.knowledgeDelta ?? 0} - risk=${cb.riskPenalty ?? 0} - conflict=${cb.conflictPenalty ?? 0} - completeness=${cb.completenessPenalty ?? 0}；cap=${cb.cap ?? '-'}；final=${cb.final ?? ks.confidence}`);
        }
        if (ks.triggeredRuleIds?.length) sections.push(`- 命中规则ID: ${ks.triggeredRuleIds.slice(0, 12).join('、')}`);
        if (ks.missingFields?.length) sections.push(`- 缺失/弱字段: ${ks.missingFields.slice(0, 10).join('、')}`);
        if (ks.topCandidateLabel) sections.push(`- 当前首选候选: ${ks.topCandidateLabel}`);
        if (ks.whyNotTop2?.length) sections.push(`- 非首选/降级理由: ${ks.whyNotTop2.slice(0, 4).join('；')}`);
        if (ks.unanalysableFlags?.length) sections.push(`- 弱分析标记: ${ks.unanalysableFlags.slice(0, 4).join('；')}`);
      }
      if (knowledge?.candidates?.length) {
        const finalMd = finalCandidatesToMarkdown(
          arbitrateCandidates(knowledge, { professionalMarket }),
          '**最终候选仲裁排序（AI优先使用，不要机械引用原始候选）**'
        );
        if (finalMd) sections.push(finalMd);
        sections.push(`**原始规则候选（供复核，不等同最终推荐）**`);
        knowledge.candidates.slice(0, 6).forEach((c, i) => {
          const evidence = (c.evidence || []).filter(Boolean).slice(0, 2).join('；');
          const risk = (c.risk || []).filter(Boolean).slice(0, 2).join('；');
          sections.push(`${i + 1}. ${c.market}: ${c.label || c.direction}（score=${c.score || 0}，规则=${(c.ruleIds || []).join('+') || '-'}${c.riskPenalty ? `，riskPenalty=${c.riskPenalty}` : ''}）`);
          if (evidence) sections.push(`   - 证据: ${evidence}`);
          if (risk) sections.push(`   - 风险: ${risk}`);
        });
      }
      if (knowledge?.hits?.length) {
        sections.push(`**主要命中规则**`);
        knowledge.hits.slice(0, 10).forEach(h => {
          const parts = [`${h.ruleId}: ${h.direction} / ${h.strength}`];
          if (h.confidenceDelta) parts.push(`delta=${h.confidenceDelta}`);
          if (h.scoreWeight) parts.push(`weight=${h.scoreWeight}`);
          if (h.evidence?.length) parts.push(`证据: ${(h.evidence || []).filter(Boolean).slice(0, 2).join('；')}`);
          if (h.risk?.length) parts.push(`风险: ${(h.risk || []).filter(Boolean).slice(0, 2).join('；')}`);
          sections.push(`- ${parts.join('；')}`);
        });
      }
      if (knowledge?.conflicts?.length) {
        sections.push(`**规则冲突**`);
        knowledge.conflicts.slice(0, 6).forEach(c => sections.push(`- [${c.level || 'medium'}] ${(c.ruleIds || []).join('+') || c.code || 'conflict'}：${c.msg || c.note || ''}`));
      }
      if (knowledge?.blockedBy?.length) {
        sections.push(`**风险/降级项**`);
        knowledge.blockedBy.slice(0, 8).forEach(r => sections.push(`- [${r.level}] ${r.msg || r.code}`));
      }
      sections.push('');
    }

    // ========== 盘口裁决契约 ==========
    if (marketVerdict) {
      const mv = marketVerdict;
      const summary = mv.summary || {};
      const intent = mv.bookmakerIntent || {};
      const plan = mv.executionPlan || {};
      const euro = mv.euroCore || {};
      const draw = mv.drawCore || {};
      const cross = mv.crossMarket || {};
      const resonance = mv.marketResonance || knowledge?.resonance || ruleDecision?.marketResonance || null;
      const resonanceTop = resonance?.topRule || null;
      sections.push(`## 十八、盘口裁决单（MARKET_VERDICT_JSON · AI必须优先复核）`);
      const verdictSource = knowledge?._source === 'cloud' || marketCommand?._source === 'cloud' ? '云端规则资产 + 欧赔核心 + 庄家盘口裁决' : '本地兜底规则资产 + 欧赔核心 + 庄家盘口裁决';
      sections.push(`> 本节由${verdictSource}生成，作为 AI 预测的 80% 主资产；其中 R01-R14 盘赔共振/背离/水位过程规则为盘口经验模块最高优先级。战绩、伤停、量化、联网情报只能作为 20% 修正，除非出现重大反证。`);
      sections.push(`- 裁决结论: ${mv.headline || summary.headline || '-'}`);
      sections.push(`- 庄家意图: ${intent.label || '-'}｜${intent.primaryIntent || '-'}`);
      sections.push(`- 欧赔核心: 初赔 ${euro.initialOdds || '-'} → 即时 ${euro.currentOdds || '-'}｜低赔侧 ${euro.favoriteSide || '-'}｜骨架 ${euro.skeleton || '-'}｜去水概率 ${euro.noVigProbability ? `${euro.noVigProbability.win}%/${euro.noVigProbability.draw}%/${euro.noVigProbability.loss}%` : '-'}`);
      sections.push(`- 平赔角色: ${draw.label || draw.role || '-'}｜风险 ${draw.riskLevel || '-'}`);
      sections.push(`- 跨盘验证: 亚盘 ${cross.asian?.line || mv.line || '-'}（${cross.asian?.supportLevel || '-'}）｜大小球 ${cross.overunder?.line || mv.overunderLine || '-'}（${cross.overunder?.goalShape || '-'}）｜一致性 ${cross.consistencyScore ?? '-'}`);
      sections.push(`- 执行计划: 最优玩法=${plan.bestMarket || '-'}｜次选=${plan.secondaryMarket || '-'}｜回避=${(plan.avoidMarkets || []).join('、') || '-'}｜仓位=${plan.stake || summary.stake || '-'}`);
      if (resonanceTop) {
        sections.push(`- 盘赔共振R01-R14: ${resonanceTop.ruleId}｜${resonanceTop.conclusion || resonanceTop.label || '-'}｜${resonanceTop.stars || '-'}星`);
        if (resonanceTop.plain) sections.push(`- 白话读盘: ${resonanceTop.plain}`);
        if (resonanceTop.evidence?.length) sections.push(`- 共振证据: ${resonanceTop.evidence.slice(0, 4).join('；')}`);
      }
      if (mv.counterEvidence?.length) sections.push(`- 最大反证: ${mv.counterEvidence.slice(0, 5).map(x => `[${x.severity}]${x.msg}`).join('；')}`);
      if (plan.liveChecklist?.length) sections.push(`- 临场复核: ${plan.liveChecklist.join('；')}`);
      sections.push('');
      sections.push('```MARKET_VERDICT_JSON');
      sections.push(marketVerdictJson);
      sections.push('```');
      sections.push('');
    }

    // ========== 盘口总控命令 ==========
    if (marketCommand) {
      sections.push(marketCommandToMarkdown(marketCommand));
      sections.push('');
    } else if (invalidMarketCommandSource) {
      sections.push('## 盘口总控 v4（MARKET_COMMAND_JSON）');
      sections.push(`> ⚠️ 云端盘口总控缺失：检测到 ${invalidMarketCommandSource} 本地存根/兜底结果，已从AI报告中剔除，不输出 MARKET_COMMAND_JSON。`);
      sections.push('> AI纪律：不得把本地存根写成“存在”，不得采信其观望/执行命令；必须说明云端计算未成功并降低置信度。');
      sections.push('');
    }

    // ========== 专业盘口增强层 ==========
    if (professionalMarket) {
      sections.push(professionalMarketToMarkdown(professionalMarket));
      sections.push('');
    }

    // ========== 系统预测主推摘要（供AI终局裁决对比） ==========
    if (localPrediction) {
      const topRec = (localPrediction.recommendations || [])[0];
      const mainDir = localPrediction.summary?.mainDirection || localPrediction.mainDirection || knowledge?.summary?.mainDirection || '';
      const recText = topRec ? `${topRec.market || ''} ${topRec.label || topRec.direction || ''} (信心${topRec.confidence || '-'}%)` : '';
      const systemSourceLabel = marketCommand?._source === 'cloud' || knowledge?._source === 'cloud' ? '云端规则增强系统' : '本地兜底系统';
      sections.push(`## ${systemSourceLabel}综合裁决（AI必须与此对比后输出终局裁决）`);
      sections.push(`- **系统主方向**: ${mainDir || '-'}`);
      if (recText) sections.push(`- **系统首推**: ${recText}`);
      const topRecs = (localPrediction.recommendations || []).slice(0, 3);
      if (topRecs.length > 1) {
        topRecs.slice(1).forEach(r => sections.push(`- 次选: ${r.market || ''} ${r.label || r.direction || ''} (信心${r.confidence || '-'}%)`));
      }
      sections.push(`> AI终局裁决必须明确说明：与系统裁决一致还是不一致；若不一致，必须归入核心伤停/首发重大轮换/战意结构反转/临场盘口反向/数据采集错误五类之一。`);
      sections.push('');
    }

    // ========== AI 分析请求 ==========
    sections.push('---');
    sections.push(`## 📊 AI 分析请求`);
    sections.push(`请你作为专业足球数据分析师，基于以上完整数据对"**${home} vs ${away}**"进行深度分析：`);
    sections.push('');
    sections.push('**【动态权重要求（禁止固定80/20）】：三盘完全共振时盘口权重=85%；无明显矛盾时=80%；欧亚背离≥0.25球时=70%；本地存根/云端缺失时=55%；盘口异常时=40%仅观望。辅助修正层：战意分差≥2时=25%，否则=20%。分析必须先声明采用哪档权重及理由，再输出结论。只有云端 _source=cloud 的 MARKET_COMMAND_JSON 盘口总控才是最高优先级；MARKET_VERDICT_JSON 盘口裁决和 R01-R14 盘赔共振/背离/水位过程规则为底层证据链；PRO_MARKET_JSON 只用于价值差、CLV、欧亚背离、大小球/平赔联动复核，不能覆盖云端盘口总控；战绩、伤停、量化模型、情报只做修正层。若上方提示本地存根/兜底结果，必须视为云端盘口总控缺失，不得写 MARKET_COMMAND_JSON 存在，不得采信本地存根的观望或执行命令。若上方存在云端 MARKET_COMMAND_JSON，必须先复核盘口剧本、反证审判、执行命令与临场复核点，再结合 PRO_MARKET_JSON 判断价值与CLV准备度，最后判断五类重大反证是否足以推翻。**');
    sections.push('**【人类盘口分析师仲裁要求】**：最终推荐前必须拆成“胜平负方向 / 亚让穿盘 / 大小球 / 价值仓位”四层。强队胜出不等于深让穿盘；规则命中数不等于可下注价值。若当前让幅≥1.25且出现小球低水/低比分风险/量化与市场概率大幅冲突/riskScore≥65/伤停交锋数据缺失，亚让穿盘必须至少降一级；若 PRO_MARKET_JSON.humanArbitration.handicapCoverStatus=downgraded 或 blocked，禁止把深让盘写成主推。盘口输出必须做一致性检查：半球=±0.5，球半=±1.5，禁止“-0.5（球半）”。**');
    sections.push('**【大小球综合仲裁要求】**：大小球不能只看盘口低水/防平。必须复核 PRO_MARKET_JSON.goalReality 与原始近期进失球、大球率、模型总进球；若 goalReality.blocksBlindUnder=true，或双方近期总进球常见3-4球/均值≥3.0/大球率≥58%/模型总进球≥2.85，禁止仅凭“小球低水、低比分风险、防平保护”推荐小球。若仍要给小球，必须写出至少两类反向强证据（退盘、小球连续降水、首发保守、天气恶劣、战意不足等），否则只能写待临场确认/观望。**');
    sections.push('');
    sections.push('**请分析以下7个维度并给出明确推荐：**');
    sections.push('');
    sections.push('1. **胜平负/欧赔（最高优先级）** - 分析主胜、平局、客胜赔率变化、平均隐含概率、欧赔核心思路与市场倾向，给出胜平负方向及信心度');
    sections.push('2. **亚让盘（最高优先级）** - 分析欧亚转换、盘口深浅、水位流向、升降盘趋势和庄家意图，给出推荐方向及信心度');
    sections.push('3. **大小球** - 结合进球线变化、双方进球率、近期走势、PRO_MARKET_JSON.goalReality 进球现实层，推荐大/小球；历史高进球与小球低水冲突时必须解释或观望');
    sections.push('4. **角球** - 分析角球盘口是否合理，推荐大/小角球');
    sections.push('5. **赛前简报解读** - 结合阵容情况（缺阵人数、位置）分析战力影响');
    sections.push('6. **盘路走势解读** - 分析赢盘率、相同盘口历史数据的参考价值');
    sections.push('7. **综合推荐** - 给出最终推荐方案（含具体盘口、方向、信心度0-100%）；若已加载球队画像库，只能作为20%辅助修正说明，PRO_MARKET_JSON 只能作为价值/CLV/联动复核，二者都不能覆盖云端盘口总控');
    sections.push('');
    sections.push('**输出格式要求**: 结构清晰，每个维度一段，最后必须给出"盘口总控v4复核"、"专业盘口增强层复核"、"人工盘口分析师仲裁"、"盘口裁决复核"、"R01-R14盘赔共振复盘"和"最佳推荐"汇总表格；盘口总控v4复核必须明确写“云端存在/云端不存在/本地存根无效”，只有云端 _source=cloud 才能写存在；PRO_MARKET_JSON 复核必须说明 edge/risk/CLV 准备度与 humanArbitration 是否支持降仓或加固，但不得单独推翻云端总控；若推翻 MARKET_COMMAND_JSON、MARKET_VERDICT_JSON 或 marketResonance，必须写明推翻证据属于重大伤停/首发轮换/战意反转/临场盘口反向/数据错误中的哪一类；若只是从“强队穿盘”降级到“强队胜/低仓/观望”，必须说明这是玩法层降级。');

    const markdown = sections.join('\n');
    const plainText = markdown.replace(/[#*|`_>]/g, '').replace(/\n{3,}/g, '\n\n');

    const betAdvice = this._buildBetAdvice({
      home, away, normalized,
      proMarket: professionalMarket,
      riskProfile: extras.riskProfile,
      marketCommand,
      marketVerdict,
    });
    const beginnerSummary = this._buildBeginnerSummary({
      home, away, matchId, fetchTime,
      betAdvice, normalized,
      riskProfile: extras.riskProfile,
      proMarket: professionalMarket,
    });

    return {
      text: plainText,
      markdown,
      structured: {
        matchInfo: analysis?.matchInfo,
        home, away,
        winDrawWin: winDrawWin?.keyOdds,
        asian: asian?.keyOdds,
        overunder: overunder?.keyOdds,
        corner: { mainLine: corner?.mainLine, companies: corner?.companies?.slice(0,3) },
        recentStats: analysis?.recentStats,
        richStats: {
          recentGoalDistribution: analysis?.recentGoalDistribution,
          halfFull: analysis?.halfFull,
          goalSingleDouble: analysis?.goalSingleDouble,
          goalTimeDistribution: analysis?.goalTimeDistribution,
          seasonComparison: analysis?.seasonComparison
        },
        injuries: analysis?.injuries,
        preBriefing: analysis?.preBriefing,
        summary: this._quickSummary(analysis, winDrawWin, asian, overunder),
        normalized,
        knowledge,
        marketVerdict,
        marketCoreDecision: marketVerdict,
        marketCommand,
        marketCommandJson,
        professionalMarket,
        professionalMarketJson,
        ruleDecision,
        localPrediction,
        teamProfiles,
        teamProfileMarkdown,
        betAdvice,
        beginnerSummary,
      }
    };
  }

  /**
   * generateCompact — 精简报告模式
   * 专为提交给AI设计：去掉逐家赔率明细表、进球时间分布、半全场分布、
   * 进球大小单双详细表、球员评分走势等冗余原始数据，
   * 保留关键均值/摘要/盘口共识/亚盘大小球变化趋势/阵容/往绩/规则引擎结论/盘口裁决/总控/增强层全量能力。
   * 调用方（background.js）可以根据 AI token 预算选择使用哪种模式。
   */
  generateCompact(stored, extras = {}) {
    const { matchId, fetchTime, data } = stored;
    if (!data) return { text: '无数据', markdown: '# 无数据', structured: {} };

    const { analysis, winDrawWin, asian, overunder, corner } = data;
    const home = analysis?.matchInfo?.home || '主队';
    const away = analysis?.matchInfo?.away || '客队';
    const matchTime = analysis?.matchInfo?.time || '';
    const normalized = extras.normalized || null;
    const knowledge = extras.knowledge || null;
    const marketVerdict = extras.marketVerdict || extras.marketCoreDecision || extras.ruleDecision?.marketVerdict || null;
    const ruleDecision = extras.ruleDecision || null;
    const localPrediction = extras.localPrediction || null;
    const rawMarketCommand = extras.marketCommand || localPrediction?.marketCommand || ruleDecision?.marketCommand || knowledge?.summary?.marketCommand || null;
    const invalidMarketCommandSource = rawMarketCommand && rawMarketCommand.version === 'market-command-v4' && rawMarketCommand._source !== 'cloud'
      ? (rawMarketCommand._source || 'unknown') : '';
    const marketCommand = rawMarketCommand && rawMarketCommand.version === 'market-command-v4' && rawMarketCommand._source === 'cloud'
      ? rawMarketCommand : null;
    const marketVerdictJson = marketVerdict ? JSON.stringify(marketVerdict, null, 2) : '';
    const professionalMarket = extras.professionalMarket || localPrediction?.professionalMarket || marketCommand?.professionalMarket || null;
    const teamProfileMarkdown = extras.teamProfileMarkdown || localPrediction?.teamProfileMarkdown || data?.teamProfileMarkdown || '';

    const s = [];

    s.push(`# ⚽ 足球分析报告（精简版）`);
    s.push(`> ${home} vs ${away} | ID: ${matchId} | ${new Date(fetchTime).toLocaleString('zh-CN')}`);
    s.push('');

    // --- 比赛信息 ---
    const mi = analysis?.matchInfo || {};
    const infoItems = [
      mi.league && `赛事: ${mi.league}`,
      matchTime && `时间: ${matchTime}`,
      mi.venue && `场地: ${mi.venue}`,
      mi.weather && `天气: ${mi.weather} ${mi.temperature || ''}`,
    ].filter(Boolean);
    if (infoItems.length) s.push(infoItems.join(' | '));
    s.push('');

    // --- 球队画像（仅摘要）---
    if (teamProfileMarkdown) {
      s.push(`## 🧬 球队画像摘要（20%辅助修正）`);
      // 只取画像中的前8行关键内容
      const profileLines = teamProfileMarkdown.split('\n').slice(0, 8).join('\n');
      s.push(profileLines);
      s.push('> 画像只作20%辅助修正，不能覆盖盘口总控。');
      s.push('');
    }

    // --- 赛前简报 ---
    if (analysis?.preBriefing) {
      s.push(`## 赛前简报`);
      s.push(`> ${analysis.preBriefing.replace(/\n/g, '\n> ')}`);
      s.push('');
    }

    // --- 阵容缺阵 ---
    const hi = analysis?.injuries?.home || [];
    const ai = analysis?.injuries?.away || [];
    if (hi.length > 0 || ai.length > 0) {
      s.push(`## 阵容缺阵`);
      if (hi.length) s.push(`- ${home} 缺阵: ${hi.map(p => `${p.name}(${p.reason})`).join('、')}`);
      if (ai.length) s.push(`- ${away} 缺阵: ${ai.map(p => `${p.name}(${p.reason})`).join('、')}`);
      s.push('');
    }

    // --- 联赛战绩摘要（只输出近6场赢盘率等关键数字，不展开战绩表）---
    const hStats = analysis?.homeStats;
    const aStats = analysis?.awayStats;
    if (hStats || aStats) {
      s.push(`## 战绩摘要`);
      const fmtStats = (team, st) => {
        if (!st) return;
        const parts = [];
        if (st.total?.played) parts.push(`总${st.total.played}场:${st.total.won}胜${st.total.drawn}平${st.total.lost}负`);
        if (st.home?.played) parts.push(`主${st.home.played}场:${st.home.won}胜${st.home.drawn}平${st.home.lost}负`);
        if (st.away?.played) parts.push(`客${st.away.played}场:${st.away.won}胜${st.away.drawn}平${st.away.lost}负`);
        if (parts.length) s.push(`- ${team}: ${parts.join(' / ')}`);
      };
      fmtStats(home, hStats);
      fmtStats(away, aStats);
      // 近6场场均进失球
      const hg = analysis?.seasonComparison?.home?.goals;
      const ag = analysis?.seasonComparison?.away?.goals;
      if (hg?.total || ag?.total) {
        s.push(`- 场均进/失球: ${home} ${hg?.total?.avgGoal||'-'}/${hg?.total?.avgLoss||'-'}，${away} ${ag?.total?.avgGoal||'-'}/${ag?.total?.avgLoss||'-'}`);
        if (hg?.venue || ag?.venue) {
          s.push(`- 主客场进/失球: ${home}主场 ${hg?.venue?.avgGoal||'-'}/${hg?.venue?.avgLoss||'-'}，${away}客场 ${ag?.venue?.avgGoal||'-'}/${ag?.venue?.avgLoss||'-'}`);
        }
      }
      s.push('');
    }

    // --- 盘路走势（摘要）---
    const ht = analysis?.handicapTrend || {};
    if (ht.home || ht.away) {
      s.push(`## 盘路走势摘要`);
      const fmtTrend = (team, trend) => {
        if (!trend) return;
        const parts = [];
        if (trend.winRates?.length) parts.push(`赢盘率(全/主或客/近6): ${trend.winRates.join('/')}`);
        if (trend.last6Asian) parts.push(`近6亚让: ${trend.last6Asian}`);
        if (trend.last6OU) parts.push(`近6大小球: ${trend.last6OU}`);
        if (parts.length) s.push(`- ${team}: ${parts.join(' | ')}`);
      };
      fmtTrend(home, ht.home);
      fmtTrend(away, ht.away);
      s.push('');
    }

    // --- 相同盘口历史（仅关键）---
    if (analysis?.sameHandicapHistory?.length > 0) {
      s.push(`## 相同盘口历史`);
      analysis.sameHandicapHistory.slice(0, 3).forEach(block => {
        if (!block.handicap) return;
        const total = block.total ? `赢${block.total.win}走${block.total.draw}输${block.total.loss} 赢盘率${block.total.rate}` : '';
        const last6 = block.last6 ? `近6: ${block.last6}` : '';
        s.push(`- 盘口${block.handicap}: ${[total, last6].filter(Boolean).join(' | ')}`);
      });
      s.push('');
    }

    // --- 对赛往绩（最近5场）---
    const fmtRow = r => `${r.date} ${r.home} ${r.score}(${r.halfScore}) ${r.away} | 让球:${r.handicapResult} 大小:${r.ouResult}`;
    if (analysis?.headToHead?.length > 0) {
      s.push(`## 对赛往绩（近${Math.min(5, analysis.headToHead.length)}场）`);
      analysis.headToHead.slice(0, 5).forEach(r => s.push(`- ${fmtRow(r)}`));
      s.push('');
    }
    if (analysis?.homeRecentMatches?.length > 0) {
      s.push(`## ${home}近期战绩（近${Math.min(5, analysis.homeRecentMatches.length)}场）`);
      analysis.homeRecentMatches.slice(0, 5).forEach(r => s.push(`- ${fmtRow(r)}`));
      s.push('');
    }
    if (analysis?.awayRecentMatches?.length > 0) {
      s.push(`## ${away}近期战绩（近${Math.min(5, analysis.awayRecentMatches.length)}场）`);
      analysis.awayRecentMatches.slice(0, 5).forEach(r => s.push(`- ${fmtRow(r)}`));
      s.push('');
    }

    // --- 欧赔摘要（关键均值，不展开逐家表）---
    s.push(`## 欧赔 / 胜平负`);
    if (winDrawWin && !winDrawWin.error) {
      const sum = winDrawWin.summary || {};
      if (sum.averageInitial) s.push(`- 初盘均值: 主${sum.averageInitial.win} 平${sum.averageInitial.draw} 客${sum.averageInitial.loss}`);
      if (sum.averageCurrent) s.push(`- 即时均值: 主**${sum.averageCurrent.win}** 平**${sum.averageCurrent.draw}** 客**${sum.averageCurrent.loss}** 返还率${sum.averageReturnRate||'-'}`);
      if (sum.impliedAverage) s.push(`- 去水概率: 主${sum.impliedAverage.win}% 平${sum.impliedAverage.draw}% 客${sum.impliedAverage.loss}%`);
      if (sum.movement) s.push(`- 变化方向: 主胜降${sum.movement.winDown||0}/升${sum.movement.winUp||0} 平降${sum.movement.drawDown||0}/升${sum.movement.drawUp||0} 客胜降${sum.movement.lossDown||0}/升${sum.movement.lossUp||0}`);
      // 仅输出前3家公司
      if (winDrawWin.companies?.length > 0) {
        s.push(`- 主要公司（前3）:`);
        winDrawWin.companies.slice(0, 3).forEach(c => {
          const changed = c.initialWin && (c.initialWin !== c.currentWin || c.initialDraw !== c.currentDraw || c.initialLoss !== c.currentLoss);
          s.push(`  - ${c.name}: 初${c.initialWin||'-'}/${c.initialDraw||'-'}/${c.initialLoss||'-'} → 即时**${c.currentWin||'-'}**/**${c.currentDraw||'-'}**/**${c.currentLoss||'-'}**${changed?' ⚠️':''}`);
        });
      }
    } else {
      s.push('- 欧赔数据获取失败');
    }
    s.push('');

    // --- 亚盘摘要（共识+变化趋势，不展开全部逐家）---
    s.push(`## 亚让盘`);
    if (asian && !asian.error) {
      const sum = asian.summary || {};
      s.push(`- 盘口动向: 升盘${sum.up||0}家 / 降盘${sum.down||0}家 | 高水${sum.highWater||0}家 / 低水${sum.lowWater||0}家`);
      if (sum.mainLine) s.push(`- 主流盘口共识: **${sum.mainLine}**`);
      // 仅前3家公司
      if (asian.companies?.length > 0) {
        s.push(`- 主要公司（前3）:`);
        asian.companies.slice(0, 3).forEach(c => {
          const ml = c.mainLine || c;
          const changed = ml.initialHandicap !== ml.currentHandicap;
          s.push(`  - ${c.name}: 初${ml.initialHome||'-'}/${ml.initialHandicap||'-'}/${ml.initialAway||'-'} → 即时${ml.currentHome||'-'}/**${ml.currentHandicap||'-'}**${changed?' ⚠️':''}/${ml.currentAway||'-'}`);
        });
      }
      // 变化记录仅最近8条
      if (asian.history?.length > 0) {
        s.push(`- 变化记录（最近8条）:`);
        asian.history.slice(0, 8).forEach(h => s.push(`  ${h.time} ${h.company||'-'} ${h.line} 主${h.v1} 客${h.v2}`));
      }
    } else {
      s.push('- 亚盘数据获取失败');
    }
    s.push('');

    // --- 大小球摘要 ---
    s.push(`## 大小球`);
    if (overunder && !overunder.error) {
      const sum = overunder.summary || {};
      s.push(`- 盘口动向: 升盘${sum.up||0}家 / 降盘${sum.down||0}家`);
      if (sum.mainLine) s.push(`- 主流进球线: **${sum.mainLine}**`);
      if (sum.lineConsensus) {
        const cs = Object.entries(sum.lineConsensus).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}(${v}家)`).join('/');
        s.push(`- 各档分布: ${cs}`);
      }
      if (overunder.companies?.length > 0) {
        s.push(`- 主要公司（前3）:`);
        overunder.companies.slice(0, 3).forEach(c => {
          const ml = c.mainLine || c;
          const changed = ml.initialLine !== ml.currentLine;
          s.push(`  - ${c.name}: 初大${ml.initialOver||'-'}/线${ml.initialLine||'-'}/小${ml.initialUnder||'-'} → 即时大${ml.currentOver||'-'}/线**${ml.currentLine||'-'}**${changed?' ⚠️':''}/小${ml.currentUnder||'-'}`);
        });
      }
      if (overunder.history?.length > 0) {
        s.push(`- 变化记录（最近8条）:`);
        overunder.history.slice(0, 8).forEach(h => s.push(`  ${h.time} ${h.company||'-'} ${h.line} 大${h.v1} 小${h.v2}`));
      }
    } else {
      s.push('- 大小球数据获取失败');
    }
    s.push('');

    // --- 角球摘要 ---
    if (corner && !corner.error) {
      const mainLine = corner.mainLine || corner.companies?.[0]?.currentLine;
      if (mainLine) {
        s.push(`## 角球`);
        s.push(`- 主流角球线: ${mainLine}`);
        s.push('');
      }
    }

    // --- 欧转亚比较（仅摘要）---
    if (analysis?.comparativeOdds?.length > 0) {
      s.push(`## 欧转亚比较（欧亚背离信号）`);
      analysis.comparativeOdds.slice(0, 2).forEach(co => {
        const curr = co.current;
        if (!curr) return;
        const gap = curr.impliedLine && curr.actualLine ? `欧转亚${curr.impliedLine} vs 实际${curr.actualLine}` : '';
        if (gap) s.push(`- ${co.name}: ${gap}${curr.impliedLine !== curr.actualLine ? ' ⚠️欧亚背离' : ''}`);
      });
      s.push('');
    }

    // --- 知识库规则引擎（全量保留，这是AI最重要的输入）---
    if (normalized || knowledge) {
      s.push(`## 知识库字段归一与规则引擎`);
      if (normalized?.derived?.dataCompleteness) {
        const dc = normalized.derived.dataCompleteness;
        s.push(`**核心完整度**: ${dc.coreScore ?? dc.score}%（${dc.level}）`);
        if (dc.coreMissing?.length) s.push(`- ⛔ 核心缺失: ${dc.coreMissing.join('、')}`);
        if (dc.enhancementMissing?.length) s.push(`- ⚠️ 增强缺失: ${dc.enhancementMissing.join('、')}`);
      }
      if (normalized?.derived?.dataQuality) {
        const dq = normalized.derived.dataQuality;
        s.push(`**数据可信度**: ${dq.score}%（${dq.level}）| 预测门禁=${dq.action||'-'}`);
        if (dq.hardBlocks?.length) s.push(`- ⛔ 预测阻断: ${dq.hardBlocks.join('；')}`);
      }
      if (normalized) {
        s.push(`- 归一化均赔: ${normalized.odds?.averageCurrent ? `${normalized.odds.averageCurrent.win}/${normalized.odds.averageCurrent.draw}/${normalized.odds.averageCurrent.loss}` : '-'}`);
        s.push(`- 归一化亚盘: ${normalized.asian?.currentLine||'-'} 主水${normalized.asian?.currentHomeWater??'-'} 客水${normalized.asian?.currentAwayWater??'-'}`);
        s.push(`- 归一化大小球: ${normalized.overunder?.currentLine??'-'} 大水${normalized.overunder?.currentOverWater??'-'} 小水${normalized.overunder?.currentUnderWater??'-'}`);
      }
      if (knowledge?.summary) {
        const ks = knowledge.summary;
        s.push(`**规则摘要**: 主方向${ks.mainDirection} | 次方向${ks.secondaryDirection||'-'} | 建议${ks.recommendationLevel} | 风险${ks.riskLevel} | 置信${ks.confidence}%`);
        if (ks.triggeredRuleIds?.length) s.push(`- 命中规则: ${ks.triggeredRuleIds.slice(0,12).join('、')}`);
        if (ks.topCandidateLabel) s.push(`- 首选候选: ${ks.topCandidateLabel}`);
      }
      if (knowledge?.candidates?.length) {
        const finalMd = finalCandidatesToMarkdown(
          arbitrateCandidates(knowledge, { professionalMarket }),
          '**最终候选仲裁排序（AI优先使用）**'
        );
        if (finalMd) s.push(finalMd);
        s.push(`**原始规则候选（供复核）**`);
        knowledge.candidates.slice(0, 4).forEach((c, i) => {
          s.push(`${i+1}. ${c.market}: ${c.label||c.direction}（score=${c.score||0}，规则=${(c.ruleIds||[]).join('+')||'-'}）`);
        });
      }
      if (knowledge?.hits?.length) {
        s.push(`**主要命中规则**`);
        knowledge.hits.slice(0, 8).forEach(h => {
          const ev = (h.evidence||[]).filter(Boolean).slice(0,2).join('；');
          s.push(`- ${h.ruleId}: ${h.direction}/${h.strength}${ev?` 证据:${ev}`:''}`);
        });
      }
      if (knowledge?.conflicts?.length) {
        s.push(`**规则冲突**: ${knowledge.conflicts.slice(0,4).map(c=>`[${c.level}]${c.msg||c.note||''}`).join('；')}`);
      }
      if (knowledge?.blockedBy?.length) {
        s.push(`**风险/降级项**: ${knowledge.blockedBy.slice(0,6).map(r=>`[${r.level}]${r.msg||r.code}`).join('；')}`);
      }
      s.push('');
    }

    // --- 盘口裁决（全量保留）---
    if (marketVerdict) {
      const mv = marketVerdict;
      const intent = mv.bookmakerIntent || {};
      const plan = mv.executionPlan || {};
      const euro = mv.euroCore || {};
      const draw = mv.drawCore || {};
      const cross = mv.crossMarket || {};
      const resonance = mv.marketResonance || knowledge?.resonance || ruleDecision?.marketResonance || null;
      const resonanceTop = resonance?.topRule || null;
      s.push(`## 盘口裁决单（MARKET_VERDICT_JSON · AI必须优先复核）`);
      const verdictSource = knowledge?._source === 'cloud' || marketCommand?._source === 'cloud' ? '云端规则资产' : '本地兜底规则资产';
      s.push(`> ${verdictSource}生成，AI预测80%主资产。R01-R14盘赔共振为最高优先级。战绩/伤停/量化只做20%修正。`);
      s.push(`- 裁决结论: ${mv.headline || mv.summary?.headline || '-'}`);
      s.push(`- 庄家意图: ${intent.label||'-'}｜${intent.primaryIntent||'-'}`);
      s.push(`- 欧赔核心: ${euro.currentOdds||'-'}｜低赔侧${euro.favoriteSide||'-'}｜去水概率${euro.noVigProbability?`${euro.noVigProbability.win}/${euro.noVigProbability.draw}/${euro.noVigProbability.loss}`:'-'}`);
      s.push(`- 平赔角色: ${draw.label||draw.role||'-'}`);
      s.push(`- 跨盘验证: 亚盘${cross.asian?.line||mv.line||'-'} 大小球${cross.overunder?.line||mv.overunderLine||'-'} 一致性${cross.consistencyScore??'-'}`);
      s.push(`- 执行计划: 最优=${plan.bestMarket||'-'}｜回避=${(plan.avoidMarkets||[]).join('、')||'-'}｜仓位=${plan.stake||mv.summary?.stake||'-'}`);
      if (resonanceTop) {
        s.push(`- 盘赔共振: ${resonanceTop.ruleId}｜${resonanceTop.conclusion||resonanceTop.label||'-'}｜${resonanceTop.stars||'-'}星`);
        if (resonanceTop.plain) s.push(`- 白话读盘: ${resonanceTop.plain}`);
      }
      if (mv.counterEvidence?.length) s.push(`- 最大反证: ${mv.counterEvidence.slice(0,5).map(x=>`[${x.severity}]${x.msg}`).join('；')}`);
      if (plan.liveChecklist?.length) s.push(`- 临场复核: ${plan.liveChecklist.join('；')}`);
      s.push('');
      s.push('```MARKET_VERDICT_JSON');
      s.push(marketVerdictJson);
      s.push('```');
      s.push('');
    }

    // --- 盘口总控命令（全量保留）---
    if (marketCommand) {
      s.push(marketCommandToMarkdown(marketCommand));
      s.push('');
    } else if (invalidMarketCommandSource) {
      s.push('## 盘口总控 v4（MARKET_COMMAND_JSON）');
      s.push(`> ⚠️ 云端盘口总控缺失：检测到 ${invalidMarketCommandSource} 本地存根，已剔除，不输出 MARKET_COMMAND_JSON。`);
      s.push('> AI纪律：不得把本地存根写成"存在"，不得采信其观望/执行命令；必须说明云端计算未成功并降低置信度。');
      s.push('');
    }

    // --- 专业盘口增强层（全量保留）---
    if (professionalMarket) {
      s.push(professionalMarketToMarkdown(professionalMarket));
      s.push('');
    }

    // --- 系统预测摘要 ---
    if (localPrediction) {
      const topRec = (localPrediction.recommendations || [])[0];
      const mainDir = localPrediction.summary?.mainDirection || localPrediction.mainDirection || knowledge?.summary?.mainDirection || '';
      const recText = topRec ? `${topRec.market||''} ${topRec.label||topRec.direction||''} (信心${topRec.confidence||'-'}%)` : '';
      const systemSourceLabel = marketCommand?._source === 'cloud' || knowledge?._source === 'cloud' ? '云端规则增强系统' : '本地兜底系统';
      s.push(`## ${systemSourceLabel}综合裁决（AI必须与此对比后输出终局裁决）`);
      s.push(`- 系统主方向: ${mainDir||'-'}`);
      if (recText) s.push(`- 系统首推: ${recText}`);
      s.push(`> AI终局裁决必须明确说明：与系统裁决一致还是不一致；若不一致，必须归入核心伤停/首发重大轮换/战意结构反转/临场盘口反向/数据采集错误五类之一。`);
      s.push('');
    }

    // --- AI分析请求 ---
    s.push('---');
    s.push(`## 📊 AI 分析请求`);
    s.push(`请基于以上精简数据对"**${home} vs ${away}**"进行深度分析：`);
    s.push('');
    s.push('**【动态权重要求（禁止固定80/20）】：三盘完全共振时盘口权重=85%；无明显矛盾时=80%；欧亚背离≥0.25球时=70%；本地存根/云端缺失时=55%；盘口异常时=40%仅观望。辅助修正层：战意分差≥2时=25%，否则=20%。分析必须先声明采用哪档权重及理由，再输出结论。**');
    s.push('**【人工盘口仲裁要求】**：终局推荐前必须拆分胜平负、亚让穿盘、大小球、价值仓位。深让≥1.25遇小球低水/低比分风险/量化冲突/riskScore高/数据缺失时，穿盘至少降一级；若 humanArbitration.handicapCoverStatus=downgraded/blocked，禁止深让主推。盘口数字与中文必须一致，禁止“-0.5（球半）”。');
    s.push('**【大小球综合仲裁】**：必须读取 goalReality/近期进失球/大球率/模型总进球。若历史常见3-4球、recentCombinedAvg≥3.0、bigBallAvg≥58%、expectedGoals≥2.85 或 blocksBlindUnder=true，禁止仅凭小球低水/防平推小球；无两类反向强证据时写待临场。');
    s.push('');
    s.push('**精简模式说明**：本报告已省略逐家赔率明细、进球时间分布、半全场分布等冗余原始数据，保留了关键均值、盘口共识、规则引擎结论、盘口裁决单和盘口总控命令。如需查看原始数据，请使用完整模式。');
    s.push('');
    s.push('请给出：盘口总控v4复核 → R01-R14共振复核 → PRO_MARKET_JSON/humanArbitration复核 → 欧赔/亚盘/大小球三盘裁决 → 人工盘口仲裁 → 终局裁决（含动态权重说明）→ 投注建议表。');

    const markdown = s.join('\n');
    const plainText = markdown.replace(/[#*|`_>]/g, '').replace(/\n{3,}/g, '\n\n');

    return {
      text: plainText,
      markdown,
      structured: {
        matchInfo: analysis?.matchInfo,
        home, away,
        asian: asian?.keyOdds,
        overunder: overunder?.keyOdds,
        normalized, knowledge, marketVerdict, marketCommand, professionalMarket, ruleDecision, localPrediction
      }
    };
  }

  /**
   * 构建小白可读的投注建议结构（betAdvice）
   * matchAnalyzer 依赖 structured.betAdvice.trustedPlans / avoidPlans / invalidIf / liveChecklist
   */
  _buildBetAdvice({ home, away, normalized, proMarket, riskProfile, marketCommand, marketVerdict } = {}) {
    const trustedPlans = [];
    const avoidPlans = [];
    const invalidIf = [];
    const liveChecklist = [];

    // 风险等级
    const riskLevel = riskProfile?.level || 'unknown';
    const riskScore = riskProfile?.score ?? null;

    // 数据完整度
    const completeness = normalized?.derived?.dataCompleteness;
    const dataQuality = normalized?.derived?.dataQuality;
    const dataOk = (completeness?.coreScore ?? completeness?.score ?? 0) >= 60;
    const dataAction = dataQuality?.action || 'allow';

    // 如果数据门禁阻断，直接观望
    if (!dataOk || dataAction === 'block') {
      return {
        recommendation: 'observe',
        recommendationText: '数据不足，建议观望',
        trustedPlans: [],
        avoidPlans: [{ reason: '核心数据缺失或质量过低，无法输出可信预测', level: 'hard_block' }],
        invalidIf: ['数据采集失败或完整度 < 60%'],
        liveChecklist: [],
        riskLevel,
        dataWarning: completeness?.coreMissing?.length
          ? `核心缺失: ${completeness.coreMissing.join('、')}`
          : '数据完整度不足',
      };
    }

    // 盘口方向
    const asianLine = normalized?.asian?.keyOdds?.ao?.mainLine;
    const asianFavor = normalized?.asian?.summary?.favorSide;
    const euroFavor = normalized?.odds?.summary?.favorSide;
    const ouLine = normalized?.overunder?.keyOdds?.ao?.mainLine;

    // 专业盘口裁决
    const verdict = proMarket?.verdict || proMarket?.humanArbitration;
    const verdictSide = verdict?.recommendedSide || verdict?.side || null;
    const verdictConfidence = verdict?.confidence || null;
    const valueAdmission = proMarket?.valueAdmission;
    const isHighValue = valueAdmission?.admitted && !valueAdmission?.isHardBlock;

    // 冷门风险
    const isHighRisk = ['high', 'very_high', 'extreme'].includes(riskLevel);
    const isLowRisk = ['low', 'medium_low'].includes(riskLevel);

    // 云端盘口总控
    const hasCloudCommand = marketCommand && marketCommand._source === 'cloud';
    const cloudAction = hasCloudCommand ? (marketCommand.action || '') : '';

    // 构建可信计划
    if (hasCloudCommand && cloudAction && cloudAction !== 'watch') {
      // 有云端总控：按指令给出建议
      const sideLabel = cloudAction.includes('home') ? `${home}胜` :
                        cloudAction.includes('away') ? `${away}胜` :
                        cloudAction.includes('draw') ? '平局' :
                        cloudAction.includes('over') ? `进球大球` :
                        cloudAction.includes('under') ? `进球小球` : cloudAction;
      trustedPlans.push({
        side: cloudAction,
        label: sideLabel,
        reason: `云端盘口总控指令：${cloudAction}，置信度：${marketCommand.confidence || '-'}`,
        tier: isHighValue ? 'high_value' : 'normal',
        source: 'cloud_command',
      });
    } else if (verdictSide && !isHighRisk) {
      // 无云端总控，用专业盘口裁决
      const sideLabel = verdictSide === 'home' ? `${home}胜` :
                        verdictSide === 'away' ? `${away}胜` :
                        verdictSide === 'draw' ? '平局' : verdictSide;
      trustedPlans.push({
        side: verdictSide,
        label: sideLabel,
        reason: `专业盘口裁决：${verdictSide}，置信度：${verdictConfidence || '-'}`,
        tier: isHighValue ? 'high_value' : (isLowRisk ? 'stable' : 'normal'),
        source: 'pro_market',
      });
    } else if (!isHighRisk && asianFavor) {
      // 降级：用亚盘走势
      const sideLabel = asianFavor === 'home' ? `${home}（亚盘主队）` :
                        asianFavor === 'away' ? `${away}（亚盘客队）` : asianFavor;
      trustedPlans.push({
        side: asianFavor,
        label: sideLabel,
        reason: `亚盘倾向 ${asianFavor}，盘口：${asianLine ?? '-'}`,
        tier: 'observe_only',
        source: 'asian_bias',
      });
    }

    // 高冷门风险：加回避项
    if (isHighRisk) {
      avoidPlans.push({
        reason: `冷门风险等级${riskLevel}（评分${riskScore}），建议缩仓或回避`,
        level: 'high_risk',
      });
    }

    // 盘口矛盾：欧亚背离
    const euroAsianGap = proMarket?.euroAsianGap;
    if (euroAsianGap?.level && ['severe_shallow', 'range_mismatch_deep', 'water_distorted'].includes(euroAsianGap.level)) {
      avoidPlans.push({
        reason: `欧亚背离风险（${euroAsianGap.level}），建议谨慎`,
        level: 'medium_risk',
      });
      invalidIf.push('欧亚背离持续扩大或临场亚盘异动');
    }

    // 失效条件
    invalidIf.push('临场出现主力伤停/轮换/战意下降');
    invalidIf.push('开赛前60分钟亚盘反向大幅移动');

    // 临场检查项
    if (asianLine !== null && asianLine !== undefined) {
      liveChecklist.push(`确认亚盘盘口维持在 ${asianLine} 附近，无异动`);
    }
    liveChecklist.push('确认主力阵容正常，无意外伤停');
    liveChecklist.push('确认欧赔方向与亚盘一致，无背离');
    if (ouLine !== null && ouLine !== undefined) {
      liveChecklist.push(`大小球盘口参考：${ouLine} 球`);
    }

    const recommendation = trustedPlans.length > 0 ? 'bet' :
                           avoidPlans.some(p => p.level === 'hard_block') ? 'block' : 'observe';

    return {
      recommendation,
      recommendationText: recommendation === 'bet' ? `可考虑：${trustedPlans.map(p => p.label).join(' / ')}` :
                          recommendation === 'block' ? '不建议投注（数据门禁）' : '建议观望',
      trustedPlans,
      avoidPlans,
      invalidIf,
      liveChecklist,
      riskLevel,
      riskScore,
    };
  }

  /**
   * 构建小白友好的首页摘要（beginnerSummary）
   * 结论先行：结论 → 理由三条 → 风险提示 → 数据可信度 → 推荐动作
   */
  _buildBeginnerSummary({ home, away, matchId, fetchTime, betAdvice, normalized, riskProfile, proMarket } = {}) {
    const completeness = normalized?.derived?.dataCompleteness;
    const dataQuality = normalized?.derived?.dataQuality;
    const coreScore = completeness?.coreScore ?? completeness?.score ?? 0;
    const qualityScore = dataQuality?.score ?? 0;
    const riskLevel = riskProfile?.level || 'unknown';

    // 可信度等级文字
    const trustLabel = coreScore >= 85 ? '高' : coreScore >= 60 ? '中' : '低';
    const trustIcon = coreScore >= 85 ? '🟢' : coreScore >= 60 ? '🟡' : '🔴';

    // 风险文字
    const riskLabel = {
      low: '低风险',
      medium_low: '中低风险',
      medium: '中等风险',
      medium_high: '中高风险',
      high: '高风险',
      very_high: '极高风险',
      extreme: '极高冷门风险',
    }[riskLevel] || '风险未知';

    // 主结论
    const rec = betAdvice?.recommendation || 'observe';
    const recText = betAdvice?.recommendationText || '建议观望';
    const conclusionIcon = rec === 'bet' ? '✅' : rec === 'block' ? '❌' : '⏸️';

    // 理由摘要（最多3条）
    const reasons = [];
    const verdict = proMarket?.humanArbitration || proMarket?.verdict;
    if (verdict?.conclusion) reasons.push(verdict.conclusion);
    const euroAsianGap = proMarket?.euroAsianGap;
    if (euroAsianGap?.summary) reasons.push(euroAsianGap.summary);
    if (completeness?.summary) reasons.push(completeness.summary);
    while (reasons.length < 3) reasons.push('分析数据已加载');

    return {
      home,
      away,
      matchId,
      fetchTime,
      conclusion: `${conclusionIcon} ${recText}`,
      reasons: reasons.slice(0, 3),
      riskLabel,
      riskLevel,
      trustLabel,
      trustIcon,
      coreScore,
      qualityScore,
      dataMissing: completeness?.coreMissing || [],
      recommendation: rec,
      actionText: rec === 'bet'
        ? `推荐方向：${betAdvice.trustedPlans.map(p => p.label).join(' / ')}`
        : rec === 'block' ? '❌ 不建议投注（数据不足）' : '⏸️ 观望，等待更多信息',
      warningText: betAdvice?.avoidPlans?.length
        ? `⚠️ 注意：${betAdvice.avoidPlans.map(p => p.reason).join('；')}`
        : '',
      invalidConditions: betAdvice?.invalidIf || [],
      liveChecklist: betAdvice?.liveChecklist || [],
    };
  }

  _formatTrendBlock(teamName, trend, icon) {
    const lines = [`### ${icon} ${teamName}`];
    let hasData = false;

    const labels = ['全场总', '全场主场', '全场客场', '近6场'];
    if (Array.isArray(trend?.winRates) && trend.winRates.some(Boolean)) {
      hasData = true;
      lines.push(`| 类型 | 赢盘率 |`);
      lines.push(`|------|--------|`);
      labels.forEach((label, i) => {
        const value = trend.winRates[i];
        lines.push(`| ${label} | ${value ? `**${value}%**` : '-'} |`);
      });
    }

    if (Array.isArray(trend?.bigBallRates) && trend.bigBallRates.some(Boolean)) {
      hasData = true;
      const bigLabels = ['全场总', '主/客场', '近6场'];
      const bigText = trend.bigBallRates
        .map((value, i) => value ? `${bigLabels[i] || `项${i + 1}`}: ${value}%` : '')
        .filter(Boolean)
        .join(' / ');
      if (bigText) lines.push(`- 大球率: ${bigText}`);
    }

    if (trend?.last6Asian) { hasData = true; lines.push(`- 近6场亚让走势: \`${trend.last6Asian}\``); }
    if (trend?.last6OU) { hasData = true; lines.push(`- 近6场大小球走势: \`${trend.last6OU}\``); }
    if (trend?.last6HalfAsian) { hasData = true; lines.push(`- 近6场半场亚让: \`${trend.last6HalfAsian}\``); }

    if (!hasData) {
      lines.push(`- 盘路走势采集未命中，请打开“调试”查看 analysis._debug.trendTables 输出。`);
    }

    return lines.join('\n');
  }

  _quickSummary(analysis, winDrawWin, asian, overunder) {
    const summary = [];
    if (winDrawWin?.summary) {
      const s = winDrawWin.summary;
      const avg = s.averageCurrent ? `即时均赔 ${s.averageCurrent.win}/${s.averageCurrent.draw}/${s.averageCurrent.loss}` : '即时均赔未知';
      const prob = s.impliedAverage ? `概率 ${s.impliedAverage.win}/${s.impliedAverage.draw}/${s.impliedAverage.loss}` : '';
      summary.push(`胜平负：${avg}${prob ? '，' + prob : ''}`);
    }
    if (asian?.summary) {
      const s = asian.summary;
      summary.push(`亚让盘：升${s.up}降${s.down}，高水${s.highWater}低水${s.lowWater}，主流盘${s.mainLine||'未知'}`);
    }
    if (overunder?.summary) {
      const s = overunder.summary;
      summary.push(`大小球：升${s.up}降${s.down}，主流线${s.mainLine||'未知'}`);
    }
    if (analysis?.preBriefing) {
      summary.push(`简报摘要：${analysis.preBriefing.substring(0, 100)}...`);
    }
    if (analysis?.seasonComparison?.home?.goals?.total || analysis?.seasonComparison?.away?.goals?.total) {
      const hg = analysis.seasonComparison.home?.goals?.total;
      const ag = analysis.seasonComparison.away?.goals?.total;
      summary.push(`场均进失球：主 ${hg?.avgGoal || '-'}/${hg?.avgLoss || '-'}，客 ${ag?.avgGoal || '-'}/${ag?.avgLoss || '-'}`);
    }
    if (analysis?.injuries) {
      const hi = analysis.injuries.home?.length || 0;
      const ai = analysis.injuries.away?.length || 0;
      if (hi > 0 || ai > 0) summary.push(`伤停：主队${hi}人 / 客队${ai}人`);
    }
    return summary;
  }

  _formatFullStats(teamName, fullStats, halfStats, side) {
    let text = `### ${side === 'home' ? '🏠 主队' : '✈️ 客队'}: ${teamName}\n`;

    if (fullStats?.total) {
      const t = fullStats.total;
      text += `**全场**: ${t.played}场 ${t.win}胜${t.draw}平${t.loss}负 | 进${t.goalsFor}失${t.goalsAgainst} | 积分${t.points} | 排名第${t.rank} | 胜率**${t.winRate}**\n`;
    }
    if (fullStats?.home) {
      const h = fullStats.home;
      text += `- 主场: ${h.played}场 ${h.win}胜${h.draw}平${h.loss}负 进${h.goalsFor}失${h.goalsAgainst} 胜率${h.winRate}\n`;
    }
    if (fullStats?.away) {
      const a = fullStats.away;
      text += `- 客场: ${a.played}场 ${a.win}胜${a.draw}平${a.loss}负 进${a.goalsFor}失${a.goalsAgainst} 胜率${a.winRate}\n`;
    }
    if (fullStats?.last6) {
      const l = fullStats.last6;
      text += `- 近6场: ${l.win}胜${l.draw}平${l.loss}负 进${l.goalsFor}失${l.goalsAgainst}\n`;
    }

    if (halfStats?.total) {
      const t = halfStats.total;
      text += `**半场**: ${t.played}场 ${t.win}胜${t.draw}平${t.loss}负 | 胜率${t.winRate}\n`;
    }

    return text + '\n';
  }
}
