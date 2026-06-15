/**
 * AIClient - 调用外部 AI API 进行预测
 * 支持 OpenAI GPT / Anthropic Claude / 自定义 OpenAI 兼容接口
 */
import { getExpertKnowledgeDoctrine } from './expert-doctrine.js';

export class AIClient {

  async predict(report, matchId) {
    const settings = await this._getSettings();

    // 自定义接口不强制要求 apiKey（本地模型如 Ollama 不需要）
    if (!settings.apiKey && settings.provider !== 'custom') {
      return { error: '请先在设置页面配置 AI API Key', needConfig: true };
    }

    const prompt = this._buildPrompt(report.markdown);

    try {
      if (settings.provider === 'openai') {
        return await this._callOpenAI(prompt, settings);
      } else if (settings.provider === 'claude') {
        return await this._callClaude(prompt, settings);
      } else if (settings.provider === 'custom') {
        return await this._callCustom(prompt, settings);
      }
      return { error: '未知 AI 提供商' };
    } catch (err) {
      return { error: `AI 调用失败: ${err.message}` };
    }
  }

  /**
   * 深度预测 (2.0)：
   *  - 保留原始数据报告（rawReportMarkdown）继续投喂
   *  - 注入知识库字段归一与规则引擎结论（normalizedMarkdown / knowledgeMarkdown）
   *  - 注入本地量化模型结论（quantMarkdown，含推导过程，仅供参考不可照抄）
   *  - 注入扩展端联网情报线索（intelMarkdown，需AI交叉核实）
   *  - 注入球队画像库（profileMarkdown，国家队/俱乐部基础实力与风格，仅20%辅助修正）
   *  - 要求AI自行联网检索最新信息，独立综合思考后给出建议
   * extras: { normalizedMarkdown, knowledgeMarkdown, quantMarkdown, intelMarkdown, riskMarkdown, profileMarkdown }
   */
  async predictDeep(report, matchId, extras = {}) {
    const settings = await this._getSettings();
    if (!settings.apiKey && settings.provider !== 'custom') {
      return { error: '请先在设置页面配置 AI API Key', needConfig: true };
    }

    const prompt = this._buildDeepPrompt(
      report.markdown,
      extras.quantMarkdown,
      extras.intelMarkdown,
      extras.normalizedMarkdown,
      extras.knowledgeMarkdown,
      extras.riskMarkdown,
      extras.profileMarkdown,
      extras.calibrationMarkdown,
      extras.skillEnhancement
    );

    const stream = !!(extras.stream ?? settings.deepStream);
    const onDelta = typeof extras.onDelta === 'function' ? extras.onDelta : null;

    try {
      const baseResult = await this._callProvider(prompt, settings, { deep: true, stream, onDelta });
      const debateAgents = settings.debateEnabled ? this._normalizeDebateAgents(settings.debateAgents) : [];
      if (!debateAgents.length) return baseResult;

      onDelta?.(`\n\n---\n\n## 🧩 多AI辩论开始\n`);
      const debateResults = [];
      for (let i = 0; i < debateAgents.length; i++) {
        const agent = debateAgents[i];
        const agentSettings = this._mergeAgentSettings(settings, agent);
        const roleName = agent.name || `辩论AI-${i + 1}`;
        onDelta?.(`\n\n### ${roleName} 观点\n`);
        const agentPrompt = `${prompt}\n\n---\n你现在扮演【${roleName}】。请只输出你的独立复核观点：1) 最不同意主裁决的地方；2) 最强支持证据；3) 最大风险；4) 你的最终方向。不要重复原报告。`;
        const result = await this._callProvider(agentPrompt, agentSettings, { deep: true, stream, onDelta });
        debateResults.push({ name: roleName, provider: result.provider, model: result.model, content: result.content || '', error: result.error || '' });
      }

      onDelta?.(`\n\n---\n\n## ⚖️ 主AI综合仲裁\n`);
      const synthPrompt = `${prompt}\n\n---\n以下是主AI初判与多AI辩论观点，请作为最终仲裁官输出“唯一最终结论”。必须指出采纳/驳回每个AI观点的理由，最后给出主推玩法、风险、仓位。\n\n## 主AI初判\n${baseResult.content || ''}\n\n## 多AI辩论观点\n${debateResults.map(r => `### ${r.name} (${r.provider}/${r.model})\n${r.error ? 'ERROR: ' + r.error : r.content}`).join('\n\n')}`;
      const finalResult = await this._callProvider(synthPrompt, settings, { deep: true, stream, onDelta });
      return {
        ...finalResult,
        debate: { enabled: true, base: baseResult, agents: debateResults },
        content: finalResult.content || baseResult.content || ''
      };
    } catch (err) {
      return { error: `AI 深度调用失败: ${err.message}` };
    }
  }

  /**
   * 专家知识体系（基于Del135、欧赔核心思维、大小球研究、纳兰老九）
   * 把成熟的盘口理论提炼为AI执行规则，直接约束每次预测判断。
   */
  _expertKnowledgeDoctrine() {
    return getExpertKnowledgeDoctrine();
  }

