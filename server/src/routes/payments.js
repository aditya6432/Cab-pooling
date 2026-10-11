// /api/payments — Member 4: Payments + Settlement.
// Every rule lives in PostgreSQL; this file only translates HTTP into calls
// to the stored functions and named queries.
import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { HttpError } from '../errors.js';
import { runNamed } from '../analytics.js';
import { requireAuth, actingStudent } from '../auth.js';

const router = Router();
router.use(requireAuth);            // the actor is always the logged-in student (Member 1's session)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const pack = (r) => ({ rows: r.rows, sql: r.sql, name: r.name, title: r.title, concepts: r.concepts, ms: r.ms, params: r.params, module: r.module });

// GET /api/payments/overview — everything the "Settle up" page needs
router.get('/overview', async (req, res) => {
  const me = { me: actingStudent(req) };
  const [money, lines, netoffs, upi] = await Promise.all([
    runNamed('my_money', me), runNamed('my_settle_lines', me), runNamed('my_netoffs', me), runNamed('my_upi_ids', me),
  ]);
  res.json({ money: money.rows[0] || null, lines: pack(lines), netoffs: pack(netoffs), upi: pack(upi), moneyQuery: pack(money) });
});

// GET /api/payments/inbox — to confirm, sent, history
router.get('/inbox', async (req, res) => {
  const me = { me: actingStudent(req) };
  const [incoming, outgoing, history] = await Promise.all([
    runNamed('my_inbox', me), runNamed('my_outgoing', me), runNamed('my_payment_history', me),
  ]);
  res.json({ incoming: pack(incoming), outgoing: pack(outgoing), history: pack(history) });
});

// GET /api/payments/statement — running balance
router.get('/statement', async (req, res) => {
  res.json(pack(await runNamed('my_statement', { me: actingStudent(req) })));
});

// GET /api/payments/rides/:rideId — positions of every member + settlement plan
router.get('/rides/:rideId', async (req, res) => {
  const p = { ride_id: req.params.rideId };
  if (!/^\d+$/.test(String(p.ride_id))) throw new HttpError(400, 'Invalid ride id');
  const { rowCount } = await pool.query('SELECT 1 FROM ride_member WHERE ride_id = $1 AND student_id = $2', [p.ride_id, actingStudent(req)]);
  if (!rowCount) throw new HttpError(403, 'Only members of this ride can see its money');
  const [positions, plan] = await Promise.all([runNamed('ride_positions', p), runNamed('ride_plan', p)]);
  res.json({ positions: pack(positions), plan: pack(plan) });
});

// GET /api/payments/:id/timeline — trigger-written status history
router.get('/:id/timeline', async (req, res) => {
  if (!/^\d+$/.test(String(req.params.id))) throw new HttpError(400, 'Invalid payment id');
  const { rows } = await pool.query('SELECT payer_id, payee_id FROM payment WHERE payment_id = $1', [req.params.id]);
  if (!rows.length) throw new HttpError(404, 'No such payment');
  if (![rows[0].payer_id, rows[0].payee_id].includes(actingStudent(req))) throw new HttpError(403, 'Only the payer or the payee can see this payment');
  res.json(pack(await runNamed('payment_timeline', { payment_id: req.params.id })));
});

// POST /api/payments — record a payment (idempotent on clientRef)
router.post('/', async (req, res) => {
  const actor = actingStudent(req);
  const { clientRef, rideId, payeeId, amount, method, utr = null, note = null } = req.body || {};
  if (!clientRef || !UUID_RE.test(clientRef)) {
    throw new HttpError(400, '"clientRef" must be a UUID generated once per payment attempt (it makes retries safe)');
  }
  const existed = (await pool.query('SELECT 1 FROM payment WHERE client_ref = $1', [clientRef])).rowCount > 0;
  const { rows } = await pool.query(
    `SELECT * FROM fn_record_payment($1::uuid, $2::char(13), $3::int, $4::char(13), $5::numeric, $6::text, $7::text, $8::text)`,
    [clientRef, actor, rideId, payeeId, amount, method, utr, note]);
  res.status(existed ? 200 : 201).json({ payment: rows[0], replayed: existed });
});

