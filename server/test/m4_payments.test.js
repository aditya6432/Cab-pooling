// Member 4 (Payments + Settlement): end-to-end tests through the real API + PostgreSQL.
// Runs on the isolated database "poolup_test" (see helpers.js); run with  npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { app, pool, bootTestDb, as, authed, anonymous, DEMO } from './helpers.js';

// every request is logged in as the demo student unless `as(req, who)` says otherwise
const request = authed;

before(async () => { await bootTestDb(); });
after(async () => { await pool.end(); });

const q1 = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const utr = () => String(100000000000 + Math.floor(Math.random() * 899999999999));
const openDebt = (exclude = '') => q1(`
  SELECT d.ride_id, d.student_id AS debtor, c.student_id AS creditor, LEAST(-d.open, c.open) AS room
  FROM v_ride_balance d JOIN v_ride_balance c ON c.ride_id = d.ride_id AND c.open > 0
  WHERE d.open < 0 AND d.student_id <> $1
    -- leave the recent hand-crafted demo rides alone (the net-off and lab tests need them):
    -- not the demo student's rides, and the oldest open debts first
    AND NOT EXISTS (SELECT 1 FROM ride_member m WHERE m.ride_id = d.ride_id AND m.student_id = '2023A7PS0001H')
  ORDER BY d.ride_id LIMIT 1`, [exclude]);
const ledger = async () => (await request(app).get('/api/analytics/ledger_integrity').expect(200)).body.rows[0];

test('books balance after seeding: every ride sums to ₹0, no orphans', async () => {
  const l = await ledger();
  assert.equal(l.unbalanced_rides, 0);
  assert.equal(Number(l.campus_sum), 0);
  assert.equal(l.bad_expenses, 0);
  assert.equal(l.payments_without_history, 0);
  assert.equal(l.overpaid_positions, 0);
  assert.ok(l.rides_with_money > 300);
});

test('every payments named query executes', async () => {
  const { body: list } = await request(app).get('/api/analytics').expect(200);
  const pay = list.filter((q) => q.module === 'payments');
  assert.ok(pay.length >= 20, `expected 20+ payment queries, got ${pay.length}`);
  const ride = await q1(`SELECT ride_id FROM ride WHERE status = 'completed' ORDER BY ride_id DESC LIMIT 1`);
  const pay1 = await q1('SELECT payment_id FROM payment ORDER BY payment_id LIMIT 1');
  for (const q of pay) {
    await request(app).get(`/api/analytics/${q.name}`)
      .query({ student_id: DEMO, ride_id: ride.ride_id, payment_id: pay1.payment_id }).expect(200);
  }
});

test('settlement plan settles each ride with at most (people − 1) transfers', async () => {
  const { rows } = await pool.query(`
    SELECT r.ride_id,
           (SELECT count(*) FROM v_ride_balance b WHERE b.ride_id = r.ride_id AND b.open <> 0) AS people,
           (SELECT count(*) FROM fn_settlement_plan(r.ride_id)) AS transfers,
           (SELECT COALESCE(SUM(amount), 0) FROM fn_settlement_plan(r.ride_id)) AS planned,
           (SELECT COALESCE(SUM(-open), 0) FROM v_ride_balance b WHERE b.ride_id = r.ride_id AND b.open < 0) AS owed
    FROM ride r WHERE r.status = 'completed'`);
  for (const r of rows) {
    if (r.people > 0) assert.ok(r.transfers <= r.people - 1, `ride ${r.ride_id}: ${r.transfers} transfers for ${r.people} people`);
    assert.equal(Number(r.planned), Number(r.owed), `ride ${r.ride_id}: plan must move exactly what is owed`);
  }
});

