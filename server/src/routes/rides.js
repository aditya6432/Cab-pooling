import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { HttpError } from '../errors.js';
import { requireAuth } from '../auth.js';

const router = Router();
const int = (v) => (v === undefined || v === null || v === '' ? null : Number.parseInt(v, 10));
const ts = (v) => (v ? v : null);

// GET /api/rides/estimate?origin=&dest=&cab=&stops=1,2  -> distance + fare
router.get('/estimate', requireAuth, async (req, res) => {
  const stops = String(req.query.stops ?? '').split(',').filter(Boolean).map(Number);
  const { rows } = await pool.query(
    `SELECT fn_route_km($1, $2, $3::int[]) AS distance_km,
            fn_estimate_fare($4, fn_route_km($1, $2, $3::int[])) AS fare_total,
            (SELECT max_seats FROM cab_type WHERE cab_type = $4) AS max_seats`,
    [int(req.query.origin), int(req.query.dest), stops, req.query.cab]);
  res.json(rows[0]);
});

// GET /api/rides/search?origin=&dest=&from=&to=&seats=&cab=&all=1
router.get('/search', requireAuth, async (req, res) => {
  const q = req.query;
  const t0 = performance.now();
  const { rows } = await pool.query(
    `SELECT * FROM fn_search_rides($1, $2, $3, $4, $5, $6, $7)`,
    [int(q.origin), int(q.dest), ts(q.from), ts(q.to), int(q.seats) ?? 1, q.cab || null, q.all ? null : req.studentId]);
  res.json({ rows, ms: Math.round((performance.now() - t0) * 10) / 10,
    sql: 'SELECT * FROM fn_search_rides(origin, dest, from, to, seats, cab, exclude_me)' });
});

// GET /api/rides/mine  rides I created or joined
router.get('/mine', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.*, (b.creator_id = $1) AS is_creator,
            COALESCE((SELECT array_agg(l.name ORDER BY s.stop_seq) FROM ride_stop s JOIN location l USING (location_id)
                       WHERE s.ride_id = b.ride_id), '{}') AS stops
     FROM v_ride_board b
     WHERE EXISTS (SELECT 1 FROM ride_member m WHERE m.ride_id = b.ride_id AND m.student_id = $1 AND m.status = 'confirmed')
     ORDER BY b.depart_start DESC LIMIT 50`, [req.studentId]);
  res.json(rows);
});

// POST /api/rides  { origin, dest, cab, start, end, stops?, note? }  atomic via fn_create_ride
router.post('/', requireAuth, async (req, res) => {
  const b = req.body ?? {};
  const id = await withTransaction(async (c) => {
    const { rows } = await c.query(
      `SELECT fn_create_ride($1, $2, $3, $4, $5, $6, $7::int[], $8) AS ride_id`,
      [req.studentId, int(b.origin), int(b.dest), b.cab, b.start, b.end,
       (b.stops ?? []).map(Number), b.note ?? null]);
    return rows[0].ride_id;
  });
  res.status(201).json(await detail(id));
});

async function detail(id) {
  const { rows } = await pool.query(
    `SELECT r.ride_id, r.status, r.depart_start, r.depart_end, r.distance_km, r.cab_type, r.note,
            r.creator_id, s.full_name AS creator_name, lo.name AS origin, ld.name AS destination,
            fn_seats_left(r.ride_id) AS seats_left, c.max_seats,
            fn_estimate_fare(r.cab_type, r.distance_km) AS fare_total
     FROM ride r JOIN student s ON s.student_id = r.creator_id
     JOIN location lo ON lo.location_id = r.origin_id JOIN location ld ON ld.location_id = r.dest_id
     JOIN cab_type c USING (cab_type) WHERE r.ride_id = $1`, [id]);
  if (!rows.length) return null;
  const [stops, members, log] = await Promise.all([
    pool.query(`SELECT s.stop_seq, l.name FROM ride_stop s JOIN location l USING (location_id) WHERE s.ride_id = $1 ORDER BY 1`, [id]),
    pool.query(`SELECT st.student_id, st.full_name, m.seats_taken FROM ride_member m JOIN student st USING (student_id)
                WHERE m.ride_id = $1 AND m.status = 'confirmed' ORDER BY m.joined_at`, [id]),
    pool.query(`SELECT old_status, new_status, changed_at FROM ride_status_log WHERE ride_id = $1 ORDER BY log_id`, [id]),
  ]);
  return { ...rows[0], stops: stops.rows, members: members.rows, history: log.rows };
}

// GET /api/rides/:id
router.get('/:id', requireAuth, async (req, res) => {
  const d = await detail(int(req.params.id));
  if (!d) throw new HttpError(404, 'No such ride');
  res.json(d);
});

// POST /api/rides/:id/cancel  (creator only; the state machine lives in a trigger)
router.post('/:id/cancel', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE ride SET status = 'cancelled' WHERE ride_id = $1 AND creator_id = $2 RETURNING ride_id`,
    [int(req.params.id), req.studentId]);
  if (!rows.length) throw new HttpError(403, 'Only the creator of a ride can cancel it');
  res.json(await detail(rows[0].ride_id));
});

export default router;