// POST /api/payments/:id/(confirm|reject|cancel|reverse)
const ACTIONS = { confirm: 'confirmed', reject: 'rejected', cancel: 'cancelled', reverse: 'reversed' };
router.post('/:id/:action', async (req, res, next) => {
  const to = ACTIONS[req.params.action];
  if (!to) return next();
  if (!/^\d+$/.test(req.params.id)) throw new HttpError(400, 'Payment id must be a number');
  const { rows } = await pool.query(
    'SELECT * FROM fn_transition_payment($1::bigint, $2::char(13), $3::text, $4::text)',
    [req.params.id, actingStudent(req), to, req.body?.reason ?? null]);
  res.json(rows[0]);
});

// POST /api/payments/net-off — cancel mutual debts across rides, no money moves
router.post('/net-off', async (req, res) => {
  const actor = actingStudent(req);
  const other = req.body?.otherId;
  if (!other) throw new HttpError(400, '"otherId" is required');
  const { rows } = await pool.query('SELECT * FROM fn_net_off($1::char(13), $2::char(13))', [actor, other]);
  res.status(201).json({ pairs: rows, netted: rows.reduce((a, r) => a + Number(r.netted), 0) });
});

// POST /api/payments/reminders — nudge a debtor (rate-limited by EXCLUDE)
router.post('/reminders', async (req, res) => {
  const creditor = actingStudent(req);
  const { rideId, debtorId, message = null } = req.body || {};
  const { rows } = await pool.query(
    `INSERT INTO payment_reminder (ride_id, creditor_id, debtor_id, message)
     VALUES ($1, $2, $3, NULLIF(trim($4), '')) RETURNING *`,
    [rideId, creditor, debtorId, message]);
  res.status(201).json(rows[0]);
});

// POST /api/payments/expire — the scheduled "system" job, runnable on demand
router.post('/expire', async (_req, res) => {
  const { rows } = await pool.query('SELECT fn_expire_stale_payments() AS expired');
  res.json({ expired: rows[0].expired });
});

// ---------- UPI IDs ----------
router.get('/methods', async (req, res) => {
  res.json(pack(await runNamed('my_upi_ids', { me: actingStudent(req) })));
});

router.post('/methods', async (req, res) => {
  const me = actingStudent(req);
  const { vpa, label = null, makeDefault = false } = req.body || {};
  const row = await withTransaction(async (c) => {
    // first UPI ID becomes the default automatically
    const { rows } = await c.query(
      `INSERT INTO payment_method (student_id, vpa, label, is_default)
       VALUES ($1, lower(trim($2)), NULLIF(trim($3), ''),
               NOT EXISTS (SELECT 1 FROM payment_method WHERE student_id = $1 AND is_default))
       RETURNING *`, [me, vpa ?? '', label]);
    if (makeDefault && !rows[0].is_default) {
      await c.query('SELECT fn_set_default_vpa($1, $2)', [me, rows[0].method_id]);
      rows[0].is_default = true;
    }
    return rows[0];
  });
  res.status(201).json(row);
});

router.post('/methods/:id/default', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw new HttpError(400, 'Method id must be a number');
  await pool.query('SELECT fn_set_default_vpa($1, $2)', [actingStudent(req), req.params.id]);
  res.json({ ok: true });
});

router.delete('/methods/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw new HttpError(400, 'Method id must be a number');
  const { rowCount } = await pool.query('DELETE FROM payment_method WHERE method_id = $1 AND student_id = $2',
    [req.params.id, actingStudent(req)]);
  if (!rowCount) throw new HttpError(404, 'No such UPI ID');
  res.status(204).end();
});

export default router;
