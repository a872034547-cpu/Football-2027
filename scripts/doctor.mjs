#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_FILE);
const SERVER_ROOT = path.resolve(SCRIPT_DIR, '..');
const SERVER_DATA_DIR = path.join(SERVER_ROOT, 'data');
const DOCTOR_DB_PATH = path.join(SERVER_DATA_DIR, '__doctor__.sqlite');

const passed = [];
const warnings = [];
const failures = [];

let closeDb = null;

function addPass(message) {
  passed.push(message);
}

function addWarning(message) {
  warnings.push(message);
}

function addFailure(message) {
  failures.push(message);
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function compareVersions(version, required) {
  const currentParts = String(version).split('.').map((item) => Number.parseInt(item, 10) || 0);
  const requiredParts = String(required).split('.').map((item) => Number.parseInt(item, 10) || 0);
  const length = Math.max(currentParts.length, requiredParts.length);

  for (let index = 0; index < length; index += 1) {
    const current = currentParts[index] || 0;
    const minimum = requiredParts[index] || 0;
    if (current > minimum) return 1;
    if (current < minimum) return -1;
  }

  return 0;
}

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return false;

  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const equalIndex = line.indexOf('=');
    if (equalIndex <= 0) continue;

    const key = line.slice(0, equalIndex).trim();
    let value = line.slice(equalIndex + 1).trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }

  return true;
}

function checkNodeVersion() {
  const version = process.versions.node;
  if (compareVersions(version, '18.0.0') >= 0) {
    addPass(`Node.js 版本 ${version}，满足 >= 18`);
  } else {
    addFailure(`Node.js 版本 ${version}，需要 >= 18`);
  }
}

function checkNpm() {
  const attempts = process.platform === 'win32'
    ? [
        { label: 'npm.cmd', command: 'npm.cmd', args: ['--version'] },
        {
          label: 'npm-cli.js',
          command: process.execPath,
          args: [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), '--version'],
        },
      ]
    : [{ label: 'npm', command: 'npm', args: ['--version'] }];
  const errors = [];

  for (const attempt of attempts) {
    try {
      const version = execFileSync(attempt.command, attempt.args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      addPass(`npm 可用，版本 ${version}（${attempt.label}）`);
      return;
    } catch (error) {
      errors.push(`${attempt.label}: ${error?.message || String(error)}`);
    }
  }

  addFailure(`npm 不可用：${errors.join('；')}`);
}

function checkPackageJson() {
  const packageJsonPath = path.join(SERVER_ROOT, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    addPass(`package.json 存在：${formatPath(packageJsonPath)}`);
  } else {
    addFailure(`package.json 不存在：${formatPath(packageJsonPath)}`);
  }
}

function checkEnvFile() {
  const envPath = path.join(SERVER_ROOT, '.env');
  if (loadEnvFile(envPath)) {
    addPass(`.env 存在并已加载：${formatPath(envPath)}`);
  } else {
    addWarning(`未找到 .env：${formatPath(envPath)}，将使用环境变量和默认配置继续检查`);
  }
}

function checkDataDirectory() {
  try {
    fs.mkdirSync(SERVER_DATA_DIR, { recursive: true });
    const probePath = path.join(SERVER_DATA_DIR, `.__doctor_write_probe_${process.pid}`);
    fs.writeFileSync(probePath, 'ok');
    fs.unlinkSync(probePath);
    addPass(`data 目录可创建且可写：${formatPath(SERVER_DATA_DIR)}`);
  } catch (error) {
    addFailure(`data 目录不可创建或不可写：${formatPath(SERVER_DATA_DIR)}；${error?.message || String(error)}`);
  }
}

function setDoctorEnvironment() {
  process.env.DATABASE_PATH = DOCTOR_DB_PATH;
  process.env.DAILY_COLLECT_CRON = '';
  process.env.RESULT_SYNC_CRON = 'false';
  addPass(`已设置诊断数据库路径：${formatPath(DOCTOR_DB_PATH)}`);
  addPass('已禁用诊断期间的定时采集/赛果同步环境变量');
}

async function checkRuntimeModules() {
  try {
    const dbModule = await import('../src/db/index.js');
    closeDb = dbModule.closeDb;
    dbModule.initDb();
    addPass('数据库模块导入成功，initDb 执行成功');
  } catch (error) {
    addFailure(`数据库模块导入或 initDb 失败：${error?.stack || error?.message || String(error)}`);
    return;
  }

  try {
    const jsModuleLoader = await import('../src/analysis/jsModuleLoader.js');
    const result = jsModuleLoader.validateJsRoot();
    if (result?.ok) {
      addPass(`分析引擎目录验证通过：${formatPath(result.path)}`);
    } else {
      addFailure(`分析引擎目录验证失败：${result?.error || '未知错误'}`);
    }
  } catch (error) {
    addFailure(`分析引擎加载器导入失败：${error?.stack || error?.message || String(error)}`);
  }
}

async function checkConfig() {
  try {
    const { config } = await import('../src/config.js');

    requireConfigValue(config.TIMEZONE, 'TIMEZONE');
    requireConfigValue(config.TITAN_BASE_URL, 'TITAN_BASE_URL');

    warnRecommendedValue(config.AI_CUSTOM_ENDPOINT, 'AI_CUSTOM_ENDPOINT', '未配置 AI 自定义接口，AI 深度分析能力可能不可用');
    warnRecommendedValue(config.AI_API_KEY, 'AI_API_KEY', '未配置 AI_API_KEY，AI/API 调用会被跳过或失败');

    if (Array.isArray(config.AUTO_PUSH_CHANNELS) && config.AUTO_PUSH_CHANNELS.length > 0) {
      addPass(`AUTO_PUSH_CHANNELS 已配置：${config.AUTO_PUSH_CHANNELS.join(', ')}`);
      checkWebhookByChannels(config);
    } else {
      addWarning('AUTO_PUSH_CHANNELS 未配置，自动推送将不会发送到飞书/企业微信/QQ 等渠道');
    }
  } catch (error) {
    addFailure(`配置模块检查失败：${error?.stack || error?.message || String(error)}`);
  }
}

