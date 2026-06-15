/**
 * pro-market-engine.js — 专业盘口增强层
 *
 * 目标：把欧赔去水、亚盘深浅、大小球联动、量化EV/Kelly、临场CLV复核
 * 组织为结构化证据。它只作为 MARKET_COMMAND_JSON 的辅助增强层，不直接覆盖云端盘口总控。
 */

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).replace(/,/g, '.').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function round(v, d = 2) {
  const n = num(v);
  if (n === null) return null;
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

function clamp(v, min, max) {
  const n = num(v);
  if (n === null) return min;
  return Math.max(min, Math.min(max, n));
}

function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function isCloudMarketCommand(command = null) {
  return command?.version === 'market-command-v4' && command?._source === 'cloud';
}

function parseLineValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  const map = {
    '受让三球': -3, '受让两球半/三球': -2.75, '受让两球半': -2.5, '受让两球/两球半': -2.25,
    '受让两球': -2, '受让球半/两球': -1.75, '受让球半': -1.5, '受让一球/球半': -1.25,
    '受让一球': -1, '受让半球/一球': -0.75, '受让半球': -0.5, '受让平手/半球': -0.25,
    '平手': 0, '平手/半球': 0.25, '半球': 0.5, '半球/一球': 0.75,
    '一球': 1, '一球/球半': 1.25, '球半': 1.5, '球半/两球': 1.75,
    '两球': 2, '两球/两球半': 2.25, '两球半': 2.5, '两球半/三球': 2.75, '三球': 3
  };
  if (Object.prototype.hasOwnProperty.call(map, text)) return map[text];
  const cleaned = text.replace(/[－—]/g, '-').replace(/让|受让|盘口|球/g, '');
  if (cleaned.includes('/')) {
    const parts = cleaned.split('/').map(x => num(x)).filter(Number.isFinite);
    if (parts.length === 2) return (parts[0] + parts[1]) / 2;
  }
  return num(cleaned);
}

function decimalWater(v) {
  const n = num(v);
  if (n === null) return null;
  // 采集链路的亚盘/大小球水位是港水口径（0.72/0.94/1.12），不能把 1.12 误减成 0.12。
  // 只有明显是欧式赔率口径（如 1.80/1.95）时，才转成等价港水 0.80/0.95。
  return n >= 1.5 ? n - 1 : n;
}

function pctValue(v) {
  const n = num(v);
  if (n === null) return null;
  return n <= 1 ? round(n * 100, 1) : round(n, 1);
}

function toPctProbObject(source) {
  if (!source) return null;
  const w = num(source.win), d = num(source.draw), l = num(source.loss);
  if ([w, d, l].every(x => Number.isFinite(x) && x > 0)) {
    const looksPct = w > 1 || d > 1 || l > 1;
    return {
      win: round(looksPct ? w : w * 100, 1),
      draw: round(looksPct ? d : d * 100, 1),
      loss: round(looksPct ? l : l * 100, 1)
    };
  }
  return null;
}

function noVigFromOdds(odds = {}) {
  const w = num(odds.win), d = num(odds.draw), l = num(odds.loss);
  if (![w, d, l].every(x => Number.isFinite(x) && x > 1)) return null;
  const iw = 1 / w, id = 1 / d, il = 1 / l;
  const sum = iw + id + il;
  if (!Number.isFinite(sum) || sum <= 0) return null;
  return {
    trueProb: { win: round(iw / sum * 100, 1), draw: round(id / sum * 100, 1), loss: round(il / sum * 100, 1) },
    impliedRaw: { win: round(iw * 100, 1), draw: round(id * 100, 1), loss: round(il * 100, 1) },
    overround: round(sum, 4),
    marginPct: round((sum - 1) * 100, 2)
  };
}

function pickNoVig(normalized = {}, quant = null) {
  if (quant?.deMargin?.ok && quant.deMargin.trueProb) {
    return {
      source: quant.deMargin.oddsSource || 'quant.deMargin',
      trueProb: toPctProbObject(quant.deMargin.trueProb),
      impliedRaw: toPctProbObject(quant.deMargin.impliedRaw),
      overround: quant.deMargin.overround ?? null,
      marginPct: quant.deMargin.marginPct ?? null
    };
  }
  const odds = normalized.odds?.averageCurrent || normalized.odds?.current || null;
  const nv = noVigFromOdds(odds || {});
  return nv ? { source: 'normalized.averageCurrent', ...nv } : null;
}

function favoriteFromProb(prob = {}) {
  const entries = [
    ['home', num(prob.win)],
    ['draw', num(prob.draw)],
    ['away', num(prob.loss)]
  ].filter(([, v]) => Number.isFinite(v));
  if (!entries.length) return { side: 'unknown', probability: null, label: '未知' };
  entries.sort((a, b) => b[1] - a[1]);
  const [side, probability] = entries[0];
  const label = side === 'home' ? '主队' : side === 'away' ? '客队' : '平局';
  return { side, probability, label };
}

function expectedLineByProb(favProb) {
  const p = num(favProb);
  if (p === null) return null;
  if (p >= 72) return 1.75;
  if (p >= 67) return 1.5;
  if (p >= 62) return 1.25;
  if (p >= 58) return 1.0;
  if (p >= 54) return 0.75;
  if (p >= 50) return 0.5;
  if (p >= 46) return 0.25;
  return 0;
}

function poissonPmfLocal(k, lambda) {
  if (!Number.isFinite(lambda) || lambda <= 0 || k < 0) return 0;
  let fact = 1;
  for (let i = 2; i <= k; i += 1) fact *= i;
  return Math.exp(-lambda) * Math.pow(lambda, k) / fact;
}

function poissonOutcomeFromLambda(lambdaHome, lambdaAway, maxGoals = 8) {
  const ph = [], pa = [];
  for (let i = 0; i <= maxGoals; i += 1) {
    ph[i] = poissonPmfLocal(i, lambdaHome);
    pa[i] = poissonPmfLocal(i, lambdaAway);
  }
  let win = 0, draw = 0, loss = 0, mass = 0;
  for (let h = 0; h <= maxGoals; h += 1) {
    for (let a = 0; a <= maxGoals; a += 1) {
      const p = ph[h] * pa[a];
      mass += p;
      if (h > a) win += p;
      else if (h === a) draw += p;
      else loss += p;
    }
  }
  if (mass > 0) { win /= mass; draw /= mass; loss /= mass; }
  return { win: round(win * 100, 1), draw: round(draw * 100, 1), loss: round(loss * 100, 1) };
}

function inferLambdaFromNoVigProb(prob = {}, options = {}) {
  const target = {
    win: num(prob.win),
    draw: num(prob.draw),
    loss: num(prob.loss)
  };
  if (![target.win, target.draw, target.loss].every(Number.isFinite)) return null;
  const total = target.win + target.draw + target.loss;
  if (!Number.isFinite(total) || total <= 0) return null;
  target.win = target.win / total * 100;
  target.draw = target.draw / total * 100;
  target.loss = target.loss / total * 100;

  const minLambda = num(options.minLambda) ?? 0.35;
  const maxLambda = num(options.maxLambda) ?? 3.4;
  const step = num(options.step) ?? 0.05;
  const maxGoals = num(options.maxGoals) ?? 8;
  let best = null;
  for (let lh = minLambda; lh <= maxLambda + 1e-9; lh += step) {
    for (let la = minLambda; la <= maxLambda + 1e-9; la += step) {
      const out = poissonOutcomeFromLambda(lh, la, maxGoals);
      const err = Math.pow((out.win - target.win) / 100, 2) + Math.pow((out.draw - target.draw) / 100, 2) * 1.25 + Math.pow((out.loss - target.loss) / 100, 2);
      if (!best || err < best.error) {
        best = { lambdaHome: lh, lambdaAway: la, outcome: out, error: err };
      }
    }
  }
  if (!best) return null;
  const lambdaHome = round(best.lambdaHome, 3);
  const lambdaAway = round(best.lambdaAway, 3);
  const lambdaDiff = round(lambdaHome - lambdaAway, 3);
  return {
    ok: true,
    lambdaHome,
    lambdaAway,
    lambdaDiff,
    outcome: best.outcome,
    fitError: round(Math.sqrt(best.error) * 100, 2),
    method: '欧赔去水胜平负概率 → 网格搜索λ主/λ客 → 泊松胜平负分布最小误差拟合'
  };
}

function expectedLineByLambdaDiff(lambdaDiff) {
  const dRaw = num(lambdaDiff);
  if (dRaw === null) return null;
  const d = Math.abs(dRaw);
  let absLine = 0;
  if (d >= 1.28) absLine = 1.75;
  else if (d >= 1.08) absLine = 1.5;
  else if (d >= 0.9) absLine = 1.25;
  else if (d >= 0.72) absLine = 1.0;
  else if (d >= 0.52) absLine = 0.75;
  else if (d >= 0.32) absLine = 0.5;
  else if (d >= 0.14) absLine = 0.25;
  const side = d < 0.08 ? 'neutral' : (dRaw > 0 ? 'home' : 'away');
  return {
    side,
    absLine,
    signedLine: side === 'away' ? -absLine : absLine,
    label: side === 'home' ? '主队' : side === 'away' ? '客队' : '均势'
  };
}

function euroAsianLevelFromGap(gap) {
  let level = 'matched';
  let score = 74;
  let riskTag = '欧亚基本一致';
  if (gap >= 0.35) { level = 'deep_open'; score = 82; riskTag = '亚盘深于欧赔，强防上盘/实力承载较足'; }
  else if (gap <= -0.5) { level = 'severe_shallow'; score = 38; riskTag = '欧赔强但亚盘明显偏浅，警惕诱上或赢球不穿'; }
  else if (gap <= -0.25) { level = 'shallow'; score = 55; riskTag = '亚盘略浅，需要大小球和水位确认'; }
  return { level, score, riskTag };
}

function buildLineRange(expectedLine, actualDepth, options = {}) {
  const expected = num(expectedLine);
  const actual = num(actualDepth);
  if (expected === null || actual === null) return null;
  const tolerance = num(options.tolerance) ?? 0.25;
  const lower = round(expected - tolerance, 2);
  const upper = round(expected + tolerance, 2);
  const inRange = actual >= lower - 1e-9 && actual <= upper + 1e-9;
  const distance = inRange ? 0 : round(actual < lower ? actual - lower : actual - upper, 2);
  return {
    expected: round(expected, 2),
    tolerance,
    lower,
    upper,
    actual: round(actual, 2),
    inRange,
    distance,
    verdict: inRange ? 'inside' : (actual > upper ? 'too_deep' : 'too_shallow'),
    plain: `理论范围[${lower}, ${upper}]，实际=${round(actual, 2)}，${inRange ? '落在范围内' : `超出范围${distance}`}`
  };
}

function sideLabel(side) {
  if (side === 'home') return '主队';
  if (side === 'away') return '客队';
  if (side === 'draw') return '平局';
  return '未知';
}

