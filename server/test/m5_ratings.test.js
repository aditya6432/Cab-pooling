// Member 5 (Ratings + Analytics / Dashboard): end-to-end tests through the real API + PostgreSQL.
// Runs on the isolated database "poolup_test" (see helpers.js); run with  npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app, pool, bootTestDb, as, authed, anonymous, DEMO } from './helpers.js';

// every request is logged in as the demo student unless `as(req, who)` says otherwise
const request = authed;

before(async () => { await bootTestDb(); });
after(async () => { await pool.end(); });


test('health check reaches PostgreSQL', async () => {
  const res = await request(app).get('/api/health').expect(200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.version, /PostgreSQL/);
});

test('every named analytics query executes and returns its SQL', async () => {
  const { body: all } = await request(app).get('/api/analytics').expect(200);
  const list = all.filter((q) => q.module === 'ratings');
  assert.ok(list.length >= 20, `expected 20+ queries, got ${list.length}`);
  for (const q of list) {
    const res = await request(app).get(`/api/analytics/${q.name}`).query({ student_id: DEMO }).expect(200);   // "me" params come from the session
    assert.equal(res.body.sql, q.sql, `${q.name} served SQL must equal executed SQL`);
    assert.ok(Array.isArray(res.body.rows));
  }
});

test('KPIs are internally consistent', async () => {
  const { body } = await request(app).get('/api/analytics/kpi_overview').expect(200);
  const k = body.rows[0];
  assert.ok(k.rides_completed <= k.rides_total);
  assert.ok(k.avg_rating >= 1 && k.avg_rating <= 5);
  assert.ok(k.rupees_saved > 0);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM rating');
  assert.equal(k.ratings_total, rows[0].n);
});

test('requests without a login session are rejected (401)', async () => {
  await anonymous(app).post('/api/ratings').send({ rideId: 1, rateeId: 'x', score: 5 }).expect(401);
});

test('Workflow 1 — batch rating is atomic: one bad item rolls back the whole batch', async () => {
  const pending = (await as(request(app).get('/api/ratings/pending'))).body.rows;
  const byRide = Object.groupBy(pending, (p) => p.ride_id);
  const [rideId, items] = Object.entries(byRide).sort((a, b) => b[1].length - a[1].length)[0];
  assert.ok(items.length >= 3, 'demo user should have a ride with 3 pending co-riders');

  const res = await as(request(app).post('/api/ratings/batch')).send({
    items: [
      { rideId: Number(rideId), rateeId: items[0].ratee_id, score: 5, tags: [1, 2] },
      { rideId: Number(rideId), rateeId: items[1].ratee_id, score: 2 },          // no comment → BR5
      { rideId: Number(rideId), rateeId: items[2].ratee_id, score: 4 },
    ],
  }).expect(422);
  assert.equal(res.body.error.rule, 'BR5');
  assert.equal(res.body.error.failedItem, 1);
  assert.equal(res.body.error.rolledBack, true);

  const after = (await as(request(app).get('/api/ratings/pending'))).body.rows;
  assert.equal(after.length, pending.length, 'nothing may be saved after a rollback');
});

test('Workflow 1 — batch rating commits, then edit and withdraw are audited', async () => {
  const pending = (await as(request(app).get('/api/ratings/pending'))).body.rows;
  const byRide = Object.groupBy(pending, (p) => p.ride_id);
  const [rideId, items] = Object.entries(byRide).sort((a, b) => b[1].length - a[1].length)[0];
  const rid = Number(rideId);

  const res = await as(request(app).post('/api/ratings/batch')).send({
    items: items.map((p, i) => ({ rideId: rid, rateeId: p.ratee_id, score: 5 - i, comment: i ? null : 'Great co-rider!', tags: i ? [] : [1] })),
  }).expect(201);
  assert.equal(res.body.saved, items.length);

  const after = (await as(request(app).get('/api/ratings/pending'))).body.rows;
  assert.equal(after.length, pending.length - items.length);

  // edit (inside 24 h) — trigger stamps updated_at
  const target = items[0].ratee_id;
  const edited = await as(request(app).put(`/api/ratings/${rid}/${target}`))
    .send({ score: 4, comment: 'Good, slightly late', tags: [1, 8] }).expect(200);
  assert.equal(edited.body.score, 4);
  assert.ok(edited.body.updated_at);

  // contradicting tag on 5★ via edit → BR14
  const bad = await as(request(app).put(`/api/ratings/${rid}/${target}`)).send({ score: 5, tags: [8] }).expect(422);
  assert.equal(bad.body.error.rule, 'BR14');

  // withdraw
  await as(request(app).delete(`/api/ratings/${rid}/${target}`)).expect(204);
  const audit = (await request(app).get(`/api/ratings/${rid}/${DEMO}/${target}/audit`).expect(200)).body;
  assert.deepEqual(audit.map((a) => a.action), ['I', 'U', 'D']);
});