test('Workflow: pay → confirm → statement; idempotent replay returns the same payment', async () => {
  const d = await openDebt(DEMO);
  const clientRef = crypto.randomUUID();
  const body = { clientRef, rideId: d.ride_id, payeeId: d.creditor, amount: d.room, method: 'upi', utr: utr() };
  const first = await as(request(app).post('/api/payments'), d.debtor).send(body).expect(201);
  assert.equal(first.body.payment.status, 'pending');
  const replay = await as(request(app).post('/api/payments'), d.debtor).send(body).expect(200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.payment.payment_id, first.body.payment.payment_id);
  // same key, different amount → refused
  const bad = await as(request(app).post('/api/payments'), d.debtor).send({ ...body, amount: 1 }).expect(422);
  assert.equal(bad.body.error.constraint, 'rule_idempotency_mismatch');

  const id = first.body.payment.payment_id;
  // a stranger cannot confirm; the payer cannot confirm their own payment
  await as(request(app).post(`/api/payments/${id}/confirm`), DEMO === d.creditor ? d.debtor : DEMO)
    .send({}).expect((r) => assert.ok([403, 422].includes(r.status)));
  const self = await as(request(app).post(`/api/payments/${id}/confirm`), d.debtor).send({}).expect(422);
  assert.equal(self.body.error.rule, 'PR12');
  // payee confirms
  const ok = await as(request(app).post(`/api/payments/${id}/confirm`), d.creditor).send({}).expect(200);
  assert.equal(ok.body.status, 'confirmed');
  assert.ok(ok.body.confirmed_at);

  const tl = (await as(request(app).get(`/api/payments/${id}/timeline`), d.creditor).expect(200)).body.rows;
  assert.deepEqual(tl.map((e) => `${e.from_status ?? '∅'}→${e.to_status}:${e.actor_role}`), ['∅→pending:payer', 'pending→confirmed:payee']);

  // statement's running balance ends at the student's true net position
  const st = (await as(request(app).get('/api/payments/statement'), d.debtor).expect(200)).body.rows;
  const net = await q1('SELECT net FROM v_student_money WHERE student_id = $1', [d.debtor]);
  assert.equal(Number(st[0].balance), Number(net.net));
  assert.equal((await ledger()).unbalanced_rides, 0);
});

test('overpayment is refused, counting pending payments as reserved', async () => {
  const d = await openDebt(DEMO);
  const r1 = await as(request(app).post('/api/payments'), d.debtor)
    .send({ clientRef: crypto.randomUUID(), rideId: d.ride_id, payeeId: d.creditor, amount: Number(d.room) + 1, method: 'cash' }).expect(422);
  assert.equal(r1.body.error.rule, 'PR10');
  await as(request(app).post('/api/payments'), d.debtor)
    .send({ clientRef: crypto.randomUUID(), rideId: d.ride_id, payeeId: d.creditor, amount: d.room, method: 'cash' }).expect(201);
  const r2 = await as(request(app).post('/api/payments'), d.debtor)
    .send({ clientRef: crypto.randomUUID(), rideId: d.ride_id, payeeId: d.creditor, amount: 1, method: 'cash' }).expect(422);
  assert.equal(r2.body.error.rule, 'PR10', 'the pending payment already reserves the whole debt');
});

test('concurrency: two simultaneous full payments → exactly one succeeds', async () => {
  const d = await openDebt(DEMO);
  const send = () => pool.query(
    `SELECT payment_id FROM fn_record_payment($1::uuid, $2, $3, $4, $5, 'cash')`,
    [crypto.randomUUID(), d.debtor, d.ride_id, d.creditor, d.room]);
  const results = await Promise.allSettled([send(), send(), send()]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, 'exactly one payment may succeed');
  for (const f of failed) assert.equal(f.reason.constraint, 'rule_no_overpayment');
  assert.equal((await ledger()).overpaid_positions, 0);
});