function buildAsianWaterRead(asian = {}, favoriteSide = 'unknown') {
  const homeWater = decimalWater(firstDefined(asian.currentHomeWater, asian.currentHome, asian.homeWater, asian.home));
  const awayWater = decimalWater(firstDefined(asian.currentAwayWater, asian.currentAway, asian.awayWater, asian.away));
  if (homeWater === null || awayWater === null) {
    return {
      ok: false,
      severity: 'unknown',
      homeWater,
      awayWater,
      spread: null,
      plain: '亚盘主客水位不足，不能判定高低水诱导。'
    };
  }

  const spread = round(Math.abs(homeWater - awayWater), 2);
  const highWaterSide = homeWater > awayWater ? 'home' : awayWater > homeWater ? 'away' : 'balanced';
  const lowWaterSide = highWaterSide === 'home' ? 'away' : highWaterSide === 'away' ? 'home' : 'balanced';
  const maxWater = Math.max(homeWater, awayWater);
  const minWater = Math.min(homeWater, awayWater);
  let severity = 'balanced';
  if (spread >= 0.22 || maxWater >= 1.08 || minWater <= 0.74) severity = 'extreme';
  else if (spread >= 0.14 || maxWater >= 1.02 || minWater <= 0.8) severity = 'skewed';

  let favoriteWaterRole = 'unknown';
  if (favoriteSide === highWaterSide) favoriteWaterRole = 'favorite_high_water';
  else if (favoriteSide === lowWaterSide) favoriteWaterRole = 'favorite_low_water';
  else if (favoriteSide === 'home' || favoriteSide === 'away') favoriteWaterRole = 'favorite_balanced';

  const notes = [];
  if (severity === 'extreme') notes.push('出现超高水/超低水组合，盘口结论必须降级复核');
  else if (severity === 'skewed') notes.push('主客水位明显倾斜，需要结合热度与变盘确认');
  if (favoriteWaterRole === 'favorite_high_water') notes.push(`${sideLabel(favoriteSide)}为欧赔强势方但处在高水侧，穿盘承载不足/诱上风险上升`);
  if (favoriteWaterRole === 'favorite_low_water') notes.push(`${sideLabel(favoriteSide)}为欧赔强势方且处在低水侧，市场有保护强势方迹象，但仍需排除热门低水诱导`);

  return {
    ok: true,
    homeWater: round(homeWater, 2),
    awayWater: round(awayWater, 2),
    spread,
    severity,
    highWaterSide,
    lowWaterSide,
    highWaterLabel: sideLabel(highWaterSide),
    lowWaterLabel: sideLabel(lowWaterSide),
    favoriteWaterRole,
    plain: notes.length ? notes.join('；') : `水位相对均衡：主水${round(homeWater, 2)}，客水${round(awayWater, 2)}。`
  };
}

function euroAsianDangerProfile(gap = {}) {
  const level = String(gap?.level || 'unknown');
  const profileMap = {
    severe_shallow: {
      severity: 'high',
      affectedMarkets: ['favorite_handicap', 'favorite_heavy_stake'],
      blocksMediumHigh: false,
      blocksHighValue: true,
      coverAction: 'blocked',
      stakeCap: '0~0.3u/观望',
      label: '欧赔强而亚盘严重偏浅',
      message: '欧赔强而亚盘严重偏浅：限制热门让球穿盘，不自动推荐反向或小球'
    },
    shallow: {
      severity: 'medium',
      affectedMarkets: ['favorite_handicap'],
      blocksMediumHigh: false,
      blocksHighValue: true,
      coverAction: 'blocked',
      stakeCap: '0~0.3u/观望',
      label: '欧赔强而亚盘偏浅',
      message: '欧赔强而亚盘偏浅：热门让球穿盘降级，不能自动反打'
    },
    range_mismatch_deep: {
      severity: 'high',
      affectedMarkets: ['favorite_handicap', 'favorite_heavy_stake', 'line_range_mismatch'],
      blocksMediumHigh: false,
      blocksHighValue: true,
      coverAction: 'downgraded',
      stakeCap: '0~0.3u/观望',
      label: '实际亚盘深于欧赔理论范围',
      message: '欧赔理论范围与实际亚盘不一致：实际偏深，按欧赔锚定只做穿盘降级/造热复核，不自动认定强防上盘'
    },
    range_mismatch_shallow: {
      severity: 'high',
      affectedMarkets: ['favorite_handicap', 'favorite_heavy_stake', 'line_range_mismatch'],
      blocksMediumHigh: false,
      blocksHighValue: true,
      coverAction: 'blocked',
      stakeCap: '0~0.3u/观望',
      label: '实际亚盘浅于欧赔理论范围',
      message: '欧赔理论范围与实际亚盘不一致：实际偏浅，限制热门穿盘并等待临场，不自动推反向高价值'
    },
    water_distorted: {
      severity: 'medium_high',
      affectedMarkets: ['favorite_handicap', 'high_value_label', 'closing_confirm'],
      blocksMediumHigh: false,
      blocksHighValue: true,
      coverAction: 'downgraded',
      stakeCap: '0~0.3u/待临场确认',
      label: '欧亚表面一致但水位畸变',
      message: '欧亚表面一致但出现超高水/超低水畸变：只能列待确认候选，禁止直接写高价值'
    },
    asian_inducement_risk: {
      severity: 'critical',
      affectedMarkets: ['favorite_handicap', 'favorite_heavy_stake', 'high_value_label', 'medium_high_value_label'],
      blocksMediumHigh: true,
      blocksHighValue: true,
      coverAction: 'blocked',
      stakeCap: '0~0.2u/观望',
      label: '亚盘诱导高风险',
      message: '欧赔理论盘口与亚盘/水位同时冲突：亚盘诱导风险高，阻断中高价值与高价值，只能观望或极低仓复核'
    }
  };
  const profile = profileMap[level] || {
    severity: 'none',
    affectedMarkets: [],
    blocksMediumHigh: false,
    blocksHighValue: false,
    coverAction: 'none',
    stakeCap: '',
    label: '欧亚未触发危险等级',
    message: ''
  };
  return { level, isDanger: !!profileMap[level], ...profile };
}

function isEuroAsianDangerLevel(level) {
  return euroAsianDangerProfile({ level }).isDanger;
}

function describeEuroAsianDanger(gap = {}) {
  const profile = euroAsianDangerProfile(gap);
  if (!profile.isDanger) return '';
  const parts = [profile.message];
  if (gap?.lineRange?.plain) parts.push(`盘口范围=${gap.lineRange.plain}`);
  if (gap?.waterImbalance?.plain) parts.push(`水位=${gap.waterImbalance.plain}`);
  if (gap?.inducementRisk?.plain) parts.push(`诱导=${gap.inducementRisk.plain}`);
  return parts.filter(Boolean).join('；');
}

function buildMarketEfficiency(normalized = {}, quant = null) {
  const nv = pickNoVig(normalized, quant);
  if (!nv?.trueProb) {
    return {
      ok: false,
      quality: 'unknown',
      score: 45,
      plain: '缺少可用欧赔均值或量化去水概率，市场效率无法可靠评估。'
    };
  }
  const overround = num(nv.overround);
  const marginPct = num(nv.marginPct);
  let score = 72;
  if (marginPct !== null) {
    if (marginPct <= 4) score = 88;
    else if (marginPct <= 7) score = 78;
    else if (marginPct <= 10) score = 66;
    else score = 54;
  }
  const fav = favoriteFromProb(nv.trueProb);
  const draw = num(nv.trueProb.draw);
  const drawRisk = draw !== null ? (draw >= 31 ? 'high' : draw >= 27 ? 'medium' : 'low') : 'unknown';
  const quality = score >= 82 ? 'sharp_like' : score >= 70 ? 'usable' : score >= 58 ? 'noisy' : 'high_margin';
  return {
    ok: true,
    source: nv.source,
    overround,
    marginPct,
    trueProb: nv.trueProb,
    impliedRaw: nv.impliedRaw,
    favorite: fav,
    drawRisk,
    quality,
    score,
    plain: `欧赔去水：${fav.label}${fav.probability ?? '-'}%，平局${draw ?? '-'}%，抽水${marginPct ?? '-'}%；市场质量=${quality}。`
  };
}

