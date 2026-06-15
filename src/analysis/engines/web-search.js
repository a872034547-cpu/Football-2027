/**
 * web-search.js — 联网情报检索 (2.1)
 *
 * 在 Service Worker 内执行真实网络检索，为 AI 提供"扩展端独立核实"的实时情报，
 * 与 AI 模型自身的联网搜索形成双重保障，确保信息真实准确。
 *
 * 设计：
 *  - 用户配置 Tavily API Key 时，直连官方 Tavily API。
 *  - 未配置用户 Key 时，使用内置 Hikari 中转额度。
 *  - 降级链路：Tavily → DuckDuckGo Lite → DuckDuckGo HTML → Bing
 *  - 全部带超时与异常兜底，单源失败自动切换，绝不抛出导致主流程中断。
 *  - 返回结构化结果（标题/摘要/来源URL），并标注检索时间，供 AI 引用与核对。
 *
 * 注意：这是情报"线索"采集，最终真实性判断仍交由 AI 结合多源交叉验证。
 */

const SEARCH_TIMEOUT_MS = 12000;
const MAX_RESULTS_PER_QUERY = 6;
// 用户自填 Key 时直连官方 Tavily；未配置时才使用内置 Hikari 中转。
const TAVILY_OFFICIAL_API_URL = 'https://api.tavily.com/search';
const TAVILY_HIKARI_API_URL = 'https://tavily.ivanli.cc/api/tavily/search';
// 内置 token（分段混淆，不做任何网络请求以外的用途）
const _tk = ['th-','sAIP','-UGO','gFvU','G1Q9','MvVV','DNVA','4gu9','5'];
function hasUserTavilyKey(apiKeyOverride) { return !!String(apiKeyOverride || '').trim(); }
function _resolveToken(override) { return hasUserTavilyKey(override) ? String(override).trim() : _tk.join(''); }
function _resolveTavilyChannel(apiKeyOverride) {
  return hasUserTavilyKey(apiKeyOverride)
    ? { url: TAVILY_OFFICIAL_API_URL, label: 'official', display: '官方 Tavily' }
    : { url: TAVILY_HIKARI_API_URL, label: 'hikari', display: '内置 Hikari 中转' };
}

/** 带超时的 fetch */
async function fetchWithTimeout(url, options = {}, timeout = SEARCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function uddg(href) {
  // DuckDuckGo lite 返回的跳转链接形如 //duckduckgo.com/l/?uddg=<encoded>
  try {
    const m = href.match(/[?&]uddg=([^&]+)/);
    if (m) return decodeURIComponent(m[1]);
  } catch {}
  return href;
}

// ---------------------------------------------------------------------------
// Tavily Search API（首选，高质量实时结果）
// ---------------------------------------------------------------------------

/**
 * Tavily Search（用户 Key 直连官方；未配置时使用内置 Hikari 中转）
 * @param {string} query
 * @param {string} [apiKeyOverride] 用户自定义官方 Tavily key（留空则用内置中转）
 * @returns {Promise<Array>}
 */
async function searchTavily(query, apiKeyOverride) {
  const token = _resolveToken(apiKeyOverride);
  const channel = _resolveTavilyChannel(apiKeyOverride);
  const resp = await fetchWithTimeout(channel.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      // 不再注入 Tavily 无来源综合答案，避免把模型摘要误当作本场事实情报。
      include_answer: false,
      include_raw_content: false,
      max_results: MAX_RESULTS_PER_QUERY,
      include_domains: [],
      exclude_domains: []
    })
  }, SEARCH_TIMEOUT_MS);
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    if (resp.status === 429 || resp.status === 402) {
      const quotaMsg = channel.label === 'official'
        ? 'TAVILY_QUOTA_EXCEEDED: 官方 Tavily Key 额度不足或计费受限，请检查 tavily.com 控制台额度/账单'
        : 'TAVILY_QUOTA_EXCEEDED: 内置 Tavily 额度已用完，请在设置页面配置您自己的 Tavily API Key（免费注册 tavily.com 可获得每月1000次免费额度）';
      throw new Error(quotaMsg);
    }
    throw new Error(`Tavily ${channel.display} HTTP ${resp.status}: ${errText.slice(0, 100)}`);
  }
  const data = await resp.json();
  const results = (data.results || []).map(r => ({
    title: r.title || '',
    snippet: r.content || r.snippet || '',
    url: r.url || '',
    source: 'tavily',
    channel: channel.label
  }));
  return results;
}

