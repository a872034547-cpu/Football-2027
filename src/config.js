import 'dotenv/config';

export function parseCsv(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function toNumber(value, defaultValue) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function toBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return String(value).trim() === '1' || String(value).trim().toLowerCase() === 'true';
}

export function maskSecret(value) {
  if (!value) return '';

  const secret = String(value);
  if (secret.length <= 4) return '*'.repeat(secret.length);
  if (secret.length <= 8) return `${secret.slice(0, 2)}${'*'.repeat(secret.length - 4)}${secret.slice(-2)}`;

  return `${secret.slice(0, 4)}${'*'.repeat(Math.max(secret.length - 8, 4))}${secret.slice(-4)}`;
}

/**
 * 规范化 AI 自定义接口地址：
 * - 只填 /v1 时，返回 /v1/chat/completions
 * - 已填完整路径时，原样返回
 * - 填的是 http/https URL 但无路径时，补 /v1/chat/completions
 */
export function normalizeAiEndpoint(endpoint) {
  if (!endpoint) return '';
  const url = endpoint.trim().replace(/\/+$/, '');
  // 已经是完整 path，包含 /chat/completions，原样返回
  if (url.includes('/chat/completions')) return url;
  // 以 /v1 结尾，补 /chat/completions
  if (url.endsWith('/v1')) return `${url}/chat/completions`;
  // 其他情况：可能是 /v1/... 的自定义路径，原样返回
  return url;
}

const envConfig = {
  // ── 服务基础 ──────────────────────────────────────────────────
  APP_PORT: toNumber(process.env.APP_PORT, 3000),
  DATABASE_PATH: process.env.DATABASE_PATH || './data/app.sqlite',
  TIMEZONE: process.env.TIMEZONE || 'Asia/Shanghai',
  PUBLIC_REPORT_BASE_URL: process.env.PUBLIC_REPORT_BASE_URL || 'http://localhost:3000/reports',

  // ── 采集 ──────────────────────────────────────────────────────
  TITAN_BASE_URL: process.env.TITAN_BASE_URL || 'https://live.titan007.com',
  COLLECT_CONCURRENCY: toNumber(process.env.COLLECT_CONCURRENCY, 4),
  DAILY_COLLECT_CRON: process.env.DAILY_COLLECT_CRON || '0 8 * * *',
  RESULT_SYNC_CRON: process.env.RESULT_SYNC_CRON || '0 23 * * *',
  PREMATCH_REFRESH_MINUTES: toNumber(process.env.PREMATCH_REFRESH_MINUTES, 15),
  ALLOW_SAMPLE_FALLBACK: toBoolean(process.env.ALLOW_SAMPLE_FALLBACK, false),

  // ── AI ────────────────────────────────────────────────────────
  AI_CUSTOM_ENDPOINT: process.env.AI_CUSTOM_ENDPOINT || '',
  AI_API_KEY: process.env.AI_API_KEY || '',
  AI_MODEL: process.env.AI_MODEL || 'gpt-4o-mini',
  AI_TIMEOUT_MS: toNumber(process.env.AI_TIMEOUT_MS, 180000),
  AI_MAX_DAILY_MATCHES_FULL_REPORT: toNumber(process.env.AI_MAX_DAILY_MATCHES_FULL_REPORT, 8),

  // ── 飞书推送 ───────────────────────────────────────────────────
  FEISHU_WEBHOOK: process.env.FEISHU_WEBHOOK || '',
  FEISHU_SECRET: process.env.FEISHU_SECRET || '',

  // ── 企业微信推送 ────────────────────────────────────────────────
  WECOM_WEBHOOK: process.env.WECOM_WEBHOOK || '',

  // ── QQ OneBot 推送 ─────────────────────────────────────────────
  ONEBOT_BASE_URL: process.env.ONEBOT_BASE_URL || 'http://127.0.0.1:3001',
  ONEBOT_ACCESS_TOKEN: process.env.ONEBOT_ACCESS_TOKEN || '',
  ONEBOT_TARGET_TYPE: process.env.ONEBOT_TARGET_TYPE || 'group',
  ONEBOT_TARGET_ID: process.env.ONEBOT_TARGET_ID || '',

  // ── 推送路由 ───────────────────────────────────────────────────
  AUTO_PUSH_CHANNELS: parseCsv(process.env.AUTO_PUSH_CHANNELS),

  // ── Hermes 集成 ────────────────────────────────────────────────
  HERMES_PORT: toNumber(process.env.HERMES_PORT, 6060),
  FOOTBALL_AUTO_BASE_URL: process.env.FOOTBALL_AUTO_BASE_URL || 'http://localhost:3000',
};

export const config = {
  // 保留 UPPER_CASE 键，兼容旧用法
  ...envConfig,

  // camelCase 别名
  appPort: envConfig.APP_PORT,
  databasePath: envConfig.DATABASE_PATH,
  timezone: envConfig.TIMEZONE,
  publicReportBaseUrl: envConfig.PUBLIC_REPORT_BASE_URL,

  titanBaseUrl: envConfig.TITAN_BASE_URL,
  collectConcurrency: envConfig.COLLECT_CONCURRENCY,
  dailyCollectCron: envConfig.DAILY_COLLECT_CRON,
  resultSyncCron: envConfig.RESULT_SYNC_CRON,
  prematchRefreshMinutes: envConfig.PREMATCH_REFRESH_MINUTES,
  allowSampleFallback: envConfig.ALLOW_SAMPLE_FALLBACK,

  // AI 端点做规范化处理，避免重复拼接 /chat/completions
  aiCustomEndpoint: normalizeAiEndpoint(envConfig.AI_CUSTOM_ENDPOINT),
  aiApiKey: envConfig.AI_API_KEY,
  aiModel: envConfig.AI_MODEL,
  aiTimeoutMs: envConfig.AI_TIMEOUT_MS,
  aiMaxDailyMatchesFullReport: envConfig.AI_MAX_DAILY_MATCHES_FULL_REPORT,

  feishuWebhook: envConfig.FEISHU_WEBHOOK,
  feishuSecret: envConfig.FEISHU_SECRET,

  wecomWebhook: envConfig.WECOM_WEBHOOK,

  onebotBaseUrl: envConfig.ONEBOT_BASE_URL,
  onebotAccessToken: envConfig.ONEBOT_ACCESS_TOKEN,
  onebotTargetType: envConfig.ONEBOT_TARGET_TYPE,
  onebotTargetId: envConfig.ONEBOT_TARGET_ID,

  autoPushChannels: envConfig.AUTO_PUSH_CHANNELS,

  hermesPort: envConfig.HERMES_PORT,
  footballAutoBaseUrl: envConfig.FOOTBALL_AUTO_BASE_URL,
};

export default config;