function buildEuroAsianGap(normalized = {}, efficiency = {}) {
  const asian = normalized.asian || {};
  const fav = efficiency.favorite || {};
  const currentLineValueRaw = firstDefined(asian.currentLineValue, asian.currentLine, asian.mainLine);
  const currentLineValue = parseLineValue(currentLineValueRaw);
  const expectedAbsLine = expectedLineByProb(fav.probability);
  if (currentLineValue === null || expectedAbsLine === null || fav.side === 'draw' || fav.side === 'unknown') {
    return {
      ok: false,
      level: 'unknown',
      gap: null,
      score: 50,
      plain: '欧赔强弱或亚盘主线不足，暂不能判断欧亚背离。'
    };
  }
  const actualFavDepth = fav.side === 'home' ? currentLineValue : -currentLineValue;
  const gap = round(actualFavDepth - expectedAbsLine, 2);
  const experienceRead = euroAsianLevelFromGap(gap);
  const experienceRange = buildLineRange(expectedAbsLine, actualFavDepth, { tolerance: 0.25 });

  const lambdaFit = inferLambdaFromNoVigProb(efficiency.trueProb || {});
  const lambdaLine = lambdaFit?.ok ? expectedLineByLambdaDiff(lambdaFit.lambdaDiff) : null;
  const lambdaActualFavDepth = lambdaLine?.side === 'away' ? -currentLineValue : currentLineValue;
  const lambdaGap = lambdaLine && lambdaLine.side !== 'neutral' ? round(lambdaActualFavDepth - lambdaLine.absLine, 2) : (lambdaLine ? round(currentLineValue - lambdaLine.signedLine, 2) : null);
  const lambdaRead = lambdaGap !== null ? euroAsianLevelFromGap(lambdaGap) : null;
  const lambdaRange = lambdaLine ? buildLineRange(lambdaLine.absLine, lambdaLine.side === 'away' ? -currentLineValue : currentLineValue, { tolerance: 0.25 }) : null;
  const lambdaConsensus = lambdaRead ? (
    lambdaRead.level === experienceRead.level ? 'same' :
    (lambdaRead.level === 'matched' || experienceRead.level === 'matched' ? 'partial' : 'conflict')
  ) : 'missing';
  const waterImbalance = buildAsianWaterRead(asian, fav.side);

  let level = experienceRead.level;
  let score = experienceRead.score;
  let riskTag = experienceRead.riskTag;
  if (lambdaRead?.level === 'severe_shallow' && experienceRead.level !== 'deep_open') {
    level = 'severe_shallow'; score = Math.min(score, 42); riskTag = '泊松反推显示亚盘明显偏浅，警惕诱上或赢球不穿';
  } else if (lambdaRead?.level === 'deep_open' && experienceRead.level !== 'severe_shallow') {
    level = experienceRead.level === 'matched' ? 'deep_open' : experienceRead.level;
    score = Math.max(score, 78);
    riskTag = experienceRead.level === 'matched' ? '泊松反推显示亚盘深于欧赔，强势方承载较足' : riskTag;
  }

  const rangeOutside = experienceRange && !experienceRange.inRange;
  const lambdaRangeOutside = lambdaRange && !lambdaRange.inRange;
  const inducementReasons = [];
  if (rangeOutside || lambdaRangeOutside) inducementReasons.push('实际亚盘不在欧赔理论盘口范围内');
  if (waterImbalance.severity === 'extreme') inducementReasons.push('亚盘出现超高水/超低水极端组合');
  else if (waterImbalance.severity === 'skewed') inducementReasons.push('亚盘水位明显倾斜');
  if (waterImbalance.favoriteWaterRole === 'favorite_high_water') inducementReasons.push('欧赔强势方处在高水侧，穿盘承载不足');

  let inducementLevel = 'low';
  if (rangeOutside || lambdaRangeOutside) inducementLevel = waterImbalance.severity === 'extreme' ? 'high' : 'medium';
  else if (waterImbalance.severity === 'extreme') inducementLevel = 'watch';
  else if (waterImbalance.severity === 'skewed') inducementLevel = 'low_watch';

  if (rangeOutside || lambdaRangeOutside) {
    const verdict = experienceRange?.verdict || lambdaRange?.verdict;
    level = verdict === 'too_deep' ? 'range_mismatch_deep' : 'range_mismatch_shallow';
    score = Math.min(score, verdict === 'too_deep' ? 55 : 45);
    riskTag = verdict === 'too_deep'
      ? '欧赔理论与亚盘不一致：按欧赔锚定，实际亚盘偏深，需防造热/诱上或强行制造承载'
      : '欧赔理论与亚盘不一致：按欧赔锚定，实际亚盘偏浅，需防强势方赢球不穿或盘口示弱';
  }
  if ((experienceRange?.inRange || lambdaRange?.inRange) && waterImbalance.severity === 'extreme') {
    level = level === 'matched' ? 'water_distorted' : level;
    score = Math.min(score, 60);
    riskTag = '欧亚表面一致，但超高水/超低水组合要求降级复核，不能直接认定可打';
  }
  if ((rangeOutside || lambdaRangeOutside) && waterImbalance.severity === 'extreme') {
    level = 'asian_inducement_risk';
    score = Math.min(score, 40);
    riskTag = '欧赔理论盘口与亚盘/水位同时冲突，亚盘诱导风险高';
  }

  const lambdaText = lambdaFit?.ok && lambdaLine
    ? `λ反推：λ主=${lambdaFit.lambdaHome}/λ客=${lambdaFit.lambdaAway}，λ差=${lambdaFit.lambdaDiff}，理论${lambdaLine.label}${lambdaLine.absLine}，范围=${lambdaRange?.lower ?? '-'}~${lambdaRange?.upper ?? '-'}，实际=${lambdaRange?.actual ?? '-'}，${lambdaRange?.inRange ? '落在范围内' : '超出范围'}，拟合误差=${lambdaFit.fitError}%`
    : 'λ反推：缺少可用胜平负概率，未启用';
  const rangeText = experienceRange ? `经验盘口范围=${experienceRange.lower}~${experienceRange.upper}，实际=${experienceRange.actual}，${experienceRange.inRange ? '落在范围内' : '超出范围'}` : '经验盘口范围不可用';

  return {
    ok: true,
    favoriteSide: fav.side,
    favoriteLabel: fav.label,
    favoriteProbability: fav.probability,
    expectedAbsLine,
    actualLine: asian.currentLine || asian.mainLine || String(currentLineValue),
    actualLineValue: currentLineValue,
    actualFavoriteDepth: round(actualFavDepth, 2),
    gap,
    level,
    score,
    lineRange: experienceRange,
    waterImbalance,
    inducementRisk: {
      level: inducementLevel,
      reasons: inducementReasons,
      plain: inducementReasons.length ? `${inducementLevel}：${inducementReasons.join('；')}` : 'low：欧赔理论盘口、实际亚盘与水位暂未形成诱导共振。'
    },
    verificationChecklist: [
      '欧赔先去水，确认强弱方向与抽水质量',
      '用经验映射和λ反推同时给出理论盘口范围',
      '检查实际亚盘是否落入理论范围，而不是只看单点差值',
      '检查主客水位是否出现超高水/超低水畸变',
      '若盘口范围不一致或水位畸变，则结论降级为观察/诱导风险，不能直接给正向投注'
    ],
    experienceGap: {
      expectedAbsLine,
      lineRange: experienceRange,
      actualFavoriteDepth: round(actualFavDepth, 2),
      gap,
      level: experienceRead.level,
      score: experienceRead.score,
      plain: `${experienceRead.riskTag}：${fav.label}去水${fav.probability ?? '-'}%，经验理论让幅≈${expectedAbsLine}，${rangeText}，差=${gap}。`
    },
    lambdaGap: lambdaFit?.ok && lambdaLine ? {
      ...lambdaFit,
      expectedLine: lambdaLine,
      lineRange: lambdaRange,
      actualFavoriteDepth: lambdaLine.side === 'away' ? round(-currentLineValue, 2) : round(currentLineValue, 2),
      gap: lambdaGap,
      level: lambdaRead?.level || 'unknown',
      score: lambdaRead?.score ?? 50,
      consensusWithExperience: lambdaConsensus
    } : null,
    plain: `${riskTag}：${fav.label}去水${fav.probability ?? '-'}%，${rangeText}，差=${gap}；${lambdaText}；水位=${waterImbalance.plain}；诱导风险=${inducementLevel}；双轨=${lambdaConsensus}。`
  };
}

function buildOuDrawLink(normalized = {}, quant = null, efficiency = {}, marketCommand = null) {
  const ou = normalized.overunder || {};
  const line = num(firstDefined(ou.currentLineValue, ou.currentLine, ou.mainLine));
  const overWater = decimalWater(firstDefined(ou.currentOverWater, ou.currentOver, ou.overDecimalOdds));
  const underWater = decimalWater(firstDefined(ou.currentUnderWater, ou.currentUnder, ou.underDecimalOdds));
  const expectedGoals = num(quant?.poisson?.expectedGoals ?? quant?.lambda?.expectedGoals);
  const drawProb = num(efficiency.trueProb?.draw);
  const scoreTemplates = String(marketCommand?.primaryScenario?.scoreTemplates || '');
  let risk = 35;
  const notes = [];
  if (drawProb !== null && drawProb >= 30) { risk += 18; notes.push('平赔/平局去水概率偏高'); }
  if (line !== null && line <= 2.25) { risk += 14; notes.push('大小球线偏低，低比分容错小'); }
  if (expectedGoals !== null && expectedGoals < 2.35) { risk += 14; notes.push(`模型总进球${expectedGoals}偏低`); }
  if (underWater !== null && overWater !== null && underWater <= overWater - 0.06) { risk += 10; notes.push('小球水位更低，市场防低比分'); }
  if (/0-0|1-1|1-0|2-0/.test(scoreTemplates)) { risk += 6; notes.push('盘口总控比分模板偏低比分'); }
  risk = clamp(risk, 0, 100);
  const level = risk >= 72 ? 'high' : risk >= 55 ? 'medium' : 'low';
  return {
    ok: line !== null || expectedGoals !== null || drawProb !== null,
    ouLine: line,
    expectedGoals,
    drawProbability: drawProb,
    overWater,
    underWater,
    lowScoreRisk: level,
    riskScore: risk,
    notes,
    plain: notes.length ? `平局/大小球联动风险=${level}：${notes.join('；')}。` : '大小球与平赔暂未形成明显低比分或大球共振信号。'
  };
}

function buildGoalRealityRead(normalized = {}, quant = null, ouDrawLink = {}) {
  const stats = normalized.stats || {};
  const recent = stats.recentStats || normalized.recentStats || {};
  const homeTrend = stats.handicapTrend?.home || {};
  const awayTrend = stats.handicapTrend?.away || {};
  const expectedGoals = num(quant?.poisson?.expectedGoals ?? quant?.lambda?.expectedGoals ?? ouDrawLink.expectedGoals);
  const line = num(ouDrawLink.ouLine);
  const overWater = decimalWater(ouDrawLink.overWater);
  const underWater = decimalWater(ouDrawLink.underWater);

  const homeFor = num(firstDefined(recent.homeFor, recent.homeGoalsFor, recent.homeAvgFor, recent.homeScored, recent.hostFor));
  const homeAgainst = num(firstDefined(recent.homeAgainst, recent.homeGoalsAgainst, recent.homeAvgAgainst, recent.homeConceded, recent.hostAgainst));
  const awayFor = num(firstDefined(recent.awayFor, recent.awayGoalsFor, recent.awayAvgFor, recent.awayScored, recent.guestFor));
  const awayAgainst = num(firstDefined(recent.awayAgainst, recent.awayGoalsAgainst, recent.awayAvgAgainst, recent.awayConceded, recent.guestAgainst));
  const directTotal = num(firstDefined(recent.totalAvg, recent.avgTotalGoals, recent.totalGoalsAvg, recent.combinedGoalsAvg));
  const homeTotal = homeFor !== null && homeAgainst !== null ? homeFor + homeAgainst : null;
  const awayTotal = awayFor !== null && awayAgainst !== null ? awayFor + awayAgainst : null;
  const recentCombinedAvg = directTotal !== null ? directTotal : (homeTotal !== null && awayTotal !== null ? round((homeTotal + awayTotal) / 2, 2) : null);

  const bigBallRates = [
    ...safeArray(homeTrend.bigBallRates), ...safeArray(awayTrend.bigBallRates),
    homeTrend.bigBallRate, awayTrend.bigBallRate, recent.homeBigBallRate, recent.awayBigBallRate, recent.bigBallRate
  ].map(pctValue).filter(v => Number.isFinite(v));
  const bigBallAvg = bigBallRates.length ? round(bigBallRates.reduce((a, b) => a + b, 0) / bigBallRates.length, 1) : null;
  const distributionText = JSON.stringify(stats.recentGoalDistribution || normalized.recentGoalDistribution || {});
  const highGoalDistribution = /3球|4球|5球|6球|3-4|大球|over/i.test(distributionText);

  let overScore = 0;
  let underScore = 0;
  const overEvidence = [];
  const underEvidence = [];
  if (recentCombinedAvg !== null) {
    if (recentCombinedAvg >= 3.05) { overScore += 28; overEvidence.push(`双方近期总进球均值${round(recentCombinedAvg, 2)}偏高`); }
    else if (recentCombinedAvg >= 2.75) { overScore += 18; overEvidence.push(`双方近期总进球均值${round(recentCombinedAvg, 2)}接近大球区`); }
    else if (recentCombinedAvg <= 2.25) { underScore += 18; underEvidence.push(`双方近期总进球均值${round(recentCombinedAvg, 2)}偏低`); }
  }
  if (expectedGoals !== null) {
    if (expectedGoals >= 2.85) { overScore += 22; overEvidence.push(`模型预期总进球${expectedGoals}偏高`); }
    else if (expectedGoals <= 2.25) { underScore += 18; underEvidence.push(`模型预期总进球${expectedGoals}偏低`); }
  }
  if (bigBallAvg !== null) {
    if (bigBallAvg >= 58) { overScore += 18; overEvidence.push(`近期/盘路大球率均值${bigBallAvg}%偏高`); }
    else if (bigBallAvg <= 42) { underScore += 12; underEvidence.push(`近期/盘路大球率均值${bigBallAvg}%偏低`); }
  }
  if (highGoalDistribution) { overScore += 10; overEvidence.push('近期进球分布出现3球/4球或大球倾向'); }
  if (line !== null && recentCombinedAvg !== null && recentCombinedAvg >= 3.0 && line <= 2.5) {
    overScore += 10;
    overEvidence.push(`实际进球均值高于当前${line}球盘口，不能仅凭小球低水压小`);
  }
  if (underWater !== null && overWater !== null && underWater <= overWater - 0.08) {
    underScore += 8;
    underEvidence.push('小球水位明显低于大球，市场存在防低比分');
  }

  const overStrong = overScore >= 38 && overScore - underScore >= 14;
  const underStrong = underScore >= 32 && underScore - overScore >= 14;
  const conflict = overScore >= 28 && underScore >= 18;
  const status = overStrong ? 'over_reality_supported' : underStrong ? 'under_reality_supported' : conflict ? 'conflict_wait_line' : 'neutral_or_data_insufficient';
  return {
    ok: recentCombinedAvg !== null || expectedGoals !== null || bigBallAvg !== null || highGoalDistribution,
    status,
    recentCombinedAvg,
    homeRecentTotalAvg: round(homeTotal, 2),
    awayRecentTotalAvg: round(awayTotal, 2),
    expectedGoals,
    bigBallAvg,
    overScore: clamp(overScore, 0, 100),
    underScore: clamp(underScore, 0, 100),
    overEvidence,
    underEvidence,
    blocksBlindUnder: overStrong || (conflict && recentCombinedAvg !== null && recentCombinedAvg >= 3),
    requiresExplanationForUnder: overScore >= 28,
    plain: overEvidence.length || underEvidence.length
      ? `进球现实仲裁=${status}：大球证据[${overEvidence.slice(0, 3).join('；') || '-'}]；小球证据[${underEvidence.slice(0, 3).join('；') || '-'}]。`
      : '进球现实仲裁：缺少近期进失球/大球率/模型总进球，大小球只能低仓或待临场。'
  };
}