// ---------------------------------------------------------------------------
// 各搜索源解析
// ---------------------------------------------------------------------------

/** DuckDuckGo Lite（最稳定、结构最简单） */
async function searchDuckLite(query) {
  const url = 'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query);
  const resp = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  if (!resp.ok) throw new Error('duck-lite HTTP ' + resp.status);
  const html = await resp.text();
  const results = [];

  // lite 版结果是表格：链接行 + 摘要行
  const linkRe = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
  const links = [];
  let m;
  while ((m = linkRe.exec(html)) !== null && links.length < MAX_RESULTS_PER_QUERY) {
    links.push({ url: uddg(m[1]), title: stripTags(m[2]) });
  }
  const snippets = [];
  let s;
  while ((s = snippetRe.exec(html)) !== null && snippets.length < MAX_RESULTS_PER_QUERY) {
    snippets.push(stripTags(s[1]));
  }
  links.forEach((lk, i) => {
    if (lk.title) results.push({ title: lk.title, snippet: snippets[i] || '', url: lk.url, source: 'duckduckgo' });
  });
  return results;
}

/** DuckDuckGo HTML（备用，结构不同） */
async function searchDuckHtml(query) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const resp = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  if (!resp.ok) throw new Error('duck-html HTTP ' + resp.status);
  const html = await resp.text();
  const results = [];
  const blockRe = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null && results.length < MAX_RESULTS_PER_QUERY) {
    const title = stripTags(m[2]);
    if (title) results.push({ title, snippet: stripTags(m[3]), url: uddg(m[1]), source: 'duckduckgo' });
  }
  return results;
}

/** Bing（第三降级源） */
async function searchBing(query) {
  const url = 'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-CN';
  const resp = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  if (!resp.ok) throw new Error('bing HTTP ' + resp.status);
  const html = await resp.text();
  const results = [];
  // Bing 结果：<li class="b_algo"> <h2><a href>title</a></h2> <p>snippet</p>
  const blockRe = /<li class="b_algo">[\s\S]*?<h2>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null && results.length < MAX_RESULTS_PER_QUERY) {
    const title = stripTags(m[2]);
    const pM = m[3].match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (title) results.push({ title, snippet: pM ? stripTags(pM[1]) : '', url: m[1], source: 'bing' });
  }
  return results;
}

function localIsoDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const TEAM_ALIAS_MAP = {
  '匈牙利': ['hungary', 'hungarian'],
  '芬兰': ['finland', 'finnish'],
  '葡萄牙': ['portugal', 'portuguese'],
  '德国': ['germany', 'german'],
  '法国': ['france', 'french'],
  '西班牙': ['spain', 'spanish'],
  '英格兰': ['england'],
  '意大利': ['italy', 'italian'],
  '荷兰': ['netherlands', 'holland', 'dutch'],
  '比利时': ['belgium', 'belgian'],
  '瑞士': ['switzerland', 'swiss'],
  '瑞典': ['sweden', 'swedish'],
  '挪威': ['norway', 'norwegian'],
  '丹麦': ['denmark', 'danish'],
  '奥地利': ['austria', 'austrian'],
  '波兰': ['poland', 'polish'],
  '捷克': ['czech republic', 'czechia', 'czech'],
  '斯洛伐克': ['slovakia', 'slovak'],
  '斯洛文尼亚': ['slovenia', 'slovenian'],
  '克罗地亚': ['croatia', 'croatian'],
  '塞尔维亚': ['serbia', 'serbian'],
  '罗马尼亚': ['romania', 'romanian'],
  '保加利亚': ['bulgaria', 'bulgarian'],
  '希腊': ['greece', 'greek'],
  '土耳其': ['turkey', 'turkiye', 'turkish'],
  '乌克兰': ['ukraine', 'ukrainian'],
  '苏格兰': ['scotland', 'scottish'],
  '爱尔兰': ['ireland', 'irish'],
  '北爱尔兰': ['northern ireland'],
  '威尔士': ['wales', 'welsh'],
  '冰岛': ['iceland', 'icelandic'],
  '美国': ['usa', 'united states', 'usmnt'],
  '加拿大': ['canada', 'canadian'],
  '墨西哥': ['mexico', 'mexican'],
  '巴西': ['brazil', 'brazilian'],
  '阿根廷': ['argentina', 'argentinian'],
  '乌拉圭': ['uruguay', 'uruguayan'],
  '日本': ['japan', 'japanese'],
  '韩国': ['south korea', 'korea republic', 'korea', 'korean'],
  '中国': ['china', 'chinese'],
  '澳大利亚': ['australia', 'australian']
};

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\x26amp;/g, '&')
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactSearchText(value) {
  return normalizeSearchText(value).replace(/\s+/g, '');
}

