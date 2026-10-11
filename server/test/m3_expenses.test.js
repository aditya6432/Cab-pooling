// Member 3 (Expense splitting): end-to-end tests through the real API + PostgreSQL.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app, pool, setupDatabase, TEST_URL as URL } from './helpers.js';
const tokens = {};
const H = (id) => ({ Authorization: `Bearer ${tokens[id]}` });
async function login(id) {
  if (!tokens[id]) tokens[id] = (await request(app).post('/api/auth/login').send({ login: id, password: 'poolup123' })).body.token;
  return H(id);
}
let ride, riders, outsider;   // a completed ride (3+ riders, no payments yet) used by most tests

before(async () => {
  await setupDatabase(URL, { log: () => {} });
  const r = await pool.query(
    `SELECT r.ride_id, array_agg(m.student_id::text ORDER BY m.joined_at, m.student_id) AS riders
     FROM ride r JOIN ride_member m ON m.ride_id = r.ride_id AND m.status = 'confirmed'
     WHERE r.status = 'completed' AND NOT EXISTS (SELECT 1 FROM payment p WHERE p.ride_id = r.ride_id)
     GROUP BY r.ride_id HAVING count(*) >= 3 ORDER BY r.ride_id DESC LIMIT 1`);
  ride = r.rows[0].ride_id; riders = r.rows[0].riders;
  outsider = (await pool.query(`SELECT student_id::text id FROM student WHERE student_id <> ALL($1) ORDER BY 1 LIMIT 1`, [riders])).rows[0].id;
});
after(() => pool.end());

const post = async (who, body) => request(app).post('/api/expenses').set(await login(who)).send(body);
const sum = (rows, k = 'share_amount') => Math.round(rows.reduce((a, r) => a + r[k], 0) * 100) / 100;

test('seed: expenses, shares, audit rows exist; every expense is fully split', async () => {
  const { rows } = await pool.query(`SELECT (SELECT count(*) FROM expense)::int e, (SELECT count(*) FROM expense_share)::int s,
    (SELECT count(*) FROM expense_audit)::int a,
    (SELECT count(*) FROM expense x WHERE x.amount <> (SELECT sum(share_amount) FROM expense_share y WHERE y.expense_id = x.expense_id))::int bad`);
  assert.ok(rows[0].e >= 300 && rows[0].s > rows[0].e && rows[0].a >= rows[0].e); assert.equal(rows[0].bad, 0);
});

test('every endpoint requires login', async () => {
  for (const p of ['/api/expenses/summary', '/api/expenses/rides', '/api/analytics?module=expenses', '/api/lab/scenarios?module=expenses']) {
    assert.equal((await request(app).get(p)).status, 401, p);
  }
  assert.equal((await request(app).post('/api/expenses').send({})).status, 401);
});

test('fn_split_amount: shares are whole paise and always add up exactly', async () => {
  for (const [amt, w] of [[100, [1, 1, 1]], [0.01, [1, 1, 1]], [1000.01, [1, 2, 3, 1, 1, 5, 7]], [999.99, [3, 3, 3, 3]], [50000, [7, 11]]]) {
    const ids = w.map((_, i) => 'P' + i);
    const { rows } = await pool.query('SELECT who, share FROM fn_split_amount($1::numeric, $2::text[], $3::numeric[])', [amt, ids, w]);
    assert.equal(rows.length, w.length); assert.equal(sum(rows, 'share'), amt);
    assert.ok(rows.every((r) => Math.abs(r.share * 100 - Math.round(r.share * 100)) < 1e-9));
  }
  const { rows } = await pool.query(`SELECT share FROM fn_split_amount(100, ARRAY['A','B','C'], ARRAY[1,1,1]::numeric[])`);
  assert.deepEqual(rows.map((r) => r.share), [33.34, 33.33, 33.33]);
});

test('ledger and pairwise views are internally consistent', async () => {
  const { rows } = await pool.query('SELECT round(sum(net), 2)::float AS t FROM v_ride_ledger');
  assert.equal(rows[0].t, 0);
  const p = await pool.query(`SELECT count(*)::int c FROM v_pairwise_balance WHERE amount <= 0 OR debtor_id = creditor_id`);
  assert.equal(p.rows[0].c, 0);
});