function buildMovementRead(normalized = {}, quant = null, marketTimeline = null) {
  const asian = normalized.asian || {};
  const initialLine = parseLineValue(firstDefined(asian.initialLineValue, asian.initialLine));
  const currentLine = parseLineValue(firstDefined(asian.currentLineValue, asian.currentLine, asian.mainLine));
  const homeDelta = (() => {
    const i = decimalWater(asian.initialHomeWater);
    const c = decimalWater(asian.currentHomeWater);
    return i !== null && c !== null ? round(c - i, 3) : null;
  })();
  const awayDelta = (() => {
    const i = decimalWater(asian.initialAwayWater);
    const c = decimalWater(asian.currentAwayWater);
    return i !== null && c !== null ? round(c - i, 3) : null;
  })();
  const lineDelta = initialLine !== null && currentLine !== null ? round(currentLine - initialLine, 3) : null;
  const signals = [];
  if (lineDelta !== null && Math.abs(lineDelta) >= 0.25) signals.push(`亚盘${lineDelta > 0 ? '升深' : '退浅'}${lineDelta}`);
  if (homeDelta !== null && Math.abs(homeDelta) >= 0.06) signals.push(`主水${homeDelta < 0 ? '下调' : '上调'}${homeDelta}`);
  if (awayDelta !== null && Math.abs(awayDelta) >= 0.06) signals.push(`客水${awayDelta < 0 ? '下调' : '上调'}${awayDelta}`);
  const quantSignals = safeArray(quant?.movement?.signals).map(s => s.msg || s.change || '').filter(Boolean).slice(0, 3);
  const timelineSignal = marketTimeline?.summary || marketTimeline?.movement?.timelineSignal?.plain || marketTimeline?.movement?.plain || '';
  const strength = safeArray(quant?.movement?.signals).some(s => s.strength === 'strong') || Math.abs(lineDelta || 0) >= 0.25 ? 'strong' : signals.length ? 'medium' : 'weak';
  return {
    ok: signals.length > 0 || quantSignals.length > 0 || !!timelineSignal,
    lineDelta,
    homeWaterDelta: homeDelta,
    awayWaterDelta: awayDelta,
    strength,
    signals: [...signals, ...quantSignals].slice(0, 6),
    timelineSignal,
    plain: [...signals, ...quantSignals].length ? `盘口异动(${strength})：${[...signals, ...quantSignals].slice(0, 4).join('；')}` : '暂未检出显著初盘到即时盘异动，等待赛前2小时/30分钟复核。'
  };
}

/**
 * 竞彩大众情绪 × 亚盘水位联合判断：
 * 大众支持率 - 欧赔去水概率 = 情绪偏差；与亚盘水位方向对比，判断是诱买还是真实方向。
 * 经济学：机构通过亚盘定价反映真实概率；大众通过竞彩投票暴露情绪偏见。
 * 当两者背离时，机构往往在反向建仓（诱买/诱空）。
 */
function buildCrowdSentimentRead(jingcaiDeviation = null, movementRead = {}) {
  if (!jingcaiDeviation) {
    return { ok: false, source: 'no_data', plain: '暂无竞彩投票偏差数据' };
  }
  const jd = jingcaiDeviation;
  const edge = jd.edge || {};
  const sr = jd.supportRate || {};
  const fp = jd.fairProb || {};

  // 找情绪偏向最大的方向
  const sides = [
    { side: 'home', label: '主队', edgeVal: edge.home ?? 0, srVal: sr.home ?? 0, fpVal: fp.home ?? 0 },
    { side: 'draw', label: '平局', edgeVal: edge.draw ?? 0, srVal: sr.draw ?? 0, fpVal: fp.draw ?? 0 },
    { side: 'away', label: '客队', edgeVal: edge.away ?? 0, srVal: sr.away ?? 0, fpVal: fp.away ?? 0 },
  ];
  const biasedSide = sides.reduce((m, x) => Math.abs(x.edgeVal) > Math.abs(m.edgeVal) ? x : m, sides[0]);
  const biasStrength = jd.deviation || 'weak'; // extreme/strong/moderate/weak
  const maxEdge = jd.maxEdge ?? 0;

  // 情绪偏离不明显 → 无信号
  if (biasStrength === 'weak' || maxEdge < 3) {
    return {
      ok: true, source: 'jingcai', biasStrength, maxEdge,
      biasedSide: biasedSide.side, biasedLabel: biasedSide.label,
      biasEdge: biasedSide.edgeVal,
      alignment: 'neutral',
      institutionSignal: 'neutral',
      plain: `大众情绪与公允概率基本吻合（maxΔ${maxEdge}%），无显著诱买/诱空信号`,
      riskFlag: null,
    };
  }

  // 从 movementRead 提取亚盘水位方向
  const homeWaterDelta = movementRead.homeWaterDelta ?? null;
  const awayWaterDelta = movementRead.awayWaterDelta ?? null;
  // 判断机构防范方向：水位下调=该侧赔付被压低/受防范；水位上调=该侧承载减弱。
  // 主水下调或客水上调 → 机构偏主；主水上调或客水下调 → 机构偏客。
  let institutionFavor = null; // 'home'|'away'|'draw'|'neutral'
  let institutionEvidence = '';
  if (homeWaterDelta !== null && Math.abs(homeWaterDelta) >= 0.03) {
    institutionFavor = homeWaterDelta < 0 ? 'home' : 'away';
    institutionEvidence = `主水${homeWaterDelta > 0 ? '上调' : '下调'}${homeWaterDelta}`;
  } else if (awayWaterDelta !== null && Math.abs(awayWaterDelta) >= 0.03) {
    institutionFavor = awayWaterDelta < 0 ? 'away' : 'home';
    institutionEvidence = `客水${awayWaterDelta > 0 ? '上调' : '下调'}${awayWaterDelta}`;
  }

  // 联合判断
  let alignment, institutionSignal, plain, riskFlag;
  if (institutionFavor === null) {
    alignment = 'unconfirmed';
    institutionSignal = 'wait';
    plain = `大众${biasedSide.label}偏离显著(Δ${biasedSide.edgeVal > 0 ? '+' : ''}${biasedSide.edgeVal}%)，但亚盘水位暂无明显变动，等待赛前水位确认诱买还是真实方向`;
    riskFlag = `竞彩情绪偏向${biasedSide.label}(Δ${biasedSide.edgeVal > 0 ? '+' : ''}${biasedSide.edgeVal}%)，暂无亚盘水位确认，临场前不宜定向`;
  } else if (institutionFavor === biasedSide.side) {
    alignment = 'confirmed';
    institutionSignal = 'real_direction';
    plain = `大众与机构同向支持${biasedSide.label}（情绪偏差${biasedSide.edgeVal > 0 ? '+' : ''}${biasedSide.edgeVal}%，${institutionEvidence || '亚盘水位确认'}），方向可信但赔率价值可能已被压缩`;
    riskFlag = `大众+机构同向${biasedSide.label}，关注赔率是否已到价值底部，避免追高`;
  } else {
    // 大众偏A，机构反向 → 诱买/诱空
    alignment = 'diverged';
    institutionSignal = 'decoy';
    const trapLabel = biasedSide.edgeVal > 0 ? `${biasedSide.label}诱买` : `${biasedSide.label}诱空`;
    const strengthLabel = maxEdge >= 12 ? '极强' : maxEdge >= 8 ? '强' : '中等';
    plain = `⚠️ ${strengthLabel}诱买/诱空信号：大众力挺${biasedSide.label}(情绪溢价Δ${biasedSide.edgeVal > 0 ? '+' : ''}${biasedSide.edgeVal}%)，但机构水位防范反向（${institutionEvidence || '亚盘水位反向'}），${trapLabel}可能性高`;
    riskFlag = `${strengthLabel}${trapLabel}信号：机构与大众反向，${biasedSide.label}方向高价值存疑，但需结合欧赔骨架和盘口总控综合确认，不可单独反打`;
  }

  return {
    ok: true,
    source: 'jingcai_x_asian',
    biasStrength,
    maxEdge,
    biasedSide: biasedSide.side,
    biasedLabel: biasedSide.label,
    biasEdge: biasedSide.edgeVal,
    crowdSupportRate: { home: sr.home, draw: sr.draw, away: sr.away },
    fairProb: { home: fp.home, draw: fp.draw, away: fp.away },
    edge: { home: edge.home, draw: edge.draw, away: edge.away },
    institutionFavor,
    alignment,          // neutral/unconfirmed/confirmed/diverged
    institutionSignal,  // neutral/wait/real_direction/decoy
    plain,
    riskFlag,
  };
}

