// Integrity Lab — Payments + Settlement scenarios (Member 4).
// Each scenario fires real SQL at PostgreSQL inside BEGIN … ROLLBACK (via
// inSandbox) unless it is marked `commits` (the concurrency race, which
// needs two connections and therefore a real COMMIT — it cleans up after
// itself through the normal state machine, leaving an honest audit trail).
import crypto from 'node:crypto';
import { HttpError } from '../errors.js';
import { step, note } from './common.js';

const RECORD = `SELECT payment_id, status, amount FROM fn_record_payment($1::uuid, $2::char(13), $3::int, $4::char(13), $5::numeric, $6::text, $7::text, $8::text)`;
const INSERT = `INSERT INTO payment (client_ref, ride_id, payer_id, payee_id, amount, method, utr) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)`;
const TRANSITION = `SELECT payment_id, status, status_reason FROM fn_transition_payment($1::bigint, $2::char(13), $3::text, $4::text)`;
const uuid = () => crypto.randomUUID();
const utr = () => String(100000000000 + Math.floor(Math.random() * 899999999999));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- live fixtures (discovered from the current data) ----------
function fixtures(c, actor) {
  const one = async (sql, params, what) => {
    const { rows } = await c.query(sql, params);
    if (!rows[0]) throw new HttpError(409, `No suitable data for this scenario (${what}). Re-seed with npm run db:setup.`);
    return rows[0];
  };
  const OPEN_DEBTS = `
    SELECT d.ride_id, d.student_id AS debtor, cr.student_id AS creditor, LEAST(-d.open, cr.open) AS room
    FROM v_ride_balance d
    JOIN v_ride_balance cr ON cr.ride_id = d.ride_id AND cr.open > 0
    WHERE d.open < 0`;
  return {
    // someone who still owes someone on a ride (prefers the acting student)
    debt: () => one(`${OPEN_DEBTS} ORDER BY (d.student_id = $1) DESC, d.ride_id DESC LIMIT 1`, [actor], 'open debt'),
    // two debts on DIFFERENT rides
    twoDebts: async () => {
      const { rows } = await c.query(`
        SELECT DISTINCT ON (x.ride_id) x.* FROM (${OPEN_DEBTS}) x ORDER BY x.ride_id DESC, x.room DESC LIMIT 2`);
      if (rows.length < 2) throw new HttpError(409, 'Need two open debts on different rides.');
      return rows;
    },
    // a debt with no reminder in the last 24 h
    remindable: () => one(`${OPEN_DEBTS}
        AND NOT EXISTS (SELECT 1 FROM payment_reminder pr
                        WHERE pr.ride_id = d.ride_id AND pr.creditor_id = cr.student_id AND pr.debtor_id = d.student_id
                          AND pr.sent_at > now() - INTERVAL '30 hours')   -- the demo backdates by 5 h
      ORDER BY (cr.student_id = $1) DESC, d.ride_id DESC LIMIT 1`, [actor], 'remindable debt'),
    // two debtors on the same ride (one tries to "pay" the other)
    twoDebtors: () => one(`
      SELECT a.ride_id, a.student_id AS debtor, b.student_id AS other_debtor
      FROM v_ride_balance a JOIN v_ride_balance b ON b.ride_id = a.ride_id AND b.student_id <> a.student_id
      WHERE a.open < 0 AND b.net < 0 ORDER BY a.ride_id DESC LIMIT 1`, [], 'ride with two debtors'),
    outsider: (rideId) => one(`
      SELECT student_id FROM student s
      WHERE NOT EXISTS (SELECT 1 FROM ride_member m WHERE m.ride_id = $1 AND m.student_id = s.student_id)
      ORDER BY student_id LIMIT 1`, [rideId], 'outsider'),
    pending: () => one(`
      SELECT payment_id, payer_id, payee_id, amount FROM payment
      WHERE status = 'pending' ORDER BY (payee_id = $1) DESC, created_at DESC LIMIT 1`, [actor], 'pending payment'),
    oldConfirmed: () => one(`
      SELECT payment_id, payer_id, payee_id, amount, confirmed_at FROM payment
      WHERE status = 'confirmed' AND method <> 'offset' AND confirmed_at < now() - fn_reversal_window()
      ORDER BY ($1 IN (payer_id, payee_id)) DESC, confirmed_at DESC LIMIT 1`, [actor], 'old confirmed payment'),
    netoffPair: () => one(`
      SELECT a.student_id AS a_id, b.student_id AS b_id, a.ride_id AS a_owes_on, LEAST(-a.open, b.open) AS cap
      FROM v_ride_balance a JOIN v_ride_balance b ON b.ride_id = a.ride_id
      WHERE a.open < 0 AND b.open > 0
        AND EXISTS (SELECT 1 FROM v_ride_balance x JOIN v_ride_balance y ON y.ride_id = x.ride_id
                    WHERE x.student_id = b.student_id AND y.student_id = a.student_id
                      AND x.open < 0 AND y.open > 0 AND x.ride_id <> a.ride_id)
      ORDER BY (a.student_id = $1) DESC, a.ride_id DESC LIMIT 1`, [actor], 'pair that owe each other on different rides'),
    withDefault: () => one(`
      SELECT student_id FROM payment_method WHERE is_default ORDER BY (student_id = $1) DESC LIMIT 1`, [actor], 'student with a default UPI ID'),
  };
}