test('summary + rides list work for the demo student', async () => {
  const s = await request(app).get('/api/expenses/summary').set(await login('2023A7PS0001H'));
  assert.equal(s.status, 200);
  assert.equal(Math.round((s.body.owedToMe - s.body.iOwe) * 100) / 100, s.body.net);
  assert.ok(s.body.owedToMe > 0 && s.body.people.length > 0);
  const r = await request(app).get('/api/expenses/rides').set(await login('2023A7PS0001H'));
  assert.equal(r.status, 200); assert.ok(r.body.length > 0 && 'my_net' in r.body[0]);
});

test('ride detail: members only (403 for outsiders, 404 unknown, 400 bad id)', async () => {
  const ok = await request(app).get(`/api/expenses/ride/${ride}`).set(await login(riders[0]));
  assert.equal(ok.status, 200); assert.equal(ok.body.ride.can_add, true);
  assert.ok(ok.body.members.length >= 3 && Array.isArray(ok.body.ledger) && Array.isArray(ok.body.transfers));
  assert.equal((await request(app).get(`/api/expenses/ride/${ride}`).set(await login(outsider))).status, 403);
  assert.equal((await request(app).get('/api/expenses/ride/99999999').set(await login(riders[0]))).status, 404);
  assert.equal((await request(app).get('/api/expenses/ride/abc').set(await login(riders[0]))).status, 400);
});

test('create: equal / seats / exact / percent all store shares that add up; preview matches', async () => {
  const [a, b, c] = riders;
  const cases = [
    { split: 'equal', amount: 100 },
    { split: 'seats', amount: 250.5 },
    { split: 'exact', amount: 300, people: [a, b, c], values: [120, 100, 80] },
    { split: 'percent', amount: 333.33, people: [a, b, c], values: [50, 30, 20] },
  ];
  for (const k of cases) {
    const body = { rideId: ride, note: `t-${k.split}`, ...k };
    const q = new URLSearchParams({ rideId: ride, amount: k.amount, split: k.split, people: (k.people || []).join(','), values: (k.values || []).join(',') });
    const pv = await request(app).get(`/api/expenses/preview?${q}`).set(await login(a));
    assert.equal(pv.status, 200, JSON.stringify(pv.body)); assert.equal(pv.body.total, k.amount);
    const res = await post(a, body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const e = res.body.expenses.find((x) => x.expense_id === res.body.expenseId);
    assert.equal(e.paid_by, a); assert.equal(e.split_type, k.split); assert.equal(sum(e.shares), k.amount);
    assert.deepEqual(e.shares.map((s) => [s.student_id, s.share_amount]).sort(), pv.body.shares.map((s) => [s.student_id, s.share_amount]).sort());
  }
  const det = await request(app).get(`/api/expenses/ride/${ride}`).set(await login(a));
  assert.equal(Math.round(det.body.ledger.reduce((t, r) => t + r.net, 0) * 100) / 100, 0);
  assert.ok(det.body.audit.some((x) => x.action === 'create'));
});

test('create: every rule is enforced by the database', async () => {
  const [a, b] = riders;
  const bad = async (who, body, status, constraint) => {
    const r = await post(who, { rideId: ride, split: 'equal', ...body });
    assert.equal(r.status, status, `${constraint}: ${JSON.stringify(r.body)}`);
    if (constraint) assert.equal(r.body.error.constraint, constraint);
    assert.ok(r.body.error.rule || !constraint);
  };
  await bad(a, { amount: 0 }, 422, 'expense_amount_positive');
  await bad(a, { amount: -5 }, 422, 'expense_amount_positive');
  await bad(a, { amount: 99999 }, 422, 'expense_amount_cap');
  await bad(a, { amount: 'abc' }, 400);
  await bad(a, { amount: 100, split: 'cubic' }, 422);
  await bad(a, { amount: 300, split: 'exact', people: [a, b], values: [100, 100] }, 422, 'rule_split_exact_sum');
  await bad(a, { amount: 300, split: 'percent', people: [a, b], values: [60, 60] }, 422, 'rule_split_percent_sum');
  await bad(a, { amount: 300, split: 'exact', people: [a, b], values: [300] }, 422, 'rule_split_weights');
  await bad(a, { amount: 100, people: [a, a] }, 409, 'expense_share_pkey');
  await bad(a, { amount: 100, people: [a, outsider] }, 422, 'rule_share_confirmed_member');
  await bad(outsider, { amount: 100 }, 422, 'expense_payer_on_ride');
  const open = (await pool.query(`SELECT r.ride_id, r.creator_id::text c FROM ride r WHERE r.status = 'open' LIMIT 1`)).rows[0];
  const o = await post(open.c, { rideId: open.ride_id, amount: 100, split: 'equal' });
  assert.equal(o.status, 422); assert.equal(o.body.error.constraint, 'rule_expense_ride_state');
  const ns = (await pool.query(`SELECT m.ride_id, m.student_id::text s FROM ride_member m JOIN ride r USING (ride_id) WHERE m.status = 'no_show' AND r.status = 'completed' LIMIT 1`)).rows[0];
  const n = await post(ns.s, { rideId: ns.ride_id, amount: 100, split: 'equal' });
  assert.equal(n.status, 422); assert.equal(n.body.error.constraint, 'rule_expense_payer_confirmed');
  const preview = await request(app).get(`/api/expenses/preview?rideId=${ride}&amount=100&split=equal`).set(await login(outsider));
  assert.equal(preview.status, 403);
});

test('direct SQL: shares that do not add up are rejected at COMMIT; shares/expenses are immutable', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query(`INSERT INTO expense (ride_id, paid_by, amount) VALUES ($1, $2, 300) RETURNING expense_id`, [ride, riders[0]]);
    await c.query(`INSERT INTO expense_share VALUES ($1, $2, 100)`, [rows[0].expense_id, riders[0]]);
    await assert.rejects(c.query('COMMIT'), (e) => e.constraint === 'rule_shares_sum_to_amount' && e.code === '23514');
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  const id = (await post(riders[0], { rideId: ride, amount: 90, split: 'equal' })).body.expenseId;
  await assert.rejects(pool.query('UPDATE expense SET amount = 91 WHERE expense_id = $1', [id]), (e) => e.constraint === 'rule_expense_immutable');
  await assert.rejects(pool.query('UPDATE expense_share SET share_amount = 1 WHERE expense_id = $1', [id]), (e) => e.constraint === 'rule_expense_immutable');
  await pool.query(`UPDATE expense SET note = 'renamed' WHERE expense_id = $1`, [id]);      // note may change
});