function buildTrapDiscipline({ marketCommand = null, euroAsianGap = {}, ouDrawLink = {}, movementRead = {}, crowdSentimentRead = {} } = {}) {
  const scenario = marketCommand?.primaryScenario || {};
  const trial = marketCommand?.counterEvidenceTrial || {};
  const exec = marketCommand?.executionCommand || {};
  const topRule = marketCommand?.currentMarketRead?.topRule || {};
  const scenarioCode = String(scenario.code || '');
  const trialVerdict = String(trial.verdict || '');
  const ruleId = String(topRule.ruleId || '');
  const avoidMarkets = safeArray(exec.avoidMarkets);
  const affectedMarkets = [];
  const localDowngrades = [];
  const independentReviews = [];
  const forbiddenInferences = [
    '不得把陷阱门控直接当成反向下注信号',
    '不得因热门让球风险自动推荐下盘',
    '不得因上盘诱买自动推荐小球',
    '不得把降仓/观望改写成反打方向'
  ];

  if (['hot_favorite_trap', 'watch_only'].includes(scenarioCode) || /R-MR-0[4-8]|R-MR-11/.test(ruleId)) {
    affectedMarkets.push('favorite_handicap', 'favorite_heavy_stake');
    localDowngrades.push('热门让球/上盘穿盘价值降级，主胜方向需结合欧赔与水位另行判断');
    independentReviews.push('大小球必须按进球预期、盘口线、水位路径和节奏证据独立复核');
  }
  if (scenarioCode === 'late_volatile_info' || movementRead.strength === 'strong') {
    affectedMarkets.push('all_heavy_stake', 'late_entry');
    localDowngrades.push('临场高波动只限制重仓和提前入场，不自动改变方向');
    independentReviews.push('赛前30分钟复核盘口是否回归原剧本或出现真实信息盘');
  }
  if (trialVerdict === 'downgrade') {
    affectedMarkets.push('stake_size');
    localDowngrades.push('反证审判=downgrade 只代表降仓，不代表反向投注');
  } else if (trialVerdict === 'overturn') {
    affectedMarkets.push('original_command');
    localDowngrades.push('反证审判=overturn 代表原总控需推翻/重算，默认观望而非自动反打');
  }
  const euroAsianDanger = euroAsianDangerProfile(euroAsianGap);
  if (euroAsianDanger.isDanger) {
    affectedMarkets.push(...euroAsianDanger.affectedMarkets);
    localDowngrades.push(describeEuroAsianDanger(euroAsianGap));
    if (euroAsianDanger.blocksMediumHigh) localDowngrades.push('欧亚诱导高风险已阻断中高价值/高价值包装，只能观望或极低仓复核');
    forbiddenInferences.push('欧亚范围不一致或高低水畸变≠反向下注信号，只能先限制命中玩法与仓位');
  }
  if (ouDrawLink.lowScoreRisk === 'high') {
    affectedMarkets.push('over_under_high_value');
    localDowngrades.push('低比分风险只限制大球/小球高价值包装，大小球方向仍需独立证据');
  }
  if (/观望|极低仓|0~0\.2u|0-0\.2u|0~0\.3u|0-0\.3u/.test(String(exec.stake || ''))) {
    affectedMarkets.push('stake_size');
    localDowngrades.push('执行仓位提示限制下注强度，不改变胜负/大小球方向');
  }
  if (avoidMarkets.length) {
    affectedMarkets.push('listed_avoid_markets');
    localDowngrades.push(`仅回避执行命令列出的玩法：${avoidMarkets.join('、')}`);
  }
  // 竞彩×亚盘联合诱买信号接入陷阱层
  if (crowdSentimentRead?.institutionSignal === 'decoy') {
    affectedMarkets.push('crowd_decoy_direction');
    localDowngrades.push(`竞彩×亚盘：${crowdSentimentRead.plain}`);
    forbiddenInferences.push('诱买/诱空信号≠反打，必须结合欧赔骨架和盘口总控才能转化为方向');
  } else if (crowdSentimentRead?.institutionSignal === 'real_direction') {
    localDowngrades.push(`竞彩×亚盘：${crowdSentimentRead.plain}`);
  }

  const uniqueAffected = [...new Set(affectedMarkets)];
  const uniqueDowngrades = [...new Set(localDowngrades)];
  const uniqueReviews = [...new Set(independentReviews)];
  return {
    version: 'trap-discipline-v1',
    hasTrap: uniqueAffected.length > 0,
    scenarioCode,
    scenarioLabel: scenario.label || '',
    ruleId,
    trialVerdict,
    affectedMarkets: uniqueAffected,
    localDowngrades: uniqueDowngrades,
    forbiddenInferences,
    independentReviews: uniqueReviews.length ? uniqueReviews : ['胜平负、亚让盘、大小球必须分别按各自证据链独立复核'],
    allowPreserveFavoriteWin: !['overturn'].includes(trialVerdict),
    allowOverIfOuEvidence: true,
    allowUnderOnlyWithOuEvidence: true,
    plain: uniqueAffected.length
      ? `陷阱纪律：${uniqueDowngrades.join('；')}；禁止外推：${forbiddenInferences.slice(0, 3).join('；')}。`
      : '未触发明显陷阱门控；仍需按胜平负、亚让盘、大小球分别复核。'
  };
}

function buildValueRead(quant = null, marketCommand = null) {
  const bets = safeArray(quant?.valueBets).filter(v => v?.ok);
  const positives = bets.filter(v => num(v.edgePct) !== null && num(v.edgePct) > 0).sort((a, b) => num(b.edgePct) - num(a.edgePct));
  const high = positives.filter(v => v.admissionEligible === true);
  const calibratedStrongEdge = positives.filter(v => v.admissionEligible === true && (num(v.edgePct) ?? 0) >= 8);
  const uncalibratedStrongEdge = positives.filter(v => v.admissionEligible !== true && (num(v.edgePct) ?? 0) >= 8);
  const strongEdge = calibratedStrongEdge;
  const mediumEdge = positives.filter(v => (num(v.edgePct) ?? 0) >= 4);
  const calibratedMediumEdge = positives.filter(v => v.admissionEligible === true && (num(v.edgePct) ?? 0) >= 4);
  const topEdgePct = positives.length ? (num(positives[0].edgePct) ?? 0) : 0;
  const bestMarket = String(marketCommand?.executionCommand?.bestMarket || marketCommand?.plainSummary || '');
  const aligned = positives.filter(v => bestMarket && bestMarket.includes(String(v.label || '').replace(/主胜|客胜|平局/g, m => ({ 主胜: '主', 客胜: '客', 平局: '平' }[m] || m))));
  const scenarioCode = String(marketCommand?.primaryScenario?.code || '');
  const trialVerdict = String(marketCommand?.counterEvidenceTrial?.verdict || '');
  const stakeText = String(marketCommand?.executionCommand?.stake || '');
  const gateReasons = [];
  // 未校准仅作软警告，不触发硬门控（无历史数据时不能永久封死），但不得触发 strong/high value。
  const uncalibratedOnly = positives.length > 0 && positives.every(v => v.admissionEligible !== true);
  // 价值层不再把盘口剧本/反证审判解释成“反向信号”；这些只由 trapDiscipline 做局部玩法降级。
  if (trialVerdict === 'overturn') gateReasons.push('反证审判=overturn，原总控需推翻/重算，默认观望而非反打');
  if (/禁止高价值/.test(stakeText)) gateReasons.push(`执行仓位=${stakeText}，限制高价值标签`);
  let score = positives.length ? 60 + Math.min(24, num(positives[0].edgePct) * 2) : 45;
  if (high.length) score += 6;
  if (aligned.length) score += 6;
  const valueGate = {
    noHighValue: gateReasons.length > 0,
    requiresClosingConfirm: gateReasons.length > 0 || uncalibratedOnly,
    stakeCap: gateReasons.length > 0 ? '0~0.2u' : uncalibratedOnly ? '0~0.5u(未校准)' : '',
    reasons: gateReasons,
    // 未校准软警告（不触发硬门控）
    calibrationWarning: uncalibratedOnly ? '量化edge未经过历史校准/CLV验证，只能作辅助参考' : ''
  };
  if (valueGate.noHighValue) score = Math.min(score, 58);
  score = clamp(score, 0, 100);
  return {
    ok: bets.length > 0,
    bestValues: positives.slice(0, 5),
    highValueCount: valueGate.noHighValue ? 0 : high.length,
    calibratedHighCount: valueGate.noHighValue ? 0 : high.length,
    strongEdgeCount: valueGate.noHighValue ? 0 : strongEdge.length,
    calibratedStrongEdgeCount: valueGate.noHighValue ? 0 : calibratedStrongEdge.length,
    uncalibratedStrongEdgeCount: uncalibratedStrongEdge.length,
    mediumEdgeCount: valueGate.noHighValue ? 0 : mediumEdge.length,
    calibratedMediumEdgeCount: valueGate.noHighValue ? 0 : calibratedMediumEdge.length,
    topEdgePct,
    alignedWithCommand: aligned.length > 0,
    valueGate,
    score,
    plain: positives.length
      ? `量化edge参考：${positives.slice(0, 3).map(v => `${v.label} edge=${v.edgePct}%/${v.tier}`).join('；')}${aligned.length ? '；与总控方向存在同向参考。' : '。'}${valueGate.noHighValue ? ` 价值门控：${gateReasons.join('；')}。` : ''}${uncalibratedOnly || uncalibratedStrongEdge.length ? ` [未校准软警告：未校准强edge=${uncalibratedStrongEdge.length}个，只能作交叉证据，不触发strong/high value]` : ''}`
      : '量化模型未给出正向edge参考，不能因模型单项强推。'
  };
}

function buildClvChecklist(marketCommand = null, movementRead = {}, efficiency = {}) {
  const base = safeArray(marketCommand?.executionCommand?.liveChecklist).slice(0, 3);
  const checklist = [
    '赛前2小时复核：欧赔低赔侧是否继续收紧，去水概率是否维持主剧本。',
    '赛前30分钟复核：亚盘是否退盘/高水反向，大小球是否仍与胜负剧本共振。',
    '收盘线复盘：记录推荐价、收盘价、盘口线差与隐含概率差，判断是否拿到正CLV。'
  ];
  if (movementRead.strength === 'strong') checklist.unshift('当前已出现较强盘口异动，必须确认是信息盘还是诱导盘，仓位先打折。');
  if (efficiency.drawRisk === 'high') checklist.push('平局概率偏高，临场若平赔继续压低，胜负/让球方向必须降级。');
  return {
    windows: ['T-2h', 'T-30m', 'closing'],
    checklist: [...base, ...checklist].filter(Boolean).slice(0, 7),
    method: '以收盘线作为更有效市场benchmark，赛后记录推荐时隐含概率、收盘隐含概率、线差与价格CLV。'
  };
}

function buildScore(parts = {}) {
  const efficiencyScore = num(parts.marketEfficiency?.score) ?? 58; // 无数据时不触发效率惩罚
  const gapScore = num(parts.euroAsianGap?.score) ?? 50;
  const valueScore = num(parts.valueRead?.score) ?? 50;
  const movementBonus = parts.movementRead?.strength === 'strong' ? 4 : parts.movementRead?.strength === 'medium' ? 2 : 0;
  const crowdSignal = String(parts.crowdSentimentRead?.institutionSignal || '');
  const crowdRiskPenalty = crowdSignal === 'decoy' ? 8 : crowdSignal === 'wait' ? 3 : crowdSignal === 'real_direction' ? 2 : 0;
  const crowdEdgeAdjust = crowdSignal === 'decoy' ? -4 : crowdSignal === 'real_direction' ? 2 : 0;
  const crowdClvAdjust = crowdSignal === 'decoy' ? -2 : 0;
  const lowScoreRisk = num(parts.ouDrawLink?.riskScore) ?? 35; // 无数据时不默认高风险
  const edgeScore = clamp(efficiencyScore * 0.24 + gapScore * 0.34 + valueScore * 0.28 + 48 * 0.14 + movementBonus + crowdEdgeAdjust, 0, 100);
  const riskScore = clamp(lowScoreRisk + (gapScore < 45 ? 12 : 0) + (efficiencyScore < 50 ? 8 : 0) + crowdRiskPenalty, 0, 100); // 降低惩罚力度
  // movementRead/valueRead 无数据时使用中性基准（65）而非偏低值（55/50）
  const clvReadiness = clamp((efficiencyScore * 0.38 + (parts.movementRead?.ok ? 72 : 65) * 0.28 + (parts.valueRead?.ok ? 72 : 65) * 0.34) + crowdClvAdjust, 0, 100);
  const confidenceDelta = Math.round((edgeScore - 60) * 0.12 - Math.max(0, riskScore - 58) * 0.10);
  return {
    edgeScore: Math.round(edgeScore),
    riskScore: Math.round(riskScore),
    clvReadiness: Math.round(clvReadiness),
    confidenceDelta: clamp(confidenceDelta, -8, 8)
  };
}

