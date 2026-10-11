// Measures each Member 2 index on a scratch database with 150k rides / ~450k bookings / 1M+ events.
// Usage: node bench/bench.mjs  (needs PostgreSQL; creates and drops database poolup_bench)
import pg from 'pg';
import { setupDatabase } from './setup-db.js';
import { LOCATIONS, CAB_TYPES } from './seed.js';
const base = 'postgres://postgres:postgres@localhost:5432/';
const URL = base + 'poolup_bench';
const admin = new pg.Client({ connectionString: base + 'postgres' }); await admin.connect();
await admin.query('DROP DATABASE IF EXISTS poolup_bench');
await setupDatabase(URL, { withSeed: false, log: () => {} });
const c = new pg.Client({ connectionString: URL }); await c.connect();
const q = (s, p) => c.query(s, p);
await q(`INSERT INTO hostel (name) VALUES ('Bench')`);
for (const l of LOCATIONS) await q(`INSERT INTO location (name, loc_type, latitude, longitude) VALUES ($1,$2,$3,$4)`, l);
for (const t of CAB_TYPES) await q(`INSERT INTO cab_type VALUES ($1,$2,$3,$4)`, t);
const N_STU = 10000, N_RIDE = 150000;
await q(`INSERT INTO student (student_id, full_name, email, phone, hostel_id, password_hash)
  SELECT (2022 + i / 2500)::text || 'A7PS' || lpad((i % 2500)::text, 4, '0') || 'H', 'Student ' || i,
         'b' || i || '@hyderabad.bits-pilani.ac.in', (6 + i % 4)::text || lpad(i::text, 9, '0'), 1, repeat('x', 64)
  FROM generate_series(0, ${N_STU - 1}) i`);