test('reject needs a reason; cancel and reject release the reservation; reverse window', async () => {
  const d = await openDebt(DEMO);
  const mk = async () => (await as(request(app).post('/api/payments'), d.debtor)
    .send({ clientRef: crypto.randomUUID(), rideId: d.ride_id, payeeId: d.creditor, amount: d.room, method: 'cash' }).expect(201)).body.payment.payment_id;

  const p1 = await mk();
  const noReason = await as(request(app).post(`/api/payments/${p1}/reject`), d.creditor).send({}).expect(422);
  assert.equal(noReason.body.error.rule, 'PR7');
  await as(request(app).post(`/api/payments/${p1}/reject`), d.creditor).send({ reason: 'Cash not received yet' }).expect(200);
  const p2 = await mk();                                   // reservation released → can pay again
  await as(request(app).post(`/api/payments/${p2}/cancel`), d.debtor).send({}).expect(200);
  const p3 = await mk();
  await as(request(app).post(`/api/payments/${p3}/confirm`), d.creditor).send({}).expect(200);
  // cannot cancel a confirmed payment; payee can reverse within 72 h
  const cc = await as(request(app).post(`/api/payments/${p3}/cancel`), d.debtor).send({}).expect(422);
  assert.equal(cc.body.error.rule, 'PR12');
  await as(request(app).post(`/api/payments/${p3}/reverse`), d.creditor).send({ reason: 'Bank reversed the credit' }).expect(200);
  const again = await q1('SELECT open FROM v_ride_balance WHERE ride_id = $1 AND student_id = $2', [d.ride_id, d.debtor]);
  assert.ok(Number(again.open) < 0, 'after a reversal the debt is owed again');
  // payments can never be edited or deleted
  await assert.rejects(pool.query('UPDATE payment SET amount = 1 WHERE payment_id = $1', [p3]), (e) => e.constraint === 'rule_payment_immutable');
  await assert.rejects(pool.query('DELETE FROM payment WHERE payment_id = $1', [p3]), (e) => e.constraint === 'rule_payment_no_delete');
});

test('expiry job expires only payments older than 7 days', async () => {
  const before = await q1(`SELECT count(*)::int AS n FROM payment WHERE status = 'pending' AND created_at <= now() - fn_payment_expiry()`);
  const res = await request(app).post('/api/payments/expire').expect(200);
  assert.equal(res.body.expired, before.n);
  const after = await q1(`SELECT count(*)::int AS n FROM payment WHERE status = 'pending' AND created_at <= now() - fn_payment_expiry()`);
  assert.equal(after.n, 0);
  // a fresh pending payment cannot be expired early, even by the system
  const fresh = await q1(`SELECT payment_id FROM payment WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1`);
  if (fresh) {
    await assert.rejects(pool.query(`UPDATE payment SET status = 'expired', status_reason = 'too early' WHERE payment_id = $1`, [fresh.payment_id]),
      (e) => e.constraint === 'rule_expiry_too_early');
  }
});