function buildValueAdmission({ valueRead = {}, score = {}, marketCommand = null, euroAsianGap = {}, ouDrawLink = {}, movementRead = {}, trapDiscipline = {}, normalized = {} } = {}) {
  const scenarioCode = String(marketCommand?.primaryScenario?.code || '');
  const trialVerdict = String(marketCommand?.counterEvidenceTrial?.verdict || '');
  const evidence = [];
  const missing = [];
  const blockers = [];
  const dataCompleteness = normalized?.derived?.dataCompleteness || normalized?.dataCompleteness || marketCommand?.historyBaseline?.dataCompleteness || {};
  const completenessScore = num(firstDefined(dataCompleteness.score, normalized?.completenessScore, normalized?.derived?.completenessScore));
  const missingFields = safeArray(normalized?.derived?.missingFields || normalized?.missingFields || dataCompleteness.missing);
  const criticalMissing = missingFields.filter(field => [
    'matchInfo',
    'winDrawWin.averageCurrent',
    'winDrawWin.companies',
    'asian.mainLine',
    'overunder.mainLine',
    'recentStats'
  ].includes(String(field)));
  const softMissing = [];
  const promotionHints = [];
  if (marketCommand?.version === 'market-command-v4' && marketCommand?._source === 'cloud') evidence.push('云端 MARKET_COMMAND_JSON 有效');
  else softMissing.push('缺少云端 MARKET_COMMAND_JSON，只能列为中高价值候选-待临场确认');
  if (Number.isFinite(completenessScore)) {
    if (completenessScore >= 80) evidence.push(`数据完整度=${completenessScore}%达标`);
    else if (completenessScore >= 68) softMissing.push(`数据完整度=${completenessScore}%未满80，允许候选但必须补采复核`);
    else blockers.push(`数据完整度=${completenessScore}%<68，坏输入不得升为中高价值`);
  } else {
    softMissing.push('缺少数据完整度评分，只能待临场/补采确认');
  }
  if (criticalMissing.length) blockers.push(`关键字段缺失=${criticalMissing.join('、')}，禁止中高价值准入`);
  if (valueRead.valueGate?.noHighValue) blockers.push(`valueGate=${safeArray(valueRead.valueGate.reasons).join('；') || 'noHighValue'}`);
  const euroAsianDanger = euroAsianDangerProfile(euroAsianGap);
  if (euroAsianDanger.isDanger) {
    const dangerText = describeEuroAsianDanger(euroAsianGap);
    evidence.push(`欧亚风险=${euroAsianDanger.level}：${euroAsianDanger.label}`);
    if (euroAsianDanger.blocksMediumHigh) blockers.push(dangerText || euroAsianDanger.message);
    else if (euroAsianDanger.blocksHighValue) softMissing.push(`${dangerText || euroAsianDanger.message}；禁止直接写高价值，需临场复核`);
  }
  // 仅未校准软警告不触发 blocker，也不计入 missing（不封死中高价值）
  if ((valueRead.highValueCount || 0) > 0) {
    evidence.push('量化edge已校准且达到中高价值候选');
  } else if (valueRead.ok) {
    // 有正EV但未校准：软警告，不写入 missing
    evidence.push('量化edge正向参考(未校准，仅辅助)');
  } else {
    missing.push('量化模型无正向edge参考');
  }
  if (valueRead.alignedWithCommand) evidence.push('edge参考方向与盘口总控最优玩法同向');
  // edge方向不同向仅软提示，不硬阻断（无历史时方向参考有限）
  if (trapDiscipline.hasTrap) evidence.push(`陷阱纪律=局部降级，不作反向信号：${trapDiscipline.affectedMarkets?.slice(0, 3).join('、') || scenarioCode}`);
  else if (scenarioCode) evidence.push(`盘口剧本=${scenarioCode}未触发局部陷阱降级`);
  if (trialVerdict === 'keep') evidence.push('反证审判=keep');
  else if (trialVerdict === 'downgrade') evidence.push('反证审判=downgrade，仅降仓不反打');
  else if (trialVerdict) blockers.push(`反证审判=${trialVerdict}，原总控需观望/重算，不得自动反向`);
  else softMissing.push('缺少反证审判 keep 结论，只能待盘口总控/临场复核');
  if ((score.edgeScore || 0) >= 58) evidence.push(`edgeScore=${score.edgeScore}达标`);  // 无历史校准时阈值58
  else missing.push(`edgeScore=${score.edgeScore ?? '-'}<58`);
  if ((score.riskScore ?? 100) < 65) evidence.push(`riskScore=${score.riskScore}<65`);  // 放宽riskScore门槛
  else blockers.push(`riskScore=${score.riskScore ?? '-'}>=65`);
  if ((score.clvReadiness || 0) >= 60) evidence.push(`CLV准备=${score.clvReadiness}达标`);  // 无收盘线时CLV门槛60
  else softMissing.push(`CLV准备=${score.clvReadiness ?? '-'}<60，缺收盘线/临场复核前只能候选待确认`);
  if (euroAsianGap.level === 'severe_shallow' && !euroAsianDanger.isDanger) evidence.push('欧亚严重背离：热门让球穿盘局部降级，不自动推客队/小球');
  if (ouDrawLink.lowScoreRisk === 'high') evidence.push('平赔/大小球低比分风险高：仅限制大小球高价值包装，方向需独立证据');
  if (movementRead.ok) evidence.push(`盘口异动证据=${movementRead.strength || 'ok'}`);
  const strongEvidence = [];
  if ((valueRead.calibratedStrongEdgeCount || 0) > 0) strongEvidence.push(`已校准强edge候选=${valueRead.calibratedStrongEdgeCount}个(top=${valueRead.topEdgePct}pct)`);
  if ((valueRead.uncalibratedStrongEdgeCount || 0) > 0) evidence.push(`未校准强edge=${valueRead.uncalibratedStrongEdgeCount}个：仅作观察证据，不触发strong/high value`);
  if (valueRead.alignedWithCommand) strongEvidence.push('edge与盘口总控同向');
  if ((score.edgeScore || 0) >= 66) strongEvidence.push(`edgeScore=${score.edgeScore}强`);
  if ((score.riskScore ?? 100) < 55) strongEvidence.push(`riskScore=${score.riskScore}低`);
  if ((score.clvReadiness || 0) >= 64) strongEvidence.push(`CLV准备=${score.clvReadiness}可复核`);
  if (trialVerdict === 'keep') strongEvidence.push('反证审判keep');
  if (marketCommand?.version === 'market-command-v4' && marketCommand?._source === 'cloud') strongEvidence.push('云端总控有效');
  if (movementRead.ok && ['strong', 'medium'].includes(String(movementRead.strength || ''))) strongEvidence.push(`盘口异动${movementRead.strength}`);

  const hardBlocked = blockers.length > 0;
  const softGapCount = softMissing.length + missing.length;
  const mediumEvidenceReady = ((valueRead.mediumEdgeCount || 0) > 0 || valueRead.ok)
    && (score.edgeScore || 0) >= 58
    && (score.riskScore ?? 100) < 65
    && evidence.length >= 3;
  const nearMissMediumHigh = !hardBlocked
    && mediumEvidenceReady
    && softGapCount <= 4;
  if (!hardBlocked && !nearMissMediumHigh) {
    if (!valueRead.ok && (valueRead.mediumEdgeCount || 0) <= 0) promotionHints.push('补足正EV/量化edge候选');
    if ((score.edgeScore || 0) < 58) promotionHints.push('edgeScore提升到58以上');
    if ((score.riskScore ?? 100) >= 65) promotionHints.push('riskScore降到65以下');
    if (evidence.length < 3) promotionHints.push('补足至少3条同向证据');
  }
  if (softMissing.some(x => /云端/.test(x))) promotionHints.push('补跑云端盘口总控');
  if (softMissing.some(x => /CLV/.test(x))) promotionHints.push('赛前90/30分钟复核水位与CLV');
  if (softMissing.some(x => /完整度|补采/.test(x))) promotionHints.push('补采关键盘口/近期数据');
  const strongValueSignal = !hardBlocked
    && !euroAsianDanger.blocksHighValue
    && (valueRead.calibratedStrongEdgeCount || 0) > 0
    && (score.edgeScore || 0) >= 66
    && (score.riskScore ?? 100) < 55
    && (score.clvReadiness || 0) >= 64
    && strongEvidence.length >= 4;
  const mediumValueSignal = !hardBlocked
    && !euroAsianDanger.blocksMediumHigh
    && mediumEvidenceReady
    && (score.clvReadiness || 0) >= 60
    && evidence.length >= 4;
  const requiresEuroAsianWatch = euroAsianDanger.isDanger && euroAsianDanger.blocksHighValue;
  // allowMediumHigh：只代表正式中高价值；欧亚范围/水位危险等级只能进入待确认候选，nearMissMediumHigh 不等同于高价值。
  const allowMediumHigh = !requiresEuroAsianWatch && (strongValueSignal || (mediumValueSignal && missing.length <= 2 && softMissing.length <= 2));
  const allowMediumHighWatch = !allowMediumHigh && (nearMissMediumHigh || (requiresEuroAsianWatch && mediumEvidenceReady && !hardBlocked));
  const allowHigh = strongValueSignal && !euroAsianDanger.blocksHighValue && (score.edgeScore || 0) >= 72 && (score.riskScore ?? 100) < 50 && (score.clvReadiness || 0) >= 70 && strongEvidence.length >= 5 && softGapCount === 0;
  const level = allowHigh ? 'high' : strongValueSignal ? 'strong_value' : allowMediumHigh ? 'medium_high' : allowMediumHighWatch ? 'medium_high_watch' : blockers.length ? 'blocked' : 'watch';
  const valueTier = allowHigh ? '高价值候选' : strongValueSignal ? '强信号中高价值候选' : allowMediumHigh ? '中高价值候选' : allowMediumHighWatch ? '中高价值候选-待临场确认' : blockers.length ? '硬阻断' : '观察候选';
  return {
    level,
    valueTier,
    allowMediumHigh,
    allowMediumHighWatch,
    allowHigh,
    nearMissMediumHigh,
    strongValueSignal,
    mediumValueSignal,
    highValueEvidence: strongEvidence.slice(0, 8),
    evidence: evidence.slice(0, 8),
    softMissing: softMissing.slice(0, 8),
    promotionHints: [...new Set(promotionHints)].slice(0, 8),
    missing: missing.slice(0, 8),
    blockers: blockers.slice(0, 8),
    required: [
      '云端 MARKET_COMMAND_JSON 有效，反证审判keep或downgrade仅降仓',
      '数据完整度≥80且关键盘口/队名/近期数据不缺失',
      '正EV达到候选并尽量与总控最优玩法同向',
      'R-MR陷阱/观望/高波动只做局部玩法降级，不得自动反向',
      'edgeScore≥58、riskScore<65；CLV/云端/完整度轻缺口可进入待确认候选，不得直接写高价值',
      '大小球高价值必须独立满足至少两类同向证据+一个反证检查'
    ],
    plain: allowMediumHigh
      ? `${valueTier}准入通过：${(strongValueSignal ? strongEvidence : evidence).slice(0, 5).join('；')}${allowHigh ? '；高价值准入通过。' : '；未达到高价值更严阈值，按低/中低仓执行。'}`
      : allowMediumHighWatch
        ? `${valueTier}：${evidence.slice(0, 5).join('；')}；待确认=${softMissing.slice(0, 3).join('；') || '临场盘口/CLV'}。`
        : `中高价值准入未通过：${[...blockers, ...missing, ...softMissing].slice(0, 6).join('；') || '证据不足'}。`
  };
}

