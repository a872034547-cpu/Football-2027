// team-profile-engine.js - 球队画像库远程加载、缓存、匹配与摘要输出

export const TEAM_PROFILE_DEFAULT_URL = 'http://2026.cdu.cc.cd/worldcup-2026-profiles/data/profiles.json';
export const TEAM_PROFILE_PAGE_URL = 'http://2026.cdu.cc.cd/worldcup-2026-profiles/index.html';
export const TEAM_PROFILE_CACHE_KEY = 'team_profile_cache_v1';
export const TEAM_PROFILE_META_KEY = 'team_profile_meta_v1';
export const TEAM_PROFILE_SOURCE_URL_KEY = 'team_profile_source_url_v1';
export const TEAM_PROFILE_TTL_MS = 24 * 60 * 60 * 1000;

function hasChromeStorage() {
  return typeof chrome !== 'undefined' && !!chrome.storage?.local;
}

async function storageGet(keys) {
  if (!hasChromeStorage()) return {};
  return await chrome.storage.local.get(keys);
}

async function storageSet(obj) {
  if (!hasChromeStorage()) return;
  await chrome.storage.local.set(obj);
}

function nowIso() {
  return new Date().toISOString();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value, fallback = '') {
  return value === null || value === undefined ? fallback : String(value);
}

function firstDefined(...values) {
  return values.find(v => v !== undefined && v !== null && v !== '');
}