  _marketReadingDoctrine() {
    return `## 盘口读盘与预测增强规则（必须内化执行）

### 🔑 动态权重框架（禁止使用固定80/20，必须根据信号质量动态调整）

**盘口总控基础权重（80%）动态调整规则**：
- 云端MARKET_COMMAND_JSON有效 + 三盘完全共振 → 盘口权重提升至 **85%**（强共振模式）
- 云端MARKET_COMMAND_JSON有效，无明显矛盾 → 盘口权重保持 **80%**（标准模式）
- 欧亚背离（偏差≥0.25球）或盘口明显矛盾 → 盘口权重降至 **70%**（矛盾模式，需辨析）
- 本地存根/云端缺失，但欧亚盘一致 → 盘口权重降至 **55%**（降级模式）
- 盘口异常波动/疑似问题球 → 盘口权重降至 **40%**（高危观望模式）

**辅助修正层（基础20%）动态调整**：
- 战意分差≥2可将修正层提升至 **25%**（战意主导修正）
- 核心球员确认伤停，替补质量差 → 修正层提升至 **22%**
- 联赛/球队盘路系数：在基础上做±5%微调
- **输出时必须明确说明本场采用了哪档权重及理由**

### 🔑 核心读盘规则
- **核心目标**：不要把预测当成猜比分，要把预测当成"市场共识概率 vs 独立判断概率"的偏差识别。欧赔、亚盘、大小球都是市场定价语言，结论必须说明是否存在价值差，而不是只给方向。
- **欧赔去水概率**：看到 1X2 欧赔时，先用 1/赔率 得到原始概率，再用三项总和归一化，形成市场共识概率。优先取 3-5 家主流机构均值；单一机构只作参考，避免被风控策略误导。
- **欧亚转换校验**：禁止只用“主胜欧赔≈某个亚盘点位”的旧单点映射下结论。必须按顺序执行：①欧赔去水概率锚定强弱侧；②结合经验盘口区间与泊松/进球差反推理论盘口范围；③对照实际亚盘让幅是否落在 PRO_MARKET_JSON.euroAsianGap.lineRange；④复核主客水位是否存在超高水/超低水畸变；⑤读取 PRO_MARKET_JSON.euroAsianGap.inducementRisk 与 verificationChecklist。实际盘口深于/浅于理论范围、或水位畸变时，只能降级/待临场复核，不能自动写“强防上盘”或反向高价值。**欧亚偏差≥0.25球或 lineRange.mismatch=true 时盘口权重自动降至70%；asian_inducement_risk 时进入高危观望模式。**
- **水位语言**：0.75-0.80 超低水=极度防范/随时升盘；0.80-0.85 低水=低阻防范；0.90-0.95 中水=均衡；0.95-1.00 中高水=阻挡或赔付压力；1.05+ 高水=不惧赔或诱买。**深盘高水=高水诱盘警报（案例库：阻盘三条件：水位>1.05+冷热指数偏差>25%+近三场赢盘率<30%同时触发才是真阻盘）。**
- **盘路过程**：一步到位升深且水位稳定=强防且信号坚挺；先升后退再临场回升=洗盘，需识别是否在清筹；临场暴拉=信息突发/热度极高，高收益但必须降仓控风险。**走地水位跳水幅度<0.20可忽略，>0.25才是有效信号（反面教材错误5）。**
- **三盘共振**：欧赔回答"谁赢"，亚盘回答"能赢几个"，大小球回答"总共几个球"。只有三者讲同一个故事才可提高信心（触发85%盘口权重）；若出现亚盘深而大小球低、欧赔强而亚盘浅等"不可能三角"，必须降级或转向更稳玩法（触发70%盘口权重）。
- **经典模型**：主胜降赔 + 亚盘升盘承接 + 大小球升盘低水 = 碾压局，比分偏 3-0/3-1，注意 2-0 双杀；低主胜 + 深让 + 大小球不升/大球高水 = 经济实惠，偏 1-0/2-0、赢球输盘；浅盘高水 + 小球坚挺 = 冷门温床，偏下盘/小球/1-1/0-0/0-1。
- **R01-R14盘赔共振最高优先级**：若 MARKET_VERDICT_JSON 或知识规则中存在 marketResonance/topRule，必须逐条复核 R01-R14：正向共振 R01-R03 提高置信；背离/陷阱 R04-R08/R11 只对命中的玩法做局部降级；水位过程 R09-R14 必须结合时间窗口。禁止绕过本地 R01-R14 裁决直接按名气、排名、战绩给答案。
- **人类盘口分析师仲裁层**：规则命中数不是最终答案，必须先做“玩法拆分裁决”：①胜平负/谁更可能赢；②亚让盘能否穿当前让幅；③大小球方向；④价值/仓位。强队胜出≠强队穿深盘；R-MR-13“升盘不升水/真阻”只能证明热门方向承载增强，不能自动推出球半穿盘可下注。
- **深让穿盘冲突降级**：当前让幅≥1.25时，如果大小球实际盘高但小球低水、PRO_MARKET_JSON.ouDrawLink.lowScoreRisk=high、量化胜率与市场概率差≥18pct、riskScore≥65、或情报/交锋/伤停缺失，则亚让穿盘至少降一级；若欧亚承载不足或反证审判overturn，则禁止把深让作为主推。
- **盘口输出一致性**：投注建议里的数字盘和中文盘必须一致：半球=±0.5，半一=±0.75，一球=±1，一/球半=±1.25，球半=±1.5。禁止出现“-0.5（球半）”这类自相矛盾写法；若不确定盘口，写“按当前球探盘口X复核”，不要硬填。
- **陷阱门控作用域纪律**：大热陷阱/上盘诱买/R-MR-04~08/R-MR-11/downgrade/avoid 不是反向下注信号，只能限制对应玩法的高价值标签和仓位。热门让球风险≠弱队有价值；上盘诱买≠小球；降仓≠反打；overturn 默认观望/重算，不得自动推荐相反方向。**（案例库错误2：把降仓等同于反打；错误1：把升盘等同于看好）**
- **中高价值准入分层**：必须读取 PRO_MARKET_JSON.valueAdmission.level/valueTier/strongValueSignal/highValueEvidence/nearMissMediumHigh/softMissing/promotionHints。blockers 或 level=blocked 时禁止高/中高价值；strongValueSignal=true 时必须在对应玩法给出“强信号中高价值候选”（仓位仍受 stakeCap 限制）；allowMediumHigh=true 可写“中高价值”；allowMediumHighWatch=true 或 nearMissMediumHigh=true 可写“中高价值候选-待临场确认”（低/中低仓，必须列 softMissing 和临场确认点）；allowHigh=true 才可写“高价值”。缺少 valueAdmission 时默认不得中高价值；trapDiscipline.hasTrap=true 时只限制 affectedMarkets，不能跨玩法压死所有推荐。若 euroAsianGap.level=range_mismatch_deep/range_mismatch_shallow/water_distorted/asian_inducement_risk，必须优先服从 valueAdmission.blockers/softMissing，不得把未校准 edge 或旧欧亚转换话术包装成中高/高价值。
- **大小球时效**：胜负方向通常赛前 4 小时核心信息基本定价；大小球受首发、天气、热身伤病和临场战术影响更大，必须明确赛前 90 分钟首发与赛前 30 分钟临场水位是否支持判断。
- **大小球价值门槛**：全场/半场大小球标为高价值或中高价值前，必须同时满足至少两类同向证据（进球预期/理论盘、盘口偏差、升降盘与水位路径、首发天气或战术节奏）；若缺少场均进失球、首发或临场水位，只能降级为"低仓观察/待临场确认"。禁止把"大热陷阱/上盘诱买/低比分风险/防平保护"自动等同于小球；也禁止为反向而反向包装大球，大球与小球必须同等检查反证。
- **战意与体系修正**：战意 1-5 分量化，分差 ≥2 时可压过纸面实力（修正层可提升至25%）；识别高位防线 vs 速度反击、传控 vs 高压绞杀、高中锋 vs 矮防线等体系克制，作为修正 xG、盘口信号和比分区间的关键变量。**（案例库：战意驱动波尔图3-0胜罗马，战意分差≥2场景）**
- **AI 与盘口结合**：AI 不是替代盘口，而是找盘口误判。若 AI 平局概率比市场高 8pct 且双方 xG 差 <0.5，只能做平局保护复核；深盘下 AI 判断上盘无法全收概率高市场 10pct，只能做受让保护/降热门仓复核，不能自动标下盘高价值；AI 总进球与大小球界限差 >0.5 且方向一致，也必须通过大小球证据门槛后才可讨论价值。
- **主方向 + 冷门双轨**：每场必须同时输出“主方向/更可能方向”和“冷门或防冷路径”。冷门路径来自 PRO_MARKET_JSON.upsetRead 或爆冷风险画像 upsetCandidate；其默认作用是保护、降仓、保险和临场触发条件。只有同时具备独立 edge、赔率保护、盘口反向异动、阵容/战意确认等证据，才可从“防冷候选”升级为“冷门投注候选”。禁止把热门风险、陷阱门控、数据缺失、降仓直接写成反向高价值。
- **盘口裁决单契约**：若报告中出现 \`MARKET_VERDICT_JSON\`，它就是本地知识库+欧赔核心+庄家盘口的机器可读裁决资产。你必须先复核它是否成立，再判断重大反证是否足以推翻；禁止绕过裁决单直接按战绩/名气/主观印象给答案。
- **MARKET_COMMAND_JSON 来源纪律**：只有 _source=cloud 的 MARKET_COMMAND_JSON 才视为云端盘口总控存在；local_stub、local_stub_error、本地存根或兜底内容一律判定为"云端盘口总控缺失，本地存根无效"，不得引用其历史基线、盘口剧本、执行命令或仓位建议。
- **联赛修正系数（必须应用）**：英超主场+0.1水位修正/容错率±0.4；西甲平赔较真实+0.15~+0.3；德甲精度最高误差±0.25；意甲大球慎重+0.2~+0.35（强队常小胜）；法甲爆冷率高默认降仓，误差±0.75。
- **纪律**：没有显著概率差、三盘逻辑不闭环、情报无法确认、或风险画像过高时，只能低仓/观望/提示风险，禁止为了给答案而强推。`;
  }

