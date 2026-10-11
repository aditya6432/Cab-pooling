// =====================================================================
// PoolUp — demo data for the Payments + Settlement module (Member 4)
// ---------------------------------------------------------------------
// Runs after Members 1–3's seeds and the demo story, in the same transaction.
// * Uses its OWN seeded PRNG, so adding payments never changes the rides,
//   bookings or expenses generated before it.
// * Every payment comes from the database's own fn_settlement_plan(), read
//   through CROSS JOIN LATERAL, so each one passes the overpayment trigger.
// * Histories go through the real state machine (pending → confirmed /
//   rejected / cancelled / expired, confirmed → reversed) by UPDATEs made
//   under the right actor role, exactly as the API does; the event trigger
//   writes payment_event for each step.
// * Late payers come from seed/traits.js, the same traits the ratings seed
//   uses for "Payment delayed" tags, so the cross-module analytics agree.
// =====================================================================
import { mulberry32, traitsFor, DEMO_ID } from './traits.js';

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const BANKS = ['okhdfc', 'okicici', 'oksbi', 'ybl', 'paytm', 'axl', 'ibl'];
const REJECT_REASONS = ['UTR not found in my bank statement', 'Received a different amount', 'Wrong UPI ID used, money not received'];
const CASH_REJECT = 'Cash not received yet';
const REVERSE_REASONS = ['Bank reversed the credit', 'Confirmed by mistake, money not received'];
const CANCEL_REASONS = ['Paid the wrong amount, re-sending', 'Sent to the wrong UPI ID'];
const REMINDERS = ['Hey! Could you settle the cab fare when you get a chance?', 'Gentle reminder for the ride share 🙏',
  'Please pay your share of the cab', 'Reminder: cab fare from last trip'];

async function insertRows(client, table, columns, rows, returning = '') {
  const out = [];
  for (let i = 0; i < rows.length; i += 400) {
    const part = rows.slice(i, i + 400);
    const params = [];
    const tuples = part.map((row) => '(' + row.map((v) => { params.push(v); return '$' + params.length; }).join(',') + ')');
    const res = await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')} ${returning}`, params);
    out.push(...res.rows);
  }
  return out;
}

// Bulk status change through the state machine, acting as `role`.
async function transition(client, role, changes) {
  if (!changes.length) return;
  await client.query("SELECT set_config('poolup.actor_role', $1, true), set_config('poolup.actor_id', '', true)", [role]);
  for (let i = 0; i < changes.length; i += 400) {
    const part = changes.slice(i, i + 400);
    const params = [];
    const tuples = part.map((c) => {
      params.push(c.id, c.status, c.reason ?? null, new Date(c.at));
      const n = params.length;
      return `($${n - 3}::bigint, $${n - 2}::text, $${n - 1}::text, $${n}::timestamptz)`;
    });
    await client.query(`
      UPDATE payment p
         SET status = v.status, status_reason = v.reason, status_changed_at = v.at
        FROM (VALUES ${tuples.join(',')}) AS v(id, status, reason, at)
       WHERE p.payment_id = v.id`, params);
  }
}