export function normalizeTeamName(name = '') {
  return String(name || '')
    .toLowerCase()
    .replace(/[\s\u3000·•.。'’`-]+/g, '')
    .replace(/[()（）\[\]【】]/g, '')
    .replace(/足球俱乐部|俱乐部|国家队|队$/g, '')
    .replace(/\b(fc|cf|sc|afc|cfc|club|footballclub|the)\b/g, '')
    .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '')
    .trim();
}

function profileNames(profile = {}, type = '') {
  const names = [
    profile.country,
    profile.name,
    profile.teamName,
    profile.club,
    profile.shortName,
    profile.localName,
    profile.englishName,
    profile.id,
    ...safeArray(profile.aliases),
    ...safeArray(profile.nicknames)
  ];
  if (type === 'national') names.push(profile.countryZh, profile.countryEn);
  return [...new Set(names.filter(Boolean).map(String))];
}

function profileTypeLabel(type) {
  if (type === 'national') return '国家队';
  if (type === 'club') return '俱乐部';
  if (type === 'league') return '联赛';
  return '球队';
}

function buildIndex(data = {}) {
  const entries = [];
  safeArray(data.nationalTeams).forEach(profile => entries.push({ type: 'national', profile, names: profileNames(profile, 'national') }));
  safeArray(data.clubs).forEach(profile => entries.push({ type: 'club', profile, names: profileNames(profile, 'club') }));
  return entries.map(entry => ({
    ...entry,
    normalizedNames: entry.names.map(normalizeTeamName).filter(Boolean)
  }));
}

function scoreNameMatch(queryNorm, candidateNorm) {
  if (!queryNorm || !candidateNorm) return 0;
  if (queryNorm === candidateNorm) return 100;
  if (queryNorm.length >= 3 && candidateNorm.includes(queryNorm)) return 88;
  if (candidateNorm.length >= 3 && queryNorm.includes(candidateNorm)) return 84;
  if (queryNorm.length >= 2 && candidateNorm.startsWith(queryNorm)) return 76;
  if (candidateNorm.length >= 2 && queryNorm.startsWith(candidateNorm)) return 72;
  return 0;
}

export function matchTeamProfile(data = {}, teamName = '', options = {}) {
  const query = text(teamName).trim();
  if (!query) return { matched: false, name: query, type: '', profile: null, score: 0, reason: 'empty_team_name' };

  const preferredType = options.type || '';
  const queryNorm = normalizeTeamName(query);
  const index = buildIndex(data);
  let best = null;

  index.forEach(entry => {
    if (preferredType && entry.type !== preferredType) return;
    entry.normalizedNames.forEach(candidateNorm => {
      const score = scoreNameMatch(queryNorm, candidateNorm);
      if (!score) return;
      const adjusted = score + (entry.type === preferredType ? 5 : 0);
      if (!best || adjusted > best.score) {
        best = { matched: true, name: query, type: entry.type, profile: entry.profile, score: adjusted, reason: 'name_match' };
      }
    });
  });

  return best || { matched: false, name: query, type: preferredType || '', profile: null, score: 0, reason: 'not_found' };
}

export function getProfileCoverage(data = {}) {
  const meta = data.meta || {};
  return {
    nationalTeams: safeArray(data.nationalTeams).length || Number(meta.coverage?.nationalTeams || 0),
    leagues: safeArray(data.leagues).length || Number(meta.coverage?.leagues || 0),
    clubs: safeArray(data.clubs).length || Number(meta.coverage?.clubs || 0)
  };
}

function isValidProfileData(data) {
  const coverage = getProfileCoverage(data);
  return !!data && typeof data === 'object' && coverage.nationalTeams > 0 && coverage.clubs > 0;
}

async function getSourceUrl(explicitUrl = '') {
  if (explicitUrl) return explicitUrl;
  const stored = await storageGet([TEAM_PROFILE_SOURCE_URL_KEY]);
  return stored[TEAM_PROFILE_SOURCE_URL_KEY] || TEAM_PROFILE_DEFAULT_URL;
}

export async function getTeamProfileStatus() {
  const sourceUrl = await getSourceUrl();
  const stored = await storageGet([TEAM_PROFILE_CACHE_KEY, TEAM_PROFILE_META_KEY]);
  const data = stored[TEAM_PROFILE_CACHE_KEY] || null;
  const meta = stored[TEAM_PROFILE_META_KEY] || null;
  const coverage = getProfileCoverage(data || {});
  const ageMs = meta?.updatedAtMs ? Date.now() - Number(meta.updatedAtMs) : null;
  const stale = !meta?.updatedAtMs || ageMs > TEAM_PROFILE_TTL_MS;
  return {
    ok: !!(data && isValidProfileData(data)),
    loaded: !!data,
    stale,
    ageMs,
    sourceUrl: meta?.sourceUrl || sourceUrl,
    pageUrl: TEAM_PROFILE_PAGE_URL,
    updatedAt: meta?.updatedAt || '',
    version: data?.meta?.version || meta?.version || '',
    coverage,
    error: meta?.error || ''
  };
}

export async function refreshTeamProfiles(options = {}) {
  const sourceUrl = await getSourceUrl(options.sourceUrl || '');
  const fetchImpl = options.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) throw new Error('当前环境不支持 fetch，无法更新球队画像库');

  const resp = await fetchImpl(sourceUrl, { cache: options.force ? 'reload' : 'default' });
  if (!resp.ok) throw new Error(`画像库下载失败：HTTP ${resp.status}`);
  const data = await resp.json();
  if (!isValidProfileData(data)) throw new Error('画像库格式异常：缺少 nationalTeams / clubs 数据');

  const coverage = getProfileCoverage(data);
  const meta = {
    sourceUrl,
    updatedAt: nowIso(),
    updatedAtMs: Date.now(),
    version: data?.meta?.version || '',
    coverage,
    error: ''
  };
  await storageSet({
    [TEAM_PROFILE_CACHE_KEY]: data,
    [TEAM_PROFILE_META_KEY]: meta,
    [TEAM_PROFILE_SOURCE_URL_KEY]: sourceUrl
  });

  return { ok: true, data, meta, coverage, sourceUrl };
}

export async function ensureTeamProfiles(options = {}) {
  const sourceUrl = await getSourceUrl(options.sourceUrl || '');
  const stored = await storageGet([TEAM_PROFILE_CACHE_KEY, TEAM_PROFILE_META_KEY]);
  const cached = stored[TEAM_PROFILE_CACHE_KEY] || null;
  const meta = stored[TEAM_PROFILE_META_KEY] || null;
  const ageMs = meta?.updatedAtMs ? Date.now() - Number(meta.updatedAtMs) : Infinity;
  const shouldRefresh = options.force || !isValidProfileData(cached) || ageMs > (options.ttlMs || TEAM_PROFILE_TTL_MS);

  if (!shouldRefresh) {
    return { ok: true, data: cached, meta, coverage: getProfileCoverage(cached), sourceUrl, fromCache: true };
  }

  try {
    return await refreshTeamProfiles({ ...options, sourceUrl });
  } catch (e) {
    const errorMeta = {
      ...(meta || {}),
      sourceUrl,
      error: e.message || String(e),
      lastFailedAt: nowIso(),
      lastFailedAtMs: Date.now()
    };
    await storageSet({ [TEAM_PROFILE_META_KEY]: errorMeta });
    if (isValidProfileData(cached)) {
      return { ok: true, data: cached, meta: errorMeta, coverage: getProfileCoverage(cached), sourceUrl, fromCache: true, stale: true, warning: e.message };
    }
    return { ok: false, data: null, meta: errorMeta, coverage: getProfileCoverage({}), sourceUrl, error: e.message || String(e) };
  }
}