  _buildPrompt(reportMarkdown) {
    return `你是一位顶级足球数据分析师团队的负责人，精通亚盘、大小球盘口分析、赔率解读和足球战术分析。你深度掌握欧赔核心思维、Del135数字心理、大小球研究和纳兰老九足彩投资体系。
你拥有以下能力：
1. 深度数据分析：精通各类盘口数据、赔率变化规律、球队战绩走势
2. 诚实信息整合：只能引用知识截止日期前已确认的信息；若不确定某伤停/首发是否属实，必须标注"待确认"，不得编造
3. 辩证思维：从正反两面分析每个推荐，指出支持和反对的证据，最终给出权衡后的结论

${this._expertKnowledgeDoctrine()}

## 分析要求
- **只引用已确认的球队动态**：若知识截止日期之后的信息无法核实，必须标注"待确认"，不得编造伤停、阵容、状态
- **辩证分析**：每个推荐必须列出"支持因素"和"风险因素"，不能只说利好
- **赔率解读**：深入分析赔率水位变化背后的含义（庄家意图、资金流向）
- **交叉验证**：用多个维度的数据互相印证，数据矛盾时要明确指出并解释
- **动态权重（替代固定80/20）**：盘口总控基础权重80%，三盘完全共振时提升至85%，欧亚背离(≥0.25球)时降至70%，本地存根/云端缺失时降至55%，盘口异常时降至40%。辅助修正层基础20%，战意分差≥2时提升至25%。输出时必须明确说明本场采用了哪档权重及理由。云端 \`_source=cloud\` 的 \`MARKET_COMMAND_JSON\` / \`marketCommand\` 盘口总控 v4 才是最高总裁决层，\`MARKET_VERDICT_JSON\` 与 \`marketResonance\` / R01-R14 是其底层证据链。
- **MARKET_COMMAND_JSON 最高优先级**：如果【数据报告】中包含 \`MARKET_COMMAND_JSON\` 或“盘口总控 v4”，必须先核验来源。只有云端 \`_source=cloud\` 才能写“存在”并复核历史基线、当前读盘、盘口剧本、反证审判、执行命令、临场复核点和赛后复盘点；若是本地存根/local_stub/local_stub_error，必须判定为“云端盘口总控缺失，本地存根无效”，不得采信。
- **MARKET_VERDICT_JSON / R01-R14 证据链**：继续逐项复核 R01-R14 命中规则、庄家意图、欧赔骨架、平赔角色、跨盘验证、执行计划、最大反证；若与总控命令冲突，以总控命令的反证审判与执行命令为准并说明取舍。
- **可推翻条件**：只有核心伤停、首发重大轮换、战意结构反转、临场盘口反向变动、数据采集错误这五类证据可以推翻 80% 盘口总控裁决与 R01-R14 共振结论；其它战绩/排名/名气只能做20%修正。
- **读盘优先级**：先复核 MARKET_COMMAND_JSON 的盘口剧本与反证审判，再复核 R01-R14 盘赔共振/背离/水位过程，然后算市场共识概率，做欧亚转换、亚盘水位、大小球联动、战意/体系修正，最后才输出推荐。
- **中高价值正向准入分层**：投注建议表不得只因“看好方向、模型edge、规则星级”写高/中高价值。必须先引用 PRO_MARKET_JSON.valueAdmission：level=blocked/blockers存在时统一写“低价值/待临场确认/不入TOP”；strongValueSignal=true 时必须敢于给对应玩法“强信号中高价值候选”；allowMediumHigh=true 才能写正式“中高价值”；allowMediumHighWatch=true/nearMissMediumHigh=true 时允许写“中高价值候选-待临场确认”（仓位低/中低，必须写 softMissing/promotionHints）；allowHigh=true 才能写高价值。若 PRO_MARKET_JSON.euroAsianGap.level 为 range_mismatch_deep/range_mismatch_shallow/water_distorted/asian_inducement_risk，必须同步引用 lineRange/waterImbalance/inducementRisk/verificationChecklist；asian_inducement_risk 直接阻断中高/高价值，water_distorted 只能待临场确认。
- **大小球高价值限制**：投注建议表里的全场/半场大小球，只有在大小球联动段已证明至少两类同向证据且反证不足时，才允许写“高价值/中高价值”；证据不足、CLV缺失/CLV-或命中风险门控时写“低价值/待临场确认/不入TOP”。
- **进球现实层硬门禁**：大小球不能只看盘口。若 PRO_MARKET_JSON.goalReality.blocksBlindUnder=true、goalReality.status=over_reality_supported/under_blocked_by_goal_reality，或双方近期总进球均值≥3.0、大球率≥58%、模型总进球≥2.85，禁止仅凭“小球低水/防平/低比分风险”推荐小球；除非你能证明盘口反向定价有至少两类强证据（退盘+小球持续降水+首发保守/天气恶劣/战意不足），否则小球只能写“观望/待临场确认”。
- **冷门候选纪律**：若报告含 PRO_MARKET_JSON.upsetRead 或爆冷风险画像 upsetCandidate，必须引用 valueStatus/paths/evidence/triggers/invalidIf/forbiddenInferences。valueStatus=hedge_only/risk_only 只能写防冷或保险，不能写反向投注；valueStatus=upset_value_watch 也必须等待临场触发和独立价值证据，仓位低于主方向候选。

${this._marketReadingDoctrine()}

## 数据报告
${reportMarkdown}

---
**【七阶段强制思维链纪律】**：必须依次完成七个阶段的分析，每阶段必须输出判断和依据，禁止跳步：
阶段一(基本面量化)→阶段二(初盘评估)→阶段三(动态盘口)→阶段四(盘赔共振)→阶段五(庄家心理模拟)→阶段六(假设验证)→阶段七(输出决策)。
三条以上规则同向触发=强信号；欧亚矛盾/水位与盘口矛盾/时间矛盾任意一条触发=必须辨析；85%+资金涌入上盘+盘口降级=下盘预警。

请严格按以下格式输出预测报告（不超过2000字）：

## 🔍 赛前情报（基于你的知识库）
- 主队近况：[最新伤停、阵容、状态、战术等你所知的信息]
- 客队近况：[最新伤停、阵容、状态、战术等你所知的信息]
- 关键对位：[影响比赛走势的关键球员/战术匹配]

## 🧠 盘口总控 v4 复核（必须先输出）
- MARKET_COMMAND_JSON：[云端存在/云端不存在/本地存根无效；只有 _source=cloud 才能写存在，local_stub/local_stub_error 必须写无效]
- 盘口剧本：[强队穿盘/赢球不穿/下盘小球/大热陷阱/下盘大球/临场高波动/观望局]
- 反证审判：[keep/downgrade/overturn；若推翻，必须归入核心伤停/首发重大轮换/战意结构反转/临场盘口反向变动/数据采集错误]
- 执行命令：[最优玩法/回避玩法/仓位纪律/临场复核点]
- MARKET_VERDICT_JSON：[存在/不存在；引用 headline/bookmakerIntent/executionPlan]
- R01-R14盘赔共振：[引用 marketResonance.topRule；说明正向共振/背离陷阱/水位过程是否成立]
- AI取舍：[保留/降级/推翻盘口总控命令 + 理由]

## 🧑‍⚖️ 人工盘口分析师仲裁（必须先于终局裁决）
- 胜平负方向：[谁更可能赢/不败；引用欧赔与盘口证据]
- 亚让穿盘方向：[当前让幅是多少；是否支持穿盘；若深让遇小球低水/量化冲突/风险高，必须写降级]
- 大小球方向：[独立判断，不得由让球陷阱外推；必须引用 PRO_MARKET_JSON.goalReality/近期总进球/大球率/模型总进球；若历史常见3-4球却想推小球，必须写清盘口反向定价证据，否则写待临场]
- 价值/仓位：[引用 PRO_MARKET_JSON.valueAdmission/humanArbitration；说明高/中高/低价值或观望]
- 输出一致性检查：[盘口数字与中文是否一致；例如球半=-1.5，不得写-0.5（球半）]

## 🎯 终局裁决（唯一主方向 + 防冷路径）
**主推玩法**：[必须给出唯一明确主方向；若亚让深盘被仲裁层降级，则不能硬推深让，改写“主胜/让浅盘候选/观望”。若真的无法裁决，只能写"本场观望，不投"。]
**防冷/冷门候选**：[必须给出平局/受让/不败/小比分/反热门胜等最可能冷门路径之一；若无明确路径写“暂无明确冷门路径”。必须说明 valueStatus，是防冷保险还是冷门价值观察。]
**冷门触发与失效**：[列出1-3条触发条件和1-2条失效条件；若只是风险/陷阱/数据缺失，必须写“不能反向下注，只能降仓/保险”。]
**裁决依据**：[一句话说明：动态盘口权重来自庄家盘口/知识规则，修正层来自其它证据；必须说明规则命中数是否被冲突仲裁降级]

## 📈 欧赔三项组合解读（专家框架，必须输出）
- **实力定位**：[主队/客队档位（豪门/准强/中上/中游/中下/弱队）；理论赔率骨架]
- **三态判断**：[实盘/中庸/韬光；判断依据]
- **分布类型**：[顺分布/逆分布/缓冲/中庸分布]
- **低赔功能**：[实盘支撑/低赔诱盘/韬光保护]
- **平赔角色**：[真实平局/分散/过渡/缓冲/阻挡/非平平赔；判断依据]
- **高赔功能**：[冷门保护/诱导/真实冷门]
- **Del135数字心理**：[是否触发敏感位；残缺平衡/尾数规律]
- **综合欧赔结论**：[三项组合讲什么故事]

## 📈 庄家读盘与价值裁决（80%权重）
- 欧赔去水概率：[主胜/平/客胜市场共识概率]
- 欧亚转换：[理论亚盘 vs 实际亚盘，深开/浅开/一致]
- 亚盘水位语言：[低阻/高水诱盘/升盘阻上/洗盘等]
- 大小球联动（按流程）：[联赛属性→战术节奏→理论盘口→实际盘口对比；是否与胜负剧本共振；至少两类同向证据+一个反证]
- R01-R14盘赔共振：[命中规则ID、星级、白话解释、是否支持最终方向]
- 盘口总控v4：[优先引用 MARKET_COMMAND_JSON 的盘口剧本、反证审判、执行命令]
- 80%权重裁决：[基于庄家盘口的主结论]
- 20%修正因素：[伤停/战绩/情报/量化如何修正，而不是反客为主]
- 裁决执行：[最优玩法/回避玩法/仓位纪律/临场复核点]

## 🏆 全场预测
### 亚让盘
- 盘口倾向：[主队/客队/平手]
- 推荐：[具体推荐，如"主队-0.5让球"]
- ✅ 支持因素：[列出2-3个支持该推荐的数据/信息]
- ⚠️ 风险因素：[列出1-2个可能导致推荐失败的因素]
- 赔率解读：[分析当前赔率水位变化，庄家意图]
- 信心度：[0-100%]

### 大小球
- 推荐：[大球/小球 + 具体进球线；证据不足则写“待临场确认”]
- ✅ 支持因素：[必须至少两类同向证据：进球预期/理论盘、盘口偏差、升降盘与水位路径、首发天气或战术节奏]
- ⚠️ 风险因素：[必须列出可能导致相反方向的反证；缺场均进失球/首发/临场水位时不得标中高价值]
- 赔率解读：[大小球赔率水位分析]
- 信心度：[0-100%]

### 角球
- 推荐：[大角球/小角球 + 角球线，如"大角球9.5"]
- 理由：[球队角球数据、战术风格]
- 信心度：[0-100%]

## 🕐 半场预测
- 半场亚盘：[主队/客队/平手让球推荐]
- 半场大小球：[大/小 + 进球线]
- 半场角球：[大/小 + 角球线]
- 理由：[赛事节奏、主客场半场数据、球队慢热/快热特点]
- 信心度：[0-100%]

## 🔢 比分预测
- 最可能比分1：[X:X]（概率约X%）
- 最可能比分2：[X:X]（概率约X%）
- 最可能比分3：[X:X]（概率约X%）
- 分析依据：[基于球队近期进失球数据 + 战术匹配分析]

## 📈 盘口读盘与价值差
- 市场共识概率：[主胜/平/客去水概率；数据不足则说明]
- 欧亚匹配：[欧赔对应标准亚盘 vs 实际亚盘，判断深开/浅开/一致]
- 水位与盘路：[低阻/高水诱盘/升盘阻上/洗盘/临场暴拉等]
- 三盘共振：[欧赔、亚盘、大小球是否讲同一个故事]
- R01-R14盘赔共振复盘：[命中规则ID、正向/背离/过程分类、白话解释、是否支持最终推荐]
- 价值差：[AI/独立判断与市场概率差；无明显差值则写“价值不足”]

## 💰 投注建议（基于赔率价值）
| 投注项目 | 推荐方向 | 当前赔率 | 价值评估 | 建议仓位 |
|---------|---------|---------|---------|---------|
| 全场亚盘 | ... | ... | 高/中/低价值 | 低/中/高仓 |
| 全场大小球 | ... | ... | ... | ... |
| 全场角球 | ... | ... | ... | ... |
| 半场亚盘 | ... | ... | ... | ... |
| 比分 | ... | ... | ... | ... |

> 高价值=赔率被低估，值得投注；低价值=赔率过低，性价比差

## ⚠️ 风险提示与辩证总结
- 最大不确定因素：[伤停、赔率异动、天气、心理因素等]
- 数据矛盾点：[如果数据之间有矛盾，明确指出]
- 庄家陷阱警示：[是否存在诱盘可能]

## 📊 综合评分
- 比赛精彩程度：[1-10]
- 数据可靠度：[高/中/低，数据越充分越高]
- 综合推荐信心：[0-100%]
- 重点关注：[最值得投注的1-2个方向，附简要理由]`;
  }

