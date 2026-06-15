/**
 * DataCollector - 基于真实HTML结构的精准解析版
 * 实际HTML结构（从web_fetch观察）：
 * 亚让：澳* 0.95 平手/半球 0.89  即时: 1.00 平手/半球 0.84
 * 大小：澳* 1.00 2.5 0.80  即时: 0.86 2/2.5 0.94
 * 角球：澳* 0.94 9.5 0.82  即时: 0.96 9.5 0.80
 */
export class DataCollector {
  constructor() {
    this.baseAnalysis = 'https://zq.titan007.com/analysis/';
    this.baseVip = 'https://vip.titan007.com/';
    this.base1x2Data = 'https://1x2d.titan007.com/';
  }

  async fetchAll(matchId) {
    const [analysis, winDrawWin, asian, overunder, corner] = await Promise.allSettled([
      this.fetchAnalysis(matchId),
      this.fetchWinDrawWin(matchId),
      this.fetchAsian(matchId),
      this.fetchOverUnder(matchId),
      this.fetchCorner(matchId)
    ]);

    return {
      matchId,
      fetchTime: new Date().toISOString(),
      analysis:  analysis.status === 'fulfilled'  ? analysis.value  : { error: analysis.reason?.message },
      winDrawWin: winDrawWin.status === 'fulfilled' ? winDrawWin.value : { error: winDrawWin.reason?.message },
      asian:     asian.status === 'fulfilled'     ? asian.value     : { error: asian.reason?.message },
      overunder: overunder.status === 'fulfilled' ? overunder.value : { error: overunder.reason?.message },
      corner:    corner.status === 'fulfilled'    ? corner.value    : { error: corner.reason?.message }
    };
  }

  // ===== 赛前分析 =====
  async fetchAnalysis(matchId) {
    const url = `${this.baseAnalysis}${matchId}cn.htm`;
    const html = await this._fetch(url);
    return this._parseAnalysis(html);
  }

  _parseAnalysis(html) {
    const result = { matchInfo: {}, homeStats: {}, awayStats: {}, handicapTrend: {} };
    const cleanCell = v => String(v || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;|\u00a0/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
    const statNum = v => {
      const text = cleanCell(v).replace(/,/g, '');
      if (!text || /^[-—]+$/.test(text)) return null;
      const m = text.match(/-?\d+(?:\.\d+)?/);
      const n = m ? parseFloat(m[0]) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    const pickAvg = (stats, key) => {
      const candidates = [stats?.last6, stats?.homeRecord, stats?.total];
      for (const row of candidates) {
        const goals = statNum(row?.[key]);
        const played = statNum(row?.played);
        if (goals !== null && played && played > 0) return Number((goals / played).toFixed(2));
      }
      return undefined;
    };
    const hasReliableRecentStats = rs => {
      const values = [rs.homeFor, rs.homeAgainst, rs.awayFor, rs.awayAgainst].map(v => Number(v));
      if (!values.every(Number.isFinite)) return false;
      if (values.every(v => v === 0)) return false;
      return values.every(v => v >= 0 && v <= 8);
    };

    // 比赛时间
    const timeM = html.match(/(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})/);
    if (timeM) result.matchInfo.time = timeM[1] + ' ' + timeM[2];

    // 主客队名称（从 <img ... alt="xxx" title="xxx"> 或 href 中提取）
    // 方式1：alt 属性
    const altNames = [];
    const altRe = /alt="([^"]{2,25})"/g;
    let m;
    while ((m = altRe.exec(html)) !== null) {
      const n = m[1].trim();
      if (n.length >= 2 && !n.match(/^\d/) && !['image','icon','logo','HGreen','HBlue','HSky','HPurple','HYellow'].includes(n)) {
        if (!altNames.includes(n)) altNames.push(n);
      }
    }
    result.matchInfo.home = altNames[0] || '';
    result.matchInfo.away = altNames[1] || '';

