// =====================================================================
// Demo storyline for the demo student (Aarav Mehta, 2023A7PS0001H).
// Runs after the M1, M2 and M3 seeds and before M4 / M5, inside the same
// transaction. It adds a handful of RECENT rides whose money and rating
// state is hand-crafted (by seed/m4_payments.js and seed/m5_ratings.js),
// so every workflow of every module has something live to show in a demo:
//
//   G  hosted by Aarav, left 50 min ago (departed) → "Complete ride", then
//      add the fare, settle, rate: the full five-module lifecycle
//   A  completed ~30 h ago, Aarav paid the fare  → confirm a pending payment,
//      remind a debtor, rate all three co-riders in one transaction
//   B  completed ~3 days ago, a co-rider paid     → Aarav must pay; one rating
//      already given 3 h ago (still editable)
//   E  completed ~2 days ago, one rider no-show   → "can't rate a no-show"
//   D  completed 10 days ago                       → rating window closed;
//      a payment pending > 7 days (expiry job)
//   F  completed 12 days ago, Aarav paid ₹540     → the ride-B payer owes
//      Aarav here while Aarav owes them on B → a net-off opportunity
//   H, I  two other students who owe each other on two different rides:
//      a second net-off opportunity (Integrity Lab, Money dashboard)
//
// Rides are written under poolup.seeding = 'on' (skips only the clock rules
// "must start in the future"); every expense goes through Member 3's
// fn_add_expense, so all splitting rules still apply.
// =====================================================================
import { DEMO_ID } from './traits.js';

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;