  /**
   * 深度提示词 (v3.6)
   * 七层信息：原始数据报告 + 字段归一 + 知识规则 + 本地量化结论(带推导) + 联网情报线索 + 爆冷风险画像 + 球队画像库。
   * 核心原则：先做“本场情报有效性门检”，再采信规则、量化、风险画像与球队画像；任何来源不匹配本场都必须剔除。
   */
  _buildDeepPrompt(rawReportMarkdown, quantMarkdown, intelMarkdown, normalizedMarkdown, knowledgeMarkdown, riskMarkdown, profileMarkdown, calibrationMarkdown, skillEnhancement = '') {
    const normalizedBlock = normalizedMarkdown
      ? normalizedMarkdown
      : '### 🧱 字段归一快照（知识库口径）\n> 本场未能生成字段归一快照，请以原始数据为准。';
    const knowledgeBlock = knowledgeMarkdown
      ? knowledgeMarkdown
      : '### 🧠 知识库规则引擎结论\n> 本场未能生成知识规则结论，请不要臆造规则命中。';
    const quantBlock = quantMarkdown
      ? quantMarkdown
      : '### 📐 本地量化模型参考结论\n> 本场未能生成量化结论（数据不足），请完全依赖原始数据与你的联网检索独立判断。';
    const intelBlock = intelMarkdown
      ? intelMarkdown
      : '### 🌐 扩展端联网情报线索\n> 扩展端未检索到情报，请务必使用你自己的联网搜索能力获取最新伤停/阵容/状态信息。';
    const riskBlock = riskMarkdown
      ? riskMarkdown
      : '### 🧯 爆冷风险与对冲建议\n> 本场未能生成爆冷风险画像，请你自行识别强队低赔不足、热门过热、平赔防冷、盘口冲突、伤停轮换和战意不明等风险。';
    const profileBlock = profileMarkdown
      ? profileMarkdown
      : '### 🧬 球队画像库\n> 本场未能加载球队画像库。请不要臆造画像字段；球队名气、排名、身价、风格只能作为20%辅助修正，不能覆盖盘口总控。';
    const calibrationBlock = calibrationMarkdown
      ? calibrationMarkdown
      : '';
    // 赛事规则叠加层：仅在用户选择了非默认赛事skill时存在。
    // 它是基础盘口分析之上的规则补充（如世界杯2026规则/教练视角），不替代盘口/价值/风险纪律。
    const skillBlock = (typeof skillEnhancement === 'string' && skillEnhancement.trim())
      ? skillEnhancement
      : '';

    return `你是一位顶级足球数据分析师团队的首席决策人，精通亚盘、大小球、赔率解读、统计建模与战术分析。你深度掌握欧赔核心思维（心理连通器/跷跷板/实盘中庸韬光）、Del135数字心理体系、《大小球研究》完整分析框架和纳兰老九足彩投资理论。

${this._expertKnowledgeDoctrine()}

# 你的工作方式（v3.9，务必严格遵守）
1. **先做本场情报有效性门检**：在采信任何联网情报前，必须确认该来源同时对应本场双方球队、比赛日期/赛事背景和当前对阵。只提到其中一队、出现其他对手（例如"葡萄牙 vs 芬兰""德国 vs 芬兰"）、日期明显不符、来源为空或只是无来源综合摘要的内容，必须列入"剔除线索"，不得作为伤停/首发/动机证据。
2. **扩展端情报只是线索，不是事实**：本次分析可能包含 Tavily/免费搜索引擎线索（见【扩展端联网情报】部分）。请仔细阅读每条摘要、来源和本场匹配评分，但必须用你自己的联网能力再次核实；无法核实的写"待确认"，不得编造。
3. **九类输入分层对待**：
   - **【原始数据报告】**：来自球探网的盘口/赔率/战绩原始采集数据，这是事实基础，可信度高；其中可能嵌入 MARKET_COMMAND_JSON、MARKET_VERDICT_JSON 与 PRO_MARKET_JSON，必须按各自纪律复核。
   - **【字段归一快照】**：扩展按知识库字段规范抽取的稳定字段，用于减少原始表格噪音；若与原始报告冲突，以原始报告为准并指出冲突。
   - **【知识库规则引擎结论】**：优先采用云端规则根据欧赔、平赔、亚盘、大小球、冲突降级规则给出的"命中/候选/风险"。若只出现本地轻量兜底/本地存根，它只代表云端规则缺失，不是有效盘口总控证据；你需逐条确认规则适用性，尤其注意 invalidIf、risk、blockedBy 和 conflicts。
   - **【专业盘口增强层 PRO_MARKET_JSON】**：扩展把欧赔去水、欧亚缺口、大小球/平赔联动、盘口移动、正EV、CLV准备度汇总成结构化复核层。它只能辅助判断价值差、降仓、等待临场或加固方向，不能单独覆盖云端 MARKET_COMMAND_JSON；只有高风险分、明确欧亚背离、CLV准备不足或五类重大反证成立时，才允许影响仓位/观望。
   - **【本地量化模型参考结论】**：扩展用确定性数学（去水概率、泊松、凯利等）算出的结论，附带推导方法。它是数学参考坐标，不能单独推翻盘口主方向；与盘口冲突时，只能作为20%修正权重，不能反客为主。
   - **【扩展端联网情报】**：通过 Tavily/降级搜索得到的公开网页线索（含标题、摘要、来源、匹配评分）。它只是一组候选来源，必须先判断"是否属于本场"。若不属于本场或无法确认，必须剔除；如发现矛盾或不确定的信息，标注"待确认"，不要编造。
   - **【爆冷风险画像】**：扩展将知识库规则、盘口、大小球、数据完整度和情报关键词合成为风险分、风险桶、对冲/仓位建议。它是风控约束，不是反打冷门的必然结论；当风险高时必须降仓、保护或输出高风险提示，但不能替用户直接放弃。
   - **【球队画像库】**：扩展从线上画像库匹配国家队/俱乐部基础实力、FIFA排名/身价、风格标签、核心球员、验证状态。它只能作为基本面、长期实力、风格、热度的20%辅助修正；partial、未匹配或验证不足时必须弱化，禁止绕过 MARKET_COMMAND_JSON / MARKET_VERDICT_JSON / PRO_MARKET_JSON 纪律链。
   - **【历史战绩校准指令】**：基于用户本账号真实历史投注记录的规则命中率统计。⚠️ 低命中规则（<45%，样本≥10）即使本场信号出现，也必须降仓，不得进入 TOP 推荐；✅ 高命中规则（≥65%，样本≥10）与盘口总控方向一致时可适当提升仓位。样本不足时只观察，不放大权重。
4. **以庄家盘口为锚，有充分证据才修正**：综合以上九类信息时，只有云端返回且明确标记 \`_source=cloud\` 的 MARKET_COMMAND_JSON 才能作为盘口总控默认锚点。若报告标注“本地存根”、\`_source=local_stub\`、\`_source=local_stub_error\` 或“兜底”，必须判定为云端盘口总控缺失，不得无故当作有效裁决。PRO_MARKET_JSON、量化模型、联网情报与球队画像都只能辅助降仓/加固/等待临场，不能单独覆盖云端盘口总控。只有当以下五类重大证据同时满足时，才允许在说明理由后对20%权重做小幅修正——核心主力伤停确认、首发重大轮换确认、战意结构性反转、临场盘口反向异动、数据采集错误。修正幅度超过盘口主方向时，必须明确写出"推翻理由"并经过五类证据核查。
5. **诚实标注**：凡引用具体情报（如"某球员伤停"），请标注来自哪条有效来源；无法从有效来源中确认的要标注"待确认"，绝不编造。不得编造知识库规则没有命中的规则。
6. **动态权重（禁止固定80/20，必须根据信号质量动态计算）**：
   - **盘口总控基础权重80%的动态档位**：三盘完全共振→提升至**85%**；无明显矛盾→保持**80%**；欧亚背离≥0.25球或盘口明显矛盾→降至**70%**；本地存根/云端缺失→降至**55%**；盘口异常/疑似问题球→降至**40%（只观望）**
   - **辅助修正层基础20%的动态档位**：战意分差≥2→提升至**25%**；核心球员确认伤停替补质量差→提升至**22%**；联赛/球队盘路系数±5%微调
   - **必须在分析开始时声明本场采用哪档权重及理由，输出报告中明确标注**
   - 云端有效 \`MARKET_COMMAND_JSON\` / \`marketCommand\` 盘口总控 v4 是最高总裁决层，\`MARKET_VERDICT_JSON\` 与 \`marketResonance\` / R01-R14 是其底层证据链，\`PRO_MARKET_JSON\` 是专业盘口增强复核层。除非有效情报出现重大伤停/战意/赛程突变，否则不得让统计战绩反客为主推翻盘口核心。
7. **MARKET_COMMAND_JSON 复核纪律**：如果【原始数据报告】包含 \`MARKET_COMMAND_JSON\` 或“盘口总控 v4”，你必须先确认其来源是否为云端 \`_source=cloud\`。只有云端 MARKET_COMMAND_JSON 才能写“存在”并复核历史基线、当前读盘、quantBridge、盘口剧本、五类反证审判、执行命令、临场复核点和赛后复盘点；若出现“本地存根”或 local_stub/local_stub_error，必须写“云端盘口总控缺失，本地存根无效”，不得采纳其观望/执行命令作为裁决。
8. **MARKET_VERDICT_JSON / R01-R14 证据链纪律**：继续复核 MARKET_VERDICT_JSON 的 R01-R14 命中规则、庄家意图、欧赔核心、平赔角色、跨盘一致性、执行计划和反证列表；若与盘口总控命令不一致，必须解释取舍，默认以 MARKET_COMMAND_JSON 为上位裁决。
9. **PRO_MARKET_JSON 辅助纪律**：如果报告包含 PRO_MARKET_JSON，必须读取 score、riskFlags、marketEfficiency、euroAsianGap、ouDrawLink、valueRead、clvChecklist。它只能说明 edge/risk/CLV准备度是否支持加固、降仓或等待临场；不得因为单一 valueBet 或单条联网文章推翻云端 MARKET_COMMAND_JSON。只有当 PRO_MARKET_JSON 给出高风险、欧亚严重背离、大小球/平赔与主剧本冲突或五类重大反证成立时，才允许降级仓位。
10. **读盘先于结论**：输出推荐前必须先完成 MARKET_COMMAND_JSON 的盘口剧本与反证审判复核，再完成 PRO_MARKET_JSON 专业增强复核，再完成 R01-R14 盘赔共振/背离/水位过程复核，再做欧赔去水、欧亚转换、亚盘水位、大小球联动、战意/体系修正和价值差检查；盘口逻辑不闭环时，必须降级为低仓/观望/风险提示。
11. **陷阱门控不是反向信号**：高风险提示、avoid、downgrade、R-MR-04/R-MR-05/R-MR-06/R-MR-07/R-MR-11、大热陷阱/上盘诱买只允许对命中的玩法局部降级和限制仓位，不得自动推荐相反方向；R-MR-05只代表反热门重仓门控，不等于自动下盘价值；上盘诱买不等于小球；downgrade不等于反打；overturn默认观望/重算。
12. **中高价值正向准入分层**：必须读取 PRO_MARKET_JSON.valueAdmission 和 trapDiscipline。level=blocked 或 blockers 存在时，命中玩法只能低价值/待临场确认/不入TOP；strongValueSignal=true 且 highValueEvidence≥4条时，必须在对应玩法写“强信号中高价值候选”（仓位仍受 humanArbitration.stakeCap 限制）；allowMediumHigh=true 才允许写正式"中高价值"；allowMediumHighWatch=true/nearMissMediumHigh=true 时允许写"中高价值候选-待临场确认"，但必须列 softMissing/promotionHints 且低/中低仓；allowHigh=true 才允许写"高价值"。watch级别只能低价值候选；trapDiscipline.hasTrap=true 时必须说明只降级 affectedMarkets，不得跨玩法外推。
13. **大小球高价值门槛**：全场/半场大小球标为高价值或中高价值前，必须给出至少两类同向证据和一个反证检查；缺少场均进失球、首发或临场水位时，只能写低仓观察/待临场确认，不能把“大热陷阱/上盘诱买/低比分风险/防平保护”自动包装成小球，也不能为了反向而包装大球。
14. **进球现实层硬门禁**：必须读取 PRO_MARKET_JSON.goalReality。若 blocksBlindUnder=true、status=over_reality_supported/under_blocked_by_goal_reality，或原始数据显示双方近期总进球经常3-4球、近期总进球均值≥3.0、大球率≥58%、模型总进球≥2.85，则小球推荐必须被阻断或降为“待临场确认”；只有同时存在盘口反向强证据（退盘/小球连续降水/首发保守/天气恶劣/战意不足至少两类）才允许低仓小球，并必须解释“为什么历史高进球本场不适用”。

${this._marketReadingDoctrine()}

---

# 【原始数据报告】（球探网采集，事实基础）
${rawReportMarkdown}

---

# 【字段归一快照】（知识库口径，用于规则与量化对齐）
${normalizedBlock}

---

# 【知识库规则引擎结论】（命中/候选/风险/冲突，按权重采信，不得无故推翻）
${knowledgeBlock}

---

${quantBlock}

---

${intelBlock}

---

# 【爆冷风险画像】（风险分层、高风险提示条件、对冲/仓位建议）
${riskBlock}

---

# 【球队画像库】（国家队/俱乐部基础实力、风格、排名、验证状态）
${profileBlock}

> 使用纪律：球队画像只作20%辅助修正；partial、未匹配或验证不足时只能弱参考；不得绕过盘口总控 v4、MARKET_VERDICT_JSON、PRO_MARKET_JSON 或 R01-R14 裁决链。

---

${calibrationBlock ? `# 【历史战绩校准指令】（本账号真实投注命中率统计，直接约束本场推荐）
${calibrationBlock}

> **执行纪律**：本层指令优先级高于"规则星级"，与盘口总控并列执行。⚠️ 低命中规则本场一律降仓，不得进入TOP推荐；✅ 高命中规则须与盘口总控方向一致才能提升仓位。样本<30时只观察，不放大权重。

---

` : ''}请先完成"本场情报有效性门检 + 联网检索交叉验证"，然后严格按以下格式输出最终报告（结构清晰、有据可依）：

## 🔎 情报有效性门检（必须先输出）
- 本场识别：[主队 vs 客队 / 赛事 / 日期时间]
- 有效来源：[列出确认同时匹配本场双方球队与日期/赛事背景的来源；没有则写“暂无可靠来源”]
- 剔除线索：[列出不是本场的来源或摘要，例如只涉及其他对手、日期不符、无来源综合答案]
- 情报可靠度：[高/中/低；若有效来源不足，后续伤停、首发和动机只能标“待确认”]

## 🔍 赛前情报核实（只允许基于有效来源 + 你自己的联网复核）
- 主队最新动态：[伤停/首发/状态/动机 + 信息来源或时效标注；无可靠来源则写待确认]
- 客队最新动态：[同上]
- 关键变量：[影响走势的最关键1-3个因素]
- 球队画像采信：[是否匹配双方；画像验证状态；基础实力/风格/核心球员只作20%辅助修正的具体作用]
- 与知识规则/量化模型/球队画像的差异：[有效情报是否支持或修正规则引擎、量化模型、球队画像的假设？具体说明]

## 🧠 欧赔三项组合解读（必须先输出，专家框架强制执行）
- **实力定位**：[主队档位/客队档位；豪门/准强/中上/中游/中下/弱队；理论赔率骨架区间]
- **三态判断**：[实盘/中庸/韬光；判断依据（赔率位置是否符合理论骨架）]
- **分布类型**：[顺分布/逆分布/缓冲分布/中庸分布；是否存在一致性陷阱]
- **低赔功能**：[实盘支撑/低赔诱盘/韬光保护；具体分析]
- **平赔角色**：[真实平局/分散/过渡/缓冲/阻挡/非平平赔；判断依据]
- **高赔功能**：[冷门保护/高赔诱导/真实冷门；分析]
- **Del135数字心理**：[是否触发敏感位2.50/2.87/1.57/1.73/1.75/1.80；残缺平衡/尾数规律]
- **综合欧赔结论**：[三项组合讲的是什么故事；实盘方向是否清晰]

## 🧠 盘口总控 v4 复核（必须输出）
- MARKET_COMMAND_JSON：[云端存在/云端不存在/本地存根无效；只有 _source=cloud 才写云端存在，若为 local_stub/local_stub_error/本地存根必须写“本地存根无效，不采信”]
- 历史基线与当前读盘：[仅云端存在时引用 historyBaseline/currentMarketRead；云端不存在时写“云端未返回，不能用本地存根历史基线”]
- 盘口剧本：[强队穿盘/赢球不穿/下盘小球/大热陷阱/下盘大球/临场高波动/观望局]
- 反证审判是否足以推翻：[否/是；若是，必须归入核心伤停/首发重大轮换/战意结构反转/临场盘口反向变动/数据采集错误]
- MARKET_VERDICT_JSON：[存在/不存在；引用 headline、bookmakerIntent、executionPlan]
- R01-R14盘赔共振：[引用 marketResonance.topRule 的规则ID、星级、白话解释；说明采信/降级/推翻]
- 最优玩法与回避玩法：[仅云端 MARKET_COMMAND_JSON 存在时引用执行命令；本地存根无效时不得引用其观望/执行命令]
- 仓位纪律、临场复核点、赛后复盘点：[给出低/中/高仓和赛前复核条件]

## 🎯 专业盘口增强层 PRO_MARKET_JSON 复核（如报告存在必须输出）
- 存在性：[存在/不存在；若存在，引用 version/source/marketCommandSource]
- edge/risk/CLV准备：[引用 score.edgeScore、score.riskScore、score.clvReadiness、confidenceDelta；说明支持加固/降仓/等待临场]
- 欧亚缺口/平赔大小球联动：[引用 euroAsianGap、ouDrawLink、movementRead 的关键结论]
- 进球现实层：[必须引用 goalReality.status、recentCombinedAvg、bigBallAvg、expectedGoals、blocksBlindUnder；若缺失，说明大小球只能低仓/待临场]
- 人工盘口仲裁：[必须引用 humanArbitration.resultStatus、handicapCoverStatus、totalGoalsStatus、goalRealityStatus、stakeCap、gates、outputGuards；若没有该字段，也必须按同等逻辑手工仲裁]
- 陷阱纪律：[必须引用 trapDiscipline.hasTrap、affectedMarkets、localDowngrades、forbiddenInferences；说明陷阱只影响哪些玩法，明确不得自动反向]
- 量化价值与CLV纪律：[引用 valueRead、clvChecklist；不得因单一 valueBet 覆盖云端 MARKET_COMMAND_JSON]
- 中高价值准入：[必须引用 valueAdmission.level、valueTier、strongValueSignal、allowMediumHigh、allowHigh、highValueEvidence/evidence/missing/blockers；硬阻断禁止高/中高价值，强信号通过则必须给出候选]
- 对仓位影响：[加固/低仓/降仓/观望/等待临场；必须说明是局部玩法降级还是五类重大反证]

## 🧠 对知识库规则的采信判断
- 命中规则采信：[列出最关键2-4条规则ID，说明采信/不采信理由]
- 风险与冲突：[blockedBy/conflicts 是否要求降级、观望或低仓]
- 规则外变量：[哪些伤停、动机、赛程、天气或阵容信息是规则未捕捉到的]

## 🧮 对量化模型的采信判断
- 去水概率：[是否采信？为什么]
- 泊松进球模型：[λ估计是否合理？本场是否有模型未捕捉的因素需要修正]
- 价值识别：[模型标出的价值点，结合情报后是否依然成立]

## 📈 价值差与战意体系修正
- 市场共识概率：[3-5家欧赔去水均值；数据不足则说明]
- 价值差结论：[平局低估≥8pct/赢球输盘≥10pct/大小球偏差>0.5球 等是否触发；无差值则写"价值不足，不投"]
- 战意与体系修正：[战意分差≥2时可压过纸面实力；战术克制如何修正xG；修正结论是否改变盘口总控方向]

## 🧑‍⚖️ 人工盘口分析师仲裁（必须输出，解决“规则多但建议不准”）
- 胜平负方向：[主胜/客胜/平局/不败；说明这是“谁更可能赢”，不是投注价值]
- 亚让穿盘方向：[当前让幅+水位；说明是否能穿当前盘口。深让≥1.25时，遇小球低水、低比分风险、量化冲突、riskScore高或数据缺失，必须降级]
- 大小球方向：[独立证据链；必须先写进球现实层：近期总进球/大球率/模型总进球/盘口水位。若历史常见3-4球或 goalReality.blocksBlindUnder=true，禁止只凭小球低水推荐小球，必须解释反向定价证据或改为观望]
- 价值与仓位：[读取 valueAdmission 与 humanArbitration.stakeCap；硬阻断只能低价值/不入TOP/观望；strongValueSignal=true 时必须说明为何可列强信号中高价值候选]
- 输出一致性检查：[盘口数字和中文名必须一致；球半=-1.5/1.5，半球=-0.5/0.5，禁止“-0.5（球半）”]

## 🎯 终局裁决（唯一方向，禁止模棱两可）
**主推玩法**：[必须给出唯一方向；如果仲裁层判定 handicapCoverStatus=downgraded/blocked，则禁止把深让盘作为主推，改为胜平负/让浅盘候选或观望。若确实无法裁决，只能写"本场观望，不投"。]
**与系统预测对比**：[系统预测方向为 X，AI综合裁决方向为 Y；若一致则写"一致支持"；若不一致则说明AI取舍理由，必须归入五类重大证据之一；若只是从“强队穿盘”降级为“强队胜/低仓”，属于玩法层降级，不算反向推翻。]
**裁决依据**：[一句话：来自庄家盘口总控/R01-R14共振/知识规则，结合人工仲裁层如何处理冲突]

## 🧯 爆冷风险与冷门双轨裁决
- 风险等级采信：[采信/部分采信/不采信本地风险画像 + 理由]
- 主方向：[更可能方向/主推玩法；说明是否可投与仓位]
- 冷门候选：[引用 PRO_MARKET_JSON.upsetRead 或 upsetCandidate 的 valueStatus/valueLabel/paths；区分“防冷保险”与“冷门价值观察”]
- 爆冷触发因素：[强队低赔不足/热门过热/平赔防冷/盘口冲突/伤停轮换/战意不明等]
- 冷门触发与失效：[触发条件/失效条件；临场未触发时不得反向下注]
- 对冲/保护提示：[双重机会/让球保护/平局保险/冷门小注保险/高风险谨慎提示，不能替用户直接放弃]
- 仓位纪律：[按分数凯利折扣给出低/中/高仓；高风险/R-MR陷阱/CLV缺失或CLV-时只能对命中玩法低仓或观望，禁止高价值与串关胆；但不得把该门控改写成反向推荐]

## 🏆 全场预测
### 亚让盘
- 推荐：[具体方向]
- ✅ 支持因素 / ⚠️ 风险因素
- 赔率与盘口解读：[结合水位异动与量化edge]
- 信心度：[0-100%]
### 大小球
- 推荐：[大/小 + 进球线；证据不足或进球现实与盘口冲突则写“待临场确认”]
- ✅ 支持：[至少两类同向证据，必须包含进球现实层或解释其缺失] / ⚠️ 风险：[至少一个反证检查；历史高进球却推小球时必须解释反向定价；缺场均进失球/首发/临场水位时不得标中高价值] / 赔率解读 / 信心度
### 角球
- 推荐 + 理由 + 信心度

## 🕐 半场预测
- 半场亚盘 / 半场大小球 / 半场角球 + 理由 + 信心度

## 🔢 比分预测
- 给出3个最可能比分及概率（参考但不照抄泊松TopScores，可结合情报调整）+ 依据

## 💰 投注建议（综合裁决，非照抄模型）
| 投注项目 | 推荐方向 | 当前赔率 | 价值评估 | 建议仓位 |
|---------|---------|---------|---------|---------|
| 全场亚盘 | ... | ... | 高/中高/中/低价值（必须受valueAdmission约束） | 低/中/高仓 |
| 全场大小球 | ... | ... | ... | ... |
| 全场角球 | ... | ... | ... | ... |
| 半场亚盘 | ... | ... | ... | ... |
| 比分 | ... | ... | ... | ... |

> 价值评估须综合"量化edge + PRO_MARKET_JSON.valueAdmission + 实时情报"给出；valueAdmission.blockers/level=blocked 时禁止出现“中高价值/高价值”；valueAdmission.strongValueSignal=true 时不得继续机械写“观望/低价值”，必须给出“强信号中高价值候选”并列 highValueEvidence 与仓位封顶；大小球证据不足时不得进入重点关注或TOP推荐。

## ⚠️ 风险提示与辩证总结
- 最大不确定因素 / 数据矛盾点 / 庄家陷阱警示
- 风险分层：重点关注 / 低仓观察 / 高风险提示，并说明原因；高风险、R-MR陷阱、CLV?或CLV-只限制命中的玩法与仓位，不得跨玩法把所有方向压成低价值；若强信号准入通过，必须解释风险如何被仓位封顶吸收
- 信息时效说明：[你检索到的情报截至何时]

## 📊 综合评分
- 数据可靠度：[高/中/低] | 情报充分度：[高/中/低]
- 综合推荐信心：[0-100%]
- 重点关注：[最值得关注的1-2个方向 + 理由]${skillBlock}`;
  }