test('delete: only the payer; audit keeps history; locked once money moved (Member 4 payments)', async () => {
  const [a, b] = riders;
  const id = (await post(a, { rideId: ride, amount: 120, split: 'equal', note: 'to delete' })).body.expenseId;
  const no = await request(app).delete(`/api/expenses/${id}`).set(await login(b));
  assert.equal(no.status, 403); assert.equal(no.body.error.constraint, 'rule_expense_owner_only');
  assert.equal((await request(app).delete(`/api/expenses/${id}`).set(await login(a))).status, 204);
  assert.equal((await request(app).delete(`/api/expenses/${id}`).set(await login(a))).status, 404);
  const au = await pool.query(`SELECT action, actor_id::text FROM expense_audit WHERE expense_id = $1 ORDER BY audit_id`, [id]);
  assert.deepEqual(au.rows.map((r) => r.action), ['create', 'delete']); assert.equal(au.rows[1].actor_id, a);
  assert.equal((await pool.query('SELECT count(*)::int c FROM expense_share WHERE expense_id = $1', [id])).rows[0].c, 0);

  const lk = (await pool.query(`SELECT e.expense_id, e.paid_by::text p FROM expense e WHERE EXISTS (SELECT 1 FROM v_settlement_flow s WHERE s.ride_id = e.ride_id) LIMIT 1`)).rows[0];
  const locked = await request(app).delete(`/api/expenses/${lk.expense_id}`).set(await login(lk.p));
  assert.equal(locked.status, 422); assert.equal(locked.body.error.constraint, 'rule_expense_locked');
});

test('deleting a ride cascades to its expenses (the lock only guards direct deletes); payments protect money history', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // a ride with expenses but no payments / reminders: the delete cascades ride -> ride_member -> expense -> shares
    const r = (await c.query(`SELECT e.ride_id FROM expense e WHERE NOT EXISTS (SELECT 1 FROM payment p WHERE p.ride_id = e.ride_id)
                                AND NOT EXISTS (SELECT 1 FROM payment_reminder x WHERE x.ride_id = e.ride_id) LIMIT 1`)).rows[0].ride_id;
    await c.query('DELETE FROM ride WHERE ride_id = $1', [r]);
    assert.equal((await c.query('SELECT count(*)::int c FROM expense WHERE ride_id = $1', [r])).rows[0].c, 0);
    // a ride with payments cannot be deleted at all: Member 4's composite FKs have no ON DELETE CASCADE
    const paid = (await c.query(`SELECT ride_id FROM payment WHERE status = 'confirmed' LIMIT 1`)).rows[0].ride_id;
    await c.query('SAVEPOINT s');
    await assert.rejects(c.query('DELETE FROM ride WHERE ride_id = $1', [paid]), (e) => e.code === '23503' && /payment/.test(e.constraint));
    await c.query('ROLLBACK TO SAVEPOINT s');
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
});

