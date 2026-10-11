// Member 2 demo-data generator: runs right after Member 1's seed, inside the same transaction.
// Deterministic (hash-based SQL + seeded PRNG). Historical rows are written under
// SET LOCAL poolup.seeding = 'on' (skips only the time-based trigger rules); every CHECK / FK /
// UNIQUE constraint, the capacity trigger and the status-flow triggers still apply.
const DAY = 24 * 3600e3, HOUR = 3600e3;
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const H = (expr) => `abs(hashtext(${expr}))`;     // deterministic pseudo-random integer per row

export async function seedBooking(client, { now = new Date() } = {}) {
  const q = (sql, params) => client.query(sql, params);
  const rand = mulberry32(20261009);
  await q(`SET LOCAL poolup.seeding = 'on'`);

  // 1. normalise Member 1's joined_at: after the ride was created, never in the future
  await q(`UPDATE ride_member m SET joined_at = LEAST(GREATEST(m.joined_at, r.created_at + interval '10 minutes'), now() - interval '5 minutes')
           FROM ride r WHERE r.ride_id = m.ride_id AND m.student_id <> r.creator_id`);

  // 2. rebuild the audit trail from the final state (the bulk load logged 'booked' with raw timestamps)
  await q(`DELETE FROM booking_event`);
  await q(`INSERT INTO booking_event (ride_id, student_id, event, seats, created_at)
           SELECT m.ride_id, m.student_id, 'booked', m.seats_taken, m.joined_at
           FROM ride_member m JOIN ride r ON r.ride_id = m.ride_id WHERE m.student_id <> r.creator_id`);
  await q(`INSERT INTO booking_event (ride_id, student_id, event, seats, created_at)
           SELECT m.ride_id, m.student_id, 'no_show', m.seats_taken, r.depart_end
           FROM ride_member m JOIN ride r ON r.ride_id = m.ride_id WHERE m.status = 'no_show'`);

  // 3. riders who board / leave at an intermediate stop (ride pooling)
  await q(`UPDATE ride_member m SET pickup_id = s.location_id
           FROM ride_stop s, ride r
           WHERE s.ride_id = m.ride_id AND s.stop_seq = 1 AND r.ride_id = m.ride_id
             AND m.student_id <> r.creator_id AND ${H(`'p' || m.ride_id::text || m.student_id`)} % 100 < 22`);
  await q(`UPDATE ride_member m SET dropoff_id = (SELECT s.location_id FROM ride_stop s WHERE s.ride_id = m.ride_id ORDER BY s.stop_seq DESC LIMIT 1)
           FROM ride r
           WHERE r.ride_id = m.ride_id AND m.student_id <> r.creator_id AND m.pickup_id IS NULL
             AND EXISTS (SELECT 1 FROM ride_stop s WHERE s.ride_id = m.ride_id)
             AND ${H(`'d' || m.ride_id::text || m.student_id`)} % 100 < 22`);

  // 4. cancelled bookings (9% of rider bookings; some late = within 2 h of departure)
  await q(`UPDATE ride_member m SET status = 'cancelled', cancel_reason = 'self',
             cancelled_at = m.joined_at + (LEAST(r.depart_start, now() - interval '1 minute') - m.joined_at)
                                          * (0.25 + 0.74 * (${H(`'c' || m.ride_id::text || m.student_id`)} % 100) / 100.0)::float8
           FROM ride r
           WHERE r.ride_id = m.ride_id AND m.student_id <> r.creator_id AND m.status = 'confirmed'
             AND r.status IN ('completed', 'open') AND ${H(`'x' || m.ride_id::text || m.student_id`)} % 100 < 9`);

  // 5. riders whose ride was cancelled by its creator
  const cr = await q(`WITH ins AS (
      INSERT INTO ride_member (ride_id, student_id, seats_taken, status, joined_at, cancelled_at, cancel_reason)
      SELECT r.ride_id, s.student_id, 1, 'cancelled', r.created_at + interval '30 minutes',
             r.created_at + interval '30 minutes' + (r.depart_start - r.created_at) * 0.4, 'ride_cancelled'
      FROM ride r
      JOIN LATERAL (SELECT student_id FROM student WHERE student_id <> r.creator_id
                    ORDER BY md5(student_id || r.ride_id::text) LIMIT 1) s ON true
      WHERE r.status = 'cancelled' AND ${H('r.ride_id::text')} % 100 < 60
      RETURNING ride_id, student_id, joined_at, cancelled_at)
    INSERT INTO booking_event (ride_id, student_id, event, seats, created_at)
    SELECT ride_id, student_id, 'booked', 1, joined_at FROM ins
    UNION ALL SELECT ride_id, student_id, 'ride_cancelled', 1, cancelled_at FROM ins`);

  // 6. booking policy: ~14% of rides ask the creator to approve riders
  await q(`INSERT INTO ride_booking_policy (ride_id, join_mode, updated_at)
           SELECT ride_id, 'approval', created_at FROM ride
           WHERE status IN ('open', 'full', 'completed') AND ${H(`'pol' || ride_id::text`)} % 100 < 14`);
  // accepted requests = the riders who are on those rides
  await q(`INSERT INTO booking_request (ride_id, student_id, seats, pickup_id, dropoff_id, status, created_at)
           SELECT m.ride_id, m.student_id, m.seats_taken, m.pickup_id, m.dropoff_id, 'pending',
                  m.joined_at - interval '1 hour' - (${H(`m.ride_id::text || m.student_id`)} % 60) * interval '1 minute'
           FROM ride_member m JOIN ride r ON r.ride_id = m.ride_id
           JOIN ride_booking_policy p ON p.ride_id = m.ride_id AND p.join_mode = 'approval'
           WHERE m.student_id <> r.creator_id AND m.status IN ('confirmed', 'no_show')`);
  await q(`UPDATE booking_request q SET status = 'accepted', decided_at = m.joined_at
           FROM ride_member m WHERE m.ride_id = q.ride_id AND m.student_id = q.student_id AND q.status = 'pending'`);
  // rejected / withdrawn requests from students who never got a seat
  await q(`INSERT INTO booking_request (ride_id, student_id, seats, status, created_at)
           SELECT r.ride_id, s.student_id, 1, 'pending', r.created_at + interval '20 minutes'
           FROM ride r JOIN ride_booking_policy p ON p.ride_id = r.ride_id AND p.join_mode = 'approval'
           JOIN LATERAL (SELECT st.student_id FROM student st
                         WHERE st.student_id <> r.creator_id
                           AND NOT EXISTS (SELECT 1 FROM ride_member m WHERE m.ride_id = r.ride_id AND m.student_id = st.student_id)
                         ORDER BY md5(st.student_id || 'rq' || r.ride_id::text) LIMIT 1) s ON true
           WHERE r.status IN ('completed', 'cancelled') AND ${H(`'rq' || r.ride_id::text`)} % 100 < 55`);
  await q(`UPDATE booking_request SET status = CASE WHEN ${H('request_id::text')} % 2 = 0 THEN 'rejected' ELSE 'withdrawn' END,
                  decided_at = LEAST(created_at + interval '2 hours', now() - interval '1 minute')
           WHERE status = 'pending' AND created_at < now() - interval '1 day'`);

  // 7. fill ~28 upcoming rides completely, then queue people on the waitlist of every full ride
  const students = (await q(`SELECT student_id FROM student ORDER BY student_id`)).rows.map((r) => r.student_id.trim());
  const pickStudents = async (rideId, n) => {
    const busy = new Set((await q(`SELECT student_id FROM ride_member WHERE ride_id = $1 UNION SELECT student_id FROM ride_waitlist WHERE ride_id = $1 UNION SELECT student_id FROM booking_request WHERE ride_id = $1`, [rideId])).rows.map((r) => r.student_id.trim()));
    const out = [];
    for (let guard = 0; out.length < n && guard < 400; guard++) {
      const s = students[Math.floor(rand() * students.length)];
      if (!busy.has(s)) { busy.add(s); out.push(s); }
    }
    return out;
  };
  const upcoming = (await q(`SELECT r.ride_id, c.max_seats FROM ride r JOIN cab_type c USING (cab_type)
                              WHERE r.status = 'open' AND r.depart_start > now() + interval '3 hours'
                                AND NOT EXISTS (SELECT 1 FROM ride_booking_policy p WHERE p.ride_id = r.ride_id AND p.join_mode = 'approval')
                              ORDER BY ${H('r.ride_id::text')} LIMIT 28`)).rows;
  for (const r of upcoming) {
    const left = (await q(`SELECT fn_seats_left($1) AS n`, [r.ride_id])).rows[0].n;
    for (const s of await pickStudents(r.ride_id, left)) {
      await q(`INSERT INTO ride_member (ride_id, student_id, seats_taken, status, joined_at) VALUES ($1, $2, 1, 'confirmed', now() - make_interval(hours => $3))`,
        [r.ride_id, s, 1 + Math.floor(rand() * 40)]);
    }
  }
  const full = (await q(`SELECT ride_id FROM ride WHERE status = 'full' AND depart_start > now()`)).rows;
  for (const r of full) {
    const n = 1 + Math.floor(rand() * 3);
    const who = await pickStudents(r.ride_id, n);
    for (let i = 0; i < who.length; i++) {
      await q(`INSERT INTO ride_waitlist (ride_id, student_id, seats, joined_at) VALUES ($1, $2, $3, now() - make_interval(hours => $4))`,
        [r.ride_id, who[i], rand() < 0.85 ? 1 : 2, 2 + (who.length - i) * 3 + Math.floor(rand() * 3)]);
    }
  }
  // pending requests on upcoming approval-mode rides (the creators' inbox)
  const appr = (await q(`SELECT r.ride_id FROM ride r JOIN ride_booking_policy p ON p.ride_id = r.ride_id AND p.join_mode = 'approval'
                          WHERE r.status = 'open' AND r.depart_start > now() + interval '3 hours'`)).rows;
  for (const r of appr) {
    if (rand() < 0.65) {
      for (const s of await pickStudents(r.ride_id, 1 + Math.floor(rand() * 2))) {
        await q(`INSERT INTO booking_request (ride_id, student_id, seats, created_at) VALUES ($1, $2, 1, now() - make_interval(hours => $3))`, [r.ride_id, s, 1 + Math.floor(rand() * 30)]);
      }
    }
  }

  // 8. demo storyline for the viva (the demo student is students[0])
  const demo = '2023A7PS0001H';
  const others = students.filter((s) => s !== demo);
  const loc = async (name) => (await q(`SELECT location_id FROM location WHERE name LIKE $1`, [name + '%'])).rows[0].location_id;
  const isFree = async (s, start, end) => !(await q(
    `SELECT 1 FROM ride_member m JOIN ride r USING (ride_id)
      WHERE m.student_id = $1 AND m.status = 'confirmed' AND r.status IN ('open','full','departed')
        AND r.depart_start < $3 AND r.depart_end > $2 LIMIT 1`, [s, start, end])).rowCount;
  const pool = (i) => others[(i * 19 + 7) % others.length];
  const story = [
    // key, creator, origin, dest, cab, join_mode, riders on the ride, waitlist, pending requests, why
    { key: 'A', creator: pool(1), o: 'BPHC Main Gate', d: 'RGIA', cab: 'sedan', mode: 'instant', riders: [pool(2)], wait: [], pend: [], demoRole: null, note: 'Demo: Aarav can book this seat instantly' },
    { key: 'B', creator: pool(3), o: 'BPHC Main Gate', d: 'Secunderabad', cab: 'mini', mode: 'approval', riders: [pool(4)], wait: [], pend: [], demoRole: null, note: 'Demo: Aarav sends a request, the creator approves' },
    { key: 'C', creator: pool(5), o: 'BPHC Main Gate', d: 'Hitech City', cab: 'auto', mode: 'instant', riders: [pool(6), pool(7)], wait: [pool(8)], pend: [], demoRole: null, note: 'Demo: full ride, Aarav joins the waitlist' },
    { key: 'D', creator: demo, o: 'BPHC Main Gate', d: 'Inorbit Mall', cab: 'mini', mode: 'approval', riders: [pool(9)], wait: [], pend: [[pool(10), 1], [pool(11), 2]], demoRole: 'creator', note: 'Demo: Aarav approves requests for his own ride' },
    { key: 'E', creator: pool(12), o: 'BPHC Main Gate', d: 'Ameerpet', cab: 'auto', mode: 'instant', riders: [demo, pool(13)], wait: [pool(14)], pend: [], demoRole: 'rider', note: 'Demo: Aarav cancels, the waitlisted student is promoted' },
  ];
  let day = 3;
  for (const s of story) {
    const people = [s.creator, ...s.riders, ...s.wait, ...s.pend.map((p) => p[0])];
    let start, end;
    for (; day < 14; day++) {
      start = new Date(Math.round((now.getTime() + day * DAY) / DAY) * DAY + 2 * HOUR + 30 * 60e3);   // ~08:00 IST
      end = new Date(start.getTime() + HOUR);
      let allFree = true;                                   // one query at a time: a single client
      for (const p of people) if (!(await isFree(p, start, end))) { allFree = false; break; }
      if (allFree) break;
    }
    const { rows } = await q(`SELECT fn_create_ride($1, $2, $3, $4, $5, $6, '{}', $7) AS id`,
      [s.creator, await loc(s.o), await loc(s.d), s.cab, start, end, s.note]);
    const id = rows[0].id;
    await q(`UPDATE ride SET created_at = now() - interval '3 days' WHERE ride_id = $1`, [id]);
    await q(`UPDATE ride_member SET joined_at = now() - interval '3 days' WHERE ride_id = $1 AND student_id = $2`, [id, s.creator]);
    if (s.mode === 'approval') await q(`INSERT INTO ride_booking_policy (ride_id, join_mode) VALUES ($1, 'approval')`, [id]);
    for (const [i, r] of s.riders.entries()) {
      await q(`INSERT INTO ride_member (ride_id, student_id, seats_taken, status, joined_at) VALUES ($1, $2, 1, 'confirmed', now() - make_interval(hours => $3))`, [id, r, 20 - i * 6]);
    }
    for (const [i, w] of s.wait.entries()) {
      await q(`INSERT INTO ride_waitlist (ride_id, student_id, seats, joined_at) VALUES ($1, $2, 1, now() - make_interval(hours => $3))`, [id, w, 8 - i]);
    }
    for (const [i, [p, n]] of s.pend.entries()) {
      await q(`INSERT INTO booking_request (ride_id, student_id, seats, message, created_at) VALUES ($1, $2, $3, $4, now() - make_interval(hours => $5))`,
        [id, p, n, n > 1 ? 'Two of us, small bags' : 'Please keep a seat!', 10 - i * 4]);
    }
    s.rideId = id; day++;
  }
  return { storyRides: Object.fromEntries(story.map((s) => [s.key, s.rideId])), cancelledRiders: cr.rowCount };
}
