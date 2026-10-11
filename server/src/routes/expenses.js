// Member 3 - Expense splitting API.   Mounted at  /api/expenses
import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { HttpError } from '../errors.js';
import { requireAuth, actingStudent } from '../auth.js';

const router = Router();
router.use(requireAuth);

const SPLITS = ['equal', 'seats', 'exact', 'percent'];
const toInt = (v) => { const n = Number.parseInt(v, 10); if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw new HttpError(400, 'Invalid id'); return n; };
const toAmount = (v) => { const n = Number(v); if (v === '' || v === null || v === undefined || !Number.isFinite(n)) throw new HttpError(400, 'Amount must be a number'); return Math.round(n * 100) / 100; };
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean);
const numList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).filter((x) => String(x).trim() !== '').map((x) => { const n = Number(x); if (!Number.isFinite(n)) throw new HttpError(400, 'Split values must be numbers'); return n; });

async function requireRideMember(rideId, studentId) {
  const { rows } = await pool.query(
    `SELECT r.ride_id, m.status AS member_status FROM ride r
     LEFT JOIN ride_member m ON m.ride_id = r.ride_id AND m.student_id = $2 WHERE r.ride_id = $1`, [rideId, studentId]);
  if (!rows.length) throw new HttpError(404, 'No such ride');
  if (rows[0].member_status !== 'confirmed') throw new HttpError(403, 'Only confirmed riders can see this ride\'s expenses');
}

// GET /api/expenses/summary  -> what I owe / am owed, per person
router.get('/summary', async (req, res) => {
  const me = actingStudent(req);
  const { rows: people } = await pool.query(
    `SELECT o.student_id AS other_id, o.full_name AS other_name, (b.creditor_id = $1) AS owes_me, b.amount
     FROM v_pairwise_balance b
     JOIN student o ON o.student_id = CASE WHEN b.debtor_id = $1 THEN b.creditor_id ELSE b.debtor_id END
     WHERE b.debtor_id = $1 OR b.creditor_id = $1
     ORDER BY b.amount DESC, o.full_name`, [me]);
  const owedToMe = people.filter((p) => p.owes_me).reduce((a, p) => a + p.amount, 0);
  const iOwe = people.filter((p) => !p.owes_me).reduce((a, p) => a + p.amount, 0);
  res.json({ owedToMe: Math.round(owedToMe * 100) / 100, iOwe: Math.round(iOwe * 100) / 100,
             net: Math.round((owedToMe - iOwe) * 100) / 100, people });
});

// GET /api/expenses/rides  -> my departed/completed rides with my position on each
router.get('/rides', async (req, res) => {
  const me = actingStudent(req);
  const { rows } = await pool.query(
    `SELECT r.ride_id, lo.name AS origin, ld.name AS destination, r.depart_start, r.status, r.cab_type, r.distance_km,
            (SELECT count(*) FROM ride_member x WHERE x.ride_id = r.ride_id AND x.status = 'confirmed')::int AS riders,
            COALESCE(t.total, 0) AS total, COALESCE(t.cnt, 0)::int AS expenses,
            COALESCE(l.paid, 0) AS my_paid, COALESCE(l.owed, 0) AS my_owed, COALESCE(l.net, 0) AS my_net
     FROM ride_member m
     JOIN ride r      ON r.ride_id = m.ride_id
     JOIN location lo ON lo.location_id = r.origin_id
     JOIN location ld ON ld.location_id = r.dest_id
     LEFT JOIN (SELECT ride_id, sum(amount) AS total, count(*) AS cnt FROM expense GROUP BY ride_id) t ON t.ride_id = r.ride_id
     LEFT JOIN v_ride_ledger l ON l.ride_id = r.ride_id AND l.student_id = m.student_id
     WHERE m.student_id = $1 AND m.status = 'confirmed' AND r.status IN ('departed', 'completed')
     ORDER BY r.depart_start DESC LIMIT 60`, [me]);
  res.json(rows);
});

// GET /api/expenses/preview?rideId=&amount=&split=&people=a,b&values=1,2   (nothing is saved)
router.get('/preview', async (req, res) => {
  const me = actingStudent(req);
  const q = req.query;
  const rideId = toInt(q.rideId);
  await requireRideMember(rideId, me);
  const { rows } = await pool.query(
    `SELECT s.who AS student_id, st.full_name, s.share AS share_amount
     FROM fn_expense_shares($1, $2::numeric, $3, $4::text[], $5::numeric[]) s
     JOIN student st ON st.student_id = s.who`,
    [rideId, toAmount(q.amount), String(q.split || 'equal'), list(q.people), numList(q.values)]);
  res.json({ shares: rows, total: Math.round(rows.reduce((a, r) => a + r.share_amount, 0) * 100) / 100 });
});

