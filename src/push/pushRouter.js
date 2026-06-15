/**
 * pushRouter.js
 * 推送路由：统一调度飞书 / 企微 / QQ OneBot，并写入推送日志
 * 各通道独立，失败不阻断其他通道
 */

import * as feishu from './feishuPusher.js';
import * as wecom from './wecomPusher.js';
import * as qq from './qqOneBotPusher.js';

/**
 * 推送今日总览报告到所有已配置的通道
 * @param {Object} config       来自 server/src/config.js 的 config 对象
 * @param {Object} report       今日 portfolio 报告
 * @param {Function} [logPush]  可选：写入 push_log 的回调，接受 (channel, status, message)
 * @returns {Promise<PushResult[]>}
 */
export async function pushDailyReportToAll(config, report, logPush) {
  const channels = resolvePushChannels(config);
  const results = await Promise.allSettled(channels.map(ch => pushChannel(ch, config, report, 'daily')));
  return collectResults(channels, results, logPush);
}

/**
 * 推送单场比赛摘要到所有已配置的通道
 * @param {Object} config
 * @param {Object} matchReport
 * @param {Function} [logPush]
 * @returns {Promise<PushResult[]>}
 */
export async function pushMatchSummaryToAll(config, matchReport, logPush) {
  const channels = resolvePushChannels(config);
  const results = await Promise.allSettled(channels.map(ch => pushChannel(ch, config, matchReport, 'match')));
  return collectResults(channels, results, logPush);
}

/**
 * 推送错误告警到所有已配置的通道
 * @param {Object} config
 * @param {{title: string, message: string, context?: any}} alert
 * @param {Function} [logPush]
 * @returns {Promise<PushResult[]>}
 */
export async function pushErrorAlertToAll(config, alert, logPush) {
  const channels = resolvePushChannels(config);
  const results = await Promise.allSettled(channels.map(ch => pushChannel(ch, config, alert, 'error')));
  return collectResults(channels, results, logPush);
}

/**
 * 推送到指定单个通道
 * @param {'feishu'|'wecom'|'onebot'} channel
 * @param {Object} config
 * @param {Object} payload
 * @param {'daily'|'match'|'error'} type
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function pushToChannel(channel, config, payload, type = 'daily') {
  return pushChannel(channel, config, payload, type);
}

// ─── 内部函数 ────────────────────────────────────────────────

async function pushChannel(channel, config, payload, type) {
  try {
    switch (channel) {
      case 'feishu': {
        const feishuCfg = {
          webhook: config.feishuWebhook || config.FEISHU_WEBHOOK,
          secret: config.feishuSecret || config.FEISHU_SECRET,
        };
        if (type === 'daily') return await feishu.pushDailyReport(feishuCfg, payload);
        if (type === 'match') return await feishu.pushMatchSummary(feishuCfg, payload);
        if (type === 'error') return await feishu.pushErrorAlert(feishuCfg, payload);
        break;
      }

      case 'wecom': {
        const wecomCfg = {
          webhook: config.wecomWebhook || config.WECOM_WEBHOOK,
        };
        if (type === 'daily') return await wecom.pushDailyReport(wecomCfg, payload);
        if (type === 'match') return await wecom.pushMatchSummary(wecomCfg, payload);
        if (type === 'error') return await wecom.pushErrorAlert(wecomCfg, payload);
        break;
      }

      case 'onebot': {
        const qqCfg = {
          baseUrl: config.onebotBaseUrl || config.ONEBOT_BASE_URL,
          accessToken: config.onebotAccessToken || config.ONEBOT_ACCESS_TOKEN,
          targetType: config.onebotTargetType || config.ONEBOT_TARGET_TYPE || 'group',
          targetId: config.onebotTargetId || config.ONEBOT_TARGET_ID,
        };
        if (type === 'daily') return await qq.pushDailyReport(qqCfg, payload);
        if (type === 'match') return await qq.pushMatchSummary(qqCfg, payload);
        if (type === 'error') return await qq.pushErrorAlert(qqCfg, payload);
        break;
      }

      default:
        return { ok: false, error: `未知推送通道: ${channel}` };
    }

    return { ok: false, error: `未知消息类型: ${type}` };
  } catch (err) {
    return { ok: false, error: `[${channel}] 推送异常: ${err.message}` };
  }
}

/**
 * 从配置解析启用的推送通道列表
 * @param {Object} config
 * @returns {string[]}
 */
function resolvePushChannels(config) {
  const channels = [];

  const auto = config.autoPushChannels || config.AUTO_PUSH_CHANNELS || [];
  const autoArr = Array.isArray(auto) ? auto : String(auto).split(',').map(s => s.trim()).filter(Boolean);

  // 检查通道是否已配置（有 webhook/baseUrl）
  for (const ch of autoArr) {
    if (ch === 'feishu' && (config.feishuWebhook || config.FEISHU_WEBHOOK)) {
      channels.push('feishu');
    } else if (ch === 'wecom' && (config.wecomWebhook || config.WECOM_WEBHOOK)) {
      channels.push('wecom');
    } else if (ch === 'onebot' && (config.onebotBaseUrl || config.ONEBOT_BASE_URL) && (config.onebotTargetId || config.ONEBOT_TARGET_ID)) {
      channels.push('onebot');
    } else if (ch && !['feishu', 'wecom', 'onebot'].includes(ch)) {
      console.warn(`[PushRouter] 未知推送通道被忽略: ${ch}`);
    }
  }

  if (channels.length === 0 && autoArr.length > 0) {
    console.warn('[PushRouter] AUTO_PUSH_CHANNELS 中的通道均未配置 Webhook/Token，本次推送跳过');
  }

  return [...new Set(channels)]; // 去重
}

/**
 * 收集 Promise.allSettled 结果
 */
function collectResults(channels, settledResults, logPush) {
  const results = settledResults.map((r, i) => {
    const ch = channels[i] || 'unknown';
    if (r.status === 'fulfilled') {
      const res = r.value || {};
      const pushResult = {
        channel: ch,
        ok: res.ok === true,
        error: res.ok ? null : (res.error || '推送失败（无错误信息）'),
      };
      safeLogPush(logPush, ch, pushResult.ok ? 'success' : 'error', pushResult.error || '');
      if (!pushResult.ok) {
        console.error(`[PushRouter] 通道 ${ch} 推送失败:`, pushResult.error);
      } else {
        console.log(`[PushRouter] 通道 ${ch} 推送成功`);
      }
      return pushResult;
    } else {
      const msg = r.reason?.message || String(r.reason);
      console.error(`[PushRouter] 通道 ${ch} 推送异常:`, msg);
      safeLogPush(logPush, ch, 'error', msg);
      return { channel: ch, ok: false, error: msg };
    }
  });

  return results;
}

function safeLogPush(logPush, channel, status, message) {
  if (!logPush) return;

  try {
    Promise.resolve(logPush(channel, status, message)).catch((err) => {
      console.warn(`[PushRouter] 推送日志写入失败: ${err?.message || err}`);
    });
  } catch (err) {
    console.warn(`[PushRouter] 推送日志写入失败: ${err?.message || err}`);
  }
}
