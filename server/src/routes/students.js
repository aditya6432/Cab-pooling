// /api/students: search (Member 1), public profile (Member 1), reputation profile + trust network (Member 5).
// /api/meta is exported from here too: the bootstrap data every page needs (public: the register page uses it).
import { Router } from 'express';
import { pool } from '../db.js';
import { HttpError } from '../errors.js';
import { requireAuth } from '../auth.js';
import { runNamed } from '../analytics.js';

const router = Router();
router.use(requireAuth);
const sid = (v) => String(v ?? '').trim().toUpperCase();

// GET /api/students?q=  prefix search on name or BITS id (uses student_name_prefix_idx)
router.get('/', async (req, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase().replace(/[%_\\]/g, '');
  const { rows } = await pool.query(
    `SELECT s.student_id, s.full_name, h.name AS hostel FROM student s JOIN hostel h USING (hostel_id)
     WHERE lower(s.full_name) LIKE $1 || '%' OR s.student_id LIKE upper($1) || '%'
     ORDER BY s.full_name LIMIT 20`, [q]);
  res.json(rows);
});

// GET /api/students/:id  public profile (no email / phone): ride stats + upcoming rides they host
router.get('/:id', async (req, res) => {
  const id = sid(req.params.id);
  const { rows } = await pool.query(
    `SELECT st.student_id, st.full_name, st.hostel, st.rides_created, st.rides_joined
     FROM v_student_ride_stats st WHERE st.student_id = $1`, [id]);
  if (!rows.length) throw new HttpError(404, 'No such student');
  const { rows: upcoming } = await pool.query(
    `SELECT ride_id, origin, destination, depart_start, seats_left FROM v_ride_board
     WHERE creator_id = $1 AND status = 'open' AND depart_start > now() ORDER BY depart_start LIMIT 5`, [id]);
  const { rows: booking } = await pool.query(
    `SELECT bookings, self_cancelled, no_shows, trips_taken, reliability_pct FROM v_student_booking_stats WHERE student_id = $1`, [id]);
  res.json({ ...rows[0], upcoming, booking: booking[0] ?? null });
});

// GET /api/students/:id/profile  reputation: six named queries run in parallel on the pool
router.get('/:id/profile', async (req, res) => {
  const p = { student_id: sid(req.params.id) };
  const [summary, histogram, tags, reviews, given, buddies] = await Promise.all([
    runNamed('profile_summary', p), runNamed('profile_histogram', p), runNamed('profile_tags', p),
    runNamed('profile_reviews', p), runNamed('profile_given', p), runNamed('profile_buddies', p),
  ]);
  if (summary.rows.length === 0) throw new HttpError(404, `No student ${req.params.id}`);
  res.json({
    summary: summary.rows[0], histogram: histogram.rows, tags: tags.rows,
    reviews: reviews.rows, given: given.rows, buddies: buddies.rows,
    queries: Object.fromEntries([summary, histogram, tags, reviews, given, buddies]
      .map((q) => [q.name, { title: q.title, concepts: q.concepts, sql: q.sql, ms: q.ms, params: q.params }])),
  });
});

// GET /api/students/:id/network?depth=3  recursive CTE
router.get('/:id/network', async (req, res) => {
  const depth = Math.min(Math.max(parseInt(req.query.depth ?? '3', 10) || 3, 1), 4);
  res.json(await runNamed('trust_network', { student_id: sid(req.params.id), depth }));
});

// GET /api/meta  (public)
export async function meta(_req, res) {
  const [hostels, locations, cabs, tags, age, demo] = await Promise.all([
    pool.query('SELECT hostel_id, name FROM hostel ORDER BY name'),
    pool.query('SELECT location_id, name, loc_type FROM location ORDER BY loc_type, name'),
    pool.query('SELECT cab_type, max_seats, base_fare, per_km FROM cab_type ORDER BY max_seats, base_fare'),
    pool.query('SELECT tag_id, label, sentiment FROM rating_tag ORDER BY sentiment DESC, tag_id'),
    // how old is the demo data? (db:setup generates it relative to "now")
    pool.query(`SELECT FLOOR(EXTRACT(EPOCH FROM (now() - MAX(created_at))) / 86400)::int AS days FROM expense`),
    pool.query(`SELECT student_id, full_name FROM student WHERE student_id = '2023A7PS0001H'`),
  ]);
  res.json({
    hostels: hostels.rows, locations: locations.rows, cabTypes: cabs.rows, tags: tags.rows,
    windows: { ratingDays: 7, editHours: 24, paymentExpiryDays: 7, reversalHours: 72 },
    dataAgeDays: age.rows[0]?.days ?? null,
    demoLogin: demo.rows[0] ? { studentId: demo.rows[0].student_id, name: demo.rows[0].full_name, password: 'poolup123' } : null,
  });
}

export default router;
