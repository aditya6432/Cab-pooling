// Password hashing (scrypt) + opaque session tokens. Only SHA-256(token) is stored.
import crypto from 'node:crypto';
import { pool } from './db.js';
import { HttpError } from './errors.js';

export const hashPassword = (pw) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
};
export const verifyPassword = (pw, stored) => {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex'), b = crypto.scryptSync(pw, salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

export async function createSession(studentId, days = 7) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO auth_session (token_hash, student_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [sha(token), studentId, days]);
  return token;
}
export const destroySession = (token) => pool.query('DELETE FROM auth_session WHERE token_hash = $1', [sha(token)]);

/** Express middleware: sets req.studentId from  Authorization: Bearer <token>  (401 otherwise). */
export async function requireAuth(req, _res, next) {
  try {
    const m = /^Bearer (\w{64})$/.exec(req.get('authorization') || '');
    if (!m) throw new HttpError(401, 'Please log in');
    const { rows } = await pool.query(
      'SELECT student_id FROM auth_session WHERE token_hash = $1 AND expires_at > now()', [sha(m[1])]);
    if (!rows.length) throw new HttpError(401, 'Session expired, please log in again');
    req.studentId = rows[0].student_id.trim();
    req.token = m[1];
    next();
  } catch (e) { next(e); }
}
// Drop-in for the Ratings module: actingStudent(req) -> student id
export const actingStudent = (req) => req.studentId;