function inferMatchInfo(stored = {}) {
  const data = stored?.data || stored || {};
  const mi = data?.analysis?.matchInfo || stored?.matchInfo || {};
  return {
    home: mi.home || data.home || stored.home || '',
    away: mi.away || data.away || stored.away || '',
    league: mi.league || data.league || stored.league || '',
    time: mi.time || mi.kickoff || data.time || stored.time || ''
  };
}

function inferPreferredType(matchInfo = {}) {
  const league = text(matchInfo.league).toLowerCase();
  if (/世界杯|world cup|欧洲杯|亚洲杯|美洲杯|非洲杯|国家队|international|友谊赛|欧国联|世预赛|euro|copa/.test(league)) return 'national';
  return '';
}

export async function enrichMatchWithTeamProfiles(stored = {}, options = {}) {
  const load = options.data ? { ok: true, data: options.data, meta: options.meta || {}, coverage: getProfileCoverage(options.data), sourceUrl: options.sourceUrl || TEAM_PROFILE_DEFAULT_URL } : await ensureTeamProfiles(options);
  const matchInfo = inferMatchInfo(stored);
  const preferredType = options.preferredType || inferPreferredType(matchInfo);

  if (!load.ok || !load.data) {
    return {
      ok: false,
      loaded: false,
      matched: false,
      sourceUrl: load.sourceUrl || TEAM_PROFILE_DEFAULT_URL,
      pageUrl: TEAM_PROFILE_PAGE_URL,
      coverage: load.coverage || getProfileCoverage({}),
      matchInfo,
      home: { matched: false, name: matchInfo.home, type: '', profile: null, score: 0 },
      away: { matched: false, name: matchInfo.away, type: '', profile: null, score: 0 },
      error: load.error || '画像库未加载'
    };
  }

  const home = matchTeamProfile(load.data, matchInfo.home, { type: preferredType });
  const away = matchTeamProfile(load.data, matchInfo.away, { type: preferredType });
  const matchedCount = [home, away].filter(x => x.matched).length;
  return {
    ok: true,
    loaded: true,
    matched: matchedCount === 2,
    partialMatched: matchedCount === 1,
    matchedCount,
    sourceUrl: load.sourceUrl || load.meta?.sourceUrl || TEAM_PROFILE_DEFAULT_URL,
    pageUrl: TEAM_PROFILE_PAGE_URL,
    updatedAt: load.meta?.updatedAt || '',
    version: load.data?.meta?.version || load.meta?.version || '',
    coverage: load.coverage || getProfileCoverage(load.data),
    matchInfo,
    preferredType,
    home,
    away,
    warning: load.warning || ''
  };
}

function formatScheduleLine(schedule = []) {
  if (!Array.isArray(schedule) || schedule.length === 0) return '';
  const lines = schedule.map(m =>
    `    MD${m.matchday} ${m.date} vs ${m.opponent}｜${m.venue}(${m.city})｜开球ET ${m.kickoffET}`
  );
  return `\n  - 小组赛程：\n${lines.join('\n')}`;
}

