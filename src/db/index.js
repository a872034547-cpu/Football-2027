import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaPath = path.join(__dirname, 'schema.sql');
const eloSchemaPath = path.join(__dirname, 'schema-elo.sql');
const marketTimelineSchemaPath = path.join(__dirname, 'schema-market-timeline.sql');
const clvSchemaPath = path.join(__dirname, 'schema-clv.sql');

let db = null;
let columnInfoCache = new Map();

export function nowIso() {
  return new Date().toISOString();
}

export function jsonStringifySafe(value) {
  if (value === undefined) return null;

  const seen = new WeakSet();

  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return item.toString();

      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }

      return item;
    });
  } catch {
    return null;
  }
}

export function parseJsonSafe(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function initDb() {
  if (db) return db;

  const databasePath = getDatabasePath();
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  db = new Database(databasePath);
  configureSqlitePragmas(db, databasePath);

  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schemaSql);

  const eloSchemaSql = fs.readFileSync(eloSchemaPath, 'utf8');
  db.exec(eloSchemaSql);

  const marketTimelineSchemaSql = fs.readFileSync(marketTimelineSchemaPath, 'utf8');
  db.exec(marketTimelineSchemaSql);

  const clvSchemaSql = fs.readFileSync(clvSchemaPath, 'utf8');
  db.exec(clvSchemaSql);

  columnInfoCache = new Map();

  return db;
}

export function getDb() {
  if (globalThis.__test_db__) {
    if (db !== globalThis.__test_db__) {
      db = globalThis.__test_db__;
      columnInfoCache = new Map();
    }
    return db;
  }

  return db || initDb();
}

export function closeDb() {
  if (!db) return;

  db.close();
  db = null;
  columnInfoCache = new Map();
}

function configureSqlitePragmas(database, databasePath) {
  try {
    database.pragma('journal_mode = WAL');
  } catch (error) {
    const message = error?.message || String(error);
    const code = error?.code ? ` code=${error.code}` : '';
    console.warn(`[db] SQLite WAL journal_mode unavailable for ${databasePath}; fallback to DELETE.${code} message=${message}`);
    database.pragma('journal_mode = DELETE');
  }

  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
}

export function upsertMatch(match) {
  const database = getDb();
  const data = prepareRow('matches', match, {
    source_json: match,
    raw_json: match,
    payload_json: match,
    data_json: match,
  });
  const conflictColumns = firstAvailableColumns('matches', [
    ['match_id'],
    ['source', 'source_id'],
    ['date', 'home_team', 'away_team'],
    ['match_date', 'home_team', 'away_team'],
    ['id'],
  ]);

  assertColumns(data, 'matches', 'upsertMatch');

  return executeUpsert(database, 'matches', data, conflictColumns);
}

export function listMatches({ date, limit, status } = {}) {
  const database = getDb();
  const columns = getTableColumnNames('matches');
  const where = [];
  const params = {};

  if (date) {
    if (columns.has('business_date')) {
      where.push('"business_date" = @date');
      params.date = date;
    } else if (columns.has('date')) {
      where.push('"date" = @date');
      params.date = date;
    } else if (columns.has('match_date')) {
      where.push('"match_date" = @date');
      params.date = date;
    } else if (columns.has('kickoff_at')) {
      where.push('substr("kickoff_at", 1, 10) = @date');
      params.date = date;
    }
  }

  if (status && columns.has('status')) {
    where.push('"status" = @status');
    params.status = status;
  }

  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const orderSql = buildOrderBy('matches', [
    ['kickoff_at', 'ASC'],
    ['match_time', 'ASC'],
    ['date', 'ASC'],
    ['match_date', 'ASC'],
    ['created_at', 'DESC'],
    ['id', 'DESC'],
  ]);
  const sql = `SELECT * FROM "matches"${whereSql}${orderSql} LIMIT @limit`;

  params.limit = normalizeLimit(limit, 100, 1000);

  return database.prepare(sql).all(params).map(parseJsonColumns);
}