async function rideDetail(rideId, me) {
  const [ride, members, expenses, shares, ledger, transfers, audit] = await Promise.all([
    pool.query(
      `SELECT r.ride_id, r.status, r.depart_start, r.cab_type, r.distance_km, lo.name AS origin, ld.name AS destination,
              round(c.base_fare + c.per_km * r.distance_km, 2) AS fare_hint, r.status IN ('departed', 'completed') AS can_add,
              EXISTS (SELECT 1 FROM v_settlement_flow f WHERE f.ride_id = r.ride_id) AS has_settlements
       FROM ride r JOIN location lo ON lo.location_id = r.origin_id JOIN location ld ON ld.location_id = r.dest_id
       JOIN cab_type c ON c.cab_type = r.cab_type WHERE r.ride_id = $1`, [rideId]),
    pool.query(
      `SELECT m.student_id, s.full_name, m.seats_taken FROM ride_member m JOIN student s USING (student_id)
       WHERE m.ride_id = $1 AND m.status = 'confirmed' ORDER BY m.joined_at, m.student_id`, [rideId]),
    pool.query(`SELECT expense_id, paid_by, paid_by_name, amount, note, split_type, created_at, participants
                FROM v_expense_detail WHERE ride_id = $1 ORDER BY created_at DESC, expense_id DESC`, [rideId]),
    pool.query(`SELECT s.expense_id, s.student_id, st.full_name, s.share_amount
                FROM expense_share s JOIN expense e USING (expense_id) JOIN student st ON st.student_id = s.student_id
                WHERE e.ride_id = $1 ORDER BY st.full_name`, [rideId]),
    pool.query(`SELECT l.student_id, st.full_name, l.paid, l.owed, l.settled_out, l.settled_in, l.net
                FROM v_ride_ledger l JOIN student st ON st.student_id = l.student_id
                WHERE l.ride_id = $1 ORDER BY l.net DESC, st.full_name`, [rideId]),
    pool.query(`SELECT t.from_id, fs.full_name AS from_name, t.to_id, ts.full_name AS to_name, t.amount
                FROM fn_simplify_debts($1) t JOIN student fs ON fs.student_id = t.from_id JOIN student ts ON ts.student_id = t.to_id
                ORDER BY t.amount DESC`, [rideId]),
    pool.query(`SELECT a.action, a.amount, a.note, a.happened_at, a.actor_id, s.full_name AS actor_name
                FROM expense_audit a LEFT JOIN student s ON s.student_id = a.actor_id
                WHERE a.ride_id = $1 ORDER BY a.audit_id DESC LIMIT 20`, [rideId]),
  ]);
  if (!ride.rows.length) return null;
  const byExpense = {};
  shares.rows.forEach((s) => { (byExpense[s.expense_id] ||= []).push({ student_id: s.student_id, full_name: s.full_name, share_amount: s.share_amount }); });
  return { ride: ride.rows[0], me, members: members.rows,
           expenses: expenses.rows.map((e) => ({ ...e, shares: byExpense[e.expense_id] || [] })),
           ledger: ledger.rows, transfers: transfers.rows, audit: audit.rows };
}

// GET /api/expenses/ride/:id
router.get('/ride/:id', async (req, res) => {
  const me = actingStudent(req), id = toInt(req.params.id);
  await requireRideMember(id, me);
  res.json(await rideDetail(id, me));
});

// POST /api/expenses  { rideId, amount, note?, split, people?[], values?[] }   payer = logged-in student
router.post('/', async (req, res) => {
  const me = actingStudent(req), b = req.body ?? {};
  const rideId = toInt(b.rideId);
  const split = String(b.split || 'equal');
  if (!SPLITS.includes(split)) throw new HttpError(422, 'Split must be equal, seats, exact or percent');
  const people = list(b.people), values = numList(b.values);
  const expenseId = await withTransaction(async (c) => {
    const { rows } = await c.query(
      `SELECT fn_add_expense($1, $2, $3::numeric, $4, $5, $6::text[], $7::numeric[]) AS id`,
      [rideId, me, toAmount(b.amount), b.note ?? null, split, people.length ? people : null, values.length ? values : null]);
    return rows[0].id;
  });
  res.status(201).json({ expenseId, ...(await rideDetail(rideId, me)) });
});

// DELETE /api/expenses/:id   (only the payer; blocked once money was settled on that ride)
router.delete('/:id', async (req, res) => {
  const me = actingStudent(req);
  await withTransaction((c) => c.query('SELECT fn_delete_expense($1, $2)', [toInt(req.params.id), me]));
  res.status(204).end();
});

export default router;