const balanceOf = (rideId, debtor, creditor) => [
  `SELECT student_id, net, open FROM v_ride_balance WHERE ride_id = $1 AND student_id IN ($2, $3) ORDER BY net`,
  [rideId, debtor, creditor],
];

export const PAYMENT_SCENARIOS = [
  // ------------------------------------------------------------------ control
  {
    id: 'p_control', group: 'Control', expect: 'accept', rule: null, fixtures,
    title: 'A valid UPI payment is recorded as pending',
    story: 'The debtor records a payment for exactly what they owe. It starts as pending (only the payee can confirm it), the history trigger writes the creation event, and the open balance drops to ₹0, so nobody can ask for that money twice.',
    async run(c, f) {
      const d = await f.debt();
      const s1 = await step(c, RECORD, [uuid(), d.debtor, d.ride_id, d.creditor, d.room, 'upi', utr(), 'Lab control']);
      const id = s1.rows?.[0]?.payment_id;
      const s2 = await step(c, `SELECT from_status, to_status, actor_role FROM payment_event WHERE payment_id = $1`, [id]);
      const [sql, p] = balanceOf(d.ride_id, d.debtor, d.creditor);
      return [s1, s2, await step(c, sql, p)];
    },
  },
  // ----------------------------------------------------------- declarative
  {
    id: 'p_self', group: 'Declarative constraints', expect: 'reject', rule: 'PR2', fixtures,
    title: 'Pay yourself',
    story: 'A raw INSERT with the same payer and payee. The trigger steps aside for single-row rules, so CHECK (payer_id <> payee_id) reports it.',
    async run(c, f) { const d = await f.debt(); return [await step(c, INSERT, [uuid(), d.ride_id, d.debtor, d.debtor, 100, 'cash', null])]; },
  },
  {
    id: 'p_amount', group: 'Declarative constraints', expect: 'reject', rule: 'PR1', fixtures,
    title: 'Pay ₹0',
    story: 'NUMERIC(10,2) with CHECK (amount > 0 AND amount <= 50000).',
    async run(c, f) { const d = await f.debt(); return [await step(c, INSERT, [uuid(), d.ride_id, d.debtor, d.creditor, 0, 'cash', null])]; },
  },
  {
    id: 'p_utr_format', group: 'Declarative constraints', expect: 'reject', rule: 'PR4', fixtures,
    title: 'UPI payment with a malformed UTR',
    story: 'UPI payments must carry a 12-digit UTR (the bank reference) and cash payments must not. One CHECK encodes both directions with a regular expression.',
    async run(c, f) { const d = await f.debt(); return [await step(c, INSERT, [uuid(), d.ride_id, d.debtor, d.creditor, 10, 'upi', '12345'])]; },
  },
  {
    id: 'p_utr_dup', group: 'Declarative constraints', expect: 'reject', rule: 'PR5', fixtures,
    title: 'Reuse a UTR for a second payment',
    story: 'Two different debts, one bank reference. The first INSERT succeeds; the second hits UNIQUE (utr), so the same UPI transfer can never "pay" two debts.',
    async run(c, f) {
      const [a, b] = await f.twoDebts(); const u = utr();
      return [await step(c, INSERT, [uuid(), a.ride_id, a.debtor, a.creditor, Math.min(10, a.room), 'upi', u]),
              await step(c, INSERT, [uuid(), b.ride_id, b.debtor, b.creditor, Math.min(10, b.room), 'upi', u])];
    },
  },
  {
    id: 'p_outsider', group: 'Declarative constraints', expect: 'reject', rule: 'PR3', fixtures,
    title: 'Pay someone who was not on the ride',
    story: 'Composite FOREIGN KEY (ride_id, payee_id) → ride_member: payments only flow between members of that ride. This is the same pattern the ratings module uses.',
    async run(c, f) { const d = await f.debt(); const o = await f.outsider(d.ride_id); return [await step(c, INSERT, [uuid(), d.ride_id, d.debtor, o.student_id, 10, 'cash', null])]; },
  },
  {
    id: 'p_reason', group: 'Declarative constraints', expect: 'reject', rule: 'PR7', fixtures,
    title: 'Reject a payment without saying why',
    story: 'The payee rejects through the proper function, but with no reason. CHECK: status NOT IN (rejected, reversed) OR length(reason) ≥ 5.',
    async run(c, f) { const p = await f.pending(); return [await step(c, TRANSITION, [p.payment_id, p.payee_id, 'rejected', null])]; },
  },
  {
    id: 'p_two_defaults', group: 'Declarative constraints', expect: 'reject', rule: 'PR17', fixtures,
    title: 'Add a second default UPI ID',
    story: 'A PARTIAL unique index, UNIQUE (student_id) WHERE is_default, allows many UPI IDs per student but only one default.',
    async run(c, f) {
      const s = await f.withDefault();
      return [await step(c, `INSERT INTO payment_method (student_id, vpa, label, is_default) VALUES ($1, $2, 'Lab', true)`,
        [s.student_id, `lab${Date.now() % 100000}@okaxis`])];
    },
  },
  // ------------------------------------------------------------ triggers
  {
    id: 'p_overpay', group: 'Trigger rules', expect: 'reject', rule: 'PR10', fixtures,
    title: 'Pay ₹100 more than is owed',
    story: 'The insert trigger locks the ride row, recomputes balances from v_ride_balance (counting pending payments as already reserved) and refuses anything above what is still payable.',
    async run(c, f) { const d = await f.debt(); return [await step(c, INSERT, [uuid(), d.ride_id, d.debtor, d.creditor, Number(d.room) + 100, 'cash', null])]; },
  },
  {
    id: 'p_wrong_payee', group: 'Trigger rules', expect: 'reject', rule: 'PR9', fixtures,
    title: 'Pay a co-rider who is not owed anything',
    story: 'Both are members of the ride (so the FK passes), but the "payee" is another debtor. The trigger checks the payee\'s balance and refuses.',
    async run(c, f) { const d = await f.twoDebtors(); return [await step(c, INSERT, [uuid(), d.ride_id, d.debtor, d.other_debtor, 10, 'cash', null])]; },
  },
  {
    id: 'p_self_confirm', group: 'Trigger rules', expect: 'reject', rule: 'PR12', fixtures,
    title: 'The payer confirms their own payment',
    story: 'Only the payee may confirm. The trigger looks up (pending → confirmed, payer) in the payment_transition table, finds nothing, and lists what is allowed. The state machine is data, not code.',
    async run(c, f) { const p = await f.pending(); return [await step(c, TRANSITION, [p.payment_id, p.payer_id, 'confirmed', null])]; },
  },
  {
    id: 'p_cancel_confirmed', group: 'Trigger rules', expect: 'reject', rule: 'PR12', fixtures,
    title: 'Cancel a payment that was already confirmed',
    story: 'confirmed → cancelled is not an edge of the state machine. From confirmed, the only move is a reversal by the payee.',
    async run(c, f) { const p = await f.oldConfirmed(); return [await step(c, TRANSITION, [p.payment_id, p.payer_id, 'cancelled', null])]; },
  },
  {
    id: 'p_reverse_late', group: 'Trigger rules', expect: 'reject', rule: 'PR13', fixtures,
    title: 'Reverse a confirmation after 72 hours',
    story: 'Reversals are allowed (bank bounced the credit…), but only within fn_reversal_window() of confirmation, checked against the transition time.',
    async run(c, f) { const p = await f.oldConfirmed(); return [await step(c, TRANSITION, [p.payment_id, p.payee_id, 'reversed', 'Bank reversed the credit'])]; },
  },
  {
    id: 'p_edit', group: 'Trigger rules', expect: 'reject', rule: 'PR14', fixtures,
    title: 'Quietly change the amount of a recorded payment',
    story: 'Financial records are append-only. The BEFORE UPDATE trigger freezes every column except the status fields.',
    async run(c, f) { const p = await f.oldConfirmed(); return [await step(c, `UPDATE payment SET amount = amount + 1 WHERE payment_id = $1`, [p.payment_id])]; },
  },
  {
    id: 'p_delete', group: 'Trigger rules', expect: 'reject', rule: 'PR14', fixtures,
    title: 'Delete a payment',
    story: 'Payments are never deleted. Cancel, reject or reverse instead, so the history stays complete.',
    async run(c, f) { const p = await f.oldConfirmed(); return [await step(c, `DELETE FROM payment WHERE payment_id = $1`, [p.payment_id])]; },
  },
  {
    id: 'p_reminder_spam', group: 'Trigger rules', expect: 'reject', rule: 'PR16', fixtures,
    title: 'Send two reminders within 24 hours',
    story: 'An EXCLUDE constraint (GiST) says no two reminders for the same ride, creditor and debtor may have overlapping 24-hour windows (&&). It is a UNIQUE constraint generalised to ranges.',
    async run(c, f) {
      const d = await f.remindable();
      const sql = `INSERT INTO payment_reminder (ride_id, creditor_id, debtor_id, message, sent_at) VALUES ($1, $2, $3, $4, now() - $5::interval)`;
      return [await step(c, sql, [d.ride_id, d.creditor, d.debtor, 'Please settle up 🙏', '5 hours']),
              await step(c, sql, [d.ride_id, d.creditor, d.debtor, 'Reminder again!', '0 hours'])];
    },
  },
  {
    id: 'p_offset_half', group: 'Trigger rules', expect: 'reject', rule: 'PR15', fixtures,
    title: 'Insert only HALF of a net-off',
    story: 'An offset row passes the insert trigger on its own, because the balance check happens at COMMIT. The pair check is a DEFERRABLE INITIALLY DEFERRED constraint trigger; SET CONSTRAINTS … IMMEDIATE makes it fire now, so the lab can show it without committing.',
    async run(c, f) {
      const d = await f.netoffPair();
      const s1 = await step(c, `INSERT INTO payment (client_ref, ride_id, payer_id, payee_id, amount, method, offset_group, status)
        VALUES ($1::uuid, $2, $3, $4, $5, 'offset', $6::uuid, 'confirmed')`, [uuid(), d.a_owes_on, d.a_id, d.b_id, Math.min(10, d.cap), uuid()]);
      const s2 = await step(c, `SET CONSTRAINTS payment_offset_balanced IMMEDIATE`, []);
      return [s1, s2];
    },
  },
  // ------------------------------------------------------- transactions
  {
    id: 'p_idempotent', group: 'Transactions & concurrency', expect: 'accept', rule: 'PR6', fixtures,
    title: 'Double-click "Pay": the same request twice',
    story: 'The client sends a unique idempotency key with every payment attempt. The second call returns the SAME payment instead of creating another, so a double-click or network retry never pays twice.',
    async run(c, f) {
      const d = await f.debt(); const key = uuid(); const u = utr();
      const args = [key, d.debtor, d.ride_id, d.creditor, d.room, 'upi', u, 'Double-click test'];
      return [await step(c, RECORD, args), await step(c, RECORD, args),
              await step(c, `SELECT count(*) AS rows_with_this_key FROM payment WHERE client_ref = $1::uuid`, [key])];
    },
  },
  {
    id: 'p_netoff', group: 'Transactions & concurrency', expect: 'accept', rule: 'PR15', fixtures,
    title: 'Net off two people who owe each other on different rides',
    story: 'fn_net_off locks the rides in ride_id order (so two simultaneous net-offs cannot deadlock), inserts mirrored, already-confirmed offset entries, and the deferred trigger verifies each pair. Campus books still sum to ₹0.',
    async run(c, f) {
      const d = await f.netoffPair();
      const s1 = await step(c, `SELECT * FROM fn_net_off($1, $2)`, [d.a_id, d.b_id]);
      const s2 = await step(c, `SET CONSTRAINTS payment_offset_balanced IMMEDIATE`, []);
      const s3 = await step(c, `SELECT ride_id, payer_id, payee_id, amount, method, status FROM payment WHERE method = 'offset' AND $1 IN (payer_id, payee_id) ORDER BY payment_id DESC LIMIT 2`, [d.a_id]);
      const s4 = await step(c, `SELECT SUM(net) AS campus_sum FROM v_ride_balance`, []);
      return [s1, s2, s3, s4];
    },
  },
  {
    id: 'p_race', group: 'Transactions & concurrency', expect: 'reject', rule: 'PR10', commits: true,
    title: 'Two people pay the same debt at the same instant',
    story: 'Two separate database sessions each try to pay the full amount. Session A takes the ride row lock; session B blocks on it; when A commits, B wakes up, re-reads the balances, sees A\'s payment and is refused. Without the lock both would pass the check. This one must really COMMIT (another session only sees committed data), so it cleans up by cancelling A\'s payment through the normal state machine.',
    async runLive({ pool, actor }) {
      const { rows: [d] } = await pool.query(`
        SELECT d.ride_id, d.student_id AS debtor, cr.student_id AS creditor, LEAST(-d.open, cr.open) AS room
        FROM v_ride_balance d JOIN v_ride_balance cr ON cr.ride_id = d.ride_id AND cr.open > 0
        WHERE d.open < 0 ORDER BY (d.student_id <> $1) DESC, d.ride_id DESC LIMIT 1`, [actor]);
      if (!d) throw new HttpError(409, 'No open debt available for the race.');
      const A = await pool.connect();
      const B = await pool.connect();
      const steps = [];
      try {
        await A.query('BEGIN'); await B.query('BEGIN');
        steps.push(note('-- session A: BEGIN;   session B: BEGIN;', 'Two independent database connections, both inside a transaction'));
        const a = await step(A, RECORD, [uuid(), d.debtor, d.ride_id, d.creditor, d.room, 'cash', null, 'Race: session A'], { session: 'A' });
        steps.push(a);
        const t0 = Date.now();
        const bPromise = step(B, RECORD, [uuid(), d.debtor, d.ride_id, d.creditor, d.room, 'cash', null, 'Race: session B'], { session: 'B' });
        await sleep(900);
        steps.push(note('-- session A: COMMIT;', `Meanwhile session B has been BLOCKED for ${Date.now() - t0} ms, waiting for A's lock on ride #${d.ride_id}`));
        await A.query('COMMIT');
        const b = await bPromise;
        b.waitedMs = Date.now() - t0;
        steps.push(b);
        await B.query('ROLLBACK');
        steps.push(note('-- session B: ROLLBACK;', `B waited ${b.waitedMs} ms in total, then re-read the balances that now include A's payment`));
        const id = a.rows?.[0]?.payment_id;
        if (id) {
          await pool.query(`SELECT fn_transition_payment($1, $2, 'cancelled', 'Concurrency lab clean-up')`, [id, d.debtor]);
          steps.push(note(`SELECT fn_transition_payment(${id}, '${d.debtor}', 'cancelled', 'Concurrency lab clean-up');`,
            'Clean-up: A\'s committed payment is cancelled through the state machine (it stays in the audit trail)'));
        }
      } finally {
        await A.query('ROLLBACK').catch(() => {});
        await B.query('ROLLBACK').catch(() => {});
        A.release(); B.release();
      }
      return steps;
    },
  },
];
