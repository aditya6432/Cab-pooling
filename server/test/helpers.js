// Shared test setup. Each test FILE runs in its own process (node --test), rebuilds
// "poolup_test" from db/*.sql with the full seed, then talks to the real Express app.
import './env.js';                      // must stay the first import (sets DATABASE_URL)
import crypto from 'node:crypto';
import { app } from '../src/app.js';
import { pool } from '../src/db.js';
import { setupDatabase } from '../scripts/setup-db.js';

export { app, pool, setupDatabase };
export const TEST_URL = process.env.DATABASE_URL;
export const DEMO = '2023A7PS0001H';

// Deterministic test tokens: one login session per student, created straight in
// auth_session (only the SHA-256 of a token is ever stored, as in Member 1's auth.js).
export const tokenFor = (id) => crypto.createHash('sha256').update(`poolup-test:${String(id).trim()}`).digest('hex');
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

export async function bootTestDb() {
  const seed = await setupDatabase(TEST_URL, { log: () => {} });
  const { rows } = await pool.query('SELECT student_id FROM student');
  const ids = rows.map((r) => r.student_id.trim());
  await pool.query(
    `INSERT INTO auth_session (token_hash, student_id, expires_at)
     SELECT h, s, now() + interval '1 day' FROM unnest($1::text[], $2::text[]) AS t(h, s)`,
    [ids.map((id) => sha(tokenFor(id))), ids]);
  return seed;
}

/** supertest helper: send the request as student `who` (default: the demo student) */
export const as = (req, who = DEMO) => req.set('Authorization', `Bearer ${tokenFor(who)}`);
export const bearer = (who = DEMO) => ({ Authorization: `Bearer ${tokenFor(who)}` });

// supertest wrapper whose requests are logged in as the demo student by default;
// `as(req, who)` re-sets the header to act as somebody else.
import supertest from 'supertest';
export function authed(target) {
  const st = supertest(target);
  const wrap = (m) => (url) => st[m](url).set(bearer(DEMO));
  return { get: wrap('get'), post: wrap('post'), put: wrap('put'), delete: wrap('delete'), patch: wrap('patch') };
}
export const anonymous = (target) => supertest(target);