function formatVenueEnvironment(venueEnv = []) {
  if (!Array.isArray(venueEnv) || venueEnv.length === 0) return '';
  const lines = venueEnv.map(v => {
    const ac = v.airConditioning ? '空调✓' : '无空调';
    const alt = v.altitudeM > 500 ? `⚠海拔${v.altitudeM}m` : `海拔${v.altitudeM}m`;
    const warnings = Array.isArray(v.performanceWarnings) ? v.performanceWarnings.slice(0, 3).join('；') : '';
    return `    ${v.name}(${v.city})：${v.turf}｜${v.roof}｜${ac}｜${alt}｜气候${v.climate}｜均温${v.tempJuneAvgC}°C｜湿度${v.humidityPct}%${warnings ? `\n      风险：${warnings}` : ''}`;
  });
  return `\n  - 场馆环境：\n${lines.join('\n')}`;
}

function formatProfileLine(sideLabel, item = {}) {
  const p = item.profile || {};
  if (!item.matched) return `- ${sideLabel}：${item.name || '-'} → 未匹配画像库（本场只使用盘口/原始数据，不臆造画像）`;
  const name = firstDefined(p.country, p.name, p.teamName, p.club, item.name, '-');
  const tier = firstDefined(p.powerTier, p.baseTier, p.tier, '-');
  const rank = firstDefined(p.fifaRank, p.leagueRank, p.rank, '-');
  const value = firstDefined(p.marketValue, p.squadValue, '-');
  const odds = firstDefined(p.worldCupOdds, p.titleOdds, p.outrightOdds, '-');
  const style = safeArray(p.styleTags).concat(safeArray(p.tacticalStyle)).slice(0, 4).join(' / ') || '-';
  const players = safeArray(p.corePlayers).slice(0, 5).join('、') || '-';
  const verify = p.verificationStatus || 'unknown';
  const notes = text(p.notes).slice(0, 120);
  const scheduleMd = formatScheduleLine(p.groupSchedule);
  const venueMd = formatVenueEnvironment(p.venueEnvironment);
  const impactMd = p.venueImpactSummary ? `\n  - 场馆影响(${p.scheduleVenueRiskRating || '?'}风险)：${String(p.venueImpactSummary).slice(0, 400)}` : '';
  return `- ${sideLabel}：**${name}**（${profileTypeLabel(item.type)}，匹配${Math.round(item.score || 0)}，验证：${verify}）｜Tier ${tier}｜排名 ${rank}｜身价 ${value}｜赔率 ${odds}\n  - 风格：${style}\n  - 核心：${players}${notes ? `\n  - 备注：${notes}` : ''}${scheduleMd}${venueMd}${impactMd}`;
}

export function teamProfilesToMarkdown(context = {}) {
  if (!context || typeof context !== 'object') {
    return '### 🧬 球队画像库\n> 暂无球队画像上下文。';
  }
  const coverage = context.coverage || {};
  const lines = [
    '### 🧬 球队画像库（自动匹配）',
    `> 来源：${context.sourceUrl || TEAM_PROFILE_DEFAULT_URL}`,
    `> 覆盖：国家队 ${coverage.nationalTeams || 0} / 联赛 ${coverage.leagues || 0} / 俱乐部 ${coverage.clubs || 0}；版本：${context.version || '-'}；更新：${context.updatedAt || '-'}`
  ];
  if (!context.loaded || context.ok === false) {
    lines.push(`> 状态：未加载或更新失败（${context.error || context.warning || 'unknown'}）。本场预测不阻断，回落到盘口/原始数据。`);
    return lines.join('\n');
  }
  lines.push(formatProfileLine('主队画像', context.home));
  lines.push(formatProfileLine('客队画像', context.away));
  if (context.warning) lines.push(`> 更新提示：远程刷新失败，当前使用本地缓存：${context.warning}`);
  lines.push('> 使用纪律：球队画像只作为基本面/热度/长期实力的 20% 修正，不能绕过 MARKET_COMMAND_JSON 盘口总控；partial 或未匹配画像只能作弱参考。');
  return lines.join('\n');
}

const TeamProfileEngine = {
  TEAM_PROFILE_DEFAULT_URL,
  TEAM_PROFILE_PAGE_URL,
  TEAM_PROFILE_TTL_MS,
  normalizeTeamName,
  matchTeamProfile,
  getProfileCoverage,
  getTeamProfileStatus,
  refreshTeamProfiles,
  ensureTeamProfiles,
  enrichMatchWithTeamProfiles,
  teamProfilesToMarkdown
};

export default TeamProfileEngine;