test('net-off clears mutual debts atomically and the books still balance', async () => {
  const pair = await q1(`
    SELECT a_id, b_id, nettable FROM (
      SELECT x.debtor AS a_id, x.creditor AS b_id, LEAST(x.t, y.t) AS nettable FROM
        (SELECT a.student_id AS debtor, b.student_id AS creditor, SUM(LEAST(-a.open, b.open)) AS t
           FROM v_ride_balance a JOIN v_ride_balance b ON b.ride_id = a.ride_id WHERE a.open < 0 AND b.open > 0
          GROUP BY 1, 2) x
      JOIN (SELECT a.student_id AS debtor, b.student_id AS creditor, SUM(LEAST(-a.open, b.open)) AS t
              FROM v_ride_balance a JOIN v_ride_balance b ON b.ride_id = a.ride_id WHERE a.open < 0 AND b.open > 0
             GROUP BY 1, 2) y ON y.debtor = x.creditor AND y.creditor = x.debtor) z
    ORDER BY nettable DESC LIMIT 1`);
  assert.ok(pair, 'seed should contain at least one net-off opportunity');
  const res = await as(request(app).post('/api/payments/net-off'), pair.a_id).send({ otherId: pair.b_id }).expect(201);
  assert.equal(Number(res.body.netted).toFixed(2), Number(pair.nettable).toFixed(2));
  const groups = await q1(`SELECT count(*)::int AS rows, count(DISTINCT offset_group)::int AS groups FROM payment WHERE method = 'offset'`);
  assert.equal(groups.rows, groups.groups * 2, 'offsets always come in pairs');
  const l = await ledger();
  assert.equal(l.unbalanced_rides, 0);
  assert.equal(l.bad_offsets, 0);
  // nothing left to net off → clear error
  const again = await as(request(app).post('/api/payments/net-off'), pair.a_id).send({ otherId: pair.b_id }).expect(422);
  assert.equal(again.body.error.constraint, 'rule_nothing_to_net_off');
  // a half offset is caught at COMMIT by the deferred constraint trigger
  const c = await pool.connect();
  try {
    const d = await openDebt('');
    await c.query('BEGIN');
    await c.query(`INSERT INTO payment (client_ref, ride_id, payer_id, payee_id, amount, method, offset_group, status)
                   VALUES (gen_random_uuid(), $1, $2, $3, 1, 'offset', gen_random_uuid(), 'confirmed')`, [d.ride_id, d.debtor, d.creditor]);
    await assert.rejects(c.query('COMMIT'), (e) => e.constraint === 'rule_offset_unbalanced');
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
});

test('reminders: only for real debts, at most one per 24 h (EXCLUDE constraint)', async () => {
  const d = await q1(`
    SELECT d.ride_id, d.student_id AS debtor, c.student_id AS creditor
    FROM v_ride_balance d JOIN v_ride_balance c ON c.ride_id = d.ride_id AND c.open > 0
    WHERE d.open < 0 AND NOT EXISTS (SELECT 1 FROM payment_reminder r WHERE r.ride_id = d.ride_id
          AND r.creditor_id = c.student_id AND r.debtor_id = d.student_id AND r.sent_at > now() - INTERVAL '24 hours')
    LIMIT 1`);
  const r1 = await as(request(app).post('/api/payments/reminders'), d.creditor).send({ rideId: d.ride_id, debtorId: d.debtor }).expect(201);
  assert.ok(Number(r1.body.amount_due) > 0, 'trigger snapshots the amount due');
  const r2 = await as(request(app).post('/api/payments/reminders'), d.creditor).send({ rideId: d.ride_id, debtorId: d.debtor }).expect(409);
  assert.equal(r2.body.error.rule, 'PR16');
  assert.equal(r2.body.error.sqlstate, '23P01');
  // the debtor cannot "remind" the creditor
  const wrong = await as(request(app).post('/api/payments/reminders'), d.debtor).send({ rideId: d.ride_id, debtorId: d.creditor }).expect(422);
  assert.equal(wrong.body.error.rule, 'PR16');
});

test('UPI IDs: format CHECK, one default (partial unique index), safe default switch', async () => {
  const who = DEMO;
  const bad = await as(request(app).post('/api/payments/methods'), who).send({ vpa: 'not a vpa' }).expect(422);
  assert.equal(bad.body.error.rule, 'PR17');
  const added = await as(request(app).post('/api/payments/methods'), who).send({ vpa: 'Aarav.Backup@YBL', label: 'Backup' }).expect(201);
  assert.equal(added.body.vpa, 'aarav.backup@ybl', 'normalised to lower case');
  assert.equal(added.body.is_default, false);
  await as(request(app).post(`/api/payments/methods/${added.body.method_id}/default`), who).send({}).expect(200);
  const defaults = await q1('SELECT count(*)::int AS n FROM payment_method WHERE student_id = $1 AND is_default', [who]);
  assert.equal(defaults.n, 1);
  await assert.rejects(pool.query(`UPDATE payment_method SET is_default = true WHERE student_id = $1`, [who]),
    (e) => e.constraint === 'payment_method_one_default');
  await as(request(app).delete(`/api/payments/methods/${added.body.method_id}`), who).expect(204);
});

test('Integrity Lab: all 20 payment scenarios behave as expected', async () => {
  const { body: list } = await request(app).get('/api/lab/scenarios').query({ module: 'payments' }).expect(200);
  assert.equal(list.length, 20);
  for (const s of list) {
    const res = await as(request(app).post(`/api/lab/scenarios/${s.id}/run`));
    assert.equal(res.status, 200, `${s.id}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.passed, true, `${s.id}: ${JSON.stringify(res.body.error)}`);
  }
  assert.equal((await ledger()).unbalanced_rides, 0);
});