  async _callProvider(prompt, settings, opts = {}) {
    if (settings.provider === 'openai') return await this._callOpenAI(prompt, settings, opts);
    if (settings.provider === 'claude') return await this._callClaude(prompt, settings, opts);
    if (settings.provider === 'custom') return await this._callCustom(prompt, settings, opts);
    throw new Error('未知 AI 提供商');
  }

  _normalizeDebateAgents(value) {
    if (!value) return [];
    let agents = [];
    if (Array.isArray(value)) agents = value;
    else {
      const text = String(value).trim();
      if (!text) return [];
      try {
        const parsed = JSON.parse(text);
        agents = Array.isArray(parsed) ? parsed : [];
      } catch {
        agents = text.split('\n').map((line, i) => {
          const parts = line.split('|').map(s => s.trim());
          return { name: parts[0] || `辩论AI-${i + 1}`, provider: parts[1] || 'custom', model: parts[2] || '', customEndpoint: parts[3] || '', apiKey: parts[4] || '' };
        });
      }
    }
    return agents.filter(a => a && (a.enabled !== false)).slice(0, 5);
  }

  _mergeAgentSettings(base, agent = {}) {
    return {
      ...base,
      provider: agent.provider || base.provider,
      apiKey: agent.apiKey ?? base.apiKey,
      model: agent.model || base.model,
      customEndpoint: agent.customEndpoint || agent.endpoint || base.customEndpoint,
      deepStream: agent.stream ?? base.deepStream
    };
  }

