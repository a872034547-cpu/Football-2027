// skill-loader.js - 赛事规则Skill加载器（普通脚本，挂载到 window.skillLoader）
// 架构说明：
//   - 基础层：专业盘口分析师（market-analyst）。所有AI深度分析永远包含该层，
//     由 ai-client 的 _marketReadingDoctrine + _expertKnowledgeDoctrine 固化注入，不可关闭。
//   - 叠加层：赛事规则skill（通用联赛/世界杯2026等）。选择skill只是切换赛事专属规则，
//     在基础层之上追加提示词，不替代盘口分析。
(function () {
  'use strict';

  const BASE_SKILL_FILE = 'skills/market-analyst.json';
  const OVERLAY_SKILL_FILES = [
    'skills/general-league.json',
    'skills/worldcup-2026-coach.json'
  ];
  const PREF_KEY = 'preferredSkill';
  const DEFAULT_SKILL_ID = 'general-league';

  const state = {
    baseSkill: null,
    overlays: [],
    loaded: false,
    loadPromise: null
  };

  async function fetchSkillJson(file) {
    try {
      const url = chrome.runtime.getURL(file);
      const resp = await fetch(url);
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) {
      console.warn('[SkillLoader] 加载skill失败:', file, e);
      return null;
    }
  }

  async function loadSkills() {
    if (state.loaded) return getOverlays();
    if (state.loadPromise) { await state.loadPromise; return getOverlays(); }
    state.loadPromise = (async () => {
      const [base, ...overlays] = await Promise.all([
        fetchSkillJson(BASE_SKILL_FILE),
        ...OVERLAY_SKILL_FILES.map(fetchSkillJson)
      ]);
      state.baseSkill = base || null;
      state.overlays = overlays.filter(s => s && s.enabled !== false);
      state.loaded = true;
    })();
    await state.loadPromise;
    return getOverlays();
  }

  function getOverlays() {
    return state.overlays.slice();
  }

  function getBaseSkill() {
    return state.baseSkill;
  }

  function getSkillById(skillId) {
    if (!skillId) return null;
    return state.overlays.find(s => s.id === skillId) || null;
  }

  function getDefaultSkillId() {
    const flagged = state.overlays.find(s => s.default === true);
    return flagged ? flagged.id : DEFAULT_SKILL_ID;
  }

  // 根据联赛/赛事名称推荐叠加skill（仅做提示，不强制切换）
  function recommendSkill(leagueName = '') {
    const text = String(leagueName || '').trim();
    if (!text) return getDefaultSkillId();
    for (const skill of state.overlays) {
      const scenes = Array.isArray(skill.applicableScenarios) ? skill.applicableScenarios : [];
      if (scenes.includes('all')) continue;
      if (scenes.some(kw => kw && text.includes(kw))) return skill.id;
    }
    return getDefaultSkillId();
  }

  // 构建叠加提示词（基础层由 ai-client 固化注入，这里只输出赛事规则叠加部分）
  function buildPromptEnhancement(skillId) {
    const skill = getSkillById(skillId);
    if (!skill || skill.id === DEFAULT_SKILL_ID) return '';
    const parts = [];
    if (skill.promptTemplate) parts.push(String(skill.promptTemplate).trim());
    if (skill.knockoutBracket && Array.isArray(skill.knockoutBracket.matches) && skill.knockoutBracket.matches.length) {
      const lines = skill.knockoutBracket.matches.map(m =>
        `- 第${m.id}场 ${m.date}：${(m.teams || []).join(' vs ')}`
      );
      parts.push(`### 淘汰赛对阵规则参考\n${skill.knockoutBracket.note || ''}\n${lines.join('\n')}`);
    }
    if (!parts.length) return '';
    return `\n\n## 🏆 赛事规则叠加层（${skill.name}）\n> 以下为赛事专属规则补充，叠加在专业盘口分析师基础层之上，不替代盘口/价值/风险分析。\n\n${parts.join('\n\n')}`;
  }

  async function getPreferredSkillId() {
    try {
      const obj = await chrome.storage.sync.get([PREF_KEY]);
      const id = obj && obj[PREF_KEY];
      if (id && getSkillById(id)) return id;
    } catch (e) { /* ignore */ }
    return getDefaultSkillId();
  }

  async function setPreferredSkillId(skillId) {
    try {
      await chrome.storage.sync.set({ [PREF_KEY]: skillId || getDefaultSkillId() });
    } catch (e) { /* ignore */ }
  }

  window.skillLoader = {
    loadSkills,
    getOverlays,
    getBaseSkill,
    getSkillById,
    getDefaultSkillId,
    recommendSkill,
    buildPromptEnhancement,
    getPreferredSkillId,
    setPreferredSkillId
  };
})();
