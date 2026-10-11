// Member 2: booking + ride pooling / seat management API.
// Every business rule is enforced by PostgreSQL (constraints, triggers and stored functions in
// db/12_booking_schema.sql + db/25_booking_logic.sql). This file only calls those functions and
// shapes the JSON; failures are translated by errors.js into rule ids.
import { Router } from 'express';
import { pool } from '../db.js';
import { HttpError } from '../errors.js';
import { requireAuth } from '../auth.js';

const router = Router();
const int = (v) => (v === undefined || v === null || v === '' ? null : Number.parseInt(v, 10));
const bool = (v) => v === true || v === 'true' || v === '1' || v === 1;

// ---------- shared SQL fragments (alias o = v_ride_occupancy) ----------
const RIDE_COLS = `o.ride_id, o.status AS ride_status, o.creator_id, o.depart_start, o.depart_end, o.cab_type, o.max_seats,
  o.seats_taken, o.seats_left, o.riders, o.waitlist_size, o.pending_requests, o.join_mode, o.fill_pct,
  r.distance_km, r.note, lo.name AS origin, ld.name AS destination, cs.full_name AS creator_name,
  COALESCE((SELECT array_agg(l.name ORDER BY s.stop_seq) FROM ride_stop s JOIN location l USING (location_id)
             WHERE s.ride_id = o.ride_id), '{}') AS stops,
  fn_estimate_fare(r.cab_type, r.distance_km) AS fare_total,
  round(fn_estimate_fare(r.cab_type, r.distance_km) / GREATEST(o.seats_taken, 1), 2) AS fare_per_head_now`;
const RIDE_REST = `JOIN ride r ON r.ride_id = o.ride_id
  JOIN location lo ON lo.location_id = r.origin_id JOIN location ld ON ld.location_id = r.dest_id
  JOIN student cs ON cs.student_id = r.creator_id`;

async function occupancy(rideId) {
  const { rows } = await pool.query(`SELECT ${RIDE_COLS} FROM v_ride_occupancy o ${RIDE_REST} WHERE o.ride_id = $1`, [rideId]);
  return rows[0] ?? null;
}
const manifest = (ids) => pool.query(
  `SELECT ride_id, student_id, full_name, hostel, seats_taken, status, is_creator, pickup, dropoff, joined_at, cancelled_at, cancel_reason
   FROM v_ride_manifest WHERE ride_id = ANY($1::int[]) ORDER BY is_creator DESC, joined_at`, [ids]);
const pendingRequests = (ids) => pool.query(
  `SELECT q.request_id, q.ride_id, q.student_id, s.full_name, h.name AS hostel, q.seats, q.message, q.created_at,
          lp.name AS pickup, ld.name AS dropoff
   FROM booking_request q JOIN student s USING (student_id) JOIN hostel h ON h.hostel_id = s.hostel_id
   JOIN ride r ON r.ride_id = q.ride_id
   JOIN location lp ON lp.location_id = COALESCE(q.pickup_id, r.origin_id) JOIN location ld ON ld.location_id = COALESCE(q.dropoff_id, r.dest_id)
   WHERE q.ride_id = ANY($1::int[]) AND q.status = 'pending' ORDER BY q.created_at`, [ids]);
const waitlistOf = (ids) => pool.query(
  `SELECT ride_id, student_id, full_name, seats, position, joined_at FROM v_waitlist_position WHERE ride_id = ANY($1::int[]) ORDER BY ride_id, position`, [ids]);
const group = (rows) => rows.reduce((m, r) => ((m[r.ride_id] ||= []).push(r), m), {});

