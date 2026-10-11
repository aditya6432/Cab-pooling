// Member 3 demo data. Deterministic (own seeded PRNG). Runs after Members 1 and 2's seeds, inside the same
// transaction. Every expense goes through fn_add_expense, so the seed itself obeys every rule.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const HOUR = 3600e3, DAY = 24 * HOUR;

export async function seedExpenses(client, { now = new Date() } = {}) {
  const rand = mulberry32(31415926);
  const chance = (p) => rand() < p;
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const uniform = (a, b) => a + (b - a) * rand();
  const NOW = now.getTime();

  const { rows: rides } = await client.query(
    `SELECT r.ride_id, r.cab_type, r.distance_km, r.completed_at, r.creator_id::text AS creator,
            c.base_fare, c.per_km, ld.loc_type AS dest_type,
            array_agg(m.student_id::text ORDER BY m.joined_at, m.student_id) AS riders
     FROM ride r JOIN cab_type c USING (cab_type) JOIN location ld ON ld.location_id = r.dest_id
     JOIN ride_member m ON m.ride_id = r.ride_id AND m.status = 'confirmed'
     WHERE r.status = 'completed' GROUP BY r.ride_id, c.base_fare, c.per_km, ld.loc_type ORDER BY r.ride_id`);

  let expenses = 0;
  for (const r of rides) {
    if (r.riders.length < 2) continue;                      // nothing to split on a solo ride
    const jobs = [{ note: 'Cab fare', amount: Math.round((r.base_fare + r.per_km * r.distance_km) * uniform(0.9, 1.15) / 10) * 10 }];
    if (r.dest_type === 'airport' && chance(0.35)) jobs.push({ note: 'Airport toll/parking', amount: pick([60, 80, 100, 120]) });
    for (const j of jobs) {
      const payer = chance(0.6) && r.riders.includes(r.creator) ? r.creator : pick(r.riders);
      const roll = rand();
      let split = 'equal', values = null;
      if (roll > 0.88 && r.riders.length >= 2) {                // exact amounts (last person takes the remainder)
        split = 'exact'; let left = j.amount; values = r.riders.map((_, i) => {
          if (i === r.riders.length - 1) return left;
          const v = Math.min(left, Math.round(j.amount * uniform(0.1, 0.5)));
          left -= v; return v;
        });
      } else if (roll > 0.78) {                                 // percentages summing to 100
        split = 'percent'; let left = 100; values = r.riders.map((_, i) => {
          if (i === r.riders.length - 1) return left;
          const v = Math.min(left, Math.round(100 * uniform(0.15, 0.5))); left -= v; return v;
        });
      } else if (roll > 0.70) split = 'seats';
      const { rows } = await client.query(
        `SELECT fn_add_expense($1, $2, $3::numeric, $4, $5, $6::text[], $7::numeric[]) AS id`,
        [r.ride_id, payer, j.amount, j.note, split, values ? r.riders : null, values]);
      const at = new Date(Math.min(new Date(r.completed_at).getTime() + 20 * 60e3, NOW));
      await client.query('UPDATE expense SET created_at = $1 WHERE expense_id = $2', [at, rows[0].id]);
      expenses++;
    }
  }
  // audit rows should carry the (historical) expense time, not the seeding time
  await client.query(`UPDATE expense_audit a SET happened_at = e.created_at FROM expense e
                      WHERE a.expense_id = e.expense_id AND a.action = 'create'`);

  // Settlement is Member 4's job: seed/m4_payments.js records payments for these expenses
  // through the payment state machine (the old `settlement` stand-in table no longer exists).
  return { expenses };
}