export function insertSnapshot(snapshot) {
  const database = getDb();
  const data = prepareRow('match_snapshots', snapshot, {
    snapshot_json: snapshot,
    payload_json: snapshot,
    data_json: snapshot,
    raw_json: snapshot,
  });

  assertColumns(data, 'match_snapshots', 'insertSnapshot');

  return executeInsert(database, 'match_snapshots', data);
}

export function upsertAnalysisReport(report) {
  const database = getDb();
  const data = prepareRow('analysis_reports', report, {
    report_json: report,
    analysis_json: report,
    payload_json: report,
    data_json: report,
  });
  const conflictColumns = firstAvailableColumns('analysis_reports', [['match_id'], ['matchId'], ['id']]);

  assertColumns(data, 'analysis_reports', 'upsertAnalysisReport');

  return executeUpsert(database, 'analysis_reports', data, conflictColumns);
}

export function getAnalysisReport(matchId) {
  return getOneByColumns('analysis_reports', [
    ['match_id', matchId],
    ['matchId', matchId],
    ['id', matchId],
  ]);
}

export function upsertDailyPortfolio(portfolio) {
  const database = getDb();
  const data = prepareRow('daily_portfolios', portfolio, {
    portfolio_json: portfolio,
    payload_json: portfolio,
    data_json: portfolio,
  });
  const conflictColumns = firstAvailableColumns('daily_portfolios', [['business_date'], ['date'], ['day'], ['id']]);

  assertColumns(data, 'daily_portfolios', 'upsertDailyPortfolio');

  return executeUpsert(database, 'daily_portfolios', data, conflictColumns);
}

export function getDailyPortfolio(date) {
  return getOneByColumns('daily_portfolios', [
    ['business_date', date],
    ['date', date],
    ['day', date],
    ['id', date],
  ]);
}

export function insertPushLog(log) {
  const database = getDb();
  const data = prepareRow('push_logs', {
    ...log,
    business_date: log?.business_date ?? log?.businessDate ?? log?.date ?? log?.payload_json?.date ?? log?.payloadJson?.date ?? null,
    error: log?.error ?? log?.message ?? null,
  }, {
    log_json: log,
    payload_json: log,
    data_json: log,
  });

  assertColumns(data, 'push_logs', 'insertPushLog');

  return executeInsert(database, 'push_logs', data);
}

export function listPushLogs({ limit = 20, channel, status, matchId, date } = {}) {
  const database = getDb();
  const where = [];
  const params = { limit: normalizeLimit(limit, 20, 200) };

  if (channel) {
    where.push('"channel" = @channel');
    params.channel = channel;
  }
  if (status) {
    where.push('"status" = @status');
    params.status = status;
  }
  if (matchId) {
    where.push('"match_id" = @matchId');
    params.matchId = matchId;
  }
  if (date) {
    where.push('"business_date" = @date');
    params.date = date;
  }

  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const orderSql = buildOrderBy('push_logs', [
    ['created_at', 'DESC'],
    ['id', 'DESC'],
  ]);
  const sql = `SELECT * FROM "push_logs"${whereSql}${orderSql} LIMIT @limit`;

  return database.prepare(sql).all(params).map(parseJsonColumns);
}

export function upsertLearningProfile(key, profile) {
  const database = getDb();
  const input = {
    key,
    profile_key: key,
    profileKey: key,
    profile,
    profile_json: profile,
    payload_json: profile,
    data_json: profile,
  };
  const data = prepareRow('learning_profiles', input);
  const conflictColumns = firstAvailableColumns('learning_profiles', [['key'], ['profile_key'], ['id']]);

  assertColumns(data, 'learning_profiles', 'upsertLearningProfile');

  return executeUpsert(database, 'learning_profiles', data, conflictColumns);
}

export function getLearningProfile(key) {
  return getOneByColumns('learning_profiles', [
    ['key', key],
    ['profile_key', key],
    ['id', key],
  ]);
}

