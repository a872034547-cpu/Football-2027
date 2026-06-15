const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

const DATE_FORMATTER_CACHE = new Map();

function getDateFormatter(timeZone) {
  const zone = timeZone || DEFAULT_TIME_ZONE;
  if (!DATE_FORMATTER_CACHE.has(zone)) {
    DATE_FORMATTER_CACHE.set(
      zone,
      new Intl.DateTimeFormat('en-CA', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      })
    );
  }
  return DATE_FORMATTER_CACHE.get(zone);
}

export function todayInTimezone(timeZone = DEFAULT_TIME_ZONE) {
  return getDateFormatter(timeZone).format(new Date());
}

function buildMatchTime(date, time) {
  return `${date}T${time}:00+08:00`;
}

function buildSampleMatches(date) {
  return [
    {
      matchId: `sample-${date}-001`,
      businessDate: date,
      league: '英超',
      home: '曼城',
      away: '阿森纳',
      matchTime: buildMatchTime(date, '19:30'),
      status: 'pre_match',
      source: 'sample-data',
      sourceUrl: 'sample://matches/epl/mancity-arsenal',
      lotteryNo: '周日001',
      odds: {
        win: 1.88,
        draw: 3.55,
        lose: 3.65,
        updatedAt: buildMatchTime(date, '10:20'),
        provider: 'sample-european-odds'
      },
      asian: {
        line: -0.5,
        homeWater: 0.92,
        awayWater: 0.94,
        updatedAt: buildMatchTime(date, '10:20'),
        provider: 'sample-asian-line'
      },
      overunder: {
        line: 2.75,
        overWater: 0.9,
        underWater: 0.96,
        updatedAt: buildMatchTime(date, '10:20'),
        provider: 'sample-total-goals'
      },
      completenessScore: 0.92,
      raw: {
        homeRank: 2,
        awayRank: 1,
        marketNote: '强强对话，欧赔与亚盘样例数据较完整。',
        injurySummary: '双方主力阵容基本完整。'
      }
    },
    {
      matchId: `sample-${date}-002`,
      businessDate: date,
      league: '西甲',
      home: '皇家社会',
      away: '比利亚雷亚尔',
      matchTime: buildMatchTime(date, '21:00'),
      status: 'pre_match',
      source: 'sample-data',
      sourceUrl: 'sample://matches/laliga/real-sociedad-villarreal',
      lotteryNo: '周日002',
      odds: {
        win: 2.18,
        draw: 3.1,
        lose: 3.05,
        updatedAt: buildMatchTime(date, '10:35'),
        provider: 'sample-european-odds'
      },
      asian: {
        line: -0.25,
        homeWater: 1.02,
        awayWater: 0.82,
        updatedAt: buildMatchTime(date, '10:35'),
        provider: 'sample-asian-line'
      },
      overunder: {
        line: 2.25,
        overWater: 0.98,
        underWater: 0.86,
        updatedAt: buildMatchTime(date, '10:35'),
        provider: 'sample-total-goals'
      },
      completenessScore: 0.78,
      raw: {
        homeRank: 6,
        awayRank: 8,
        marketNote: '主队让步偏浅且主队高水，适合测试后续降级逻辑。',
        injurySummary: '客队锋线轮换信息待确认。'
      }
    },
    {
      matchId: `sample-${date}-003`,
      businessDate: date,
      league: '意甲',
      home: '罗马',
      away: '拉齐奥',
      matchTime: buildMatchTime(date, '23:30'),
      status: 'pre_match',
      source: 'sample-data',
      sourceUrl: 'sample://matches/serie-a/roma-lazio',
      lotteryNo: '周日003',
      odds: {
        win: 2.46,
        draw: 2.95,
        lose: 2.72,
        updatedAt: buildMatchTime(date, '11:05'),
        provider: 'sample-european-odds'
      },
      asian: {
        line: 0,
        homeWater: 0.88,
        awayWater: 1.0,
        updatedAt: buildMatchTime(date, '11:05'),
        provider: 'sample-asian-line'
      },
      overunder: {
        line: 2,
        overWater: 1.04,
        underWater: 0.8,
        updatedAt: buildMatchTime(date, '11:05'),
        provider: 'sample-total-goals'
      },
      completenessScore: 0.71,
      raw: {
        derby: true,
        marketNote: '德比战波动较大，大小球低水侧明显。',
        injurySummary: '部分停赛与轮换消息未完全确认。'
      }
    },
    {
      matchId: `sample-${date}-004`,
      businessDate: date,
      league: '日职联',
      home: '横滨水手',
      away: '川崎前锋',
      matchTime: buildMatchTime(date, '18:00'),
      status: 'live_pending',
      source: 'sample-data',
      sourceUrl: 'sample://matches/j1/yokohama-marinos-kawasaki-frontale',
      lotteryNo: '周日004',
      odds: {
        win: 2.62,
        draw: 3.55,
        lose: 2.28,
        updatedAt: buildMatchTime(date, '09:50'),
        provider: 'sample-european-odds'
      },
      asian: {
        line: 0.25,
        homeWater: 0.86,
        awayWater: 1.02,
        updatedAt: buildMatchTime(date, '09:50'),
        provider: 'sample-asian-line'
      },
      overunder: {
        line: 3,
        overWater: 0.84,
        underWater: 1.04,
        updatedAt: buildMatchTime(date, '09:50'),
        provider: 'sample-total-goals'
      },
      completenessScore: 0.66,
      raw: {
        tempo: 'high',
        marketNote: '进球预期偏高但临场阵容缺失，适合测试 live/sourceMeta 降级。',
        injurySummary: '双方首发名单待开赛前确认。'
      }
    }
  ];
}

