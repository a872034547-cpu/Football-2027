/**
 * qqOneBotPusher.js
 * QQ 推送适配器，通过 NapCatQQ + OneBot 11 HTTP API 发送消息
 * 支持群消息和私聊消息
 * 配置项：ONEBOT_BASE_URL / ONEBOT_ACCESS_TOKEN / ONEBOT_TARGET_TYPE / ONEBOT_TARGET_ID
 */

const ONEBOT_TIMEOUT_MS = 15000;

/**
 * 发送消息（文本）
 * @param {Object} config
 * @param {string} config.baseUrl          OneBot HTTP 服务地址
 * @param {string} [config.accessToken]    认证 Token
 * @param {string} config.targetType       'group' | 'private'
 * @param {string} config.targetId         群号或 QQ 号
 * @param {string} text                    消息文本
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function sendText(config, text) {
  const { baseUrl, accessToken, targetType, targetId } = normalizeConfig(config);
  if (!baseUrl || !targetId) {
    return { ok: false, error: 'OneBot 配置不完整（缺少 baseUrl 或 targetId）' };
  }

  const action = targetType === 'private' ? 'send_private_msg' : 'send_group_msg';
  const body = targetType === 'private'
    ? { user_id: Number(targetId), message: text }
    : { group_id: Number(targetId), message: text };

  return callOneBot(baseUrl, action, body, accessToken);
}

/**
 * 推送今日总览报告
 * @param {Object} config
 * @param {Object} report
 */
export async function pushDailyReport(config, report) {
  const { baseUrl, accessToken, targetType, targetId } = normalizeConfig(config);
  if (!baseUrl || !targetId) {
    return { ok: false, error: 'OneBot 配置不完整' };
  }

  const dateStr = report?.date || formatToday();
  const matches = report?.rankedMatches || [];
  const topMatches = matches.slice(0, 5);

  const lines = [
    `⚽ 足球预测今日报告 ${dateStr}`,
    `📊 今日共 ${matches.length} 场比赛完成分析`,
  ];

  if (report?.portfolio?.stable?.length > 0) {
    lines.push('');
    lines.push('✅ 稳健方案组合：');
    for (const plan of report.portfolio.stable) {
      lines.push(`· ${plan.home} vs ${plan.away} — ${plan.direction} ${riskBadge(plan.riskLevel)}`);
    }
  }

  if (topMatches.length > 0) {
    lines.push('');
    lines.push('🔝 TOP 可信排行：');
    for (let i = 0; i < topMatches.length; i++) {
      const m = topMatches[i];
      lines.push(`${i + 1}. ${m.home} vs ${m.away} [评分 ${m.rankScore ?? '-'}] ${riskBadge(m.riskLevel)}`);
    }
  }

  if (report?.warnings?.length > 0) {
    lines.push('');
    lines.push('⚠️ 风险提醒：');
    for (const w of report.warnings.slice(0, 3)) {
      lines.push(`· ${w}`);
    }
  }

  if (report?.publicReportUrl) {
    lines.push('');
    lines.push(`📋 完整报告：${report.publicReportUrl}`);
  }

  // QQ 消息无 Markdown 格式，纯文本
  const text = lines.join('\n');

  const action = targetType === 'private' ? 'send_private_msg' : 'send_group_msg';
  const body = targetType === 'private'
    ? { user_id: Number(targetId), message: text }
    : { group_id: Number(targetId), message: text };

  return callOneBot(baseUrl, action, body, accessToken);
}

/**
 * 推送单场比赛摘要
 */
export async function pushMatchSummary(config, matchReport) {
  const m = matchReport;

  const lines = [
    `⚽ ${m.home} vs ${m.away}`,
    `🏆 ${m.league || '未知联赛'}  ${m.matchTime || ''}`,
    `主胜 ${fmtPct(m.probabilities?.home)} / 平 ${fmtPct(m.probabilities?.draw)} / 客胜 ${fmtPct(m.probabilities?.away)}`,
    `置信度：${m.confidence || '-'}  风险：${riskBadge(m.riskLevel)}`,
  ];

  if (m.trustedPlans?.length > 0) {
    lines.push(`✅ 推荐：${m.trustedPlans.map(p => p.direction || p).join(' / ')}`);
  }

  if (m.avoidPlans?.length > 0) {
    lines.push(`⛔ 回避：${m.avoidPlans.slice(0, 2).join(' / ')}`);
  }

  if (m.invalidIf?.length > 0) {
    lines.push(`❗ 失效条件：${m.invalidIf.slice(0, 2).join('；')}`);
  }

  return sendText(config, lines.join('\n'));
}

/**
 * 推送错误告警
 */
export async function pushErrorAlert(config, { title, message, context }) {
  const text = [
    `🚨 ${title || '系统告警'}`,
    `时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    '',
    message || '',
    context ? `上下文：${typeof context === 'object' ? JSON.stringify(context).slice(0, 200) : context}` : '',
  ].filter(Boolean).join('\n');

  return sendText(config, text);
}

// ─── 内部函数 ────────────────────────────────────────────────

async function callOneBot(baseUrl, action, params, accessToken) {
  const url = `${baseUrl.replace(/\/+$/, '')}/${action}`;

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ONEBOT_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify(params),
    });

    clearTimeout(timer);

    const json = await resp.json().catch(() => ({}));

    if (!resp.ok || json.retcode !== 0) {
      const msg = json.wording || json.message || `HTTP ${resp.status}`;
      return {
        ok: false,
        error: `OneBot API 错误 [${action}]: ${msg} (retcode=${json.retcode})`,
        raw: json,
      };
    }

    return { ok: true, data: json.data };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return { ok: false, error: `QQ OneBot 推送超时（${ONEBOT_TIMEOUT_MS}ms）` };
    }
    return { ok: false, error: `QQ OneBot 推送失败: ${err.message}` };
  }
}

function normalizeConfig(config) {
  return {
    baseUrl: config?.baseUrl || config?.ONEBOT_BASE_URL || '',
    accessToken: config?.accessToken || config?.ONEBOT_ACCESS_TOKEN || '',
    targetType: config?.targetType || config?.ONEBOT_TARGET_TYPE || 'group',
    targetId: String(config?.targetId || config?.ONEBOT_TARGET_ID || ''),
  };
}

function fmtPct(v) {
  if (v == null || v === '') return '-';
  const n = parseFloat(v);
  if (isNaN(n)) return '-';
  return n < 1 ? `${Math.round(n * 100)}%` : `${Math.round(n)}%`;
}

function riskBadge(level) {
  const map = { low: '低', medium_low: '中低', medium: '中', medium_high: '中高', high: '高' };
  return level ? `[风险:${map[level] || level}]` : '';
}

function formatToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}