// ---------- GET /api/bookings/preview/:id?seats=&pickup=&dropoff= : what would happen if I tried ----------
router.get('/preview/:id', requireAuth, async (req, res) => {
  const id = int(req.params.id), seats = int(req.query.seats) ?? 1, me = req.studentId;
  const ride = await occupancy(id);
  if (!ride) throw new HttpError(404, 'No such ride');
  const [path, mine, clash] = await Promise.all([
    pool.query(`SELECT seq, location_id, name FROM fn_ride_path($1)`, [id]),
    pool.query(`SELECT (SELECT status FROM ride_member WHERE ride_id = $1 AND student_id = $2) AS member_status,
                       (SELECT position FROM v_waitlist_position WHERE ride_id = $1 AND student_id = $2) AS waitlist_position,
                       (SELECT request_id FROM booking_request WHERE ride_id = $1 AND student_id = $2 AND status = 'pending') AS pending_request`, [id, me]),
    pool.query(`SELECT r.ride_id, lo.name AS origin, ld.name AS destination, r.depart_start
                FROM ride_member m JOIN ride r USING (ride_id)
                JOIN location lo ON lo.location_id = r.origin_id JOIN location ld ON ld.location_id = r.dest_id
                WHERE m.student_id = $2 AND m.status = 'confirmed' AND m.ride_id <> $1 AND r.status IN ('open','full','departed')
                  AND r.depart_start < (SELECT depart_end FROM ride WHERE ride_id = $1)
                  AND r.depart_end   > (SELECT depart_start FROM ride WHERE ride_id = $1) LIMIT 1`, [id, me]),
  ]);
  const m = mine.rows[0];
  let can = 'book', reason = null;
  if (ride.creator_id === me) { can = 'none'; reason = 'This is your own ride.'; }
  else if (['confirmed', 'no_show'].includes(m.member_status)) { can = 'none'; reason = 'You already have a seat on this ride.'; }
  else if (m.pending_request) { can = 'none'; reason = 'Your request is waiting for the creator.'; }
  else if (m.waitlist_position) { can = 'none'; reason = `You are number ${m.waitlist_position} on the waitlist.`; }
  else if (!['open', 'full'].includes(ride.ride_status)) { can = 'none'; reason = `This ride is ${ride.ride_status}.`; }
  else if (new Date(ride.depart_end) <= new Date()) { can = 'none'; reason = 'Booking closed: the departure window has ended.'; }
  else if (ride.seats_left < seats) can = 'waitlist';
  else if (ride.join_mode === 'approval') can = 'request';
  res.json({ ride, path: path.rows, my: m, can, reason, overlap: clash.rows[0] ?? null,
    fare_per_head_if_join: Math.round((ride.fare_total / (ride.seats_taken + seats)) * 100) / 100 });
});

// ---------- POST /api/bookings  { rideId, seats, pickup?, dropoff?, message?, waitlist? } ----------
router.post('/', requireAuth, async (req, res) => {
  const b = req.body ?? {};
  const { rows } = await pool.query(`SELECT fn_book_seat($1, $2, $3, $4, $5, $6, $7) AS outcome`,
    [req.studentId, int(b.rideId), int(b.seats) ?? 1, int(b.pickup), int(b.dropoff), b.message ?? null, bool(b.waitlist)]);
  res.status(201).json({ outcome: rows[0].outcome, ride: await occupancy(int(b.rideId)) });
});

