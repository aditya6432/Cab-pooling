// Member 1 (Users + Ride creation / search): end-to-end tests through the real API + PostgreSQL.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app, pool, setupDatabase, TEST_URL as URL } from './helpers.js';
let tok, tok2, meta;
const A = () => ({ Authorization: `Bearer ${tok}` });
const B = () => ({ Authorization: `Bearer ${tok2}` });
const inHours = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const loc = (n) => meta.locations.find((l) => l.name.includes(n)).location_id;

before(async () => {
  await setupDatabase(URL, { log: () => {} });
  meta = (await request(app).get('/api/meta')).body;
  tok = (await request(app).post('/api/auth/login').send({ login: '2023A7PS0001H', password: 'poolup123' })).body.token;
  const other = (await pool.query(`SELECT student_id FROM student WHERE student_id <> '2023A7PS0001H' LIMIT 1`)).rows[0].student_id;
  tok2 = (await request(app).post('/api/auth/login').send({ login: other, password: 'poolup123' })).body.token;
});
after(() => pool.end());

const ride = (o = {}) => ({ origin: loc('Main Gate'), dest: loc('Airport'), cab: 'sedan', start: inHours(500), end: inHours(501), ...o });

test('seed has 500+ rows and every table is populated', async () => {
  const { rows } = await pool.query(`SELECT (SELECT count(*) FROM ride)::int r, (SELECT count(*) FROM student)::int s, (SELECT count(*) FROM ride_stop)::int st`);
  assert.ok(rows[0].r >= 500 && rows[0].s >= 100 && rows[0].st > 0);
});

test('registration: valid -> 201 + token; DB rules reject bad data', async () => {
  const good = { studentId: '2024A7PS0999H', fullName: '  Test   User ', email: 'f20240999@hyderabad.bits-pilani.ac.in', phone: '9876501234', hostelId: meta.hostels[0].hostel_id, password: 'longenough1' };
  const ok = await request(app).post('/api/auth/register').send(good);
  assert.equal(ok.status, 201); assert.equal(ok.body.student.full_name, 'Test User');   // trigger normalised spaces
  const dup = await request(app).post('/api/auth/register').send(good);
  assert.equal(dup.status, 409);
  const badEmail = await request(app).post('/api/auth/register').send({ ...good, studentId: '2024A7PS0998H', phone: '9876501235', email: 'x@gmail.com' });
  assert.equal(badEmail.status, 422); assert.equal(badEmail.body.error.constraint, 'student_email_domain');
  const badId = await request(app).post('/api/auth/register').send({ ...good, studentId: 'ABC', email: 'a@hyderabad.bits-pilani.ac.in' });
  assert.equal(badId.status, 422);
  const badPhone = await request(app).post('/api/auth/register').send({ ...good, studentId: '2024A7PS0997H', email: 'b@hyderabad.bits-pilani.ac.in', phone: '1234567890' });
  assert.equal(badPhone.body.error.constraint, 'student_phone_format');
});

test('login: wrong password 401, /me needs a token', async () => {
  assert.equal((await request(app).post('/api/auth/login').send({ login: '2023A7PS0001H', password: 'nope' })).status, 401);
  assert.equal((await request(app).get('/api/auth/me')).status, 401);
  const me = await request(app).get('/api/auth/me').set(A());
  assert.equal(me.body.full_name, 'Aarav Mehta');
});

test('create ride: success returns fare, seats and the creator as first member', async () => {
  const r = await request(app).post('/api/rides').set(A()).send(ride({ stops: [loc('Ameerpet')], note: ' bring ID ' }));
  assert.equal(r.status, 201);
  assert.equal(r.body.members.length, 1); assert.equal(r.body.seats_left, 3);
  assert.equal(r.body.stops[0].name, 'Ameerpet'); assert.equal(r.body.note, 'bring ID');
  assert.ok(r.body.distance_km > 20 && r.body.fare_total > 80);
});

test('create ride: every rule is rejected by the database', async () => {
  const cases = [
    [ride({ dest: loc('Main Gate'), start: inHours(1400), end: inHours(1401) }), 'ride_distance_km_check'],
    [ride({ start: inHours(600), end: inHours(599) }), 'ride_window_valid'],
    [ride({ start: inHours(700), end: inHours(705) }), 'ride_window_max_3h'],
    [ride({ start: inHours(0.1), end: inHours(1) }), 'rule_ride_in_future'],
    [ride({ start: inHours(24 * 90), end: inHours(24 * 90 + 1) }), 'rule_ride_horizon'],
    [ride({ cab: 'rocket', start: inHours(800), end: inHours(801) }), 'ride_cab_type_fkey'],
    [ride({ stops: [loc('Airport')], start: inHours(810), end: inHours(811) }), 'rule_stop_not_endpoint'],
    [ride({ stops: [loc('Ameerpet'), loc('Ameerpet')], start: inHours(820), end: inHours(821) }), 'ride_stop_unique_location'],
    [ride({ stops: [loc('GVK'), loc('Inorbit'), loc('Hitech'), loc('Kacheguda')], start: inHours(830), end: inHours(831) }), 'ride_stop_stop_seq_check'],
  ];
  for (const [body, constraint] of cases) {
    const r = await request(app).post('/api/rides').set(A()).send(body);
    assert.ok(r.status >= 400 && r.status < 500, `${constraint}: got ${r.status}`);
    assert.equal(r.body.error.constraint, constraint);
  }
});