test('bad input types are rejected by PostgreSQL type checking (400)', async () => {
  const pending = (await as(request(app).get('/api/ratings/pending'))).body.rows;
  const p = pending[0];
  const res = await as(request(app).post('/api/ratings')).send({ rideId: p.ride_id, rateeId: p.ratee_id, score: 'five' }).expect(400);
  assert.equal(res.body.error.sqlstate, '22P02');
  await as(request(app).post('/api/ratings')).send({ rideId: p.ride_id, rateeId: p.ratee_id, score: 4, tags: 'Late' }).expect(400);
});

test('Workflow 3 — every Integrity Lab scenario behaves as expected', async () => {
  const { body: scenarios } = await request(app).get('/api/lab/scenarios').query({ module: 'ratings' }).expect(200);
  assert.ok(scenarios.length >= 12);
  const before = (await pool.query('SELECT count(*)::int n FROM rating')).rows[0].n;
  for (const s of scenarios) {
    const { body } = await as(request(app).post(`/api/lab/scenarios/${s.id}/run`)).expect(200);
    assert.equal(body.passed, true, `scenario ${s.id} did not behave as expected: ${JSON.stringify(body.error)}`);
    assert.equal(body.rolledBack, true);
  }
  const afterN = (await pool.query('SELECT count(*)::int n FROM rating')).rows[0].n;
  assert.equal(afterN, before, 'the lab must never change data');
});

test('materialized view is stale until refreshed; live view is immediate', async () => {
  const pending = (await as(request(app).get('/api/ratings/pending'))).body.rows;
  const p = pending[0];
  const q = (rel) => pool.query(`SELECT ratings_received FROM ${rel} WHERE student_id = $1`, [p.ratee_id]).then((r) => r.rows[0].ratings_received);
  const mvBefore = await q('mv_student_reputation');
  const liveBefore = await q('v_student_reputation');

  await as(request(app).post('/api/ratings')).send({ rideId: p.ride_id, rateeId: p.ratee_id, score: 5 }).expect(201);

  assert.equal(await q('v_student_reputation'), liveBefore + 1, 'view reflects the new rating at once');
  assert.equal(await q('mv_student_reputation'), mvBefore, 'materialized view is a snapshot');
  const r = await request(app).post('/api/analytics/refresh').expect(200);
  assert.ok(r.body.refreshedAt);
  assert.equal(await q('mv_student_reputation'), liveBefore + 1, 'after REFRESH it catches up');
});

test('EXPLAIN shows the pending-ratings query using our indexes', async () => {
  const { body } = await request(app).get('/api/analytics/pending_ratings/explain').expect(200);
  assert.match(body.plan, /actual time/);
  assert.ok(body.indexesUsed.includes('ride_member_student_idx'), `indexes used: ${body.indexesUsed}`);
});

test('trust network is a bounded recursive walk with no cycles', async () => {
  const { body } = await request(app).get(`/api/students/${DEMO}/network`).query({ depth: 3 }).expect(200);
  for (const n of body.rows) {
    assert.ok(n.hops >= 1 && n.hops <= 3);
    assert.equal(n.path_ids.length, n.hops + 1);
    assert.equal(new Set(n.path_ids).size, n.path_ids.length, 'path must not revisit a student');
    assert.notEqual(n.student_id, DEMO);
  }
});

test('unknown query → 404, bad parameter → 400', async () => {
  await request(app).get('/api/analytics/drop_tables').expect(404);
  await request(app).get('/api/analytics/leaderboard').query({ min_ratings: '1; DROP TABLE rating' }).expect(400);
});