export async function seedPayments(client, { now = new Date(), story }) {
  const NOW = now.getTime();
  const rand = mulberry32(4242);
  const uniform = (a, b) => a + (b - a) * rand();
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const uuid = () => {
    const h = Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16)).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[Math.floor(rand() * 4)]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  const usedUtr = new Set();
  const utr = () => {
    let u;
    do { u = String(Math.floor(uniform(1e11, 1e12 - 1))); } while (usedUtr.has(u));
    usedUtr.add(u);
    return u;
  };

  const { rows: students } = await client.query(`SELECT student_id::text AS id, full_name AS name FROM student ORDER BY student_id`);
  const traits = new Map(students.map((s) => [s.id, traitsFor(s.id)]));

  // ---------------- UPI IDs ----------------
  const methodRows = [];
  const usedVpa = new Set();
  for (const s of students) {
    if (traits.get(s.id).cashOnly) continue;                  // a few cash-only students
    const [first, last] = s.name.toLowerCase().replace(/[^a-z ]/g, '').split(' ');
    const roll = s.id.slice(8, 12);
    let vpa = s.id === DEMO_ID ? 'aarav.mehta@okhdfc' : `${first}.${last}${roll}@${pick(BANKS)}`;
    if (usedVpa.has(vpa)) continue;
    usedVpa.add(vpa);
    methodRows.push([s.id, vpa, 'Primary', true]);
    if (rand() < 0.3) {
      vpa = `${first}${roll}@${pick(BANKS)}`;
      if (!usedVpa.has(vpa)) { usedVpa.add(vpa); methodRows.push([s.id, vpa, 'Backup', false]); }
    }
  }
  await insertRows(client, 'payment_method', ['student_id', 'vpa', 'label', 'is_default'], methodRows);

  // ---------------- what does each ride still need? ----------------
  const { rows: plan } = await client.query(`
    SELECT r.ride_id, p.from_id, p.to_id, p.amount::text AS amount
    FROM ride r
    CROSS JOIN LATERAL fn_settlement_plan(r.ride_id) p
    WHERE r.status = 'completed'
    ORDER BY r.ride_id, p.from_id, p.to_id`);
  const { rows: rideRows } = await client.query(
    `SELECT ride_id, extract(epoch FROM completed_at) * 1000 AS completed_ms FROM ride WHERE status = 'completed'`);
  const rideById = new Map(rideRows.map((r) => [r.ride_id, { id: r.ride_id, completedAt: Number(r.completed_ms) }]));

  // hand-crafted money state for the demo student's rides (see seed/demo_story.js)
  const S = story.rides, C = story.co;
  const ov = new Map();
  const set = (label, who, spec) => ov.set(`${S[label].id}:${who}`, spec);
  set('A', C[0],    { fate: 'pending',   delayH: 3,  method: 'upi' });                 // Aarav must confirm
  set('A', C[1],    { fate: 'confirmed', delayH: 1,  confirmH: 1, method: 'upi' });
  set('A', C[2],    { fate: 'unpaid' });                                                // Aarav can remind
  set('B', DEMO_ID, { fate: 'unpaid' });                                                // Aarav must pay
  set('B', C[4],    { fate: 'confirmed', delayH: 5,  confirmH: 2, method: 'cash' });
  set('D', C[6],    { fate: 'confirmed', delayH: 12, confirmH: 3, method: 'upi' });
  set('D', C[7],    { fate: 'stale',     delayH: 20, method: 'upi' });                 // >7 days pending → expiry demo
  set('E', DEMO_ID, { fate: 'unpaid' });                                                // Aarav must pay
  set('F', C[3],    { fate: 'unpaid' });                                                // net-off with ride B
  set('F', C[9],    { fate: 'confirmed', delayH: 6,  confirmH: 4, method: 'upi' });
  set('H', C[13],   { fate: 'unpaid' });                                                // H + I: a second net-off pair
  set('H', C[14],   { fate: 'confirmed', delayH: 8,  confirmH: 2, method: 'upi' });
  set('I', C[12],   { fate: 'unpaid' });
  set('I', C[14],   { fate: 'confirmed', delayH: 4,  confirmH: 6, method: 'cash' });
  const storyRides = new Set(Object.values(S).map((r) => r.id));

  const attempts = [];
  const unpaid = [];
  for (const line of plan) {
    const r = rideById.get(line.ride_id);
    const key = `${line.ride_id}:${line.from_id}`;
    let spec = ov.get(key);
    if (!spec && storyRides.has(line.ride_id)) spec = { fate: 'unpaid' };
    if (!spec) {
      const late = traits.get(String(line.from_id).trim())?.latePayer;
      const delayDays = late ? uniform(2, 9) : uniform(0.05, 1.5);
      const h = { delayDays, willPay: r.completedAt + delayDays * DAY < NOW && rand() < (late ? 0.75 : 0.97),
                  method: traits.get(String(line.to_id).trim())?.cashOnly || rand() >= 0.9 ? 'cash' : 'upi' };
      if (!h.willPay) spec = { fate: 'unpaid' };
      else {
        const u = rand();
        const fate = u < 0.025 ? 'rejected' : u < 0.045 ? 'cancelled' : u < 0.055 ? 'reversed' : u < 0.062 ? 'ignored' : 'confirmed';
        spec = { fate, delayH: h.delayDays * 24, confirmH: uniform(0.5, 30), method: h.method };
      }
    }
    const created = spec.fate === 'unpaid' ? null : r.completedAt + spec.delayH * HOUR;
    if (!created || created > NOW - 20 * MIN) { unpaid.push({ line, r }); continue; }
    attempts.push({ line, r, spec, created, ref: uuid(), method: spec.method, utr: spec.method === 'upi' ? utr() : null });
  }

  // Phase 1 — record every first attempt (all start pending)
  const ins = (list) => insertRows(client, 'payment',
    ['client_ref', 'ride_id', 'payer_id', 'payee_id', 'amount', 'method', 'utr', 'created_at'],
    list.map((a) => [a.ref, a.line.ride_id, a.line.from_id, a.line.to_id, a.line.amount, a.method, a.utr, new Date(a.created)]),
    'RETURNING payment_id, client_ref');
  const mapIds = (list, rows) => {
    const byRef = new Map(rows.map((x) => [x.client_ref, x.payment_id]));
    for (const a of list) a.id = byRef.get(a.ref);
  };
  mapIds(attempts, await ins(attempts));

  // Phase 2 — what happened next
  const payee = [], payer = [], system = [], reversals = [], retries = [];
  const cutoff = NOW - 5 * MIN;
  for (const a of attempts) {
    const { fate } = a.spec;
    if (fate === 'confirmed') {
      const t = a.created + a.spec.confirmH * HOUR;
      if (t <= cutoff) payee.push({ id: a.id, status: 'confirmed', at: t });
    } else if (fate === 'rejected') {
      const t = a.created + uniform(2, 20) * HOUR;
      if (t <= cutoff) {
        payee.push({ id: a.id, status: 'rejected', reason: a.method === 'cash' ? CASH_REJECT : pick(REJECT_REASONS), at: t });
        retries.push({ a, after: t });
      }
    } else if (fate === 'cancelled') {
      const t = a.created + uniform(0.2, 3) * HOUR;
      if (t <= cutoff) { payer.push({ id: a.id, status: 'cancelled', reason: pick(CANCEL_REASONS), at: t }); retries.push({ a, after: t }); }
    } else if (fate === 'ignored') {
      const t = a.created + 7 * DAY + uniform(0.5, 10) * HOUR;
      if (t <= cutoff) { system.push({ id: a.id, status: 'expired', reason: 'No response within 7 days', at: t }); retries.push({ a, after: t }); }
    } else if (fate === 'reversed') {
      const tc = a.created + a.spec.confirmH * HOUR;
      if (tc <= cutoff) {
        payee.push({ id: a.id, status: 'confirmed', at: tc });
        const tr = tc + uniform(2, 40) * HOUR;
        if (tr <= cutoff) { reversals.push({ id: a.id, status: 'reversed', reason: pick(REVERSE_REASONS), at: tr }); retries.push({ a, after: tr }); }
      }
    }
    // 'pending' and 'stale' stay pending on purpose
  }
  await transition(client, 'payee', payee);
  await transition(client, 'payer', payer);
  await transition(client, 'system', system);
  await transition(client, 'payee', reversals);

  // Phase 3 — the debtor pays again after a failed attempt
  const repay = [];
  for (const { a, after } of retries) {
    const created = after + uniform(3, 36) * HOUR;
    if (created > NOW - 20 * MIN) { unpaid.push({ line: a.line, r: a.r }); continue; }
    const method = rand() < 0.9 ? 'upi' : 'cash';
    repay.push({ line: a.line, r: a.r, created, ref: uuid(), method, utr: method === 'upi' ? utr() : null,
      confirmAt: created + uniform(0.5, 20) * HOUR });
  }
  mapIds(repay, await ins(repay));
  await transition(client, 'payee', repay.filter((a) => a.confirmAt <= cutoff).map((a) => ({ id: a.id, status: 'confirmed', at: a.confirmAt })));

  // ---------------- reminders for debts still unpaid after 2 days ----------------
  const reminderRows = [];
  for (const { line, r } of unpaid) {
    let t = r.completedAt + uniform(2.2, 3) * DAY;
    let n = 0;
    while (t < NOW - 10 * MIN && n < 3) {
      reminderRows.push([line.ride_id, line.to_id, line.from_id, pick(REMINDERS), new Date(t)]);
      t += uniform(1.3, 3) * DAY;
      n++;
    }
  }
  await insertRows(client, 'payment_reminder', ['ride_id', 'creditor_id', 'debtor_id', 'message', 'sent_at'], reminderRows);

  const { rows: [c] } = await client.query(`
    SELECT (SELECT count(*) FROM payment)::int        AS payments,
           (SELECT count(*) FROM payment_event)::int  AS payment_events`);
  return { upi_ids: methodRows.length, ...c, reminders: reminderRows.length, unpaid_debts: unpaid.length };
}
