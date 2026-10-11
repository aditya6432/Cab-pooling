import fs from 'node:fs';
import { pool } from './db.js';
import { HttpError } from './errors.js';
import { QUERY_FILES, loadQueries, bindParams } from './queries.js';

// Hot-reload the SQL files when any of them changes, so teammates can edit a
// query and refresh the dashboard without restarting the server.
let cache = { stamp: '', queries: new Map() };
export function queries() {
  const stamp = QUERY_FILES.map(({ file }) => fs.statSync(file).mtimeMs).join(':');
  if (stamp !== cache.stamp) cache = { stamp, queries: loadQueries() };
  return cache.queries;
}

export function getQuery(name) {
  const def = queries().get(name);
  if (!def) throw new HttpError(404, `Unknown query "${name}"`);
  return def;
}

/** Execute a named query; returns rows plus the exact SQL and timing. */
export async function runNamed(name, input = {}, client = pool) {
  const def = getQuery(name);
  const values = bindParams(def, input);
  const t0 = process.hrtime.bigint();
  const { rows } = await client.query(def.sql, values);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    name: def.name,
    module: def.module,
    title: def.title,
    concepts: def.concepts,
    sql: def.sql,
    params: def.params.map((p, i) => ({ name: p.name, type: p.type, value: values[i] })),
    ms: Math.round(ms * 10) / 10,
    rowCount: rows.length,
    rows,
  };
}

/** EXPLAIN ANALYZE a named query inside a rolled-back transaction. */
export async function explainNamed(name, input = {}) {
  const def = getQuery(name);
  const values = bindParams(def, input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, COSTS, FORMAT TEXT) ${def.sql}`, values);
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    const indexesUsed = [...new Set([...plan.matchAll(/(?:Index|Index Only|Bitmap Index) Scan(?: Backward)? (?:using|on) (\w+)/g)].map((m) => m[1]))];
    return { name, plan, indexesUsed };
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}
