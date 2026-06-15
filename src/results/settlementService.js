import {
  actualOutcome1x2,
  leadingPick,
  metricsFor1x2,
  normalizeOutcomeSide,
  normalizeProb1x2,
} from '../metrics/probabilityMetrics.js';

export function buildMatchResult(input = {}) {
  const homeScore = toInteger(input.homeScore ?? input.home_score);
  const awayScore = toInteger(input.awayScore ?? input.away_score);
  const result1x2 = normalizeOutcomeSide(input.result1x2 ?? input.result_1x2)
    || actualOutcome1x2({ home_score: homeScore, away_score: awayScore });

  return {
    match_id: input.match_id ?? input.matchId,
    business_date: input.business_date ?? input.businessDate,
    league: input.league,
    home: input.home,
    away: input.away,
    kickoff_time: input.kickoff_time ?? input.kickoffTime ?? input.match_time ?? input.matchTime,
    home_score: homeScore,
    away_score: awayScore,
    result_1x2: result1x2,
    total_goals: Number.isFinite(homeScore) && Number.isFinite(awayScore) ? homeScore + awayScore : null,
    asian_result_json: input.asian_result_json ?? input.asianResult ?? null,
    overunder_result_json: input.overunder_result_json ?? input.overunderResult ?? null,
    source: input.source || 'manual',
    source_json: input.source_json ?? input.sourceJson ?? input,
    confirmed_at: input.confirmed_at ?? input.confirmedAt ?? new Date().toISOString(),
  };
}

export function settleAnalysisReport(report = {}, result = {}) {
  const matchResult = buildMatchResult(result);
  const actualSide = normalizeOutcomeSide(matchResult.result_1x2);

  if (!report?.match_id && !report?.matchId) {
    return {
      ok: false,
      reason: 'missing_report_match_id',
    };
  }

  if (!actualSide) {
    return {
      ok: false,
      reason: 'missing_actual_outcome',
      matchResult,
    };
  }

  const probabilities = normalizeProb1x2(report.probabilities_json ?? report.probabilities ?? {});
  const metrics = metricsFor1x2(probabilities, actualSide);
  if (!metrics.ok) return metrics;

  const primaryPick = extractPrimaryPick(report, probabilities);
  const predictionKey = buildPredictionKey({
    matchId: report.match_id ?? report.matchId,
    analysisReportId: report.id ?? report.analysis_report_id ?? report.analysisReportId,
  });

  return {
    ok: true,
    outcome: {
      outcome_key: predictionKey,
      match_id: report.match_id ?? report.matchId,
      analysis_report_id: report.id ?? report.analysis_report_id ?? report.analysisReportId ?? null,
      business_date: report.business_date ?? report.businessDate ?? matchResult.business_date,
      predicted_side: primaryPick.side,
      predicted_prob: primaryPick.probability,
      candidate_tier: extractCandidateTier(report),
      rank_score: toNumber(report.rank_score ?? report.rankScore),
      enhanced_rank_score: toNumber(report.enhanced_rank_score ?? report.enhancedRankScore ?? report.agent_json?.serverEnhancement?.decision?.enhancedScore),
      risk_level: report.risk_level ?? report.riskLevel ?? null,
      settled_result: actualSide,
      is_hit: primaryPick.side === actualSide ? 1 : 0,
      brier: metrics.brier,
      log_loss: metrics.logLoss,
      rps: metrics.rps,
      settled_at: new Date().toISOString(),
      meta_json: {
        probabilities,
        metricProbabilities: metrics.probabilities,
        matchResult,
        reportCreatedAt: report.created_at ?? report.createdAt ?? null,
      },
    },
    metrics,
    matchResult,
  };
}

export function buildPredictionKey({ matchId, analysisReportId } = {}) {
  const safeMatchId = String(matchId || '').trim();
  const safeReportId = analysisReportId === undefined || analysisReportId === null || analysisReportId === ''
    ? 'latest'
    : String(analysisReportId).trim();

  return `${safeMatchId}:${safeReportId}`;
}

function extractPrimaryPick(report = {}, probabilities = {}) {
  const agent = report.agent_json && typeof report.agent_json === 'object' ? report.agent_json : {};
  const structured = report.report_structured && typeof report.report_structured === 'object' ? report.report_structured : {};
  const candidates = [
    report.primary_pick,
    report.primaryPick,
    agent.primaryPick,
    structured.primaryPick,
    structured.betAdvice?.primaryPick,
    Array.isArray(report.trusted_plans_json) ? report.trusted_plans_json[0] : null,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const side = pickSideFromText(candidate);
      if (side) return { side, probability: probabilities[side] ?? leadingPick(probabilities).probability };
    }

    if (candidate && typeof candidate === 'object') {
      const side = normalizeOutcomeSide(
        candidate.side
          ?? candidate.pick
          ?? candidate.selection
          ?? candidate.direction
          ?? candidate.predicted_side
          ?? candidate.predictedSide,
      ) || pickSideFromText(candidate.direction ?? candidate.reason ?? candidate.label ?? '');

      if (side) {
        const probability = toNumber(candidate.probability ?? candidate.prob ?? candidate.predicted_prob, probabilities[side]);
        return { side, probability };
      }
    }
  }

  return leadingPick(probabilities);
}

function extractCandidateTier(report = {}) {
  const agent = report.agent_json && typeof report.agent_json === 'object' ? report.agent_json : {};
  return report.candidate_tier
    ?? report.candidateTier
    ?? report.enhancedCandidateTier
    ?? agent.enhancedCandidateTier
    ?? agent.serverEnhancement?.decision?.candidateTier
    ?? null;
}

function pickSideFromText(value = '') {
  const text = String(value);
  if (/主胜|主队|home|胜/.test(text) && !/客胜|客队|away|负/.test(text)) return 'home';
  if (/平局|平|draw|tie|\bx\b/i.test(text)) return 'draw';
  if (/客胜|客队|away|负/.test(text)) return 'away';
  return null;
}

function toInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export default {
  buildMatchResult,
  settleAnalysisReport,
  buildPredictionKey,
};