function teamAliases(name) {
  const raw = String(name || '').trim();
  const norm = normalizeSearchText(raw);
  const compact = compactSearchText(raw);
  const aliases = new Set([norm, compact]);
  const mapped = TEAM_ALIAS_MAP[raw] || TEAM_ALIAS_MAP[norm] || TEAM_ALIAS_MAP[compact] || [];
  mapped.forEach(x => {
    aliases.add(normalizeSearchText(x));
    aliases.add(compactSearchText(x));
  });
  norm.split(' ').filter(x => x.length >= 3).forEach(x => aliases.add(x));
  return [...aliases].filter(Boolean);
}

function mentionsTeam(text, aliases) {
  const norm = normalizeSearchText(text);
  const compact = compactSearchText(text);
  return aliases.some(alias => {
    if (!alias) return false;
    if (/\s/.test(alias)) return norm.includes(alias);
    if (/^[a-z0-9]+$/i.test(alias)) return new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(norm);
    return compact.includes(alias.replace(/\s+/g, ''));
  });
}

function extractDateHints(timeText) {
  const text = String(timeText || '');
  const hints = new Set();
  const monthLong = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const monthShort = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const iso = text.match(/(20\d{2})[-\/\.年](\d{1,2})[-\/\.月](\d{1,2})/);
  if (iso) {
    const y = iso[1];
    const m = iso[2].padStart(2, '0');
    const d = iso[3].padStart(2, '0');
    const mi = Math.max(0, Math.min(11, Number(m) - 1));
    const dn = Number(d);
    const mn = Number(m);
    hints.add(`${y}-${m}-${d}`);
    hints.add(`${y}/${m}/${d}`);
    hints.add(`${m}-${d}`);
    hints.add(`${mn}/${dn}`);
    hints.add(`${mn}月${dn}日`);
    hints.add(`${dn} ${monthLong[mi]}`);
    hints.add(`${monthLong[mi]} ${dn}`);
    hints.add(`${dn} ${monthShort[mi]}`);
    hints.add(`${monthShort[mi]} ${dn}`);
  }
  if (!hints.size) hints.add(localIsoDate());
  return [...hints].filter(Boolean);
}

function pickSearchName(original, aliases) {
  const latin = aliases.find(x => /^[a-z][a-z\s]+$/i.test(x) && x.length >= 3 && x !== 'finnish' && x !== 'hungarian');
  return latin || original;
}

function buildQueryContext({ home, away, league, matchTime } = {}) {
  const dateHints = extractDateHints(matchTime);
  const homeAliases = teamAliases(home);
  const awayAliases = teamAliases(away);
  const searchHome = pickSearchName(home, homeAliases);
  const searchAway = pickSearchName(away, awayAliases);
  const exactPair = `"${searchHome}" "${searchAway}"`;
  const cnPair = `"${home}" "${away}"`;
  const lg = league ? ` ${league}` : '';
  const date = dateHints[0] || localIsoDate();
  const queries = [
    `${exactPair} ${date}${lg} team news lineup injury preview`,
    `${searchHome} vs ${searchAway} ${date}${lg} prediction team news lineups injuries`,
    `${cnPair} ${date}${lg} 首发 阵容 伤停 赛前 情报`,
    `${searchHome} vs ${searchAway} ${date} recent form h2h preview`,
    `${searchHome} vs ${searchAway} ${date}${lg} asian handicap odds movement`,
    `${searchHome} vs ${searchAway} ${date}${lg} line movement betting preview`,
    `${searchHome} vs ${searchAway} ${date}${lg} odds market preview`,
    `${cnPair} ${date}${lg} 亚盘 盘口 赔率 变盘`
  ];
  if (searchHome !== home || searchAway !== away) {
    queries.splice(2, 0, `${home} ${away} ${searchHome} ${searchAway} ${date}${lg} 赛前 情报 prediction`);
  }
  return {
    date,
    dateHints,
    homeAliases,
    awayAliases,
    queries
  };
}