test('overlap rule + atomic rollback: failed ride leaves no orphan rows', async () => {
  const before = (await pool.query('SELECT count(*)::int c FROM ride')).rows[0].c;
  const s = inHours(900);
  const ok = await request(app).post('/api/rides').set(A()).send(ride({ start: s, end: inHours(901) }));
  assert.equal(ok.status, 201);
  const clash = await request(app).post('/api/rides').set(A()).send(ride({ start: inHours(900.5), end: inHours(902), dest: loc('Secunderabad') }));
  assert.equal(clash.body.error.constraint, 'rule_no_overlap');
  assert.equal((await pool.query('SELECT count(*)::int c FROM ride')).rows[0].c, before + 1);
});

test('concurrent creates by the same student: exactly one wins (row lock)', async () => {
  const res = await Promise.all([1, 2, 3, 4].map((i) =>
    request(app).post('/api/rides').set(B()).send(ride({ start: inHours(1000), end: inHours(1001), dest: loc('GVK') }))));
  assert.equal(res.filter((r) => r.status === 201).length, 1);
  assert.equal(res.filter((r) => r.body?.error?.constraint === 'rule_no_overlap').length, 3);
});

test('search: finds the rides just created, incl. via-stop sub-route, respects seats and exclusion', async () => {
  const direct = await request(app).get('/api/rides/search').set(B()).query({ origin: loc('Main Gate'), dest: loc('Airport'), from: inHours(498), to: inHours(503) });
  assert.ok(direct.body.rows.some((r) => r.creator_id.trim() === '2023A7PS0001H' && r.exact_route));
  const sub = await request(app).get('/api/rides/search').set(B()).query({ origin: loc('Main Gate'), dest: loc('Ameerpet'), from: inHours(498), to: inHours(503) });
  assert.ok(sub.body.rows.length >= 1 && sub.body.rows.every((r) => !r.exact_route || r.dest_name === 'Ameerpet'));
  const wrongOrder = await request(app).get('/api/rides/search').set(B()).query({ origin: loc('Ameerpet'), dest: loc('Main Gate'), from: inHours(498), to: inHours(503) });
  assert.ok(!wrongOrder.body.rows.some((r) => r.creator_id.trim() === '2023A7PS0001H' && r.stops.includes('Ameerpet')));
  const mine = await request(app).get('/api/rides/search').set(A()).query({ origin: loc('Main Gate'), dest: loc('Airport'), from: inHours(498), to: inHours(503) });
  assert.ok(!mine.body.rows.some((r) => r.creator_id.trim() === '2023A7PS0001H'));
  const tooMany = await request(app).get('/api/rides/search').set(B()).query({ seats: 6, cab: 'sedan' });
  assert.equal(tooMany.body.rows.length, 0);
});

test('cancel: creator only, state machine blocks cancelled -> open', async () => {
  const r = await request(app).post('/api/rides').set(A()).send(ride({ start: inHours(1200), end: inHours(1201) }));
  assert.equal((await request(app).post(`/api/rides/${r.body.ride_id}/cancel`).set(B())).status, 403);
  const c = await request(app).post(`/api/rides/${r.body.ride_id}/cancel`).set(A());
  assert.equal(c.body.status, 'cancelled'); assert.equal(c.body.history.at(-1).new_status, 'cancelled');
  await assert.rejects(pool.query(`UPDATE ride SET status = 'open' WHERE ride_id = $1`, [r.body.ride_id]), { constraint: 'rule_ride_status_flow' });
  await assert.rejects(pool.query(`UPDATE ride SET dest_id = origin_id + 1 WHERE ride_id = $1`, [r.body.ride_id]), { constraint: 'rule_ride_core_immutable' });
});

test('insights: every named query of the module runs', async () => {
  const list = (await request(app).get('/api/analytics?module=users-rides').set(A())).body;
  assert.ok(list.length >= 8);
  for (const q of list) {
    const r = await request(app).get(`/api/analytics/${q.name}`).set(A());
    assert.equal(r.status, 200, q.name); assert.ok(r.body.rows.length > 0, `${q.name} returned no rows`);
  }
});

test('ride_distinct_endpoints CHECK also guards direct SQL inserts', async () => {
  await assert.rejects(pool.query(
    `INSERT INTO ride (creator_id, origin_id, dest_id, cab_type, depart_start, depart_end, distance_km)
     VALUES ('2023A7PS0001H', 1, 1, 'mini', now() + interval '40 days', now() + interval '40 days 1 hour', 5)`),
    { constraint: 'ride_distinct_endpoints' });
});

test('integrity lab: every scenario behaves as documented and nothing persists', async () => {
  const before = (await pool.query('SELECT (SELECT count(*) FROM ride)::int r, (SELECT count(*) FROM student)::int s, (SELECT count(*) FROM ride_stop)::int st')).rows[0];
  const list = (await request(app).get('/api/lab/scenarios?module=users-rides').set(A())).body;
  assert.ok(list.length >= 12);
  for (const sc of list) {
    const r = await request(app).post(`/api/lab/scenarios/${sc.id}/run`).set(A());
    assert.equal(r.status, 200);
    assert.equal(r.body.passed, true, `${sc.id}: expected ${sc.expectConstraint}, got ${r.body.error?.constraint} (${r.body.error?.dbMessage})`);
  }
  const after = (await pool.query('SELECT (SELECT count(*) FROM ride)::int r, (SELECT count(*) FROM student)::int s, (SELECT count(*) FROM ride_stop)::int st')).rows[0];
  assert.deepEqual(after, before);
});
