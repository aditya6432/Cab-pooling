import 'dotenv/config';
import pg from 'pg';

// Return COUNT(*) / bigint and NUMERIC as JS numbers (safe at this scale),
// and DATE as a plain 'YYYY-MM-DD' string (no timezone shifting).
pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));     // int8
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));     // numeric
pg.types.setTypeParser(1082, (v) => v);                                        // date

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/poolup',
  max: 10,
});

/** Run fn(client) inside BEGIN … COMMIT; ROLLBACK on any error. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Run fn(client) inside a transaction that is ALWAYS rolled back (sandbox). */
export async function inSandbox(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}