  async _readOpenAIStream(resp, onDelta) {
    const reader = resp.body?.getReader?.();
    if (!reader) throw new Error('当前环境不支持读取流式响应');
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let content = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim();
        if (!s || !s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content || json.choices?.[0]?.message?.content || '';
          if (delta) {
            content += delta;
            onDelta?.(delta);
          }
        } catch {}
      }
    }
    return content;
  }

  async _callOpenAI(prompt, settings, opts = {}) {
    const maxTokens = opts.deep ? 30000 : 25000;
    const body = {
      model: settings.model || 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.3,
      stream: !!opts.stream
    };
    // 深度模式启用联网搜索工具（兼容支持 web_search 的模型，不支持会被忽略）
    if (opts.deep) {
      body.tools = [{ type: 'web_search' }];
      body.tool_choice = 'auto';
    }
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${resp.status}`);
    }
    if (opts.stream) {
      const content = await this._readOpenAIStream(resp, opts.onDelta);
      return {
        provider: 'openai',
        model: settings.model || 'gpt-4o',
        content,
        tokens: undefined,
        streamed: true,
        generatedAt: new Date().toISOString()
      };
    }
    const data = await resp.json();
    return {
      provider: 'openai',
      model: data.model,
      content: data.choices[0].message.content,
      tokens: data.usage?.total_tokens,
      generatedAt: new Date().toISOString()
    };
  }

  async _callClaude(prompt, settings, opts = {}) {
    const maxTokens = opts.deep ? 30000 : 25000;
    const body = {
      model: settings.model || 'claude-3-5-sonnet-20241022',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    };
    // 深度模式启用 Claude 原生联网搜索工具
    if (opts.deep) {
      body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
    }
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    // 联网工具调用会产生多个 content block，需拼接所有 text 块
    const text = Array.isArray(data.content)
      ? data.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
      : (data.content?.[0]?.text || '');
    return {
      provider: 'claude',
      model: data.model,
      content: text,
      tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
      generatedAt: new Date().toISOString()
    };
  }

  _resolveCustomEndpoint(settings = {}) {
    // 自定义接口支持两种写法：
    // 1) 完整请求 URL：.../v1/chat/completions 或服务商自定义完整路径 → 原样请求
    // 2) OpenAI 兼容 Base URL：.../v1 → 仅补 /chat/completions，避免 POST /v1 触发 Invalid URL
    // 注意：不再把裸域名强行补成 /v1/chat/completions，裸域名/特殊路径按用户填写原样请求。
    const raw = String(settings.customEndpoint || 'http://localhost:11434/v1').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(raw)) {
      throw new Error(`自定义接口地址无效，请填写完整 http(s) URL：${raw || '(空)'}`);
    }
    let url;
    try { url = new URL(raw); } catch (e) {
      throw new Error(`自定义接口地址格式错误：${raw}`);
    }
    const pathname = url.pathname.replace(/\/+$/, '');
    if (/\/v1$/i.test(pathname) && !/\/chat\/completions$/i.test(pathname)) {
      url.pathname = `${pathname}/chat/completions`;
      return url.toString().replace(/\/+$/, '');
    }
    return raw;
  }

  async _callCustom(prompt, settings, opts = {}) {
    // 支持自定义 OpenAI 兼容接口（DeepSeek、Ollama、本地模型等）。
    // 注意：这里不再自动补全路径，用户在设置页填什么就请求什么。
    const endpoint = this._resolveCustomEndpoint(settings);

    const headers = { 'Content-Type': 'application/json' };
    if (settings.apiKey) {
      headers['Authorization'] = `Bearer ${settings.apiKey}`;
    }

    let resp;
    try {
      resp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: settings.model || 'deepseek-chat',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: opts.deep ? 6000 : 2500,
          temperature: 0.3,
          stream: !!opts.stream
        })
      });
    } catch (fetchErr) {
      throw new Error(`无法连接到自定义端点 ${endpoint}：${fetchErr.message}`);
    }

    if (!resp.ok) {
      let errMsg = `HTTP ${resp.status}`;
      try {
        const errBody = await resp.json();
        errMsg = errBody.error?.message || errBody.message || errMsg;
      } catch {}
      throw new Error(`自定义接口错误 [${endpoint}]: ${errMsg}`);
    }

    if (opts.stream) {
      const content = await this._readOpenAIStream(resp, opts.onDelta);
      if (!content) throw new Error(`自定义接口流式响应为空 [${endpoint}]`);
      return {
        provider: 'custom',
        model: settings.model,
        content,
        tokens: undefined,
        streamed: true,
        generatedAt: new Date().toISOString()
      };
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(`自定义接口响应格式异常: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return {
      provider: 'custom',
      model: data.model || settings.model,
      content,
      tokens: data.usage?.total_tokens,
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * 多轮对话 - messages: [{role:'user'|'assistant'|'system', content:'...'}]
   * systemContext: 报告原文（作为 system 背景）
   */
  async chat(messages, systemContext) {
    const settings = await this._getSettings();
    if (!settings.apiKey && settings.provider !== 'custom') {
      return { error: '请先配置 AI API Key', needConfig: true };
    }
    const fullMessages = systemContext
      ? [{ role: 'system', content: `你是一位顶级足球数据分析师，精通亚盘、大小球盘口分析、赔率解读和足球战术分析。
你的分析原则：
1. 结合你所知道的最新球队动态（伤停、阵容、状态、转会等）
2. 辩证思维：从正反两面分析，指出支持和反对的证据
3. 赔率解读：分析水位变化背后的庄家意图
4. 交叉验证：多维度数据互相印证，矛盾时明确指出
5. 读盘优先：先完成欧赔去水概率、欧亚转换、亚盘水位、大小球联动、战意/体系修正，再回答用户问题

${this._marketReadingDoctrine()}

以下是当前比赛的完整数据报告：
${systemContext}

请基于以上数据和你的知识库回答用户问题，给出真实准确的分析。` }, ...messages]
      : messages;
    try {
      if (settings.provider === 'openai') return await this._chatOpenAI(fullMessages, settings);
      if (settings.provider === 'claude') return await this._chatClaude(fullMessages, settings);
      if (settings.provider === 'custom') return await this._chatCustom(fullMessages, settings);
      return { error: '未知 AI 提供商' };
    } catch (err) {
      return { error: `AI 调用失败: ${err.message}` };
    }
  }

  async _chatOpenAI(messages, settings) {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
      body: JSON.stringify({ model: settings.model || 'gpt-4o', messages, max_tokens: 2000, temperature: 0.3 })
    });
    if (!resp.ok) { const e = await resp.json().catch(()=>({})); throw new Error(e.error?.message || `HTTP ${resp.status}`); }
    const data = await resp.json();
    return { provider:'openai', model:data.model, content:data.choices[0].message.content, tokens:data.usage?.total_tokens, generatedAt:new Date().toISOString() };
  }

  async _chatClaude(messages, settings) {
    const systemMsg = messages[0]?.role === 'system' ? messages[0].content : '';
    const userMessages = systemMsg ? messages.slice(1) : messages;
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: settings.model || 'claude-3-5-sonnet-20241022', max_tokens: 2000, system: systemMsg || undefined, messages: userMessages })
    });
    if (!resp.ok) { const e = await resp.json().catch(()=>({})); throw new Error(e.error?.message || `HTTP ${resp.status}`); }
    const data = await resp.json();
    return { provider:'claude', model:data.model, content:data.content[0].text, tokens:(data.usage?.input_tokens||0)+(data.usage?.output_tokens||0), generatedAt:new Date().toISOString() };
  }

  async _chatCustom(messages, settings) {
    const endpoint = this._resolveCustomEndpoint(settings);
    const headers = { 'Content-Type': 'application/json' };
    if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;
    // 合并 system 消息到首条 user 消息（部分接口不支持 system role）
    let msgs = [...messages];
    if (msgs[0]?.role === 'system') {
      const sys = msgs.shift();
      if (msgs[0]?.role === 'user') msgs[0] = { role:'user', content: sys.content + '\n\n' + msgs[0].content };
    }
    let resp;
    try {
      resp = await fetch(endpoint, { method:'POST', headers, body: JSON.stringify({ model: settings.model||'deepseek-chat', messages: msgs, max_tokens:2000, temperature:0.3, stream:false }) });
    } catch (fe) { throw new Error(`无法连接 ${endpoint}：${fe.message}`); }
    if (!resp.ok) { let m=`HTTP ${resp.status}`; try{const b=await resp.json();m=b.error?.message||b.message||m;}catch{} throw new Error(`[${endpoint}] ${m}`); }
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error(`响应格式异常: ${JSON.stringify(data).slice(0,200)}`);
    return { provider:'custom', model:data.model||settings.model, content, tokens:data.usage?.total_tokens, generatedAt:new Date().toISOString() };
  }

  async _getSettings() {
    const result = await chrome.storage.sync.get(['aiProvider', 'aiApiKey', 'aiModel', 'aiCustomEndpoint', 'tavilyApiKey', 'aiDeepStream', 'aiDebateEnabled', 'aiDebateAgents']);
    return {
      provider: result.aiProvider || 'openai',
      apiKey: result.aiApiKey || '',
      model: result.aiModel || '',
      customEndpoint: result.aiCustomEndpoint || '',
      tavilyApiKey: result.tavilyApiKey || '',
      deepStream: result.aiDeepStream !== false,
      debateEnabled: !!result.aiDebateEnabled,
      debateAgents: result.aiDebateAgents || ''
    };
  }
}
