/**
 * feishuPusher.js
 * 飞书自定义机器人推送适配器
 * 支持文本消息、富文本（post）和互动卡片
 * 支持签名校验（secret 模式）
 */

import crypto from 'crypto';

const FEISHU_TIMEOUT_MS = 15000;

/**
 * 发送文本消息
 * @param {string} webhook
 * @param {string} text
 * @param {string} [secret]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function sendText(webhook, text, secret) {
  const body = { msg_type: 'text', content: { text } };
  return doSend(webhook, body, secret);
}

/**
 * 发送富文本（post）消息
 * 支持标题 + 多段落内容
 * @param {string} webhook
 * @param {{title: string, content: Array<Array<Object>>}} post
 * @param {string} [secret]
 */
export async function sendPost(webhook, post, secret) {
  const body = {
    msg_type: 'post',
    content: {
      post: {
        zh_cn: {
          title: post.title || '',
          content: post.content || [],
        },
      },
    },
  };
  return doSend(webhook, body, secret);
}

/**
 * 推送今日总览报告
 * @param {Object} config
 * @param {string} config.webhook
 * @param {string} [config.secret]
 * @param {Object} report  今日 portfolio 报告
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function pushDailyReport(config, report) {
  if (!config?.webhook) {
    return { ok: false, error: '未配置 FEISHU_WEBHOOK' };
  }

  const { webhook, secret } = config;
  const dateStr = report?.date || formatToday();
  const matches = report?.rankedMatches || [];
  const topMatches = matches.slice(0, 5);

  // 构建富文本内容
  const content = [];

  // 概要段落
  content.push([
    { tag: 'text', text: `📅 赛事日期：${dateStr}` },
  ]);
  content.push([
    { tag: 'text', text: `📊 今日共 ${matches.length} 场比赛完成分析` },
  ]);

  if (report?.portfolio?.stable?.length > 0) {
    content.push([{ tag: 'text', text: '' }]);
    content.push([{ tag: 'text', text: '✅ 稳健方案组合：' }]);
    for (const plan of report.portfolio.stable) {
      content.push([{ tag: 'text', text: `  · ${plan.home} vs ${plan.away} — ${plan.direction} ${riskBadge(plan.riskLevel)}` }]);
    }
  }

  if (topMatches.length > 0) {
    content.push([{ tag: 'text', text: '' }]);
    content.push([{ tag: 'text', text: '🔝 TOP 可信排行（按综合评分）：' }]);
    for (let i = 0; i < topMatches.length; i++) {
      const m = topMatches[i];
      content.push([
        {
          tag: 'text',
          text: `  ${i + 1}. ${m.home} vs ${m.away}  [评分 ${m.rankScore ?? '-'}] ${riskBadge(m.riskLevel)}`,
        },
      ]);
    }
  }

  if (report?.publicReportUrl) {
    content.push([{ tag: 'text', text: '' }]);
    content.push([
      { tag: 'a', text: '📋 查看完整报告', href: report.publicReportUrl },
    ]);
  }

  if (report?.warnings?.length > 0) {
    content.push([{ tag: 'text', text: '' }]);
    content.push([{ tag: 'text', text: '⚠️ 风险提醒：' }]);
    for (const w of report.warnings.slice(0, 3)) {
      content.push([{ tag: 'text', text: `  · ${w}` }]);
    }
  }

  return sendPost(webhook, {
    title: `⚽ 足球预测今日报告 ${dateStr}`,
    content,
  }, secret);
}

/**
 * 推送单场比赛摘要
 */
export async function pushMatchSummary(config, matchReport) {
  if (!config?.webhook) {
    return { ok: false, error: '未配置 FEISHU_WEBHOOK' };
  }

  const { webhook, secret } = config;
  const m = matchReport;

  const lines = [
    `⚽ ${m.home} vs ${m.away}`,
    `🏆 ${m.league || '未知联赛'}  ${m.matchTime || ''}`,
    `📊 主胜 ${fmtPct(m.probabilities?.home)} / 平 ${fmtPct(m.probabilities?.draw)} / 客胜 ${fmtPct(m.probabilities?.away)}`,
    `🎯 置信度：${m.confidence || '-'}  风险：${m.riskLevel || '-'}`,
  ];

  if (m.trustedPlans?.length > 0) {
    lines.push('');
    lines.push(`✅ 推荐方向：${m.trustedPlans.map(p => p.direction || p).join(' / ')}`);
  }

  if (m.avoidPlans?.length > 0) {
    lines.push(`⛔ 回避：${m.avoidPlans.slice(0, 2).join(' / ')}`);
  }

  if (m.invalidIf?.length > 0) {
    lines.push(`❗ 失效条件：${m.invalidIf.slice(0, 2).join('；')}`);
  }

  return sendText(webhook, lines.join('\n'), secret);
}

/**
 * 推送错误告警
 */
export async function pushErrorAlert(config, { title, message, context }) {
  if (!config?.webhook) return { ok: false, error: '未配置 FEISHU_WEBHOOK' };

  const text = [
    `🚨 ${title || '系统告警'}`,
    `时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    '',
    message || '',
    context ? `\n上下文：${typeof context === 'object' ? JSON.stringify(context) : context}` : '',
  ].filter(Boolean).join('\n');

  return sendText(config.webhook, text, config.secret);
}

// ─── 内部函数 ────────────────────────────────────────────────

async function doSend(webhook, body, secret) {
  if (!webhook) return { ok: false, error: 'webhook 未配置' };

  // 签名校验（secret 模式）
  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = genSign(timestamp, secret);
    body.timestamp = String(timestamp);
    body.sign = sign;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEISHU_TIMEOUT_MS);

  try {
    const resp = await fetch(webhook, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });

    clearTimeout(timer);

    const json = await resp.json().catch(() => ({}));

    if (!resp.ok || json.code !== 0) {
      const msg = json.msg || json.message || `HTTP ${resp.status}`;
      return { ok: false, error: `飞书 API 错误: ${msg}`, raw: json };
    }

    return { ok: true };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return { ok: false, error: `飞书推送超时（${FEISHU_TIMEOUT_MS}ms）` };
    }
    return { ok: false, error: err.message };
  }
}

function genSign(timestamp, secret) {
  const str = `${timestamp}\n${secret}`;
  return crypto.createHmac('sha256', str).digest('base64');
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