// ---------- GET /api/bookings/mine ----------
router.get('/mine', requireAuth, async (req, res) => {
  const me = req.studentId;
  const [bookings, requests, waitlist, stats] = await Promise.all([
    pool.query(`SELECT m.status AS booking_status, m.seats_taken AS my_seats, m.joined_at, m.cancelled_at, m.cancel_reason,
                       COALESCE(pl.name, lo.name) AS pickup, COALESCE(dl.name, ld.name) AS dropoff, ${RIDE_COLS}
                FROM ride_member m JOIN v_ride_occupancy o ON o.ride_id = m.ride_id ${RIDE_REST}
                LEFT JOIN location pl ON pl.location_id = m.pickup_id LEFT JOIN location dl ON dl.location_id = m.dropoff_id
                WHERE m.student_id = $1 AND r.creator_id <> $1 ORDER BY r.depart_start DESC LIMIT 60`, [me]),
    pool.query(`SELECT q.request_id, q.status AS request_status, q.seats AS my_seats, q.message, q.created_at, q.decided_at, ${RIDE_COLS}
                FROM booking_request q JOIN v_ride_occupancy o ON o.ride_id = q.ride_id ${RIDE_REST}
                WHERE q.student_id = $1 ORDER BY q.created_at DESC LIMIT 30`, [me]),
    pool.query(`SELECT w.position, w.seats AS my_seats, w.joined_at AS waiting_since, ${RIDE_COLS}
                FROM v_waitlist_position w JOIN v_ride_occupancy o ON o.ride_id = w.ride_id ${RIDE_REST}
                WHERE w.student_id = $1 ORDER BY r.depart_start`, [me]),
    pool.query(`SELECT bookings, self_cancelled, no_shows, trips_taken, reliability_pct FROM v_student_booking_stats WHERE student_id = $1`, [me]),
  ]);
  res.json({ bookings: bookings.rows, requests: requests.rows, waitlist: waitlist.rows, stats: stats.rows[0] });
});

// ---------- GET /api/bookings/hosting : rides I created, with manifest / inbox / waitlist ----------
router.get('/hosting', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${RIDE_COLS} FROM v_ride_occupancy o ${RIDE_REST}
     WHERE o.creator_id = $1 AND (o.status IN ('open','full','departed') OR (o.status = 'completed' AND o.depart_start > now() - interval '7 days'))
     ORDER BY o.depart_start LIMIT 30`, [req.studentId]);
  const ids = rows.map((r) => r.ride_id);
  const [mf, rq, wl] = await Promise.all([manifest(ids), pendingRequests(ids), waitlistOf(ids)]);
  const M = group(mf.rows), Q = group(rq.rows), W = group(wl.rows);
  res.json(rows.map((r) => ({ ...r,
    members: (M[r.ride_id] || []).filter((m) => ['confirmed', 'no_show'].includes(m.status)),
    requests: Q[r.ride_id] || [], waitlist: W[r.ride_id] || [] })));
});

// ---------- GET /api/bookings/full?origin=&dest= : full rides still open to the waitlist ----------
router.get('/full', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${RIDE_COLS}, (SELECT position FROM v_waitlist_position w WHERE w.ride_id = o.ride_id AND w.student_id = $3) AS my_position
     FROM v_ride_occupancy o ${RIDE_REST}
     WHERE o.status = 'full' AND o.depart_end > now() AND o.creator_id <> $3
       AND NOT EXISTS (SELECT 1 FROM ride_member m WHERE m.ride_id = o.ride_id AND m.student_id = $3 AND m.status IN ('confirmed','no_show'))
       AND EXISTS (SELECT 1 FROM fn_ride_path(o.ride_id) a JOIN fn_ride_path(o.ride_id) b ON b.seq > a.seq
                    WHERE ($1::int IS NULL OR a.location_id = $1) AND ($2::int IS NULL OR b.location_id = $2))
     ORDER BY o.depart_start LIMIT 30`, [int(req.query.origin), int(req.query.dest), req.studentId]);
  res.json(rows);
});

// ---------- GET /api/bookings/ride/:id : seat map of one ride ----------
router.get('/ride/:id', requireAuth, async (req, res) => {
  const id = int(req.params.id);
  const ride = await occupancy(id);
  if (!ride) throw new HttpError(404, 'No such ride');
  const isCreator = ride.creator_id === req.studentId;
  const [mf, path] = await Promise.all([manifest([id]), pool.query(`SELECT seq, location_id, name FROM fn_ride_path($1)`, [id])]);
  const out = { ride, path: path.rows, is_creator: isCreator,
    members: mf.rows.filter((m) => ['confirmed', 'no_show'].includes(m.status)) };
  if (isCreator) {
    const [rq, wl] = await Promise.all([pendingRequests([id]), waitlistOf([id])]);
    Object.assign(out, { requests: rq.rows, waitlist: wl.rows, cancelled: mf.rows.filter((m) => m.status === 'cancelled') });
  }
  res.json(out);
});