function requireConfigValue(value, name) {
  if (isBlank(value)) {
    addFailure(`${name} 未配置`);
  } else {
    addPass(`${name} = ${value}`);
  }
}

function warnRecommendedValue(value, name, message) {
  if (isBlank(value)) {
    addWarning(message);
  } else if (name.toUpperCase().includes('KEY')) {
    addPass(`${name} 已配置：${maskSecret(value)}`);
  } else {
    addPass(`${name} 已配置：${value}`);
  }
}

function checkWebhookByChannels(config) {
  const channels = new Set(config.AUTO_PUSH_CHANNELS.map((item) => String(item).trim().toLowerCase()).filter(Boolean));

  if (channels.has('feishu') || channels.has('lark')) {
    if (isBlank(config.FEISHU_WEBHOOK)) addWarning('已启用飞书推送，但 FEISHU_WEBHOOK 未配置');
    else addPass('FEISHU_WEBHOOK 已配置');
  }

  if (channels.has('wecom') || channels.has('wechat-work') || channels.has('enterprise-wechat')) {
    if (isBlank(config.WECOM_WEBHOOK)) addWarning('已启用企业微信推送，但 WECOM_WEBHOOK 未配置');
    else addPass('WECOM_WEBHOOK 已配置');
  }

  if (channels.has('qq') || channels.has('onebot')) {
    if (isBlank(config.ONEBOT_BASE_URL)) addWarning('已启用 QQ/OneBot 推送，但 ONEBOT_BASE_URL 未配置');
    else addPass(`ONEBOT_BASE_URL = ${config.ONEBOT_BASE_URL}`);

    if (isBlank(config.ONEBOT_TARGET_ID)) addWarning('已启用 QQ/OneBot 推送，但 ONEBOT_TARGET_ID 未配置');
    else addPass('ONEBOT_TARGET_ID 已配置');
  }
}

async function checkHttpHealth() {
  const cliUrl = readCliUrl();
  const baseUrl = cliUrl || process.env.FOOTBALL_AUTO_BASE_URL;

  if (isBlank(baseUrl)) return;

  let healthUrl;
  try {
    healthUrl = new URL('/health', String(baseUrl).trim().replace(/\/+$/, '')).toString();
  } catch {
    addFailure(`HTTP 检查地址无效：${baseUrl}`);
    return;
  }

  try {
    const response = await fetch(healthUrl, { method: 'GET' });
    const body = await response.text();
    if (response.ok) {
      addPass(`HTTP /health 检查通过：${healthUrl}，状态码 ${response.status}`);
    } else {
      addFailure(`HTTP /health 检查失败：${healthUrl}，状态码 ${response.status}，响应：${truncate(body, 500)}`);
    }
  } catch (error) {
    addFailure(`HTTP /health 请求失败：${healthUrl}；${error?.message || String(error)}`);
  }
}

function readCliUrl() {
  const item = process.argv.slice(2).find((arg) => arg.startsWith('--url='));
  if (!item) return '';
  return item.slice('--url='.length).trim();
}

function cleanupDoctorDatabase() {
  for (const suffix of ['', '-wal', '-shm']) {
    const targetPath = `${DOCTOR_DB_PATH}${suffix}`;
    try {
      if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    } catch (error) {
      addWarning(`诊断数据库临时文件清理失败：${formatPath(targetPath)}；${error?.message || String(error)}`);
    }
  }
}

function maskSecret(value) {
  const secret = String(value || '');
  if (secret.length <= 4) return '*'.repeat(secret.length);
  if (secret.length <= 8) return `${secret.slice(0, 2)}${'*'.repeat(secret.length - 4)}${secret.slice(-2)}`;
  return `${secret.slice(0, 4)}${'*'.repeat(Math.max(secret.length - 8, 4))}${secret.slice(-4)}`;
}

function truncate(value, maxLength) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function formatPath(value) {
  return path.relative(process.cwd(), value) || '.';
}

function printGroup(title, icon, items) {
  console.log(`\n${icon} ${title}`);
  if (!items.length) {
    console.log('  - 无');
    return;
  }

  for (const item of items) {
    console.log(`  - ${item}`);
  }
}

function printReport() {
  console.log('足球预测自动化服务 Doctor 检查');
  console.log(`server 根目录：${formatPath(SERVER_ROOT)}`);

  printGroup('通过', '✅', passed);
  printGroup('警告', '⚠️', warnings);
  printGroup('失败', '❌', failures);

  console.log(`\n检查结果：通过 ${passed.length} 项，警告 ${warnings.length} 项，失败 ${failures.length} 项`);
}

async function main() {
  checkNodeVersion();
  checkNpm();
  checkPackageJson();
  checkEnvFile();
  checkDataDirectory();
  setDoctorEnvironment();

  await checkRuntimeModules();
  await checkConfig();
  await checkHttpHealth();
}

try {
  await main();
} finally {
  if (typeof closeDb === 'function') {
    try {
      closeDb();
      addPass('数据库连接已关闭');
    } catch (error) {
      addWarning(`closeDb 执行失败：${error?.message || String(error)}`);
    }
  }

  cleanupDoctorDatabase();
  printReport();
  process.exitCode = failures.length > 0 ? 1 : 0;
}