for (const t of ['ride', 'ride_member', 'ride_waitlist', 'booking_request', 'booking_event']) await q(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
const sid = (e) => `(2022 + (${e}) / 2500)::text || 'A7PS' || lpad(((${e}) % 2500)::text, 4, '0') || 'H'`;
await q(`INSERT INTO ride (creator_id, origin_id, dest_id, cab_type, depart_start, depart_end, distance_km, status, completed_at, created_at)
  SELECT ${sid('i % ' + N_STU)}, 1 + i % 8, 9 + i % 8, (ARRAY['auto','mini','sedan','suv'])[1 + i % 4],
         t, t + interval '1 hour', 20 + i % 40, CASE WHEN t < now() THEN 'completed' ELSE 'open' END,
         CASE WHEN t < now() THEN t + interval '2 hours' END, t - interval '2 days'
  FROM (SELECT i, now() - interval '200 days' + (i::float8 / ${N_RIDE}) * interval '215 days' AS t FROM generate_series(1, ${N_RIDE}) i) x`);
await q(`INSERT INTO ride_member (ride_id, student_id, seats_taken, status, joined_at)
  SELECT ride_id, creator_id, 1, 'confirmed', created_at FROM ride`);
await q(`INSERT INTO ride_member (ride_id, student_id, seats_taken, status, joined_at)
  SELECT r.ride_id, ${sid('((s.n)::int + k * 37 + 1) % ' + N_STU)}, 1,
         CASE WHEN (r.ride_id + k) % 23 = 0 THEN 'cancelled' ELSE 'confirmed' END, r.created_at
  FROM ride r CROSS JOIN generate_series(1, 2) k
  JOIN LATERAL (SELECT (r.ride_id * 7 % ${N_STU})::int AS n) s ON true ON CONFLICT DO NOTHING`);
await q(`INSERT INTO ride_waitlist (ride_id, student_id, seats, joined_at)
  SELECT 1 + (i * 3) % ${N_RIDE}, ${sid('(i * 11) % ' + N_STU)}, 1, now() - (i % 500) * interval '1 minute'
  FROM generate_series(1, 60000) i ON CONFLICT DO NOTHING`);
await q(`INSERT INTO booking_request (ride_id, student_id, seats, status, created_at, decided_at)
  SELECT 1 + (i * 5) % ${N_RIDE}, ${sid('(i * 13) % ' + N_STU)}, 1, CASE WHEN i % 40 = 0 THEN 'pending' ELSE 'accepted' END,
         now() - (i % 4000) * interval '1 hour', CASE WHEN i % 40 = 0 THEN NULL ELSE now() END
  FROM generate_series(1, 250000) i ON CONFLICT DO NOTHING`);
await q(`INSERT INTO booking_event (ride_id, student_id, event, seats, created_at)
  SELECT 1 + (i * 7) % ${N_RIDE}, ${sid('(i * 17) % ' + N_STU)}, (ARRAY['booked','cancelled','late_cancel','waitlisted','promoted'])[1 + i % 5], 1, now() - (i % 100000) * interval '5 minutes'
  FROM generate_series(1, 1200000) i`);
await q('ANALYZE');
const counts = (await q(`SELECT (SELECT count(*) FROM ride)::int rides,(SELECT count(*) FROM ride_member)::int members,(SELECT count(*) FROM ride_waitlist)::int waitlist,(SELECT count(*) FROM booking_request)::int requests,(SELECT count(*) FROM booking_event)::int events`)).rows[0];

const probeRide = 70001, probeStu = sid('4321').replace(/^/, '').length && (await q(`SELECT ${sid('4321')} AS s`)).rows[0].s;
const tests = [
  { name: 'Seats taken for rides departing in the next 2 days (seat map / search)', index: 'member_confirmed_seats_idx',
    sql: `SELECT ride_id, sum(seats_taken) FROM ride_member WHERE status = 'confirmed' AND ride_id IN
          (SELECT ride_id FROM ride WHERE depart_start BETWEEN now() + interval '1 day' AND now() + interval '3 days') GROUP BY ride_id` },
  { name: 'Waitlist queue of one ride in FIFO order (promotion)', index: 'waitlist_fifo_idx',
    sql: `SELECT * FROM ride_waitlist WHERE ride_id = ${probeRide} ORDER BY joined_at, student_id` },
  { name: 'Latest 40 notifications of one student', index: 'event_student_idx',
    sql: `SELECT * FROM booking_event WHERE student_id = '${probeStu}' ORDER BY created_at DESC LIMIT 40` },
  { name: 'My requests, newest first', index: 'request_student_idx',
    sql: `SELECT * FROM booking_request WHERE student_id = '${probeStu}' ORDER BY created_at DESC LIMIT 30` },
  { name: 'Creator inbox: pending requests of 20 rides', index: 'request_one_pending',
    sql: `SELECT * FROM booking_request WHERE status = 'pending' AND ride_id = ANY(ARRAY[${Array.from({ length: 20 }, (_, i) => 1 + i * 7000).join(',')}])` },
];
const run = async (sql) => {
  let best = Infinity, plan = '';
  for (let i = 0; i < 5; i++) {
    const rows = (await q(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`)).rows.map((r) => r['QUERY PLAN']);
    const ms = parseFloat(/Execution Time: ([\d.]+)/.exec(rows.join('\n'))[1]);
    if (ms < best) { best = ms; plan = rows; }
  }
  const node = plan.find((l) => /(Index Only Scan|Index Scan|Bitmap Heap Scan|Seq Scan|Parallel Seq Scan)/.test(l))?.trim().replace(/\s+\(cost.*/, '') ?? '';
  const buf = /Buffers: shared (?:hit=(\d+))?(?: read=(\d+))?/.exec(plan.join('\n'));
  return { ms: best, node, buffers: (+(buf?.[1] ?? 0)) + (+(buf?.[2] ?? 0)) };
};
const out = { counts, tests: [] };
for (const t of tests) {
  const def = (await q(`SELECT indexdef FROM pg_indexes WHERE indexname = $1`, [t.index])).rows[0].indexdef;
  const size = (await q(`SELECT pg_size_pretty(pg_relation_size($1::regclass)) s`, [t.index])).rows[0].s;
  const isUnique = /UNIQUE/.test(def);
  let without;
  if (isUnique) { without = null; }
  else { await q(`DROP INDEX ${t.index}`); await q('ANALYZE'); without = await run(t.sql); await q(def); await q('ANALYZE'); }
  const withIdx = await run(t.sql);
  out.tests.push({ ...t, def, size, without, with: withIdx, speedup: without ? +(without.ms / withIdx.ms).toFixed(1) : null });
  console.log(t.name, '|', without ? `${without.ms} ms (${without.node}, ${without.buffers} buf)` : 'n/a', '->', `${withIdx.ms} ms (${withIdx.node}, ${withIdx.buffers} buf)`, '| index', size);
}
import fs from 'node:fs'; fs.writeFileSync('/tmp/bench.json', JSON.stringify(out, null, 1));
console.log(counts);
await c.end(); await admin.query('DROP DATABASE poolup_bench'); await admin.end();
