// Shared helpers for the Integrity Lab (Ratings + Payments scenarios).
import { describePgError } from '../errors.js';

// ---------- SQL display helpers ----------
export const lit = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (Array.isArray(v)) return `ARRAY[${v.map(lit).join(', ')}]::smallint[]`;
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};
// Replace $1, $2 … (and an optional ::cast after them) with literal values for display
export const show = (sql, params) => sql.replace(/\$(\d+)(::[\w()[\]]+)?/g, (_, i) => lit(params[Number(i) - 1]));

// Run one statement under a SAVEPOINT so a failure doesn't abort the
// surrounding transaction (later steps can still inspect the database).
export async function step(c, sql, params = [], extra = {}) {
  await c.query('SAVEPOINT s');
  try {
    const res = await c.query(sql, params);
    await c.query('RELEASE SAVEPOINT s');
    return { sql: show(sql, params), ok: true, rowCount: res.rowCount, rows: res.rows.slice(0, 3), ...extra };
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT s');
    const d = describePgError(err);
    if (!d) throw err;
    return { sql: show(sql, params), ok: false, error: d.body.error, ...extra };
  }
}

export const note = (sql, text) => ({ sql, ok: true, note: text });