function lineLabelFromValue(value) {
  const v = Math.abs(num(value) ?? NaN);
  const map = {
    0: '平手',
    0.25: '平手/半球',
    0.5: '半球',
    0.75: '半球/一球',
    1: '一球',
    1.25: '一球/球半',
    1.5: '球半',
    1.75: '球半/两球',
    2: '两球',
    2.25: '两球/两球半',
    2.5: '两球半',
    2.75: '两球半/三球',
    3: '三球'
  };
  return Object.prototype.hasOwnProperty.call(map, v) ? map[v] : '';
}

function buildHumanArbitration({ normalized = {}, quant = null, marketEfficiency = {}, euroAsianGap = {}, ouDrawLink = {}, goalReality = {}, movementRead = {}, trapDiscipline = {}, valueAdmission = {}, score = {}, marketCommand = null } = {}) {
  const asian = normalized.asian || {};
  const currentLineValue = parseLineValue(firstDefined(asian.currentLineValue, asian.currentLine, asian.mainLine));
  const favoriteSide = euroAsianGap.favoriteSide || marketEfficiency.favorite?.side || 'unknown';
  const favoriteLabel = euroAsianGap.favoriteLabel || marketEfficiency.favorite?.label || '热门方';
  const favoriteDepth = Math.abs(num(euroAsianGap.actualFavoriteDepth) ?? (currentLineValue ?? 0));
  const overWater = decimalWater(firstDefined(normalized.overunder?.currentOverWater, normalized.overunder?.currentOver, normalized.overunder?.overDecimalOdds));
  const underWater = decimalWater(firstDefined(normalized.overunder?.currentUnderWater, normalized.overunder?.currentUnder, normalized.overunder?.underDecimalOdds));
  const quantProb = toPctProbObject(quant?.probabilities || quant?.wdw || quant?.winDrawWin || quant?.resultProbabilities) || {};
  const marketFavProb = num(marketEfficiency.favorite?.probability);
  const quantFavProb = favoriteSide === 'home' ? quantProb.home : favoriteSide === 'away' ? quantProb.away : null;
  const quantGap = marketFavProb !== null && quantFavProb !== null ? round(Math.abs(marketFavProb - quantFavProb), 2) : null;
  const reasons = [];
  const gates = [];
  const outputGuards = [];
  let coverStatus = 'playable';
  let resultStatus = 'lean_favorite';
  let totalStatus = 'independent_review';
  let stakeCap = valueAdmission.allowMediumHigh ? '中低仓封顶' : '低仓/待临场确认';

  if (favoriteDepth >= 1.25) {
    reasons.push(`深让盘(${lineLabelFromValue(favoriteDepth) || favoriteDepth})必须单独审查穿盘，不得把${favoriteLabel}胜出直接等同于穿盘`);
    if (ouDrawLink.lowScoreRisk === 'high' || (underWater !== null && overWater !== null && underWater <= overWater - 0.12)) {
      coverStatus = 'downgraded';
      gates.push('深让盘遇到小球/低比分防范：热门穿盘至少降一级，主胜与让球分离');
    }
    const euroAsianDanger = euroAsianDangerProfile(euroAsianGap);
    if (euroAsianDanger.isDanger) {
      coverStatus = euroAsianDanger.coverAction === 'blocked' ? 'blocked' : (coverStatus === 'blocked' ? 'blocked' : 'downgraded');
      gates.push(euroAsianDanger.message);
      if (euroAsianDanger.stakeCap) stakeCap = euroAsianDanger.stakeCap;
    }
  }
  if (quantGap !== null && quantGap >= 18) {
    coverStatus = coverStatus === 'blocked' ? 'blocked' : 'downgraded';
    gates.push(`量化胜率与市场热门概率差${quantGap}pct：触发人工复核/降仓，不允许规则命中数直接抬升仓位`);
  }
  if (trapDiscipline.hasTrap && safeArray(trapDiscipline.affectedMarkets).some(m => /favorite_handicap|deep_handicap|favorite_heavy/.test(String(m)))) {
    coverStatus = coverStatus === 'blocked' ? 'blocked' : 'downgraded';
    gates.push(`陷阱纪律影响${trapDiscipline.affectedMarkets.join('、')}：只降级对应玩法，不外推成反向高价值`);
  }
  if ((score.riskScore ?? 0) >= 65) {
    stakeCap = '0~0.3u/观望';
    gates.push(`风险分${score.riskScore}偏高：所有投注仓位封顶`);
  }
  if (marketCommand?.counterEvidenceTrial?.verdict === 'overturn') {
    resultStatus = 'watch_only';
    coverStatus = 'blocked';
    totalStatus = 'watch_only';
    stakeCap = '观望';
    gates.push('反证审判=overturn：原剧本重算，不自动反打');
  }
  if (ouDrawLink.lowScoreRisk === 'high') totalStatus = 'under_watch_not_auto_pick';
  if (ouDrawLink.lowScoreRisk !== 'high' && ouDrawLink.ok) totalStatus = 'neutral_or_wait_line';
  if (goalReality.blocksBlindUnder) {
    totalStatus = 'under_blocked_by_goal_reality';
    gates.push('历史/近期进球现实偏大：小球不能只凭低水或防平信号主推，必须解释盘口反向定价，否则降级观望');
  } else if (goalReality.status === 'over_reality_supported') {
    totalStatus = 'over_supported_by_goal_reality';
    gates.push('近期进球均值/大球率/模型总进球支持大球，大小球需优先复核大球价值');
  } else if (goalReality.status === 'conflict_wait_line') {
    totalStatus = 'total_goals_conflict_wait_line';
    gates.push('大小球盘口与进球现实冲突：等待首发、天气和临场水位确认');
  } else if (goalReality.status === 'under_reality_supported' && ouDrawLink.lowScoreRisk === 'high') {
    totalStatus = 'under_supported_but_low_value_check';
    gates.push('小球同时获得进球现实和盘口低比分支持，但仍需检查水位是否已压低导致价值不足');
  }
  const euroAsianDanger = euroAsianDangerProfile(euroAsianGap);
  if (euroAsianDanger.isDanger && favoriteDepth < 1.25) {
    coverStatus = euroAsianDanger.coverAction === 'blocked' ? 'blocked' : (coverStatus === 'blocked' ? 'blocked' : 'downgraded');
    gates.push(euroAsianDanger.message);
    if (euroAsianDanger.stakeCap) stakeCap = euroAsianDanger.stakeCap;
  }
  if (euroAsianDanger.blocksMediumHigh) {
    resultStatus = 'watch_only';
    stakeCap = euroAsianDanger.stakeCap || '0~0.2u/观望';
  }
  outputGuards.push('终局输出必须拆成：胜平负方向、亚让穿盘、大小球、价值/仓位四栏');
  outputGuards.push('盘口文字与数字必须一致：半球=-0.5/0.5，球半=-1.5/1.5，禁止出现“-0.5（球半）”');
  outputGuards.push('规则命中数只代表证据数量，最终按玩法冲突仲裁；冲突未解除时只能降级或观望');
  outputGuards.push('推荐小球前必须引用近期总进球/大球率/模型总进球；若历史常见3-4球且无盘口反向强证据，小球只能写观望');

  const mainRecommendation = (() => {
    if (resultStatus === 'watch_only') return '本场观望，不投';
    if (coverStatus === 'blocked') return `${favoriteLabel}胜负方向可复核，但亚让深盘穿盘不入主推；转为胜平负/让浅盘或观望`;
    if (coverStatus === 'downgraded') return `${favoriteLabel}方向保留，但让球穿盘降为低仓候选，需临场水位/大小球共振确认`;
    return `${favoriteLabel}方向可作为候选，但仍按价值准入与CLV复核控仓`;
  })();

  return {
    version: 'human-arbitration-v1',
    favoriteSide,
    favoriteLabel,
    currentLineValue,
    lineLabel: lineLabelFromValue(currentLineValue),
    favoriteDepth,
    resultStatus,
    handicapCoverStatus: coverStatus,
    totalGoalsStatus: totalStatus,
    stakeCap,
    quantMarketGapPct: quantGap,
    goalRealityStatus: goalReality.status || 'unknown',
    gates,
    reasons,
    outputGuards,
    mainRecommendation,
    plain: `人工仲裁：${mainRecommendation}；仓位=${stakeCap}${gates.length ? `；触发=${gates.slice(0, 3).join('；')}` : '；未触发硬降级门'}`
  };
}

function buildUpsetRead({ marketEfficiency = {}, euroAsianGap = {}, ouDrawLink = {}, goalReality = {}, movementRead = {}, trapDiscipline = {}, valueAdmission = {}, score = {}, humanArbitration = {} } = {}) {
  const paths = [];
  const evidence = [];
  const triggers = [];
  const invalidIf = [];
  const forbiddenInferences = [
    'PRO_MARKET_JSON 的 trapDiscipline/高风险/降仓只能限制命中玩法，不自动生成反向下注价值',
    '欧亚偏浅优先解释为热门让球穿盘降级或受让保护，不等于客胜/主胜反向高价值',
    '低比分/平赔风险只支持防平、防赢球不穿或低比分路径，大小球仍需 goalReality 独立证据',
    'valueAdmission 未通过时，不能把主方向低价值改写成冷门高价值'
  ];
  const addPath = p => { if (p && !paths.includes(p)) paths.push(p); };
  const addEvidence = e => { if (e && !evidence.includes(e)) evidence.push(e); };

  const favoriteLabel = euroAsianGap.favoriteLabel || marketEfficiency.favorite?.label || humanArbitration.favoriteLabel || '热门侧';
  const favoriteSide = euroAsianGap.favoriteSide || marketEfficiency.favorite?.side || humanArbitration.favoriteSide || 'unknown';
  const dogLabel = favoriteSide === 'home' ? '客队' : favoriteSide === 'away' ? '主队' : '受让方';

  const euroAsianDanger = euroAsianDangerProfile(euroAsianGap);
  if (euroAsianDanger.isDanger) {
    if (['shallow', 'severe_shallow', 'range_mismatch_shallow'].includes(euroAsianDanger.level)) addPath(`${dogLabel}受让/热门赢球不穿`);
    else if (euroAsianDanger.level === 'range_mismatch_deep') addPath(`${favoriteLabel}方向造热/强行深开后赢球不穿`);
    else addPath(`${favoriteLabel}方向低仓保护/待临场确认`);
    addEvidence(`欧亚风险=${euroAsianDanger.level}：${euroAsianDanger.message}`);
    triggers.push('临场欧赔、亚盘理论范围与主客水位重新一致后，才允许解除欧亚风险降级');
  }
  if (ouDrawLink.lowScoreRisk === 'high') {
    addPath('平局/小比分防冷');
    addEvidence('平赔/大小球低比分风险为high，热门穿盘容错下降');
    triggers.push('总进球低盘延续、小球水位持续压低或平赔保持保护');
  }
  if (goalReality.status === 'under_reality_supported' && ouDrawLink.lowScoreRisk === 'high') {
    addPath('小比分冷门观察');
    addEvidence('进球现实层与低比分盘口同向，但仍需检查水位价值');
  }
  if (goalReality.blocksBlindUnder) {
    addEvidence('进球现实层阻断盲目小球：冷门路径不能自动包装成小球');
    invalidIf.push('近期总进球/大球率继续支持大球且缺少盘口反向强证据');
  }
  if (humanArbitration.handicapCoverStatus === 'downgraded' || humanArbitration.handicapCoverStatus === 'blocked') {
    addPath(`${favoriteLabel}胜出但不穿盘`);
    addEvidence(`人工盘口仲裁限制让球穿盘：${humanArbitration.handicapCoverStatus}`);
  }
  if (trapDiscipline.hasTrap) {
    addEvidence(`陷阱纪律影响=${safeArray(trapDiscipline.affectedMarkets).join('、') || '-'}`);
  }
  if ((score.riskScore ?? 0) >= 65) {
    addEvidence(`专业盘口riskScore=${score.riskScore}，所有冷热门方向都需仓位封顶`);
  }

  invalidIf.push('临场形成欧赔、亚盘、大小球三盘同向支持热门穿盘');
  invalidIf.push('反证审判keep且盘口异动继续支持主方向');
  invalidIf.push('冷门方向赔率被压低、CLV转负或缺少独立edge');

  const independentEvidence = evidence.filter(e => !/阻断|不能自动|所有冷热门/.test(e)).length;
  let valueStatus = 'none';
  let valueLabel = '无明确冷门候选';
  if (paths.length) {
    valueStatus = 'hedge_only';
    valueLabel = '防冷/保护候选';
  }
  if (paths.length && independentEvidence >= 3 && (score.riskScore ?? 0) >= 58 && !valueAdmission.allowHigh && !euroAsianDanger.blocksMediumHigh) {
    valueStatus = 'upset_value_watch';
    valueLabel = '冷门价值观察候选，必须临场二次确认';
  }
  if (valueAdmission.allowHigh || valueAdmission.strongValueSignal) {
    valueStatus = valueStatus === 'upset_value_watch' ? 'hedge_only' : valueStatus;
    valueLabel = paths.length ? '主方向强信号下仅做防冷保护，不反向抢价值' : valueLabel;
    addEvidence('主方向价值准入强，不因普通防冷信号推翻主方向');
  }

  const mainDirection = humanArbitration.mainRecommendation || `${favoriteLabel}方向按价值准入复核`;
  const plain = paths.length
    ? `${valueLabel}：主方向=${mainDirection}；防冷=${paths.slice(0, 3).join('、')}；纪律=风险/陷阱不等于反向价值`
    : `暂无明确冷门路径；主方向=${mainDirection}`;

  return {
    version: 'upset-read-v1',
    favoriteSide,
    favoriteLabel,
    oppositeSideLabel: dogLabel,
    mainDirection,
    valueStatus,
    valueLabel,
    valueAllowed: valueStatus === 'upset_value_watch',
    paths,
    evidence: evidence.slice(0, 10),
    triggers: [...new Set(triggers)].slice(0, 8),
    invalidIf: [...new Set(invalidIf)].slice(0, 8),
    forbiddenInferences,
    plain
  };
}

