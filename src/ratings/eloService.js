/**
 * Elo Rating Service - P1 足球预测 Elo 评分系统
 * 
 * 基于 World Football Elo Ratings 和 ClubElo 方法论
 * 参考：https://www.eloratings.net/ 和 http://clubelo.com/
 */

import * as db from '../db/index.js';

// ============================================================================
// Constants - 根据调研确定的参数
// ============================================================================

const DEFAULT_RATING = 1500;
const HOME_FIELD_ADVANTAGE = 55;
const K_FACTOR_REGULAR = 20;
const K_FACTOR_PROVISIONAL = 28;
const PROVISIONAL_MATCH_THRESHOLD = 10;
const GOAL_MARGIN_CAP = 2.2;

const COMPETITION_WEIGHTS = {
  league: 1.0,
  cup: 0.9,
  friendly: 0.6,
  default: 1.0,
};

// ============================================================================
// Team Name Normalization - 复用 js/team-profile-engine.js 逻辑
// ============================================================================

/**
 * 队名规范化，生成统一的 team_key
 * 复用 js/team-profile-engine.js 的 normalizeTeamName 逻辑
 */
export function normalizeTeamName(name = '') {
  return String(name || '')
    .toLowerCase()
    .replace(/[\s\u3000·•.。''`-]+/g, '')
    .replace(/[()（）\[\]【】]/g, '')
    .replace(/足球俱乐部|俱乐部|国家队|队$/g, '')
    .replace(/\b(fc|cf|sc|afc|cfc|club|footballclub|the)\b/g, '')
    .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '')
    .trim();
}

// ============================================================================
// Elo Calculation Functions
// ============================================================================

/**
 * 计算期望得分（Expected Score）
 * E = 1 / (10^(-(R_home + HFA - R_away) / 400) + 1)
 */
export function calculateExpectedScore(homeRating, awayRating, homeAdvantage = HOME_FIELD_ADVANTAGE) {
  const ratingDiff = homeRating + homeAdvantage - awayRating;
  const expected = 1 / (Math.pow(10, -ratingDiff / 400) + 1);
  return Math.max(0, Math.min(1, expected)); // 限制在 [0, 1]
}

/**
 * 计算实际得分（Actual Score）
 * 赢 = 1.0, 平 = 0.5, 输 = 0.0
 */
export function calculateActualScore(homeScore, awayScore) {
  if (homeScore > awayScore) return 1.0;
  if (homeScore < awayScore) return 0.0;
  return 0.5;
}

/**
 * 计算进球差乘数（Goal Margin Multiplier）
 * G = min(sqrt(|goal_diff|), 2.2)
 * 采用 ClubElo 的平方根公式，带上限
 */
export function calculateGoalMarginMultiplier(homeScore, awayScore) {
  const goalDiff = Math.abs(Number(homeScore) - Number(awayScore));
  if (!Number.isFinite(goalDiff) || goalDiff <= 1) return 1;

  const multiplier = Math.sqrt(goalDiff);
  return Math.min(multiplier, GOAL_MARGIN_CAP);
}

/**
 * 获取 K-factor
 * 新球队（比赛数 < 10）：28，常规球队：20
 */
export function getKFactor(matchesPlayed) {
  return matchesPlayed < PROVISIONAL_MATCH_THRESHOLD ? K_FACTOR_PROVISIONAL : K_FACTOR_REGULAR;
}

/**
 * 获取赛事权重（Competition Weight）
 * 根据联赛类型返回权重，默认 1.0
 */
export function getCompetitionWeight(league = '') {
  const lowerLeague = String(league).toLowerCase();
  
  if (lowerLeague.includes('friendly') || lowerLeague.includes('热身') || lowerLeague.includes('友谊')) {
    return COMPETITION_WEIGHTS.friendly;
  }
  if (lowerLeague.includes('cup') || lowerLeague.includes('杯')) {
    return COMPETITION_WEIGHTS.cup;
  }
  
  return COMPETITION_WEIGHTS.default;
}

/**
 * 计算 Elo 评分变化
 * Delta = K * G * CompWeight * (W - E)
 */
export function calculateRatingChange(kFactor, goalMarginMultiplier, competitionWeight, actual, expected) {
  return kFactor * goalMarginMultiplier * competitionWeight * (actual - expected);
}

// ============================================================================
// Database Integration Functions
// ============================================================================

/**
 * 获取或初始化球队评分
 */
export async function getOrInitTeamRating(namespace = 'global', teamKey, teamName = null, league = null) {
  let rating = db.getTeamRating(namespace, teamKey);
  
  if (!rating) {
    // 初始化新球队
    rating = {
      namespace,
      team_key: teamKey,
      team_name: teamName,
      league,
      rating: DEFAULT_RATING,
      matches_played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      goals_for: 0,
      goals_against: 0,
    };
    db.upsertTeamRating(rating);
    rating = db.getTeamRating(namespace, teamKey);
  }
  
  return rating;
}

/**
 * 更新球队评分和统计
 */
function updateTeamStats(rating, newRating, homeScore, awayScore, isHome, matchId, businessDate) {
  const goalDiff = isHome ? (homeScore - awayScore) : (awayScore - homeScore);
  
  return {
    namespace: rating.namespace,
    team_key: rating.team_key,
    team_name: rating.team_name,
    league: rating.league,
    rating: newRating,
    matches_played: rating.matches_played + 1,
    wins: rating.wins + (goalDiff > 0 ? 1 : 0),
    draws: rating.draws + (goalDiff === 0 ? 1 : 0),
    losses: rating.losses + (goalDiff < 0 ? 1 : 0),
    goals_for: rating.goals_for + (isHome ? homeScore : awayScore),
    goals_against: rating.goals_against + (isHome ? awayScore : homeScore),
    last_match_id: matchId,
    last_played_at: businessDate,
  };
}

/**
 * 处理比赛结果并更新 Elo 评分
 * 
 * @param {Object} matchResult - 比赛结果
 * @param {string} matchResult.match_id - 比赛 ID
 * @param {string} matchResult.business_date - 业务日期
 * @param {string} matchResult.league - 联赛名称
 * @param {string} matchResult.home_team - 主队名称
 * @param {string} matchResult.away_team - 客队名称
 * @param {number} matchResult.home_score - 主队得分
 * @param {number} matchResult.away_score - 客队得分
 * @param {string} [namespace='global'] - 命名空间
 * @returns {Object} 包含更新结果的对象
 */
export async function processMatchResult(matchResult, namespace = 'global') {
  const normalizedResult = normalizeMatchResultInput(matchResult);
  const {
    matchId,
    businessDate,
    league,
    homeTeamName,
    awayTeamName,
    homeScore,
    awayScore,
  } = normalizedResult;

  if (!matchId) throw new Error('processMatchResult requires match_id or matchId');
  if (!homeTeamName || !awayTeamName) throw new Error('processMatchResult requires home_team/away_team or homeTeam/awayTeam');
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) throw new Error('processMatchResult requires numeric home_score/away_score');
  
  // 规范化队名
  const homeTeamKey = normalizeTeamName(homeTeamName);
  const awayTeamKey = normalizeTeamName(awayTeamName);
  
  // 获取或初始化球队评分
  const homeRating = await getOrInitTeamRating(namespace, homeTeamKey, homeTeamName, league);
  const awayRating = await getOrInitTeamRating(namespace, awayTeamKey, awayTeamName, league);
  
  // 计算期望得分
  const expectedHome = calculateExpectedScore(homeRating.rating, awayRating.rating);
  const expectedAway = 1 - expectedHome;
  
  // 计算实际得分
  const actualHome = calculateActualScore(homeScore, awayScore);
  const actualAway = 1 - actualHome;
  
  // 计算参数
  const goalMarginMultiplier = calculateGoalMarginMultiplier(homeScore, awayScore);
  const competitionWeight = getCompetitionWeight(league);
  const homeKFactor = getKFactor(homeRating.matches_played);
  const awayKFactor = getKFactor(awayRating.matches_played);
  
  // 计算评分变化
  const homeDelta = calculateRatingChange(homeKFactor, goalMarginMultiplier, competitionWeight, actualHome, expectedHome);
  const awayDelta = calculateRatingChange(awayKFactor, goalMarginMultiplier, competitionWeight, actualAway, expectedAway);
  
  // 新评分
  const newHomeRating = Math.round((homeRating.rating + homeDelta) * 10) / 10;
  const newAwayRating = Math.round((awayRating.rating + awayDelta) * 10) / 10;
  
  // 记录 Elo 事件
  const eventKey = `${namespace}:${matchId}`;
  const eloEvent = {
    event_key: eventKey,
    namespace,
    match_id: matchId,
    business_date: businessDate,
    league,
    home_team_key: homeTeamKey,
    away_team_key: awayTeamKey,
    home_team_name: homeTeamName,
    away_team_name: awayTeamName,
    home_score: homeScore,
    away_score: awayScore,
    actual_home: actualHome,
    expected_home: expectedHome,
    home_rating_before: homeRating.rating,
    away_rating_before: awayRating.rating,
    home_rating_after: newHomeRating,
    away_rating_after: newAwayRating,
    delta: homeDelta,
    k_factor: homeKFactor,
    competition_weight: competitionWeight,
    margin_multiplier: goalMarginMultiplier,
    home_advantage: HOME_FIELD_ADVANTAGE,
    config_json: {
      k_factor_home: homeKFactor,
      k_factor_away: awayKFactor,
      default_rating: DEFAULT_RATING,
      provisional_threshold: PROVISIONAL_MATCH_THRESHOLD,
    },
  };
  
  db.upsertEloRatingEvent(eloEvent);
  
  // 更新球队评分
  const updatedHome = updateTeamStats(homeRating, newHomeRating, homeScore, awayScore, true, matchId, businessDate);
  const updatedAway = updateTeamStats(awayRating, newAwayRating, homeScore, awayScore, false, matchId, businessDate);
  
  db.upsertTeamRating(updatedHome);
  db.upsertTeamRating(updatedAway);
  
  return {
    success: true,
    event_key: eventKey,
    home: {
      team_key: homeTeamKey,
      oldRating: homeRating.rating,
      newRating: newHomeRating,
      rating_before: homeRating.rating,
      rating_after: newHomeRating,
      delta: homeDelta,
    },
    away: {
      team_key: awayTeamKey,
      oldRating: awayRating.rating,
      newRating: newAwayRating,
      rating_before: awayRating.rating,
      rating_after: newAwayRating,
      delta: awayDelta,
    },
    expected: {
      home: expectedHome,
      away: expectedAway,
      homeWinProb: expectedHome,
      awayWinProb: expectedAway,
      homeAdvantage: HOME_FIELD_ADVANTAGE,
    },
    actual: {
      home: actualHome,
      away: actualAway,
    },
  };
}

/**
 * 获取球队当前评分（用于赛前预测）
 */
export async function getTeamRatingsForMatch(homeTeamName, awayTeamName, league = null, namespace = 'global') {
  const homeTeamKey = normalizeTeamName(homeTeamName);
  const awayTeamKey = normalizeTeamName(awayTeamName);
  
  const homeRating = await getOrInitTeamRating(namespace, homeTeamKey, homeTeamName, league);
  const awayRating = await getOrInitTeamRating(namespace, awayTeamKey, awayTeamName, league);
  
  const expectedHome = calculateExpectedScore(homeRating.rating, awayRating.rating);
  
  return {
    home: {
      team_key: homeTeamKey,
      team_name: homeTeamName,
      rating: homeRating.rating,
      matches_played: homeRating.matches_played,
    },
    away: {
      team_key: awayTeamKey,
      team_name: awayTeamName,
      rating: awayRating.rating,
      matches_played: awayRating.matches_played,
    },
    expected: {
      home: expectedHome,
      away: 1 - expectedHome,
      homeWinProb: expectedHome,
      awayWinProb: 1 - expectedHome,
      homeAdvantage: HOME_FIELD_ADVANTAGE,
      ratingDiff: homeRating.rating - awayRating.rating,
    },
    expected_home_score: expectedHome,
    expected_away_score: 1 - expectedHome,
    rating_diff: homeRating.rating - awayRating.rating,
    home_advantage: HOME_FIELD_ADVANTAGE,
  };
}

function normalizeMatchResultInput(matchResult = {}) {
  const homeScore = Number(matchResult.home_score ?? matchResult.homeScore);
  const awayScore = Number(matchResult.away_score ?? matchResult.awayScore);

  return {
    matchId: matchResult.match_id ?? matchResult.matchId ?? matchResult.id ?? null,
    businessDate: matchResult.business_date ?? matchResult.businessDate ?? matchResult.date ?? null,
    league: matchResult.league ?? matchResult.competition ?? null,
    homeTeamName: matchResult.home_team ?? matchResult.homeTeam ?? matchResult.home ?? null,
    awayTeamName: matchResult.away_team ?? matchResult.awayTeam ?? matchResult.away ?? null,
    homeScore,
    awayScore,
  };
}

export default {
  normalizeTeamName,
  calculateExpectedScore,
  calculateActualScore,
  calculateGoalMarginMultiplier,
  getKFactor,
  getCompetitionWeight,
  calculateRatingChange,
  processMatchResult,
  getTeamRatingsForMatch,
  getOrInitTeamRating,
};