test('fn_simplify_debts: paying the suggested transfers through Member 4 settles everyone to zero in both ledgers', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const [a, b, d] = riders;
    await c.query(`SELECT fn_add_expense($1, $2, 300, 'x', 'equal', ARRAY[$2,$3,$4]::text[])`, [ride, a, b, d]);
    await c.query(`SELECT fn_add_expense($1, $2, 90, 'y', 'exact', ARRAY[$2,$3,$4]::text[], ARRAY[10,50,30]::numeric[])`, [ride, b, a, d]);
    const { rows: t } = await c.query('SELECT from_id, to_id, amount FROM fn_simplify_debts($1)', [ride]);
    assert.ok(t.length >= 1 && t.length <= 2);                               // 3 people => at most 2 transfers
    // M4 agrees with M3 on what is owed (same transfers, same total)
    const { rows: plan } = await c.query('SELECT from_id, to_id, amount FROM fn_settlement_plan($1)', [ride]);
    assert.equal(sum(plan, 'amount'), sum(t, 'amount'));
    // pay each transfer the real way: payer records it (pending), payee confirms it (state machine)
    for (const x of t) {
      const { rows: [p] } = await c.query(`SELECT payment_id FROM fn_record_payment(gen_random_uuid(), $1, $2, $3, $4, 'cash', NULL, NULL)`, [x.from_id, ride, x.to_id, x.amount]);
      await c.query(`SELECT * FROM fn_transition_payment($1, $2, 'confirmed', NULL)`, [p.payment_id, x.to_id]);
    }
    const { rows: l } = await c.query('SELECT student_id, net::float n FROM v_ride_ledger WHERE ride_id = $1', [ride]);
    assert.ok(l.every((x) => Math.abs(x.n) < 0.005), JSON.stringify(l));
    const { rows: bal } = await c.query('SELECT student_id, net::float n FROM v_ride_balance WHERE ride_id = $1', [ride]);
    assert.ok(bal.every((x) => Math.abs(x.n) < 0.005), JSON.stringify(bal));
    assert.equal((await c.query('SELECT count(*)::int c FROM fn_simplify_debts($1)', [ride])).rows[0].c, 0);
    assert.equal((await c.query('SELECT count(*)::int c FROM fn_settlement_plan($1)', [ride])).rows[0].c, 0);
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
});

test('SQL library: every query runs; EXPLAIN works; unknown name is 404', async () => {
  const A = await login('2023A7PS0001H');
  const list = await request(app).get('/api/analytics?module=expenses').set(A);
  assert.ok(list.body.length >= 6);
  for (const q of list.body) {
    const r = await request(app).get(`/api/analytics/${q.name}`).set(A);
    assert.equal(r.status, 200, `${q.name}: ${JSON.stringify(r.body)}`); assert.ok(Array.isArray(r.body.rows));
    if (q.name !== 'settlement_lag') assert.ok(r.body.rows.length > 0, `${q.name} returned no rows`);
    const ex = await request(app).get(`/api/analytics/${q.name}/explain`).set(A);
    assert.equal(ex.status, 200); assert.ok(ex.body.plan.length > 0);
  }
  assert.equal((await request(app).get('/api/analytics/nope').set(A)).status, 404);
  assert.equal((await request(app).get('/api/analytics/constructor').set(A)).status, 404);
});

test('integrity lab: every scenario behaves as documented and nothing persists', async () => {
  const A = await login('2023A7PS0001H');
  const before = (await pool.query(`SELECT (SELECT count(*) FROM expense)::int e, (SELECT count(*) FROM expense_share)::int s, (SELECT count(*) FROM expense_audit)::int a`)).rows[0];
  const list = await request(app).get('/api/lab/scenarios?module=expenses').set(A);
  assert.ok(list.body.length >= 14);
  for (const s of list.body) {
    const r = await request(app).post(`/api/lab/scenarios/${s.id}/run`).set(A);
    assert.equal(r.status, 200, `${s.id}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.passed, true, `${s.id}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.rolledBack, true);
  }
  const after = (await pool.query(`SELECT (SELECT count(*) FROM expense)::int e, (SELECT count(*) FROM expense_share)::int s, (SELECT count(*) FROM expense_audit)::int a`)).rows[0];
  assert.deepEqual(after, before);
  assert.equal((await request(app).post('/api/lab/scenarios/nope/run').set(A)).status, 404);
});