function toMarkdown(result = {}) {
  if (!result || result.version !== 'pro-market-v1') return '';
  const L = [];
  L.push('### 🎯 专业盘口增强层 PRO_MARKET_JSON');
  L.push('> 辅助纪律：本层用于价值差、CLV、欧亚/大小球联动复核，不得覆盖云端 MARKET_COMMAND_JSON；只有高风险或五类重大反证才允许降仓/观望。');
  L.push(`- 总结：${result.plainSummary || '-'}`);
  if (result.score) L.push(`- 评分：edge=${result.score.edgeScore} / risk=${result.score.riskScore} / CLV准备=${result.score.clvReadiness} / 置信修正=${result.score.confidenceDelta}`);
  if (result.humanArbitration?.plain) L.push(`- 人工盘口仲裁：${result.humanArbitration.plain}`);
  if (result.marketEfficiency?.plain) L.push(`- 市场效率：${result.marketEfficiency.plain}`);
  if (result.euroAsianGap?.plain) L.push(`- 欧亚缺口：${result.euroAsianGap.plain}`);
  if (result.euroAsianGap?.lineRange?.plain) L.push(`- 欧亚理论范围：${result.euroAsianGap.lineRange.plain}`);
  if (result.euroAsianGap?.waterImbalance?.plain) L.push(`- 亚盘高低水：${result.euroAsianGap.waterImbalance.plain}`);
  if (result.euroAsianGap?.inducementRisk?.plain) L.push(`- 欧亚诱导风险：${result.euroAsianGap.inducementRisk.plain}`);
  if (result.ouDrawLink?.plain) L.push(`- 平赔/大小球：${result.ouDrawLink.plain}`);
  if (result.goalReality?.plain) L.push(`- 进球现实层：${result.goalReality.plain}`);
  if (result.movementRead?.plain) L.push(`- 异动：${result.movementRead.plain}`);
  if (result.valueRead?.plain) L.push(`- 价值：${result.valueRead.plain}`);
  if (result.trapDiscipline?.plain) L.push(`- 陷阱纪律：${result.trapDiscipline.plain}`);
  if (result.valueAdmission?.plain) L.push(`- 中高价值准入：${result.valueAdmission.plain}`);
  if (result.upsetRead?.plain) {
    L.push(`- 冷门双轨：${result.upsetRead.plain}`);
    if (result.upsetRead.triggers?.length) L.push(`- 冷门触发：${result.upsetRead.triggers.slice(0, 4).join('；')}`);
    if (result.upsetRead.forbiddenInferences?.length) L.push(`- 禁止误推：${result.upsetRead.forbiddenInferences.slice(0, 3).join('；')}`);
  }
  if (result.clvChecklist?.checklist?.length) L.push(`- CLV复核：${result.clvChecklist.checklist.slice(0, 4).join('；')}`);
  L.push('```PRO_MARKET_JSON');
  L.push(JSON.stringify(result, null, 2));
  L.push('```');
  return L.join('\n');
}

export function analyzeProfessionalMarket({ normalized = {}, knowledge = {}, quant = null, marketCommand = null, marketTimeline = null, jingcaiDeviation = null } = {}) {
  const rawMarketCommand = marketCommand;
  const cloudMarketCommand = isCloudMarketCommand(rawMarketCommand) ? rawMarketCommand : null;
  const marketEfficiency = buildMarketEfficiency(normalized, quant);
  const euroAsianGap = buildEuroAsianGap(normalized, marketEfficiency);
  const ouDrawLink = buildOuDrawLink(normalized, quant, marketEfficiency, cloudMarketCommand);
  const goalReality = buildGoalRealityRead(normalized, quant, ouDrawLink);
  const movementRead = buildMovementRead(normalized, quant, marketTimeline);
  const crowdSentimentRead = buildCrowdSentimentRead(jingcaiDeviation, movementRead);
  const valueRead = buildValueRead(quant, cloudMarketCommand);
  const trapDiscipline = buildTrapDiscipline({ marketCommand: cloudMarketCommand, euroAsianGap, ouDrawLink, movementRead, crowdSentimentRead });
  const clvChecklist = buildClvChecklist(cloudMarketCommand, movementRead, marketEfficiency);
  const score = buildScore({ marketEfficiency, euroAsianGap, ouDrawLink, movementRead, valueRead, crowdSentimentRead });
  const valueAdmission = buildValueAdmission({ valueRead, score, marketCommand: cloudMarketCommand, euroAsianGap, ouDrawLink, movementRead, trapDiscipline, normalized });
  const humanArbitration = buildHumanArbitration({ normalized, quant, marketEfficiency, euroAsianGap, ouDrawLink, goalReality, movementRead, trapDiscipline, valueAdmission, score, marketCommand: cloudMarketCommand });
  const upsetRead = buildUpsetRead({ marketEfficiency, euroAsianGap, ouDrawLink, goalReality, movementRead, trapDiscipline, valueAdmission, score, humanArbitration });
  const riskFlags = [];
  if (rawMarketCommand && !cloudMarketCommand) riskFlags.push(`检测到${rawMarketCommand._source || 'unknown'}盘口总控存根，专业盘口增强层已排除其历史基线、盘口剧本、执行命令和仓位建议。`);
  if (score.riskScore >= 72) riskFlags.push('专业盘口增强层判定风险偏高，仓位必须打折或等待临场。');
  if (valueAdmission.strongValueSignal) riskFlags.push(`强信号价值候选已出现：${valueAdmission.highValueEvidence.slice(0, 4).join('；')}，仍需按仓位封顶执行。`);
  if (!valueAdmission.allowMediumHigh && valueAdmission.allowMediumHighWatch) riskFlags.push(`中高价值待确认候选：${valueAdmission.softMissing.slice(0, 4).join('；')}`);
  else if (!valueAdmission.allowMediumHigh) riskFlags.push(`中高价值准入未通过：${[...valueAdmission.blockers, ...valueAdmission.missing, ...(valueAdmission.softMissing || [])].slice(0, 4).join('；')}`);
  if (valueRead.valueGate?.noHighValue) riskFlags.push(`量化正EV已被价值门控降级：${valueRead.valueGate.reasons.join('；')}`);
  if (trapDiscipline.hasTrap) riskFlags.push(`陷阱门控已改为局部降级：${trapDiscipline.localDowngrades.slice(0, 2).join('；')}`);
  const euroAsianDanger = euroAsianDangerProfile(euroAsianGap);
  if (euroAsianDanger.isDanger) riskFlags.push(describeEuroAsianDanger(euroAsianGap));
  if (ouDrawLink.lowScoreRisk === 'high') riskFlags.push('平局/小球低比分风险偏高：大小球方向仍需独立证据。');
  if (goalReality.blocksBlindUnder) riskFlags.push('进球现实层阻断盲目小球：历史/近期总进球偏高时，不得仅凭小球低水或防平信号推荐小球。');
  if (humanArbitration.handicapCoverStatus !== 'playable') riskFlags.push(`人工盘口仲裁已限制让球穿盘：${humanArbitration.mainRecommendation}`);
  if (upsetRead.valueStatus !== 'none') riskFlags.push(`冷门双轨：${upsetRead.plain}`);
  if (crowdSentimentRead.ok && crowdSentimentRead.riskFlag) riskFlags.push(crowdSentimentRead.riskFlag);
  const euroAsianDangerSummary = euroAsianDanger.isDanger ? describeEuroAsianDanger(euroAsianGap) : '';
  const plainSummary = `专业盘口增强：edge=${score.edgeScore}，risk=${score.riskScore}，CLV准备=${score.clvReadiness}；${euroAsianDangerSummary}；${humanArbitration.plain}；${upsetRead.plain}；${crowdSentimentRead.ok ? crowdSentimentRead.plain : ''}；${[marketEfficiency.plain, euroAsianGap.plain, valueRead.plain].filter(Boolean).slice(0, 2).join(' ')}`.replace(/；+/g, '；').replace(/^；|；$/g, '');
  return {
    version: 'pro-market-v1',
    generatedAt: new Date().toISOString(),
    source: 'local_pro_market',
    marketCommandSource: cloudMarketCommand?._source || '',
    rawMarketCommandSource: rawMarketCommand?._source || '',
    knowledgeSource: knowledge?._source || '',
    marketEfficiency,
    euroAsianGap,
    ouDrawLink,
    goalReality,
    movementRead,
    crowdSentimentRead,
    valueRead,
    trapDiscipline,
    valueAdmission,
    humanArbitration,
    upsetRead,
    clvChecklist,
    score,
    riskFlags,
    plainSummary
  };
}

export { toMarkdown as professionalMarketToMarkdown };

export default {
  analyzeProfessionalMarket,
  professionalMarketToMarkdown: toMarkdown
};