export function startJobRun(jobKey, meta) {
  const database = getDb();
  const now = nowIso();
  const input = {
    jobKey,
    job_key: jobKey,
    status: 'running',
    meta,
    meta_json: meta,
    started_at: now,
    created_at: now,
    updated_at: now,
  };
  const data = prepareRow('job_runs', input);

  if (!('id' in data)) {
    const idInfo = getTableColumnInfo('job_runs').get('id');
    if (idInfo && !isIntegerPrimaryKey(idInfo)) {
      data.id = `${jobKey}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    }
  }

  assertColumns(data, 'job_runs', 'startJobRun');

  const result = executeInsert(database, 'job_runs', data);
  return data.id ?? Number(result.lastInsertRowid);
}

export function finishJobRun(id, status, message, meta) {
  const database = getDb();
  const columns = getTableColumnNames('job_runs');
  const data = {};

  if (columns.has('status')) data.status = status;
  if (columns.has('message')) data.message = message;
  if (columns.has('meta_json')) data.meta_json = coerceDbValue(meta);
  else if (columns.has('meta')) data.meta = coerceDbValue(meta);
  if (columns.has('finished_at')) data.finished_at = nowIso();
  if (columns.has('updated_at')) data.updated_at = nowIso();

  assertColumns(data, 'job_runs', 'finishJobRun');

  const setSql = Object.keys(data).map((column) => `${quoteIdentifier(column)} = @${column}`).join(', ');
  return database.prepare(`UPDATE "job_runs" SET ${setSql} WHERE "id" = @id`).run({ ...data, id });
}

export function getLatestJobRuns(limit = 20) {
  const database = getDb();
  const orderSql = buildOrderBy('job_runs', [
    ['started_at', 'DESC'],
    ['created_at', 'DESC'],
    ['updated_at', 'DESC'],
    ['id', 'DESC'],
  ]);
  const sql = `SELECT * FROM "job_runs"${orderSql} LIMIT @limit`;

  return database.prepare(sql).all({ limit: normalizeLimit(limit, 20, 200) }).map(parseJsonColumns);
}

// ──────────────────────────────────────────────────────────────
// P0: match_results
// ──────────────────────────────────────────────────────────────

export function upsertMatchResult(result) {
  const database = getDb();
  const data = prepareRow('match_results', result, {
    source_json: result,
    asian_result_json: result?.asian_result_json ?? result?.asianResult,
    overunder_result_json: result?.overunder_result_json ?? result?.overunderResult,
  });
  const conflictColumns = firstAvailableColumns('match_results', [['match_id'], ['id']]);
  assertColumns(data, 'match_results', 'upsertMatchResult');
  return executeUpsert(database, 'match_results', data, conflictColumns);
}

export function getMatchResult(matchId) {
  return getOneByColumns('match_results', [['match_id', matchId], ['id', matchId]]);
}

export function listMatchResults({ date, limit } = {}) {
  const database = getDb();
  const columns = getTableColumnNames('match_results');
  const where = [];
  const params = {};

  if (date && columns.has('business_date')) {
    where.push('"business_date" = @date');
    params.date = date;
  }

  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const orderSql = buildOrderBy('match_results', [['business_date', 'ASC'], ['kickoff_time', 'ASC'], ['id', 'ASC']]);
  const sql = `SELECT * FROM "match_results"${whereSql}${orderSql} LIMIT @limit`;
  params.limit = normalizeLimit(limit, 100, 1000);

  return database.prepare(sql).all(params).map(parseJsonColumns);
}

// ──────────────────────────────────────────────────────────────
// P0: prediction_outcomes
// ──────────────────────────────────────────────────────────────

export function upsertPredictionOutcome(outcome) {
  const database = getDb();
  const data = prepareRow('prediction_outcomes', outcome, {
    meta_json: outcome?.meta_json ?? outcome?.meta,
  });
  const conflictColumns = firstAvailableColumns('prediction_outcomes', [['outcome_key'], ['match_id'], ['id']]);
  assertColumns(data, 'prediction_outcomes', 'upsertPredictionOutcome');
  return executeUpsert(database, 'prediction_outcomes', data, conflictColumns);
}

export function getPredictionOutcome(matchId) {
  return getOneByColumns('prediction_outcomes', [['match_id', matchId], ['outcome_key', matchId], ['id', matchId]]);
}

export function listPredictionOutcomes({ date, candidateTier, limit } = {}) {
  const database = getDb();
  const columns = getTableColumnNames('prediction_outcomes');
  const where = [];
  const params = {};

  if (date && columns.has('business_date')) {
    where.push('"business_date" = @date');
    params.date = date;
  }

  if (candidateTier && columns.has('candidate_tier')) {
    where.push('"candidate_tier" = @candidateTier');
    params.candidateTier = candidateTier;
  }

  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const orderSql = buildOrderBy('prediction_outcomes', [['business_date', 'ASC'], ['settled_at', 'ASC'], ['id', 'ASC']]);
  const sql = `SELECT * FROM "prediction_outcomes"${whereSql}${orderSql} LIMIT @limit`;
  params.limit = normalizeLimit(limit, 200, 2000);

  return database.prepare(sql).all(params).map(parseJsonColumns);
}

// ──────────────────────────────────────────────────────────────
// P0: backtest_runs
// ──────────────────────────────────────────────────────────────

export function upsertBacktestRun(run) {
  const database = getDb();
  const data = prepareRow('backtest_runs', run, {
    metrics_json: run?.metrics_json ?? run?.global,
    segments_json: run?.segments_json ?? run?.segments,
    timeline_json: run?.timeline_json ?? run?.timeline,
    config_json: run?.config_json ?? run?.config,
  });
  const conflictColumns = firstAvailableColumns('backtest_runs', [['run_id'], ['id']]);
  assertColumns(data, 'backtest_runs', 'upsertBacktestRun');
  return executeUpsert(database, 'backtest_runs', data, conflictColumns);
}

export function getBacktestRun(runId) {
  return getOneByColumns('backtest_runs', [['run_id', runId], ['id', runId]]);
}

export function getLatestBacktestRuns(limit = 10) {
  const database = getDb();
  const orderSql = buildOrderBy('backtest_runs', [['started_at', 'DESC'], ['created_at', 'DESC'], ['id', 'DESC']]);
  const sql = `SELECT * FROM "backtest_runs"${orderSql} LIMIT @limit`;
  return database.prepare(sql).all({ limit: normalizeLimit(limit, 10, 100) }).map(parseJsonColumns);
}

// ──────────────────────────────────────────────────────────────
// P0: calibration_buckets
// ──────────────────────────────────────────────────────────────

export function insertCalibrationBuckets(runId, buckets = []) {
  const database = getDb();
  const stmt = database.prepare(
    'INSERT INTO "calibration_buckets" ("run_id","segment_key","bucket_min","bucket_max","bucket_key","predicted_avg","actual_rate","sample_count","metrics_json","created_at") ' +
    'VALUES (@run_id, @segment_key, @bucket_min, @bucket_max, @bucket_key, @predicted_avg, @actual_rate, @sample_count, @metrics_json, @created_at)',
  );

  const now = nowIso();
  const insertMany = database.transaction((rows) => {
    for (const row of rows) {
      stmt.run({
        run_id: runId,
        segment_key: String(row.segment ?? row.segment_key ?? 'unknown'),
        bucket_min: row.bucketMin ?? row.bucket_min ?? null,
        bucket_max: row.bucketMax ?? row.bucket_max ?? null,
        bucket_key: row.bucket ?? row.bucket_key ?? null,
        predicted_avg: row.predictedAvg ?? row.predicted_avg ?? null,
        actual_rate: row.actualRate ?? row.actual_rate ?? null,
        sample_count: row.sampleCount ?? row.sample_count ?? null,
        metrics_json: jsonStringifySafe(row),
        created_at: now,
      });
    }
  });

  insertMany(buckets);
}

export function getCalibrationBuckets(runId) {
  const database = getDb();
  return database
    .prepare('SELECT * FROM "calibration_buckets" WHERE "run_id" = @runId ORDER BY "segment_key", "bucket_min"')
    .all({ runId })
    .map(parseJsonColumns);
}

function getDatabasePath() {
  const databasePath = config.DATABASE_PATH || config.databasePath;
  if (!databasePath) {
    throw new Error('config.DATABASE_PATH is required');
  }

  if (databasePath === ':memory:' || path.isAbsolute(databasePath)) return databasePath;
  return path.resolve(process.cwd(), databasePath);
}

export function getOneByColumns(table, candidates) {
  const database = getDb();
  const columns = getTableColumnNames(table);
  const candidate = candidates.find(([column]) => columns.has(column));

  if (!candidate) {
    throw new Error(`No supported lookup column found for ${table}`);
  }

  const [column, value] = candidate;
  const row = database
    .prepare(`SELECT * FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} = @value LIMIT 1`)
    .get({ value });

  return row ? parseJsonColumns(row) : null;
}

export function executeInsert(database, table, data) {
  const columns = Object.keys(data);
  const columnSql = columns.map(quoteIdentifier).join(', ');
  const valueSql = columns.map((column) => `@${column}`).join(', ');

  return database.prepare(`INSERT INTO ${quoteIdentifier(table)} (${columnSql}) VALUES (${valueSql})`).run(data);
}

export function executeUpsert(database, table, data, conflictColumns) {
  const columns = Object.keys(data);
  const columnSql = columns.map(quoteIdentifier).join(', ');
  const valueSql = columns.map((column) => `@${column}`).join(', ');
  const conflictSql = conflictColumns.map(quoteIdentifier).join(', ');
  const updateColumns = columns.filter(
    (column) => !conflictColumns.includes(column) && column !== 'created_at' && column !== 'createdAt',
  );
  const updateSql = updateColumns.length
    ? `DO UPDATE SET ${updateColumns.map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`).join(', ')}`
    : 'DO NOTHING';
  const sql = `INSERT INTO ${quoteIdentifier(table)} (${columnSql}) VALUES (${valueSql}) ON CONFLICT (${conflictSql}) ${updateSql}`;

  return database.prepare(sql).run(data);
}

export function prepareRow(table, input, jsonDefaults = {}) {
  const now = nowIso();
  const columns = getTableColumnNames(table);
  const source = { ...(input || {}) };
  const data = {};

  for (const [column, value] of Object.entries(jsonDefaults)) {
    if (columns.has(column) && source[column] === undefined && source[toCamelCase(column)] === undefined) {
      source[column] = value;
    }
  }

  for (const column of columns) {
    if (column === 'id' && source.id === undefined && isIntegerPrimaryKey(getTableColumnInfo(table).get(column))) {
      continue;
    }

    const sourceKey = findSourceKey(source, column);
    if (sourceKey !== null) {
      data[column] = coerceDbValue(source[sourceKey]);
    }
  }

  if (columns.has('created_at') && data.created_at === undefined) data.created_at = now;
  if (columns.has('createdAt') && data.createdAt === undefined) data.createdAt = now;
  if (columns.has('updated_at')) data.updated_at = now;
  if (columns.has('updatedAt')) data.updatedAt = now;
  if (columns.has('created_at') && data.created_at === null) data.created_at = now;
  if (columns.has('updated_at') && data.updated_at === null) data.updated_at = now;

  return data;
}

function assertColumns(data, table, caller) {
  if (!Object.keys(data).length) {
    throw new Error(`${caller} has no writable columns for table ${table}`);
  }
}

export function firstAvailableColumns(table, groups) {
  const columns = getTableColumnNames(table);
  const group = groups.find((items) => items.every((column) => columns.has(column)));

  if (!group) {
    throw new Error(`No supported conflict columns found for ${table}`);
  }

  return group;
}

export function buildOrderBy(table, candidates) {
  const columns = getTableColumnNames(table);
  const parts = candidates
    .filter(([column]) => columns.has(column))
    .map(([column, direction]) => `${quoteIdentifier(column)} ${direction}`);

  return parts.length ? ` ORDER BY ${parts.join(', ')}` : '';
}

function getTableColumnNames(table) {
  return new Set(getTableColumnInfo(table).keys());
}

function getTableColumnInfo(table) {
  const database = getDb();

  if (!columnInfoCache.has(table)) {
    const rows = database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
    columnInfoCache.set(
      table,
      new Map(rows.map((row) => [row.name, row])),
    );
  }

  return columnInfoCache.get(table);
}

function findSourceKey(source, column) {
  if (Object.prototype.hasOwnProperty.call(source, column)) return column;

  const camel = toCamelCase(column);
  if (Object.prototype.hasOwnProperty.call(source, camel)) return camel;

  const snake = toSnakeCase(column);
  if (Object.prototype.hasOwnProperty.call(source, snake)) return snake;

  return null;
}

function coerceDbValue(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object') return jsonStringifySafe(value);

  return value;
}

export function parseJsonColumns(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [isJsonColumn(key) ? key : key, isJsonColumn(key) ? parseJsonSafe(value, value) : value]),
  );
}