export async function seedDemoStory(client, { now = new Date() } = {}) {
  const q = (sql, params) => client.query(sql, params);
  const NOW = now.getTime();
  await q(`SET LOCAL poolup.seeding = 'on'`);

  const loc = async (prefix) => (await q(`SELECT location_id FROM location WHERE name LIKE $1 ORDER BY location_id LIMIT 1`, [`${prefix}%`])).rows[0].location_id;
  const places = [];
  for (const p of ['BPHC Main Gate', 'RGIA', 'Secunderabad', 'Inorbit', 'Lulu', 'Hitech']) places.push(await loc(p));   // sequential: one client
  const [gate, airport, secbad, inorbit, lulu, hitech] = places;

  // Co-riders: regular students who are free in every story window and not the
  // people Member 2's story already uses. Deterministic: ordered by md5(id).
  const busyIn = async (sid, start, end) => (await q(
    `SELECT 1 FROM ride_member m JOIN ride r USING (ride_id)
      WHERE m.student_id = $1 AND m.status IN ('confirmed','no_show') AND r.status <> 'cancelled'
        AND r.depart_start < $3 AND r.depart_end + interval '2 hours' > $2 LIMIT 1`, [sid, start, end])).rowCount > 0;
  const { rows: cand } = await q(
    `SELECT s.student_id::text AS id,
            (SELECT count(*) FROM ride_member m WHERE m.student_id = s.student_id AND m.status = 'no_show')::int AS no_shows
       FROM student s
      WHERE s.student_id <> $1
        AND NOT EXISTS (SELECT 1 FROM ride r WHERE r.creator_id = s.student_id AND r.depart_start > now())
      ORDER BY md5(s.student_id || 'story')`, [DEMO_ID]);

  const PLAN = [
    // label, start offset, minutes travelled, cab, origin, dest, creator ('demo' or co-rider index), riders, extra
    { label: 'G', start: -50 * MIN, travel: null, cab: 'sedan', o: gate, d: hitech,  creator: 'demo', riders: ['demo', 10, 11] },
    { label: 'A', start: -30 * HOUR, travel: 70, cab: 'suv',   o: gate, d: airport, creator: 'demo', riders: ['demo', 0, 1, 2], payer: 'demo' },
    { label: 'B', start: -75 * HOUR, travel: 55, cab: 'sedan', o: gate, d: secbad,  creator: 3,      riders: [3, 'demo', 4],    payer: 3 },
    { label: 'E', start: -50 * HOUR, travel: 75, cab: 'sedan', o: gate, d: airport, creator: 8,      riders: [8, 'demo', 'flaky'], payer: 8, noShow: 'flaky' },
    { label: 'D', start: -10 * DAY,  travel: 60, cab: 'mini',  o: gate, d: inorbit, creator: 'demo', riders: ['demo', 6, 7],    payer: 'demo' },
    { label: 'F', start: -12 * DAY,  travel: 45, cab: 'sedan', o: gate, d: lulu,    creator: 'demo', riders: ['demo', 3, 9],    payer: 'demo', fare: 540 },
    // a second net-off pair between two other students (for the lab and the dashboard list)
    { label: 'H', start: -5 * DAY,   travel: 60, cab: 'sedan', o: gate, d: secbad,  creator: 12,     riders: [12, 13, 14],      payer: 12 },
    { label: 'I', start: -8 * DAY,   travel: 50, cab: 'mini',  o: gate, d: inorbit, creator: 13,     riders: [13, 12, 14],      payer: 13 },
  ];

  // 1. fix each ride's start so that Aarav himself is free then (shift past rides by a few hours if needed)
  for (const p of PLAN) {
    const shifts = p.label === 'G' ? [0] : [0, -3, 3, -6, 6, -9, 9].map((h) => h * HOUR);
    for (const sh of shifts) {
      const at = Math.round((NOW + p.start + sh) / (5 * MIN)) * 5 * MIN;
      if (sh === shifts[shifts.length - 1] || !(await busyIn(DEMO_ID, new Date(at - HOUR), new Date(at + 3 * HOUR)))) { p.at = at; break; }
    }
  }
  // 2. pick co-riders who are free during every window they appear in
  const windows = (idx) => PLAN.filter((p) => p.riders.includes(idx)).map((p) => [p.at - HOUR, p.at + 3 * HOUR]);
  const co = {};
  const taken = new Set();
  for (const idx of [...new Set(PLAN.flatMap((p) => p.riders))].filter((x) => x !== 'demo')) {
    for (const c of cand) {
      if (taken.has(c.id)) continue;
      if (idx === 'flaky' ? c.no_shows === 0 : c.no_shows > 0) continue;   // the no-show rider has a history of it
      let free = true;
      for (const [a, b] of windows(idx)) if (await busyIn(c.id, new Date(a), new Date(b))) { free = false; break; }
      if (free) { co[idx] = c.id; taken.add(c.id); break; }
    }
    if (!co[idx]) throw new Error(`demo story: no free co-rider for slot ${idx}`);
  }
  const who = (x) => (x === 'demo' ? DEMO_ID : co[x]);

  const rides = {};
  for (const p of PLAN) {
    const start = new Date(p.at);
    const end = new Date(start.getTime() + 60 * MIN);
    const completed = p.travel ? new Date(start.getTime() + p.travel * MIN) : null;
    const status = completed ? 'completed' : 'departed';
    const km = (await q(`SELECT fn_route_km($1, $2) AS km`, [p.o, p.d])).rows[0].km;
    const created = new Date(start.getTime() - 30 * HOUR);
    const { rows: [r] } = await q(
      `INSERT INTO ride (creator_id, origin_id, dest_id, cab_type, depart_start, depart_end, distance_km, status, completed_at, created_at, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ride_id`,
      [who(p.creator), p.o, p.d, p.cab, start, end, km, status, completed, created,
       p.label === 'A' ? 'Flight at 9, leaving on the dot' : null]);
    const id = r.ride_id;                                     // the creator's seat was added by trigger
    for (const [i, x] of p.riders.entries()) {
      if (x === p.creator) continue;
      const sid = who(x);
      const joined = new Date(created.getTime() + (2 + i) * HOUR);
      await q(`INSERT INTO ride_member (ride_id, student_id, seats_taken, status, joined_at) VALUES ($1, $2, 1, $3, $4)`,
        [id, sid, x === p.noShow ? 'no_show' : 'confirmed', joined]);
      if (x === p.noShow) {     // the booking trigger only logs confirmed seats; log the no-show story by hand
        await q(`INSERT INTO booking_event (ride_id, student_id, event, seats, created_at) VALUES ($1, $2, 'booked', 1, $3), ($1, $2, 'no_show', 1, $4)`,
          [id, sid, joined, end]);
      }
    }
    // status history the ride_status trigger would have written
    await q(`INSERT INTO ride_status_log (ride_id, old_status, new_status, changed_at) VALUES ($1, 'open', 'departed', $2)`, [id, start]);
    if (completed) await q(`INSERT INTO ride_status_log (ride_id, old_status, new_status, changed_at) VALUES ($1, 'departed', 'completed', $2)`, [id, completed]);

    // the cab fare, through Member 3's function (equal split among confirmed riders)
    if (p.payer !== undefined) {
      const fare = p.fare ?? Math.round((await q(`SELECT fn_estimate_fare($1, $2) AS f`, [p.cab, km])).rows[0].f / 10) * 10;
      const { rows: [e] } = await q(`SELECT fn_add_expense($1, $2, $3::numeric, 'Cab fare', 'equal') AS id`, [id, who(p.payer), fare]);
      const at = new Date(completed.getTime() + 20 * MIN);
      await q(`UPDATE expense SET created_at = $1 WHERE expense_id = $2`, [at, e.id]);
      await q(`UPDATE expense_audit SET happened_at = $1 WHERE expense_id = $2`, [at, e.id]);
    }
    rides[p.label] = { id, completedAt: completed?.getTime() ?? null, members: p.riders.map(who), payer: p.payer !== undefined ? who(p.payer) : null };
  }

  return {
    demo: DEMO_ID,
    rides,                                  // label → { id, completedAt, members, payer }
    co: Object.fromEntries(Object.entries(co).map(([k, v]) => [k, v])),
    labels: Object.fromEntries(Object.entries(rides).map(([k, v]) => [k, v.id])),
  };
}