    // 天气温度（编码后可能是GB2312，先尝试）
    const weatherM = html.match(/天气[：:uff1a]([^\s<&\n]{1,8})/);
    if (weatherM) result.matchInfo.weather = weatherM[1];
    const tempM = html.match(/温度[：:uff1a]([^<&\n]{3,15})/);
    if (tempM) result.matchInfo.temperature = tempM[1].trim();

    // 联赛
    const leagueM = html.match(/(\d{4}-\d{4})赛季([^<\)\n\-（]{2,20})/);
    if (leagueM) result.matchInfo.league = leagueM[2].trim();

    // 战绩统计 - 寻找表格中的数字行
    // 典型格式：总</td><td>34</td><td>24</td><td>4</td><td>6</td><td>74</td><td>29</td><td>45</td><td>76</td><td>1</td><td>70.6%</td>
    const rowRe = /<tr[^>]*>[\s\S]*?<\/tr>/g;
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;

    const extractRow = (rowHtml) => {
      const cells = [];
      let cm;
      while ((cm = tdRe.exec(rowHtml)) !== null) {
        cells.push(cleanCell(cm[1]));
      }
      tdRe.lastIndex = 0;
      return cells;
    };

    let teamIndex = 0;
    while ((m = rowRe.exec(html)) !== null) {
      const cells = extractRow(m[0]);
      const rowLabel = cleanCell(cells[0]).replace(/\s+/g, '');
      if (rowLabel === '总' && cells.length >= 8 && statNum(cells[1]) !== null) {
        const statsObj = {
          played: cells[1], win: cells[2], draw: cells[3], loss: cells[4],
          goalsFor: cells[5], goalsAgainst: cells[6], diff: cells[7],
          points: cells[8] || '', rank: cells[9] || '', winRate: cells[10] || ''
        };
        if (teamIndex === 0) result.homeStats.total = statsObj;
        else if (teamIndex === 1) result.awayStats.total = statsObj;
      }
      if (rowLabel === '主场' || rowLabel === '主' || rowLabel === '客场' || rowLabel === '客') {
        const venueMatch = {
          played: cells[1], win: cells[2], draw: cells[3], loss: cells[4],
          goalsFor: cells[5], goalsAgainst: cells[6], winRate: cells[10] || ''
        };
        if (teamIndex === 0) result.homeStats.homeRecord = venueMatch;
        else result.awayStats.homeRecord = venueMatch;
      }
      if (/^近6/.test(rowLabel)) {
        const offset = statNum(cells[1]) === 6 ? 1 : 0;
        const last6 = {
          played: 6,
          win: cells[1 + offset], draw: cells[2 + offset], loss: cells[3 + offset],
          goalsFor: cells[4 + offset], goalsAgainst: cells[5 + offset]
        };
        if (teamIndex === 0) { result.homeStats.last6 = last6; teamIndex++; }
        else result.awayStats.last6 = last6;
      }
    }
    rowRe.lastIndex = 0;

    // 盘路赢盘率（从文本提取）
    const rateRe = /赢盘率[\s\S]{0,5}(\d{1,3}\.?\d*)%/g;
    const rates = [];
    while ((m = rateRe.exec(html)) !== null) rates.push(m[1]);
    if (rates[0]) result.handicapTrend.homeWinRate = rates[0];
    if (rates[1]) result.handicapTrend.awayWinRate = rates[1];

    const bigM = html.match(/大球率[\s\S]{0,5}(\d{1,3}\.?\d*)%/);
    if (bigM) result.handicapTrend.bigBallRate = bigM[1];

    const recentStats = {
      homeFor: pickAvg(result.homeStats, 'goalsFor'),
      homeAgainst: pickAvg(result.homeStats, 'goalsAgainst'),
      awayFor: pickAvg(result.awayStats, 'goalsFor'),
      awayAgainst: pickAvg(result.awayStats, 'goalsAgainst'),
      leagueAvg: 1.35,
      source: 'collector-analysis-stats-fallback'
    };
    if (hasReliableRecentStats(recentStats)) {
      result.recentStats = recentStats;
    } else {
      result.recentStatsStatus = {
        source: 'collector-analysis-stats-fallback',
        status: 'invalid_or_placeholder',
        reason: '分析页近期进失球为空、占位或字段不足，不能作为真实近期攻防输入'
      };
    }

    return result;
  }

  // ===== 胜平负 / 欧赔 =====
  async fetchWinDrawWin(matchId) {
    const js = await this._fetch(`${this.base1x2Data}${matchId}.js`);
    return this._parseWinDrawWinScript(js);
  }

  _parseWinDrawWinScript(js) {
    const result = { companies: [], summary: {}, keyOdds: {}, allOdds: [], _debug: { source: '1x2d-js', parsedRows: 0 } };
    const fmt = n => Number.isFinite(n) ? Number(n).toFixed(2) : '';
    const fmtPct = n => Number.isFinite(n) ? (n * 100).toFixed(2) + '%' : '';
    const isOdds = n => { n = parseFloat(n); return Number.isFinite(n) && n >= 1.01 && n <= 30; };
    const calcReturnRate = (win, draw, loss) => {
      win = parseFloat(win); draw = parseFloat(draw); loss = parseFloat(loss);
      return win > 0 && draw > 0 && loss > 0 ? win * draw * loss / (win * draw + draw * loss + win * loss) : null;
    };
    const isValidTriple = (win, draw, loss) => {
      if (!isOdds(win) || !isOdds(draw) || !isOdds(loss)) return false;
      const rate = calcReturnRate(win, draw, loss);
      return !!rate && rate >= 0.70 && rate <= 1.05;
    };
    const calcProbabilities = (win, draw, loss) => {
      const rate = calcReturnRate(win, draw, loss);
      win = parseFloat(win); draw = parseFloat(draw); loss = parseFloat(loss);
      if (!rate || !(win > 0 && draw > 0 && loss > 0)) return null;
      return { win: fmtPct(rate / win), draw: fmtPct(rate / draw), loss: fmtPct(rate / loss), returnRate: fmtPct(rate), _decimal: { win: rate / win, draw: rate / draw, loss: rate / loss } };
    };
    const normalizeCompanyName = raw => {
      let name = String(raw || '').replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\*.*$/, '').replace(/[×√□☑★]/g, '').replace(/\s+/g, '').trim();
      name = name.replace(/^[\d一二三四五六七八九十]+[、.．\-]\s*/, '').replace(/\[[^\]]*\]/g, '').replace(/[【】]/g, '');
      return name.length > 24 ? name.substring(0, 24) : name;
    };
    const isValidCompanyName = name => {
      name = normalizeCompanyName(name);
      if (!name || name.length > 24) return false;
      if (/^(公司|所有|主流|交易所|非交易所|初|即|主|和|客|主胜|客胜|返还率|凯利指数|变化时间|历史指数|筛选|设置自定义)$/.test(name)) return false;
      if (/^\d+(?:\.\d+)?%?$/.test(name) || /^[\d\s]+$/.test(name)) return false;
      return /[\u4e00-\u9fa5A-Za-z]/.test(name);
    };
    const recentChange = timeText => {
      const m = String(timeText || '').match(/(?:(\d{4})[,\-/])?(\d{1,2})[,\-/](\d{1,2})[,\-/\s]+(\d{1,2})[,\-:](\d{2})/);
      if (!m) return false;
      const now = new Date();
      const dt = new Date(m[1] ? parseInt(m[1], 10) : now.getFullYear(), parseInt(m[2], 10) - 1, parseInt(m[3], 10), parseInt(m[4], 10), parseInt(m[5], 10));
      const diff = now.getTime() - dt.getTime();
      return diff >= 0 && diff <= 30 * 60 * 1000;
    };
    const decodeJsString = s => String(s || '').replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(["'\\])/g, '$1');
    const addCompany = entry => {
      if (!entry || !isValidCompanyName(entry.name) || !isValidTriple(entry.currentWin, entry.currentDraw, entry.currentLoss)) return;
      entry.name = normalizeCompanyName(entry.name);
      const key = [entry.name, entry.currentWin, entry.currentDraw, entry.currentLoss].join('|');
      if (result.companies.some(c => [c.name, c.currentWin, c.currentDraw, c.currentLoss].join('|') === key)) return;
      result.companies.push(entry);
      result.allOdds.push(entry);
      result._debug.parsedRows++;
    };

    const gameM = String(js || '').match(/var\s+game\s*=\s*Array\(([\s\S]*?)\);/);
    if (gameM) {
      const itemRe = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g;
      let m;
      while ((m = itemRe.exec(gameM[1])) !== null) {
        const raw = decodeJsString(m[1] || m[2] || '');
        const parts = raw.split('|').map(x => x.trim());
        if (parts.length < 17) continue;
        const name = normalizeCompanyName(parts[21] || parts[2] || '');
        const initial = [parseFloat(parts[3]), parseFloat(parts[4]), parseFloat(parts[5])];
        const current = [parseFloat(parts[10]), parseFloat(parts[11]), parseFloat(parts[12])];
        if (!isValidTriple(current[0], current[1], current[2])) continue;
        const entry = {
          id: parts[0] || '',
          name,
          source: '1x2d-game-js',
          initialWin: isValidTriple(initial[0], initial[1], initial[2]) ? fmt(initial[0]) : '',
          initialDraw: isValidTriple(initial[0], initial[1], initial[2]) ? fmt(initial[1]) : '',
          initialLoss: isValidTriple(initial[0], initial[1], initial[2]) ? fmt(initial[2]) : '',
          currentWin: fmt(current[0]),
          currentDraw: fmt(current[1]),
          currentLoss: fmt(current[2]),
          changeTime: parts[20] || ''
        };
        if (parts[17] || parts[18] || parts[19]) entry.kelly = { win: parts[17] || '', draw: parts[18] || '', loss: parts[19] || '' };
        addCompany(entry);
      }
    }

    const avg = rows => {
      rows = rows.filter(x => x && isValidTriple(x.win, x.draw, x.loss));
      if (!rows.length) return null;
      const sum = rows.reduce((acc, x) => ({ win: acc.win + parseFloat(x.win), draw: acc.draw + parseFloat(x.draw), loss: acc.loss + parseFloat(x.loss) }), { win: 0, draw: 0, loss: 0 });
      return { win: fmt(sum.win / rows.length), draw: fmt(sum.draw / rows.length), loss: fmt(sum.loss / rows.length) };
    };
    result.summary.count = result.companies.length;
    result.summary.averageCurrent = avg(result.companies.map(c => ({ win: c.currentWin, draw: c.currentDraw, loss: c.currentLoss })));
    result.summary.averageInitial = avg(result.companies.map(c => ({ win: c.initialWin, draw: c.initialDraw, loss: c.initialLoss })));
    if (result.summary.averageCurrent) {
      const calc = calcProbabilities(result.summary.averageCurrent.win, result.summary.averageCurrent.draw, result.summary.averageCurrent.loss);
      if (calc) {
        result.summary.impliedAverage = { win: calc.win, draw: calc.draw, loss: calc.loss };
        result.summary.averageReturnRate = calc.returnRate;
      }
    }
    result.companies.forEach(c => {
      const cp = calcProbabilities(c.currentWin, c.currentDraw, c.currentLoss);
      if (cp) {
        c.returnRate = cp.returnRate;
        c.currentReturnRate = cp.returnRate;
        c.probabilities = { win: cp.win, draw: cp.draw, loss: cp.loss };
        c.currentProbabilities = c.probabilities;
      }
      const ip = calcProbabilities(c.initialWin, c.initialDraw, c.initialLoss);
      if (ip) {
        c.initialReturnRate = ip.returnRate;
        c.initialProbabilities = { win: ip.win, draw: ip.draw, loss: ip.loss };
      }
      if (c.changeTime) c.recent30 = recentChange(c.changeTime);
    });
    result.keyOdds.allCurrent = result.companies.map(c => ({ name: c.name, win: c.currentWin, draw: c.currentDraw, loss: c.currentLoss }));
    if (result.companies[0]) result.keyOdds.ao = { name: result.companies[0].name, ...result.companies[0] };
    if (result.companies[1]) result.keyOdds.crown = { name: result.companies[1].name, ...result.companies[1] };
    return result;
  }

  // ===== 亚让盘 =====
  async fetchAsian(matchId) {
    const url = `${this.baseVip}AsianOdds_n.aspx?id=${matchId}&l=0`;
    const html = await this._fetch(url);
    return this._parseAsian(html);
  }

  _parseAsian(html) {
    const result = { companies: [], summary: {}, keyOdds: {} };

    // 升降盘
    result.summary.up        = (html.match(/升盘_(\d+)_/) || [,'0'])[1];
    result.summary.down      = (html.match(/降盘_(\d+)_/) || [,'0'])[1];
    result.summary.highWater = (html.match(/高水_(\d+)_/) || [,'0'])[1];
    result.summary.lowWater  = (html.match(/低水_(\d+)_/) || [,'0'])[1];

    // 从 HTML 表格提取盘口
    // 表格行结构：公司名 | 初主水 | 初盘口 | 初客水 | 即主水 | 即盘口 | 即客水
    const companies = this._extractOddsTable(html, 'asian');
    result.companies = companies;

    if (companies[0]) result.keyOdds.ao    = { name: companies[0].name || '澳门', ...companies[0] };
    if (companies[1]) result.keyOdds.crown = { name: companies[1].name || '皇冠', ...companies[1] };
    result.keyOdds.allCurrent = companies.map(c => ({
      name: c.name, home: c.currentHome, line: c.currentHandicap, away: c.currentAway
    }));

    const lineCounts = {};
    result.keyOdds.allCurrent.forEach(c => {
      if (c.line) lineCounts[c.line] = (lineCounts[c.line] || 0) + 1;
    });
    result.summary.mainLine = Object.entries(lineCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    result.summary.lineConsensus = lineCounts;

    return result;
  }

  // ===== 大小球 =====
  async fetchOverUnder(matchId) {
    const url = `${this.baseVip}OverDown_n.aspx?id=${matchId}&l=0`;
    const html = await this._fetch(url);
    return this._parseOverUnder(html);
  }

  _parseOverUnder(html) {
    const result = { companies: [], summary: {}, keyOdds: {}, allOdds: [] };

    result.summary.up   = (html.match(/升盘_(\d+)_/) || [,'0'])[1];
    result.summary.down = (html.match(/降盘_(\d+)_/) || [,'0'])[1];

    const companies = this._extractOddsTable(html, 'ou');
    result.companies = companies;
    result.allOdds = companies;

    if (companies[0]) result.keyOdds.ao    = { name: companies[0].name || '澳门', ...companies[0] };
    if (companies[1]) result.keyOdds.crown = { name: companies[1].name || '皇冠', ...companies[1] };
    result.keyOdds.allCurrent = companies.map(c => ({
      name: c.name, over: c.currentOver, line: c.currentLine, under: c.currentUnder
    }));

    const lineCounts = {};
    result.keyOdds.allCurrent.forEach(c => {
      if (c.line) lineCounts[c.line] = (lineCounts[c.line] || 0) + 1;
    });
    result.summary.mainLine = Object.entries(lineCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    result.summary.lineConsensus = lineCounts;

    return result;
  }

  // ===== 角球 =====
  async fetchCorner(matchId) {
    const url = `${this.baseVip}Corner.aspx?id=${matchId}&l=0`;
    const html = await this._fetch(url);
    return this._parseCorner(html);
  }

  _parseCorner(html) {
    const result = { allOdds: [] };
    const companies = this._extractOddsTable(html, 'corner');
    result.allOdds = companies;

    if (companies[0]) {
      result.mainLine  = companies[0].currentLine;
      result.mainOver  = companies[0].currentOver;
      result.mainUnder = companies[0].currentUnder;
    }

    return result;
  }

  // ===== 通用表格提取 =====
  _extractOddsTable(html, type) {
    const results = [];

    // 提取所有 <tr> 行
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let trM;

    while ((trM = trRe.exec(html)) !== null) {
      const rowHtml = trM[1];
      const cells = [];
      let tdM;
      while ((tdM = tdRe.exec(rowHtml)) !== null) {
        // 去除HTML标签，提取纯文本
        const text = tdM[1]
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/\s+/g, ' ')
          .trim();
        if (text) cells.push(text);
      }
      tdRe.lastIndex = 0;

      if (cells.length < 3) continue;

      if (type === 'asian') {
        // 寻找含盘口名称的行；真实页面单元格可能带箭头/链接/混合文本，必须先提取 token 再校验
        const handRe = /^(?:受让两球半|受让两球\/两球半|受让两球|受让球半\/两球|受让球半|受让一球\/球半|受让一球|受让半球\/一球|受让半球|受让平手\/半球|平手\/半球|半球\/一球|一球\/球半|球半\/两球|两球\/两球半|两球半\/三球|平手|半球|一球|球半|两球|两球半|三球)$/;
        const handTokenRe = /受让两球半|受让两球\/两球半|受让两球|受让球半\/两球|受让球半|受让一球\/球半|受让一球|受让半球\/一球|受让半球|受让平手\/半球|平手\/半球|半球\/一球|一球\/球半|球半\/两球|两球\/两球半|两球半\/三球|平手|半球|一球|球半|两球|两球半|三球/g;
        const waterRe = /^[01]\.\d{2}$/;
        const waterTokenRe = /(^|[^\d.])([01]\.\d{2})(?![\d.])/g;
        const extractWaterTokens = list => {
          const out = [];
          list.forEach(cell => {
            const text = String(cell || '').replace(/\u00a0/g, ' ');
            let m;
            while ((m = waterTokenRe.exec(text)) !== null) out.push(m[2]);
            waterTokenRe.lastIndex = 0;
          });
          return out;
        };
        const extractAsianLineTokens = list => {
          const out = [];
          list.forEach(cell => {
            const text = String(cell || '').replace(/\s+/g, '');
            let m;
            while ((m = handTokenRe.exec(text)) !== null) if (handRe.test(m[0])) out.push(m[0]);
            handTokenRe.lastIndex = 0;
          });
          return out;
        };
        const lineIdx = cells.findIndex(c => extractAsianLineTokens([c]).length > 0);
        if (lineIdx >= 0) {
          const waters = extractWaterTokens(cells);
          const lines = extractAsianLineTokens(cells);

          if (waters.length >= 4 && lines.length >= 1) {
            const name = cells[0].replace(/[*★\s\t]/g, '').substring(0, 10);
            if (/^(公司|初|即时|历史|主队|客队|盘|多盘|公司多盘|最大值|最小值|平均值)$/.test(name)) continue;
            results.push({
              name,
              initialHome: waters[0], initialHandicap: lines[0], initialAway: waters[1],
              currentHome: waters[2],
              currentHandicap: lines[lines.length > 1 ? 1 : 0],
              currentAway: waters[3]
            });
          }
        }
      } else if (type === 'ou') {
        // 寻找含进球线的行（数字如 2.5 / 3 / 2/2.5）
        const lineRe = /^(?:\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)$/;
        const lineTokenRe = /(^|[^\d.])(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)(?![\d.])/g;
        const waterRe = /^[01]\.\d{2}$/;
        const waterTokenRe = /(^|[^\d.])([01]\.\d{2})(?![\d.])/g;
        const isLine = c => {
          if (!lineRe.test(c) || waterRe.test(c)) return false;
          const parts = String(c).split('/').map(v => parseFloat(v));
          if (!parts.length || parts.some(n => !Number.isFinite(n) || n < 1.5 || n > 5.5 || Math.abs(n * 4 - Math.round(n * 4)) > 1e-6)) return false;
          return parts.length === 1 || (parts.length === 2 && Math.abs(parts[1] - parts[0] - 0.5) < 1e-6);
        };
        const extractWaterTokens = list => {
          const out = [];
          list.forEach(cell => {
            const text = String(cell || '').replace(/\u00a0/g, ' ');
            let m;
            while ((m = waterTokenRe.exec(text)) !== null) out.push(m[2]);
            waterTokenRe.lastIndex = 0;
          });
          return out;
        };
        const extractOuLineTokens = list => {
          const out = [];
          list.forEach(cell => {
            const text = String(cell || '').replace(/\u00a0/g, ' ');
            let m;
            while ((m = lineTokenRe.exec(text)) !== null) if (isLine(m[2])) out.push(m[2]);
            lineTokenRe.lastIndex = 0;
          });
          return out;
        };
        const lines = extractOuLineTokens(cells);
        const waters = extractWaterTokens(cells);

        if (lines.length >= 1 && waters.length >= 4) {
          const name = cells[0].replace(/[*★\s\t]/g, '').substring(0, 10);
          if (/^(公司|初|即时|大球|小球|进球数|盘口|多盘|最大值|最小值|平均值)$/.test(name)) continue;
          results.push({
            name,
            initialOver: waters[0], initialLine: lines[0], initialUnder: waters[1],
            currentOver: waters[2],
            currentLine: lines[lines.length > 1 ? 1 : 0],
            currentUnder: waters[3]
          });
        }
      } else if (type === 'corner') {
        const lineRe = /^\d{1,2}(?:\.\d)?(?:\/\d{1,2}(?:\.\d)?)?$/;
        const waterRe = /^[01]\.\d{2}$/;
        const lines = cells.filter(c => lineRe.test(c) && parseFloat(c) >= 7 && parseFloat(c) <= 14);
        const waters = cells.filter(c => waterRe.test(c));

        if (lines.length >= 1 && waters.length >= 4) {
          const name = cells[0].replace(/[*★\s\t]/g, '').substring(0, 10);
          results.push({
            name,
            initialOver: waters[0], initialLine: lines[0], initialUnder: waters[1],
            currentOver: waters[waters.length >= 6 ? 3 : 2],
            currentLine: lines[lines.length > 1 ? 1 : 0],
            currentUnder: waters[waters.length >= 6 ? 4 : 3]
          });
        }
      }

      if (results.length >= 15) break;
    }

    // 如果 HTML 表格方式没有结果，尝试纯文本正则
    if (results.length === 0) {
      return this._extractByRegex(html, type);
    }

    return results;
  }

  _extractByRegex(html, type) {
    const results = [];

    if (type === 'asian') {
      // 匹配：数字 盘口名 数字 ... 数字 盘口名 数字（忽略中间内容）
      const lineNames = '(?:受让两球半|受让两球\\/两球半|受让两球|受让球半\\/两球|受让球半|受让一球\\/球半|受让一球|受让半球\\/一球|受让半球|受让平手\\/半球|平手\\/半球|半球\\/一球|一球\\/球半|球半\\/两球|两球\\/两球半|两球半\\/三球|平手|半球|一球|球半|两球|两球半|三球)';
      // 提取所有 [水位 盘口名 水位] 三元组
      const re = new RegExp(`([01]\\.\\d{2})\\s+(${lineNames})\\s+([01]\\.\\d{2})`, 'g');
      const triples = [];
      let m;
      while ((m = re.exec(html)) !== null) {
        triples.push({ home: m[1], line: m[2], away: m[3] });
      }
      // 奇数为初盘，偶数为即时（每两个一组）
      for (let i = 0; i + 1 < triples.length; i += 2) {
        results.push({
          name: `C${Math.floor(i/2)+1}`,
          initialHome: triples[i].home, initialHandicap: triples[i].line, initialAway: triples[i].away,
          currentHome: triples[i+1].home, currentHandicap: triples[i+1].line, currentAway: triples[i+1].away
        });
        if (results.length >= 15) break;
      }
    } else if (type === 'ou') {
      const re = /([01]\.\d{2})\s+((?:\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?))(?=\s+[01]\.\d{2})\s+([01]\.\d{2})/g;
      const triples = [];
      let m;
      while ((m = re.exec(html)) !== null) {
        const parts = String(m[2]).split('/').map(v => parseFloat(v));
        const validLine = !/^[01]\.\d{2}$/.test(m[2])
          && parts.length > 0
          && parts.every(n => Number.isFinite(n) && n >= 1.5 && n <= 5.5 && Math.abs(n * 4 - Math.round(n * 4)) <= 1e-6)
          && (parts.length === 1 || (parts.length === 2 && Math.abs(parts[1] - parts[0] - 0.5) < 1e-6));
        if (validLine) triples.push({ over: m[1], line: m[2], under: m[3] });
      }
      for (let i = 0; i + 1 < triples.length; i += 2) {
        results.push({
          name: `C${Math.floor(i/2)+1}`,
          initialOver: triples[i].over, initialLine: triples[i].line, initialUnder: triples[i].under,
          currentOver: triples[i+1].over, currentLine: triples[i+1].line, currentUnder: triples[i+1].under
        });
        if (results.length >= 15) break;
      }
    } else if (type === 'corner') {
      const re = /([01]\.\d{2})\s+(\d{1,2}(?:\.\d)?(?:\/\d{1,2}(?:\.\d)?)?)\s+([01]\.\d{2})/g;
      const triples = [];
      let m;
      while ((m = re.exec(html)) !== null) {
        const line = parseFloat(m[2]);
        if (line >= 7 && line <= 14) triples.push({ over: m[1], line: m[2], under: m[3] });
      }
      for (let i = 0; i + 1 < triples.length; i += 2) {
        results.push({
          name: `C${Math.floor(i/2)+1}`,
          initialOver: triples[i].over, initialLine: triples[i].line, initialUnder: triples[i].under,
          currentOver: triples[i+1].over, currentLine: triples[i+1].line, currentUnder: triples[i+1].under
        });
        if (results.length >= 15) break;
      }
    }

    return results;
  }

  // ===== 通用 fetch =====
  async _fetch(url) {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Referer': 'https://www.titan007.com/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Cache-Control': 'no-cache'
      },
      credentials: 'include'
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status} - ${url}`);

    const buffer = await resp.arrayBuffer();
    const contentType = resp.headers.get('content-type') || '';
    const headerCharset = (contentType.match(/charset\s*=\s*([\w-]+)/i) || [])[1] || '';
    const decode = charset => new TextDecoder(charset, { fatal: false }).decode(buffer);

    // 优先信任 HTTP Content-Type。真实 vip.titan007 盘口页返回 text/html;charset=UTF-8，
    // 页面脚本里可能残留 gb2312 字符串，不能用全文搜索误判，否则中文盘口会被解成乱码。
    if (/^utf-?8$/i.test(headerCharset)) return decode('utf-8');
    if (/^(?:gb2312|gbk|gb_2312)$/i.test(headerCharset)) {
      try { return decode('gbk'); } catch (e) { return decode('utf-8'); }
    }

    const utf8Text = decode('utf-8');
    const head = utf8Text.slice(0, 4096);
    const metaCharset = (head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i) || [])[1] || '';
    if (/^(?:gb2312|gbk|gb_2312)$/i.test(metaCharset)) {
      try { return decode('gbk'); } catch (e) { return utf8Text; }
    }

    return utf8Text;
  }
}
