import { Router } from 'express';
import { pool } from '../db.js';
import { HttpError } from '../errors.js';
import { hashPassword, verifyPassword, createSession, destroySession, requireAuth } from '../auth.js';

const router = Router();
const PUBLIC = `s.student_id, s.full_name, s.email, s.phone, s.hostel_id, h.name AS hostel, s.created_at`;

// POST /api/auth/register  -> every format / uniqueness rule is enforced by the DB
router.post('/register', async (req, res) => {
  const { studentId, fullName, email, phone, hostelId, password } = req.body ?? {};
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  await pool.query(
    `INSERT INTO student (student_id, full_name, email, phone, hostel_id, password_hash) VALUES ($1,$2,$3,$4,$5,$6)`,
    [studentId, fullName, email, phone, hostelId, hashPassword(password)]);
  const sid = String(studentId).trim().toUpperCase();
  const { rows } = await pool.query(`SELECT ${PUBLIC} FROM student s JOIN hostel h USING (hostel_id) WHERE s.student_id = $1`, [sid]);
  res.status(201).json({ token: await createSession(sid), student: rows[0] });
});

// POST /api/auth/login  { login: email | BITS id, password }
router.post('/login', async (req, res) => {
  const { login, password } = req.body ?? {};
  const { rows } = await pool.query(
    `SELECT ${PUBLIC}, s.password_hash FROM student s JOIN hostel h USING (hostel_id)
     WHERE s.email = lower($1) OR s.student_id = upper($1)`, [String(login ?? '').trim()]);
  const row = rows[0];
  if (!row || !verifyPassword(String(password ?? ''), row.password_hash)) throw new HttpError(401, 'Wrong ID/email or password');
  const { password_hash, ...student } = row;
  res.json({ token: await createSession(row.student_id), student });
});

router.post('/logout', requireAuth, async (req, res) => { await destroySession(req.token); res.status(204).end(); });

router.get('/me', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${PUBLIC}, st.rides_created, st.rides_joined FROM student s JOIN hostel h USING (hostel_id)
     JOIN v_student_ride_stats st USING (student_id) WHERE s.student_id = $1`, [req.studentId]);
  res.json(rows[0]);
});

// PUT /api/auth/me  (edit phone / hostel / name)
router.put('/me', requireAuth, async (req, res) => {
  const { fullName, phone, hostelId } = req.body ?? {};
  const { rows } = await pool.query(
    `UPDATE student SET full_name = COALESCE($2, full_name), phone = COALESCE($3, phone), hostel_id = COALESCE($4, hostel_id)
     WHERE student_id = $1 RETURNING student_id, full_name, phone, hostel_id`,
    [req.studentId, fullName ?? null, phone ?? null, hostelId ?? null]);
  res.json(rows[0]);
});

export default router;
