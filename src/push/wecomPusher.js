/**
 * wecomPusher.js
 * 企业微信群机器人推送适配器
 * 支持文本、markdown、图文消息
 * Webhook 格式：https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
 */

const WECOM_TIMEOUT_MS = 15000;

/**
 * 发送文本消息
 * @param {string} webhook
 * @param {string} text
 * @param {string[]} [mentionList]  @指定成员的 userid 列表
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function sendText(webhook, text, mentionList = []) {
  const body = {
    msgtype: 'text',
    text: {
      content: text,
      mentioned_list: mentionList,
    },
  };
  return doSend(webhook, body);
}

/**
 * 发送 Markdown 消息（企业微信 markdown 子集）
 * @param {string} webhook
 * @param {string} markdown
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function sendMarkdown(webhook, markdown) {
  const body = {
    msgtype: 'markdown',
    markdown: { content: markdown },
  };
  return doSend(webhook, body);
}

/**
 * 推送今日总览报告
 * @param {Object} config
 * @param {string} config.webhook
 * @param {Object} report
 */
export async function pushDailyReport(config, report) {
  if (!config?.webhook) {
    return { ok: false, error: '未配置 WECOM_WEBHOOK' };
  }

  const dateStr = report?.date || formatToday();
  const matches = report?.rankedMatches || [];
  const topMatches = matches.slice(0, 5);

  const lines = [
    `## ⚽ 足球预测今日报告 ${dateStr}`,
    `> 今日共 **${matches.length}** 场比赛完成分析`,
  ];

  if (report?.portfolio?.stable?.length > 0) {
    lines.push('\n**✅ 稳健方案组合：**');
    for (const plan of report.portfolio.stable) {
      lines.push(`> ${plan.home} vs ${plan.away} — **${plan.direction}** ${riskBadge(plan.riskLevel)}`);
    }
  }

  if (topMatches.length > 0) {
    lines.push('\n**🔝 TOP 可信排行：**');
    for (let i = 0; i < topMatches.length; i++) {
      const m = topMatches[i];
      lines.push(`> ${i + 1}. ${m.home} vs ${m.away} [评分 ${m.rankScore ?? '-'}] ${riskBadge(m.riskLevel)}`);
    }
  }

  if (report?.warnings?.length > 0) {
    lines.push('\n**⚠️ 风险提醒：**');
    for (const w of report.warnings.slice(0, 3)) {
      lines.push(`> · ${w}`);
    }
  }

  if (report?.publicReportUrl) {
    lines.push(`\n[📋 查看完整报告](${report.publicReportUrl})`);
  }

  // 企微 Markdown 有 4096 字符限制，超出截断
  let md = lines.join('\n');
  if (md.length > 4000) {
    md = md.slice(0, 4000) + '\n\n...(内容截断，请访问报告链接查看)';
  }

  return sendMarkdown(config.webhook, md);
}

/**
 * 推送单场比赛摘要
 */
export async function pushMatchSummary(config, matchReport) {
  if (!config?.webhook) {
    return { ok: false, error: '未配置 WECOM_WEBHOOK' };
  }

  const m = matchReport;
  const lines = [
    `## ⚽ ${m.home} vs ${m.away}`,
    `> **${m.league || '未知联赛'}**  ${m.matchTime || ''}`,
    '',
    `主胜 **${fmtPct(m.probabilities?.home)}** / 平 **${fmtPct(m.probabilities?.draw)}** / 客胜 **${fmtPct(m.probabilities?.away)}**`,
    `置信度：${m.confidence || '-'}  风险：${riskBadge(m.riskLevel)}`,
  ];

  if (m.trustedPlans?.length > 0) {
    lines.push(`\n✅ 推荐方向：**${m.trustedPlans.map(p => p.direction || p).join(' / ')}**`);
  }

  if (m.avoidPlans?.length > 0) {
    lines.push(`⛔ 回避：${m.avoidPlans.slice(0, 2).join(' / ')}`);
  }

  if (m.invalidIf?.length > 0) {
    lines.push(`❗ 失效条件：${m.invalidIf.slice(0, 2).join('；')}`);
  }

  return sendMarkdown(config.webhook, lines.join('\n'));
}

/**
 * 推送错误告警
 */
export async function pushErrorAlert(config, { title, message, context }) {
  if (!config?.webhook) return { ok: false, error: '未配置 WECOM_WEBHOOK' };

  const md = [
    `## 🚨 ${title || '系统告警'}`,
    `> 时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    '',
    message || '',
    context ? `\n上下文：\`${typeof context === 'object' ? JSON.stringify(context).slice(0, 200) : context}\`` : '',
  ].filter(Boolean).join('\n');

  return sendMarkdown(config.webhook, md);
}

// ─── 内部函数 ────────────────────────────────────────────────

async function doSend(webhook, body) {
  if (!webhook) return { ok: false, error: 'webhook 未配置' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WECOM_TIMEOUT_MS);

  try {
    const resp = await fetch(webhook, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });

    clearTimeout(timer);

    const json = await resp.json().catch(() => ({}));

    if (!resp.ok || json.errcode !== 0) {
      const msg = json.errmsg || `HTTP ${resp.status}`;
      return { ok: false, error: `企业微信 API 错误: ${msg} (code=${json.errcode})`, raw: json };
    }

    return { ok: true };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return { ok: false, error: `企业微信推送超时（${WECOM_TIMEOUT_MS}ms）` };
    }
    return { ok: false, error: err.message };
  }
}

function fmtPct(v) {
  if (v == null || v === '') return '-';
  const n = parseFloat(v);
  if (isNaN(n)) return '-';
  return n < 1 ? `${Math.round(n * 100)}%` : `${Math.round(n)}%`;
}

function riskBadge(level) {
  const map = { low: '🟢低', medium_low: '🟡中低', medium: '🟡中', medium_high: '🟠中高', high: '🔴高' };
  return map[level] || level || '';
}

function formatToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}