function isJsonColumn(key) {
  return key.endsWith('_json') || key === 'json' || key === 'payload' || key === 'data' || key === 'meta' || key === 'profile';
}

function isIntegerPrimaryKey(info) {
  return Boolean(info?.pk) && /INT/i.test(info?.type || '');
}

function toCamelCase(value) {
  return value.replace(/_([a-z])/g, (_match, char) => char.toUpperCase());
}

function toSnakeCase(value) {
  return value.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

function quoteIdentifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }

  return `"${value}"`;
}

export function normalizeLimit(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;

  return Math.min(parsed, max);
}

// ============================================================================
// Elo Rating System Functions (P1)
// ============================================================================

export function upsertTeamRating(rating) {
  const data = prepareRow('team_ratings', rating, {
    aliases_json: true,
    config_json: true,
  });
  const conflictColumns = ['namespace', 'team_key'];

  return executeUpsert(getDb(), 'team_ratings', data, conflictColumns);
}

export function getTeamRating(namespace = 'global', teamKey) {
  const database = getDb();
  const columns = getTableColumnNames('team_ratings');

  if (columns.has('namespace') && columns.has('team_key')) {
    const row = database
      .prepare('SELECT * FROM "team_ratings" WHERE "namespace" = @namespace AND "team_key" = @teamKey LIMIT 1')
      .get({ namespace, teamKey });
    return row ? parseJsonColumns(row) : null;
  }

  return getOneByColumns('team_ratings', [['team_key', teamKey], ['id', teamKey]]);
}