function scoreIntelResult(result, ctx) {
  const text = `${result.title || ''} ${result.snippet || ''} ${result.url || ''}`;
  const hasHome = mentionsTeam(text, ctx.homeAliases);
  const hasAway = mentionsTeam(text, ctx.awayAliases);
  const dateHit = ctx.dateHints.some(h => h && normalizeSearchText(text).includes(normalizeSearchText(h)));
  const exactVs = /\b(vs|v|versus)\b/i.test(text) || /对阵|迎战|vs/i.test(text);
  const marketHit = /asian handicap|odds movement|line movement|betting preview|market preview|盘口|亚盘|赔率|变盘|水位/i.test(text);
  let score = 0;
  if (hasHome) score += 35;
  if (hasAway) score += 35;
  if (dateHit) score += 15;
  if (exactVs) score += 5;
  if (marketHit) score += 4;
  if (result.source === 'tavily') score += 5;
  if (!result.url) score -= 25;
  if (hasHome !== hasAway) score -= 45;
  return {
    ...result,
    intelQuality: {
      score: Math.max(0, Math.min(100, score)),
      hasHome,
      hasAway,
      dateHit,
      marketHit,
      accepted: hasHome && hasAway && score >= 55,
      reason: hasHome && hasAway ? '同时匹配主客队' : '未同时匹配主客队，疑似其他比赛噪声'
    }
  };
}

/**
 * 执行单次查询，优先 Tavily，失败降级免费源。
 * @param {string} query
 * @param {string} [tavilyApiKey] 用户自定义官方 key（留空用内置中转）
 */
async function runQuery(query, tavilyApiKey) {
  const channel = _resolveTavilyChannel(tavilyApiKey);
  // 优先使用 Tavily：用户 Key 走官方；未配置走内置 Hikari 中转。
  try {
    const r = await searchTavily(query, tavilyApiKey);
    if (r && r.length > 0) return r;
  } catch (e) {
    console.warn(`[web-search] Tavily ${channel.display} 失败，降级:`, e.message);
  }
  // 降级到免费源
  const engines = [searchDuckLite, searchDuckHtml, searchBing];
  for (const engine of engines) {
    try {
      const r = await engine(query);
      if (r && r.length > 0) return r;
    } catch (e) {
      console.warn('[web-search] 源失败:', engine.name, e.message);
    }
  }
  return [];
}

/**
 * 为一场比赛检索综合情报。
 * 输入：{ home, away, league, matchTime, tavilyApiKey }
 * 输出：{ ok, source, queries:[{query,results}], gathered:[...扁平结果], rejected:[...噪声结果], fetchedAt, errors:[] }
 *
 * 检索维度：伤停/阵容、近期状态、交锋、赛前预测。
 * 优先使用 Tavily：配置 API Key 时走官方 tavily.com；未配置时走内置 Hikari 中转；失败后降级免费源。
 */
