import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  session_id TEXT,
  turn INTEGER,
  mode TEXT NOT NULL DEFAULT 'auto',
  question TEXT NOT NULL,
  problem_type TEXT NOT NULL,
  problem_type_other TEXT,
  situation_tags TEXT NOT NULL DEFAULT '[]',
  situation_bucket TEXT NOT NULL DEFAULT 'general',
  classification_by TEXT NOT NULL DEFAULT 'model',
  classification_conf REAL NOT NULL DEFAULT 0.5,
  sampling_strength TEXT,
  sampling_run_id TEXT,
  sampled_options TEXT NOT NULL DEFAULT '[]',
  user_choice TEXT,
  user_choice_name TEXT,
  user_choice_description TEXT,
  user_reason TEXT,
  explicit_global INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0.5,
  level_after TEXT NOT NULL DEFAULT 'weak',
  scope_after TEXT NOT NULL DEFAULT 'situation',
  same_direction_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_obs_type_bucket ON observations(problem_type, situation_bucket, created_at);
CREATE INDEX IF NOT EXISTS idx_obs_type ON observations(problem_type, created_at);

CREATE TABLE IF NOT EXISTS sampling_runs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  question TEXT NOT NULL,
  problem_type TEXT,
  queries TEXT NOT NULL DEFAULT '[]',
  source_count INTEGER NOT NULL DEFAULT 0,
  domain_count INTEGER NOT NULL DEFAULT 0,
  top_domain_share REAL NOT NULL DEFAULT 0,
  dated_share REAL NOT NULL DEFAULT 0,
  strength TEXT NOT NULL DEFAULT 'none',
  degraded INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  sources TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS preferences (
  problem_type TEXT NOT NULL,
  situation_bucket TEXT NOT NULL,
  direction_name TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'weak',
  scope TEXT NOT NULL DEFAULT 'situation',
  same_direction_count INTEGER NOT NULL DEFAULT 1,
  distinct_buckets INTEGER NOT NULL DEFAULT 1,
  last_seen TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (problem_type, situation_bucket, direction_name)
);
`

export function openStore(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 3000')
  db.exec(SCHEMA)

  const insertObsSql = `INSERT INTO observations (
    id, created_at, session_id, turn, mode, question, problem_type, problem_type_other,
    situation_tags, situation_bucket, classification_by, classification_conf,
    sampling_strength, sampling_run_id, sampled_options, user_choice, user_choice_name,
    user_choice_description, user_reason, explicit_global, confidence, level_after,
    scope_after, same_direction_count
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`

  return {
    raw: db,
    dbPath,

    addObservation(row) {
      const id = row.id || randomUUID()
      const createdAt = row.created_at || new Date().toISOString()
      db.prepare(insertObsSql).run(
        id,
        createdAt,
        row.session_id ?? null,
        row.turn ?? null,
        row.mode ?? 'auto',
        row.question ?? '',
        row.problem_type ?? 'other',
        row.problem_type_other ?? null,
        JSON.stringify(row.situation_tags ?? []),
        row.situation_bucket ?? 'general',
        row.classification_by ?? 'model',
        row.classification_conf ?? 0.5,
        row.sampling_strength ?? null,
        row.sampling_run_id ?? null,
        JSON.stringify(row.sampled_options ?? []),
        row.user_choice ?? null,
        row.user_choice_name ?? null,
        row.user_choice_description ?? null,
        row.user_reason ?? null,
        row.explicit_global ? 1 : 0,
        row.confidence ?? 0.5,
        row.level_after ?? 'weak',
        row.scope_after ?? 'situation',
        row.same_direction_count ?? 1,
      )
      return { id, created_at: createdAt }
    },

    historyFor(problemType, limit = 200) {
      return db
        .prepare('SELECT * FROM observations WHERE problem_type = ? ORDER BY created_at ASC LIMIT ?')
        .all(problemType, limit)
        .map(decodeRow)
    },

    recent(limit = 20) {
      return db.prepare('SELECT * FROM observations ORDER BY created_at DESC LIMIT ?').all(limit).map(decodeRow)
    },

    addSamplingRun(run) {
      const id = run.id || randomUUID()
      db.prepare(
        `INSERT INTO sampling_runs (id, created_at, question, problem_type, queries, source_count,
          domain_count, top_domain_share, dated_share, strength, degraded, reason, sources)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        run.created_at || new Date().toISOString(),
        run.question ?? '',
        run.problem_type ?? null,
        JSON.stringify(run.queries ?? []),
        run.source_count ?? 0,
        run.domain_count ?? 0,
        run.top_domain_share ?? 0,
        run.dated_share ?? 0,
        run.strength ?? 'none',
        run.degraded ? 1 : 0,
        run.reason ?? null,
        JSON.stringify(run.sources ?? []),
      )
      return { id }
    },

    upsertPreference(p) {
      db.prepare(
        `INSERT INTO preferences (problem_type, situation_bucket, direction_name, level, scope,
           same_direction_count, distinct_buckets, last_seen, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(problem_type, situation_bucket, direction_name) DO UPDATE SET
           level = excluded.level,
           scope = excluded.scope,
           same_direction_count = excluded.same_direction_count,
           distinct_buckets = excluded.distinct_buckets,
           last_seen = excluded.last_seen,
           updated_at = excluded.updated_at`,
      ).run(
        p.problem_type,
        p.situation_bucket,
        p.direction_name,
        p.level,
        p.scope,
        p.same_direction_count ?? 1,
        p.distinct_buckets ?? 1,
        p.last_seen || new Date().toISOString(),
        new Date().toISOString(),
      )
    },

    count() {
      return db.prepare('SELECT COUNT(*) AS n FROM observations').get().n
    },

    close() {
      try {
        db.close()
      } catch {
        /* already closed */
      }
    },
  }
}

function decodeRow(row) {
  return {
    ...row,
    situation_tags: safeJson(row.situation_tags, []),
    sampled_options: safeJson(row.sampled_options, []),
    explicit_global: Boolean(row.explicit_global),
  }
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}
