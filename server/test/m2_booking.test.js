// Member 2 tests: real API + real PostgreSQL. Rebuilds the database from db/*.sql + seeds first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app, pool, setupDatabase, TEST_URL as URL } from './helpers.js';
let meta, ids;
const tokens = {};
const inHours = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const loc = (n) => meta.locations.find((l) => l.name.includes(n)).location_id;
async function as(i) {                       // acting student number i (cached login)
  const id = ids[i];
  tokens[id] ??= (await request(app).post('/api/auth/login').send({ login: id, password: 'poolup123' })).body.token;
  return { id, H: { Authorization: `Bearer ${tokens[id]}` } };
}
const mkRide = async (creator, hoursAhead, o = {}) => {
  const r = await request(app).post('/api/rides').set(creator.H).send({ origin: loc('Main Gate'), dest: loc('Airport'), cab: 'auto',
    start: inHours(hoursAhead), end: inHours(hoursAhead + 1), ...o });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.ride_id;
};
const book = (who, rideId, o = {}) => request(app).post('/api/bookings').set(who.H).send({ rideId, ...o });
const occ = async (id) => (await pool.query(`SELECT * FROM v_ride_occupancy WHERE ride_id = $1`, [id])).rows[0];
const count = async (t) => (await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;

before(async () => {
  await setupDatabase(URL, { log: () => {} });
  meta = (await request(app).get('/api/meta')).body;
  ids = (await pool.query(`SELECT student_id FROM student WHERE student_id <> '2023A7PS0001H' ORDER BY student_id OFFSET 30`)).rows.map((r) => r.student_id.trim());
});
after(() => pool.end());

test('seed: every booking table is populated and seat invariants hold', async () => {
  for (const t of ['ride_member', 'booking_event', 'booking_request', 'ride_waitlist', 'ride_booking_policy']) assert.ok(await count(t) > 50, t);
  const bad = (await pool.query(`SELECT
      (SELECT count(*) FROM v_ride_occupancy WHERE status = 'open' AND seats_left <= 0)::int AS open_no_seat,
      (SELECT count(*) FROM v_ride_occupancy WHERE status = 'full' AND seats_left > 0)::int AS full_with_seat,
      (SELECT count(*) FROM v_ride_occupancy WHERE seats_left < 0)::int AS overbooked,
      (SELECT count(*) FROM ride_waitlist w JOIN ride r USING (ride_id) WHERE r.status <> 'full')::int AS waitlist_on_open`)).rows[0];
  assert.deepEqual(bad, { open_no_seat: 0, full_with_seat: 0, overbooked: 0, waitlist_on_open: 0 });
});

test('book a seat: seats drop, ride flips to full, rules reject the rest', async () => {
  const [a, b, c, d] = [await as(0), await as(1), await as(2), await as(3)];
  const rid = await mkRide(a, 700);                                   // auto = 3 seats, creator holds 1
  assert.equal((await book(b, rid)).body.outcome, 'confirmed');
  assert.equal((await occ(rid)).seats_left, 1);
  const again = await book(b, rid); assert.equal(again.status, 422); assert.equal(again.body.error.constraint, 'rule_already_member');
  const own = await book(a, rid); assert.equal(own.body.error.constraint, 'rule_own_ride');
  const big = await book(c, rid, { seats: 2 }); assert.equal(big.body.error.constraint, 'rule_seat_capacity'); assert.match(big.body.error.message, /1 left/);
  assert.equal((await book(c, rid)).body.outcome, 'confirmed');
  assert.equal((await occ(rid)).status, 'full');                      // trigger set it
  const late = await book(d, rid); assert.equal(late.body.error.constraint, 'rule_ride_full');
  const direct = await pool.query(`INSERT INTO ride_member (ride_id, student_id) VALUES ($1, $2)`, [rid, d.id]).catch((e) => e);
  assert.equal(direct.constraint, 'rule_ride_full');                  // same rule when the API is bypassed
});

test('concurrency: 6 people fight for 2 seats, exactly 2 win and nobody overbooks', async () => {
  const creator = await as(4);
  const rid = await mkRide(creator, 710, { cab: 'sedan' });
  assert.equal((await book(await as(5), rid)).body.outcome, 'confirmed');   // 2 of 4 seats left
  const riders = await Promise.all([6, 7, 8, 9, 10, 11].map(as));
  const res = await Promise.all(riders.map((r) => book(r, rid)));
  assert.equal(res.filter((r) => r.status === 201).length, 2);
  assert.ok(res.filter((r) => r.status === 422).every((r) => ['rule_ride_full', 'rule_seat_capacity'].includes(r.body.error.constraint)));
  const o = await occ(rid); assert.equal(o.seats_left, 0); assert.equal(o.status, 'full');
});

test('concurrency: one student cannot grab two overlapping rides at once', async () => {
  const [c1, c2, s] = [await as(12), await as(13), await as(14)];
  const r1 = await mkRide(c1, 720), r2 = await mkRide(c2, 720.5);     // windows overlap by 30 minutes
  const res = await Promise.all([book(s, r1), book(s, r2)]);
  assert.equal(res.filter((r) => r.status === 201).length, 1);
  assert.equal(res.find((r) => r.status !== 201).body.error.constraint, 'rule_member_overlap');
});

test('waitlist: FIFO, first-fit, auto-promotion, and joining only when needed', async () => {
  const [cr, b, c, d, e] = [await as(15), await as(16), await as(17), await as(18), await as(19)];
  const rid = await mkRide(cr, 730);
  assert.equal((await book(b, rid, { seats: 2 })).body.outcome, 'confirmed');  // full: 3/3
  assert.equal((await book(c, rid, { seats: 2, waitlist: true })).body.outcome, 'waitlisted');
  assert.equal((await book(d, rid, { waitlist: true })).body.outcome, 'waitlisted');
  assert.equal((await book(c, rid, { waitlist: true })).status, 409);          // already queued: PK
  const mine = await request(app).get('/api/bookings/mine').set(d.H);
  assert.equal(mine.body.waitlist[0].position, 2);
  const x = await request(app).post(`/api/bookings/ride/${rid}/cancel`).set(b.H);   // frees 2 seats
  assert.equal(x.body.seats_released, 2);
  const members = (await pool.query(`SELECT student_id, status FROM ride_member WHERE ride_id = $1 ORDER BY joined_at`, [rid])).rows;
  assert.deepEqual(members.filter((m) => m.status === 'confirmed').map((m) => m.student_id.trim()).sort(), [cr.id, c.id].sort());
  assert.equal((await pool.query(`SELECT count(*)::int n FROM ride_waitlist WHERE ride_id = $1`, [rid])).rows[0].n, 1);  // d is still queued: no seat fits yet
  assert.equal((await occ(rid)).status, 'full');                       // c took both freed seats; d keeps waiting
  const ev = (await pool.query(`SELECT event FROM booking_event WHERE ride_id = $1 AND student_id = $2 ORDER BY event_id`, [rid, c.id])).rows.map((r) => r.event);
  assert.deepEqual(ev, ['waitlisted', 'promoted']);
  // seats are available again -> waiting is refused by the database
  await request(app).post(`/api/bookings/ride/${rid}/cancel`).set(c.H);
  const left = await pool.query(`SELECT status FROM ride_member WHERE ride_id = $1 AND student_id = $2`, [rid, d.id]);
  assert.equal(left.rows[0].status, 'confirmed');                      // d promoted after c left
  const direct = await pool.query(`INSERT INTO ride_waitlist (ride_id, student_id) VALUES ($1, $2)`, [rid, e.id]).catch((er) => er);
  assert.equal(direct.constraint, 'rule_waitlist_not_needed');
});

test('approval mode: request, one pending per ride, only the creator decides', async () => {
  const [cr, b, c] = [await as(20), await as(21), await as(22)];
  const rid = await mkRide(cr, 740, { cab: 'sedan' });
  assert.equal((await request(app).post(`/api/bookings/ride/${rid}/policy`).set(b.H).send({ joinMode: 'approval' })).status, 403);
  assert.equal((await request(app).post(`/api/bookings/ride/${rid}/policy`).set(cr.H).send({ joinMode: 'maybe' })).body.error.constraint, 'policy_join_mode_values');
  assert.equal((await request(app).post(`/api/bookings/ride/${rid}/policy`).set(cr.H).send({ joinMode: 'approval' })).status, 200);
  assert.equal((await book(b, rid)).body.outcome, 'requested');
  assert.equal((await book(b, rid)).body.error.constraint, 'request_one_pending');
  const host = (await request(app).get('/api/bookings/hosting').set(cr.H)).body.find((r) => r.ride_id === rid);
  assert.equal(host.requests.length, 1);
  const rq = host.requests[0].request_id;
  assert.equal((await request(app).post(`/api/bookings/requests/${rq}/decide`).set(c.H).send({ accept: true })).status, 403);
  assert.equal((await request(app).post(`/api/bookings/requests/${rq}/decide`).set(cr.H).send({ accept: true })).body.decision, 'accepted');
  assert.equal((await occ(rid)).seats_left, 2);
  assert.equal((await request(app).post(`/api/bookings/requests/${rq}/decide`).set(cr.H).send({ accept: false })).body.error.constraint, 'rule_request_flow');
  assert.equal((await book(c, rid)).body.outcome, 'requested');
  const w = await request(app).get('/api/bookings/mine').set(c.H);
  assert.equal((await request(app).post(`/api/bookings/requests/${w.body.requests[0].request_id}/withdraw`).set(c.H)).status, 200);
  assert.equal((await pool.query(`SELECT status FROM booking_request WHERE request_id = $1`, [w.body.requests[0].request_id])).rows[0].status, 'withdrawn');
});

test('ride pooling: pickup / drop-off must lie on the route, in order', async () => {
  const [cr, b, c] = [await as(23), await as(24), await as(25)];
  const rid = await mkRide(cr, 750, { cab: 'sedan', stops: [loc('Ameerpet')] });
  const bad = await book(b, rid, { pickup: loc('Airport'), dropoff: loc('Main Gate') });
  assert.equal(bad.body.error.constraint, 'rule_bad_segment');
  assert.equal((await book(b, rid, { pickup: loc('Inorbit') })).body.error.constraint, 'rule_bad_segment');
  assert.equal((await book(b, rid, { pickup: loc('Ameerpet'), dropoff: loc('Ameerpet') })).status, 422);
  assert.equal((await book(b, rid, { pickup: loc('Ameerpet') })).body.outcome, 'confirmed');
  const m = (await request(app).get(`/api/bookings/ride/${rid}`).set(c.H)).body.members.find((x) => x.student_id.trim() === b.id);
  assert.equal(m.pickup, 'Ameerpet'); assert.match(m.dropoff, /Airport/);
  const pv = (await request(app).get(`/api/bookings/preview/${rid}`).query({ seats: 1 }).set(c.H)).body;
  assert.equal(pv.can, 'book'); assert.equal(pv.path.length, 3);
});

test('cancel: rider cancels, creator removes, creator seat is protected, ride cancel cascades', async () => {
  const [cr, b, c, d] = [await as(26), await as(27), await as(28), await as(29)];
  const rid = await mkRide(cr, 760, { cab: 'sedan' });
  await book(b, rid); await book(c, rid); await book(d, rid, { seats: 1 });
  assert.equal((await request(app).post(`/api/bookings/ride/${rid}/cancel`).set(cr.H)).body.error.constraint, 'rule_creator_seat_locked');
  assert.equal((await request(app).post(`/api/bookings/ride/${rid}/cancel`).set(b.H)).status, 200);
  assert.equal((await request(app).post(`/api/bookings/ride/${rid}/cancel`).set(b.H)).status, 404);   // nothing left to cancel
  assert.equal((await request(app).post(`/api/bookings/ride/${rid}/remove`).set(b.H).send({ studentId: c.id })).status, 403);
  assert.equal((await request(app).post(`/api/bookings/ride/${rid}/remove`).set(cr.H).send({ studentId: c.id })).status, 200);
  assert.equal((await book(b, rid)).body.outcome, 'confirmed');                                          // re-booking after cancelling works
  const row = (await pool.query(`SELECT status, cancelled_at, cancel_reason FROM ride_member WHERE ride_id = $1 AND student_id = $2`, [rid, c.id])).rows[0];
  assert.deepEqual([row.status, row.cancel_reason, !!row.cancelled_at], ['cancelled', 'removed', true]);
  const cancel = await request(app).post(`/api/rides/${rid}/cancel`).set(cr.H);      // Member 1's endpoint
  assert.equal(cancel.status, 200);
  const after = (await pool.query(`SELECT student_id, status, cancel_reason FROM ride_member WHERE ride_id = $1`, [rid])).rows;
  assert.equal(after.find((m) => m.student_id.trim() === cr.id).status, 'confirmed');                    // creator row stays
  assert.ok(after.filter((m) => m.student_id.trim() !== cr.id).every((m) => m.status === 'cancelled'));
  const ev = (await pool.query(`SELECT event, count(*)::int n FROM booking_event WHERE ride_id = $1 GROUP BY 1`, [rid])).rows;
  assert.ok(ev.find((e) => e.event === 'ride_cancelled').n >= 2);
  assert.equal((await book(d, rid)).body.error.constraint, 'rule_ride_not_bookable');
});

test('ride lifecycle: start, no-show, complete; M5 can rely on completed_at and member status', async () => {
  const [cr, b, c] = [await as(30), await as(31), await as(32)];
  const rid = await mkRide(cr, 770, { cab: 'sedan' });
  await book(b, rid); await book(c, rid);
  assert.equal((await request(app).post(`/api/bookings/ride/${rid}/start`).set(cr.H)).body.error.constraint, 'rule_too_early_to_depart');
  assert.equal((await request(app).post(`/api/bookings/ride/${rid}/no-show`).set(cr.H).send({ studentId: c.id })).body.error.constraint, 'rule_no_show_needs_departure');
  await pool.query(`UPDATE ride SET depart_start = now() - interval '30 minutes', depart_end = now() + interval '30 minutes' WHERE ride_id = $1`, [rid]);
  assert.equal((await request(app).post(`/api/bookings/ride/${rid}/start`).set(b.H)).status, 403);
  assert.equal((await request(app).post(`/api/bookings/ride/${rid}/start`).set(cr.H)).body.ride.ride_status, 'departed');
  assert.equal((await request(app).post(`/api/bookings/ride/${rid}/cancel`).set(b.H)).body.error.constraint, 'rule_cancel_after_departure');
  assert.equal((await book(await as(33), rid)).body.error.constraint, 'rule_ride_not_bookable');
  assert.equal((await request(app).post(`/api/bookings/ride/${rid}/no-show`).set(cr.H).send({ studentId: c.id })).status, 200);
  assert.equal((await request(app).post(`/api/bookings/ride/${rid}/complete`).set(cr.H)).body.ride.ride_status, 'completed');
  const r = (await pool.query(`SELECT status, completed_at FROM ride WHERE ride_id = $1`, [rid])).rows[0];
  assert.ok(r.completed_at);
  const st = (await pool.query(`SELECT student_id, status FROM ride_member WHERE ride_id = $1 ORDER BY student_id`, [rid])).rows.map((m) => `${m.student_id.trim()}:${m.status}`);
  assert.ok(st.includes(`${b.id}:confirmed`) && st.includes(`${c.id}:no_show`));
  const log = (await pool.query(`SELECT new_status FROM ride_status_log WHERE ride_id = $1 ORDER BY log_id`, [rid])).rows.map((x) => x.new_status);
  assert.deepEqual(log, ['full', 'departed', 'completed'].filter((s) => log.includes(s)));
  assert.ok(log.includes('departed') && log.includes('completed'));
});

test('search (Member 1) reflects bookings; full rides are listed for the waitlist', async () => {
  const [cr, b, c] = [await as(34), await as(35), await as(36)];
  const rid = await mkRide(cr, 780);
  const find = async (who) => (await request(app).get('/api/rides/search').query({ origin: loc('Main Gate'), dest: loc('Airport'), from: inHours(779), to: inHours(782) }).set(who.H)).body.rows.find((r) => r.ride_id === rid);
  assert.equal((await find(c)).seats_left, 2);
  await book(b, rid, { seats: 2 });
  assert.equal(await find(c), undefined);                              // full rides leave the search results
  const full = (await request(app).get('/api/bookings/full').query({ origin: loc('Main Gate'), dest: loc('Airport') }).set(c.H)).body;
  assert.ok(full.some((r) => r.ride_id === rid));
  assert.equal((await book(c, rid, { waitlist: true })).body.outcome, 'waitlisted');
  const ev = (await request(app).get('/api/bookings/events').set(cr.H)).body;
  assert.ok(ev.onMyRides.some((e) => e.event === 'waitlisted' && e.ride_id === rid));
  assert.ok((await request(app).get('/api/bookings/events').set(c.H)).body.mine.some((e) => e.event === 'waitlisted'));
});

test('rule check: constraints still guard direct SQL', async () => {
  const [cr, b] = [await as(37), await as(38)];
  const rid = await mkRide(cr, 790, { cab: 'sedan' });
  const e1 = await pool.query(`INSERT INTO ride_member (ride_id, student_id, status) VALUES ($1, $2, 'waiting')`, [rid, b.id]).catch((e) => e);
  assert.equal(e1.constraint, 'member_status_values');
  const e2 = await pool.query(`INSERT INTO ride_member (ride_id, student_id, seats_taken) VALUES ($1, $2, 9)`, [rid, b.id]).catch((e) => e);
  assert.ok(['member_seats_range', 'rule_seat_capacity'].includes(e2.constraint));
  const e3 = await pool.query(`UPDATE booking_event SET event = 'booked' WHERE event_id = (SELECT min(event_id) FROM booking_event)`).catch((e) => e);
  assert.equal(e3.constraint, 'rule_event_immutable');
});

test('booking insights: every named query runs; EXPLAIN works', async () => {
  const { id, H } = await as(39); void id;
  const list = (await request(app).get('/api/analytics?module=booking').set(H)).body;
  assert.equal(list.length, 11);
  for (const q of list) {
    const r = await request(app).get(`/api/analytics/${q.name}`).set(H);
    assert.equal(r.status, 200, q.name); assert.ok(Array.isArray(r.body.rows));
  }
  const ex = await request(app).get('/api/analytics/fill_by_route/explain').set(H);
  assert.ok(ex.body.plan.includes('Execution Time'));
});

test('integrity lab: every scenario behaves as documented and nothing persists', async () => {
  const { H } = await as(40);
  const tables = ['ride', 'ride_member', 'ride_stop', 'ride_waitlist', 'booking_request', 'booking_event', 'ride_booking_policy', 'ride_status_log'];
  const before = await Promise.all(tables.map(count));
  const list = (await request(app).get('/api/lab/scenarios?module=booking').set(H)).body;
  assert.ok(list.length >= 18);
  for (const s of list) {
    const r = (await request(app).post(`/api/lab/scenarios/${s.id}/run`).set(H)).body;
    assert.ok(r.passed, `${s.id}: ${JSON.stringify(r)}`);
  }
  assert.deepEqual(await Promise.all(tables.map(count)), before);
});