async function gatherMatchIntel({ home, away, league, matchTime, tavilyApiKey } = {}) {
  const fetchedAt = new Date().toISOString();
  const result = { ok: false, source: 'none', queries: [], gathered: [], rejected: [], fetchedAt, errors: [] };
  if (!home || !away) {
    result.errors.push('缺少球队名，无法检索情报');
    return result;
  }

  const ctx = buildQueryContext({ home, away, league, matchTime });
  result.context = { home, away, league: league || '', matchTime: matchTime || '', date: ctx.date };

  const seen = new Set();
  for (const q of ctx.queries) {
    let results = [];
    try {
      results = await runQuery(q, tavilyApiKey);
    } catch (e) {
      result.errors.push(`查询失败 [${q}]: ${e.message}`);
    }
    const scored = results.map(r => scoreIntelResult(r, ctx));
    result.queries.push({ query: q, count: results.length, accepted: scored.filter(r => r.intelQuality.accepted).length });
    scored.forEach(r => {
      const key = r.url || (r.title + r.snippet);
      if (key && !seen.has(key)) {
        seen.add(key);
        if (r.intelQuality.accepted) result.gathered.push(r);
        else result.rejected.push(r);
      }
    });
    // 已收集足够则提前结束，节省时间
    if (result.gathered.length >= 12) break;
  }

  result.ok = result.gathered.length > 0;
  // 标注数据源与 Tavily 通道，便于确认用户 Key 是否已切到官方 API。
  if (result.gathered.length > 0) {
    const tavilyHit = result.gathered.find(r => r.source === 'tavily');
    result.source = tavilyHit ? 'tavily' : 'free';
    if (tavilyHit?.channel) result.tavilyChannel = tavilyHit.channel;
  }
  if (!result.ok) {
    const rejectedCount = result.rejected.length;
    result.errors.push(rejectedCount
      ? `检索到 ${rejectedCount} 条线索，但未通过本场比赛匹配过滤（需同时匹配主客队，避免误采信其他对手比赛）。`
      : '所有搜索源均未返回结果（可能被限流或网络不可达）');
  }
  return result;
}

/**
 * 将情报渲染为 Markdown，供注入 AI 提示词。
 * 明确标注为"线索"，要求 AI 交叉核实。
 */
function intelToMarkdown(intel) {
  if (!intel || !intel.ok || !intel.gathered.length) {
    return '### 🌐 扩展端联网情报\n> 未检索到有效情报线索' +
      (intel?.errors?.length ? `（${intel.errors.join('；')}）` : '') +
      '。请基于你自身的联网搜索与知识库补充，并明确标注信息来源与时效。';
  }
  const tavilyChannelLabel = intel.tavilyChannel === 'official' ? '官方 API' : intel.tavilyChannel === 'hikari' ? '内置中转' : '';
  const sourceLabel = intel.source === 'tavily'
    ? `🟢 Tavily 实时搜索${tavilyChannelLabel ? `｜${tavilyChannelLabel}` : ''}`
    : '⚪ 免费搜索引擎';
  const L = [];
  L.push(`### 🌐 扩展端联网情报线索（${sourceLabel}，检索时间：${intel.fetchedAt}）`);
  if (intel.context) L.push(`> 本场匹配目标：${intel.context.home} vs ${intel.context.away}${intel.context.league ? `｜${intel.context.league}` : ''}${intel.context.matchTime ? `｜${intel.context.matchTime}` : ''}`);
  L.push('> 以下线索已通过“同时匹配主客队”的本场过滤，但仍只作核实参考。AI 必须先做来源有效性门检：若网页实际不是本场、日期不符、只提到其中一队或来自无来源摘要，必须剔除，不可直接照搬。');
  L.push('');
  intel.gathered.slice(0, 10).forEach((r, i) => {
    L.push(`${i + 1}. **${r.title}**`);
    if (r.snippet) L.push(`   - 摘要：${r.snippet.slice(0, 300)}`);
    const itemChannelLabel = r.source === 'tavily' && r.channel === 'official' ? '｜官方 API' : r.source === 'tavily' && r.channel === 'hikari' ? '｜内置中转' : '';
    if (r.url) L.push(`   - 来源：${r.url}（${r.source}${itemChannelLabel}）`);
    if (r.intelQuality) L.push(`   - 本场匹配评分：${r.intelQuality.score}/100（${r.intelQuality.reason}${r.intelQuality.dateHit ? '，日期/时间有命中' : '，日期/时间未确认'}）`);
  });
  if (intel.rejected?.length) {
    L.push('');
    L.push(`> 已自动过滤 ${intel.rejected.length} 条疑似噪声线索（未同时匹配本场双方球队）。`);
  }
  L.push('');
  return L.join('\n');
}

export { gatherMatchIntel, intelToMarkdown, runQuery };