export function listTeamRatings({ namespace = 'global', league, limit = 100 } = {}) {
  const database = getDb();
  const params = { namespace };
  let whereSql = 'WHERE namespace = $namespace';

  if (league) {
    whereSql += ' AND league = $league';
    params.league = league;
  }

  const orderSql = buildOrderBy('team_ratings', [['rating', 'DESC'], ['matches_played', 'DESC']]);
  const limitSql = ` LIMIT ${normalizeLimit(limit, 100, 500)}`;
  const sql = `SELECT * FROM team_ratings ${whereSql}${orderSql}${limitSql}`;

  return database.prepare(sql).all(params).map(parseJsonColumns);
}

export function upsertEloRatingEvent(event) {
  const data = prepareRow('elo_rating_events', event, {
    config_json: true,
    source_json: true,
  });
  const conflictColumns = ['event_key'];

  return executeUpsert(getDb(), 'elo_rating_events', data, conflictColumns);
}

export function getEloRatingEvent(eventKey) {
  return getOneByColumns('elo_rating_events', [['event_key', eventKey]]);
}

export function listEloRatingEvents({ matchId, teamKey, namespace = 'global', limit = 50 } = {}) {
  const database = getDb();
  const params = { namespace };
  const conditions = ['namespace = $namespace'];

  if (matchId) {
    conditions.push('match_id = $matchId');
    params.matchId = matchId;
  }

  if (teamKey) {
    conditions.push('(home_team_key = $teamKey OR away_team_key = $teamKey)');
    params.teamKey = teamKey;
  }

  const whereSql = `WHERE ${conditions.join(' AND ')}`;
  const orderSql = buildOrderBy('elo_rating_events', [['business_date', 'DESC'], ['created_at', 'DESC']]);
  const limitSql = ` LIMIT ${normalizeLimit(limit, 50, 200)}`;
  const sql = `SELECT * FROM elo_rating_events ${whereSql}${orderSql}${limitSql}`;

  return database.prepare(sql).all(params).map(parseJsonColumns);
}
 
// Market Timeline Functions