function clone(value) {
  return structuredClone(value);
}

function toPercentFromOdds(odds) {
  if (!Number.isFinite(odds) || odds <= 0) return null;
  return Number((100 / odds).toFixed(2));
}

function normalizeMatchId(matchId) {
  return String(matchId || '').trim();
}

function buildSnapshot(match) {
  const quality = match.completenessScore >= 0.85 ? 'sample_complete' : 'sample_degraded';
  const downgradeReasons = [];

  if (match.completenessScore < 0.85) {
    downgradeReasons.push('sample_completeness_below_full_threshold');
  }
  if (match.status !== 'pre_match') {
    downgradeReasons.push('sample_status_requires_live_confirmation');
  }
  if (match.raw?.injurySummary?.includes('待')) {
    downgradeReasons.push('sample_lineup_or_injury_pending');
  }

  return {
    analysis: {
      matchId: match.matchId,
      businessDate: match.businessDate,
      league: match.league,
      matchup: `${match.home} vs ${match.away}`,
      status: match.status,
      quality,
      completenessScore: match.completenessScore,
      downgradeRequired: downgradeReasons.length > 0,
      downgradeReasons,
      summary: '本地样例快照仅用于打通后续分析链路，不能作为真实投注依据。'
    },
    winDrawWin: {
      odds: clone(match.odds),
      impliedProbabilityPct: {
        win: toPercentFromOdds(match.odds.win),
        draw: toPercentFromOdds(match.odds.draw),
        lose: toPercentFromOdds(match.odds.lose)
      },
      dataQuality: quality,
      downgradeHint: downgradeReasons.length > 0 ? '胜平负仅作样例输入，需等待真实采集源复核。' : '样例字段完整，可进入基础分析演示。'
    },
    asian: {
      line: match.asian.line,
      homeWater: match.asian.homeWater,
      awayWater: match.asian.awayWater,
      provider: match.asian.provider,
      updatedAt: match.asian.updatedAt,
      dataQuality: quality,
      downgradeHint: Math.abs(match.asian.homeWater - match.asian.awayWater) >= 0.16
        ? '亚盘水位差偏大，后续分析应降级并要求临场确认。'
        : '亚盘样例水位相对均衡。'
    },
    overunder: {
      line: match.overunder.line,
      overWater: match.overunder.overWater,
      underWater: match.overunder.underWater,
      provider: match.overunder.provider,
      updatedAt: match.overunder.updatedAt,
      dataQuality: quality,
      downgradeHint: Math.abs(match.overunder.overWater - match.overunder.underWater) >= 0.16
        ? '大小球水位差偏大，后续分析应降级并要求临场确认。'
        : '大小球样例水位相对均衡。'
    },
    live: {
      status: match.status,
      matchTime: match.matchTime,
      hasLiveFeed: false,
      score: null,
      incidents: [],
      downgradeHint: '样例数据不包含真实滚球事件，滚球与临场结论必须降级。'
    },
    sourceMeta: {
      source: match.source,
      sourceUrl: match.sourceUrl,
      lotteryNo: match.lotteryNo,
      generatedAt: new Date().toISOString(),
      isSample: true,
      raw: clone(match.raw)
    }
  };
}

export function getSampleTodayMatches(date = todayInTimezone()) {
  return buildSampleMatches(date).map(clone);
}

export function getSampleMatchSnapshot(matchId, date = todayInTimezone()) {
  const normalizedMatchId = normalizeMatchId(matchId);
  const match = buildSampleMatches(date).find((item) => item.matchId === normalizedMatchId || item.lotteryNo === normalizedMatchId);

  if (!match) {
    return null;
  }

  return buildSnapshot(match);
}
