/**
 * jsModuleLoader.js
 * 加载 server 内部自包含的分析引擎（server/src/analysis/engines/）。
 *
 * 独立化说明（2026-06-14）：
 *   服务器全自动版已完全独立，不再依赖项目根目录 js/。
 *   所有分析引擎已内化到 server/src/analysis/engines/ 目录，
 *   与浏览器插件代码完全解耦，可单独部署、单独迁移、单独升级。
 *
 * 路径解析优先级：
 *   1. ENGINES_PATH 环境变量（自定义引擎目录，Docker 可覆盖）
 *   2. 本文件同级的 engines/ 目录（标准内部路径）
 *
 * 用法：
 *   const { normalizeMatch } = await loadModule('match-normalizer.js');
 */

import { pathToFileURL } from 'url';
import path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 解析内部引擎根目录
function resolveEnginesRoot() {
  // 1. 环境变量覆盖
  if (process.env.ENGINES_PATH) {
    const p = path.resolve(process.env.ENGINES_PATH);
    if (existsSync(path.join(p, 'match-normalizer.js'))) return p;
    console.warn(`[engineLoader] ENGINES_PATH=${process.env.ENGINES_PATH} 无效，回退内部 engines/`);
  }

  // 2. 内部 engines/ 目录（server 自包含标准路径）
  const internal = path.resolve(__dirname, 'engines');
  if (existsSync(path.join(internal, 'match-normalizer.js'))) return internal;

  throw new Error(
    '[engineLoader] 无法找到内部分析引擎目录 server/src/analysis/engines/。' +
    '请确认引擎已正确内化，或设置 ENGINES_PATH 指向有效引擎目录。'
  );
}

let _enginesRoot = null;
function getEnginesRoot() {
  if (!_enginesRoot) _enginesRoot = resolveEnginesRoot();
  return _enginesRoot;
}

// 模块缓存
const _cache = new Map();

/**
 * 加载内部 engines/ 下的指定模块
 * @param {string} filename  如 'match-normalizer.js'
 * @returns {Promise<Object>} 模块的命名空间对象
 */
export async function loadModule(filename) {
  if (_cache.has(filename)) return _cache.get(filename);

  const filePath = path.join(getEnginesRoot(), filename);
  if (!existsSync(filePath)) {
    throw new Error(`[engineLoader] 内部引擎不存在：${filePath}`);
  }

  const fileUrl = pathToFileURL(filePath).href;
  const mod = await import(fileUrl);
  _cache.set(filename, mod);
  return mod;
}

/**
 * 批量预加载常用分析引擎，减少首次分析延迟
 */
export async function preloadAnalysisModules() {
  const modules = [
    'match-normalizer.js',
    'quant-engine.js',
    'pro-market-engine.js',
    'risk-engine.js',
    'report.js',
    'expert-doctrine.js',
    'candidate-arbitrator.js',
    'market-orchestrator.js',
    'daily-analyzer.js',
    'portfolio-orchestrator.js',
  ];

  const results = await Promise.allSettled(modules.map(m => loadModule(m)));
  let loaded = 0;
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      loaded++;
    } else {
      console.warn(`[engineLoader] 预加载 ${modules[i]} 失败：`, results[i].reason?.message);
    }
  }

  console.log(`[engineLoader] 预加载完成 ${loaded}/${modules.length} 个内部分析引擎，enginesRoot=${getEnginesRoot()}`);
  return loaded;
}

/**
 * 验证内部引擎路径可访问
 */
export function validateJsRoot() {
  try {
    const root = getEnginesRoot();
    return { ok: true, path: root };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 别名导出，语义更清晰
 */
export const validateEnginesRoot = validateJsRoot;