// ---------- cancel my booking / leave the waitlist / withdraw a request ----------
router.post('/ride/:id/cancel', requireAuth, async (req, res) => {
  const id = int(req.params.id);
  const { rows } = await pool.query(`SELECT fn_cancel_booking($1, $2) AS seats_released`, [req.studentId, id]);
  res.json({ ...rows[0], ride: await occupancy(id) });
});
router.post('/ride/:id/waitlist/leave', requireAuth, async (req, res) => {
  await pool.query(`SELECT fn_leave_waitlist($1, $2)`, [req.studentId, int(req.params.id)]);
  res.json({ ok: true });
});
router.post('/requests/:id/withdraw', requireAuth, async (req, res) => {
  await pool.query(`SELECT fn_withdraw_request($1, $2)`, [req.studentId, int(req.params.id)]);
  res.json({ ok: true });
});

// ---------- creator tools ----------
router.post('/requests/:id/decide', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT fn_decide_request($1, $2, $3) AS decision`, [req.studentId, int(req.params.id), bool(req.body?.accept)]);
  res.json(rows[0]);
});
router.post('/ride/:id/remove', requireAuth, async (req, res) => {
  await pool.query(`SELECT fn_remove_rider($1, $2, $3)`, [req.studentId, int(req.params.id), req.body?.studentId]);
  res.json({ ok: true, ride: await occupancy(int(req.params.id)) });
});
router.post('/ride/:id/policy', requireAuth, async (req, res) => {
  await pool.query(`SELECT fn_set_join_mode($1, $2, $3)`, [req.studentId, int(req.params.id), req.body?.joinMode]);
  res.json({ ok: true, ride: await occupancy(int(req.params.id)) });
});
router.post('/ride/:id/start', requireAuth, async (req, res) => {
  await pool.query(`SELECT fn_start_ride($1, $2)`, [req.studentId, int(req.params.id)]);
  res.json({ ok: true, ride: await occupancy(int(req.params.id)) });
});
router.post('/ride/:id/complete', requireAuth, async (req, res) => {
  await pool.query(`SELECT fn_complete_ride($1, $2)`, [req.studentId, int(req.params.id)]);
  res.json({ ok: true, ride: await occupancy(int(req.params.id)) });
});
router.post('/ride/:id/no-show', requireAuth, async (req, res) => {
  await pool.query(`SELECT fn_mark_no_show($1, $2, $3)`, [req.studentId, int(req.params.id), req.body?.studentId]);
  res.json({ ok: true, ride: await occupancy(int(req.params.id)) });
});

// ---------- GET /api/bookings/events : my notification feed + what happened on my rides ----------
router.get('/events', requireAuth, async (req, res) => {
  const base = `SELECT e.event_id, e.event, e.seats, e.created_at, e.ride_id, e.student_id, s.full_name, lo.name AS origin, ld.name AS destination, r.depart_start
                FROM booking_event e JOIN ride r USING (ride_id) JOIN student s ON s.student_id = e.student_id
                JOIN location lo ON lo.location_id = r.origin_id JOIN location ld ON ld.location_id = r.dest_id`;
  const [mine, onMine] = await Promise.all([
    pool.query(`${base} WHERE e.student_id = $1 ORDER BY e.created_at DESC, e.event_id DESC LIMIT 40`, [req.studentId]),
    pool.query(`${base} WHERE r.creator_id = $1 AND e.student_id <> $1 ORDER BY e.created_at DESC, e.event_id DESC LIMIT 40`, [req.studentId]),
  ]);
  res.json({ mine: mine.rows, onMyRides: onMine.rows });
});

export default router;
