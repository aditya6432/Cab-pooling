// =====================================================================
// PoolUp — demo data for the Ratings module (Member 5)
// ---------------------------------------------------------------------
// Runs last, after every other module's seed, in the same transaction.
// * Own seeded PRNG: never changes the rides, money or bookings before it.
// * Ratings are generated only where the rules allow them: completed rides,
//   both people travelled (status 'confirmed'), inside the 7-day window.
//   The insert trigger re-checks every one of those rules for every row.
// * Scores come from hidden traits (seed/traits.js): a good co-rider gets
//   good scores, harsh raters score lower, flaky riders collect "Late" and
//   late payers collect "Payment delayed" tags.
// * The demo student's recent rides are left partly unrated on purpose so
//   the "Rate co-riders" workflow always has something to do.
// =====================================================================
import { mulberry32, traitsFor, DEMO_ID } from './traits.js';

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;

const COMMENTS = {
  5: ['Super punctual and friendly, would pool again!', 'Paid instantly on UPI. Great company.',
      'Helped everyone with bags at the airport.', 'Smooth ride, great conversation.', 'Perfect co-rider.'],
  4: ['Good ride overall.', 'Nice person, a couple of minutes late.', 'Paid by the next morning, all good.',
      'Quiet but polite.', 'Would ride again.'],
  3: ['Okay ride, was 10 minutes late to the gate.', 'Fine, but changed pickup point last minute.',
      'Took a while to pay the share.', 'Average experience.'],
  2: ['Kept everyone waiting for 20 minutes at the gate.', 'Took four days and three reminders to pay their share.',
      'Brought two huge suitcases without telling us.', 'Changed the pickup time twice the night before.'],
  1: ['Did not show up on time and we nearly missed the flight.', 'Rude to the driver and to the rest of us.',
      'Still has not paid their share after a week of reminders.'],
};
const POS = ['Punctual', 'Friendly', 'Paid on time', 'Clear communication', 'Respectful', 'Helped with luggage', 'Good conversation'];

async function insertRows(client, table, columns, rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    const params = [];
    const tuples = part.map((row) => '(' + row.map((v) => { params.push(v); return '$' + params.length; }).join(',') + ')');
    await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')}`, params);
  }
}

export async function seedRatings(client, { now = new Date(), story }) {
  const NOW = now.getTime();
  const rand = mulberry32(5555);
  const chance = (p) => rand() < p;
  const uniform = (a, b) => a + (b - a) * rand();
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const gauss = (m, s) => m + s * Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const weighted = (items) => {
    let x = rand() * items.reduce((s, [, w]) => s + w, 0);
    for (const [v, w] of items) if ((x -= w) <= 0) return v;
    return items[items.length - 1][0];
  };
  const sample = (arr, k) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a.slice(0, k);
  };

  // traits: a student who has actually skipped rides is more likely "flaky"
  const { rows: people } = await client.query(
    `SELECT s.student_id::text AS id,
            (SELECT count(*) FROM ride_member m WHERE m.student_id = s.student_id AND m.status = 'no_show')::int AS no_shows
       FROM student s ORDER BY s.student_id`);
  const T = new Map(people.map((p) => [p.id, traitsFor(p.id, { noShows: p.no_shows })]));

  const { rows: tagRowsDb } = await client.query('SELECT tag_id, label FROM rating_tag');
  const tagId = Object.fromEntries(tagRowsDb.map((t) => [t.label, t.tag_id]));
  function tagsFor(score, ratee) {
    const t = T.get(ratee);
    const neg = [];
    if (t.flaky) neg.push('Late', 'Last-minute changes');
    if (t.latePayer) neg.push('Payment delayed', 'Payment delayed');
    neg.push('Poor communication', 'Too much luggage', 'Late');
    if (score === 1) neg.push('Rude');
    let chosen;
    if (score === 5) chosen = sample(POS, weighted([[0, 2], [1, 4], [2, 3], [3, 1]]));
    else if (score === 4) chosen = [...sample(POS, weighted([[0, 3], [1, 4], [2, 2]])), ...(chance(0.12) ? [pick(neg)] : [])];
    else if (score === 3) chosen = [...(chance(0.4) ? [pick(POS)] : []), ...(chance(0.7) ? [pick(neg)] : [])];
    else chosen = sample([...new Set(neg)], weighted([[1, 3], [2, 2]]));
    if (score === 1) chosen = chosen.filter((x) => !POS.includes(x));
    return [...new Set(chosen)].slice(0, 3).map((l) => tagId[l]);
  }

  const { rows: rides } = await client.query(`
    SELECT r.ride_id, extract(epoch FROM r.completed_at) * 1000 AS completed_ms,
           array_agg(m.student_id::text ORDER BY m.joined_at, m.student_id) AS riders
    FROM ride r JOIN ride_member m ON m.ride_id = r.ride_id AND m.status = 'confirmed'
    WHERE r.status = 'completed'
    GROUP BY r.ride_id HAVING count(*) >= 2
    ORDER BY r.ride_id`);

  const S = story.rides;
  const labelOf = new Map(Object.entries(S).map(([k, v]) => [v.id, k]));
  const ratingRows = [], tagRows = [];
  for (const r of rides) {
    const label = labelOf.get(r.ride_id);
    if (label === 'F') continue;                    // payments-demo ride: kept unrated
    const done = Number(r.completed_ms);
    for (const rater of r.riders) {
      for (const ratee of r.riders) {
        if (rater === ratee) continue;
        let at;
        if (label) {                                // hand-crafted demo state
          if (label === 'B' && rater === DEMO_ID && ratee === S.B.members[0]) at = NOW - 3 * HOUR;   // still editable
          else if (rater === DEMO_ID) continue;     // left pending (A, B, E) or expired (D)
          else if (label === 'D' || chance(0.5)) at = done + uniform(1, 30) * HOUR;
          else continue;
        } else {
          if (rater === DEMO_ID && NOW - done < 7 * DAY) continue;      // keep the demo's recent ones pending
          const recency = NOW - done < 2 * DAY ? 0.4 : 1;
          if (!chance(T.get(rater).diligence * recency)) continue;
          at = done + Math.min(weighted([[uniform(0.2, 6), 5], [uniform(6, 48), 3], [uniform(48, 160), 1]]) * HOUR, 6.9 * DAY);
        }
        if (at > NOW - 2 * MIN) continue;
        const score = clamp(Math.round(T.get(ratee).quality + T.get(rater).harshness + gauss(0, 0.55)), 1, 5);
        const comment = score <= 2 || chance(0.35) ? pick(COMMENTS[score]) : null;
        ratingRows.push([r.ride_id, rater, ratee, score, comment, new Date(at)]);
        for (const t of tagsFor(score, ratee)) tagRows.push([r.ride_id, rater, ratee, t]);
      }
    }
  }
  await insertRows(client, 'rating', ['ride_id', 'rater_id', 'ratee_id', 'score', 'comment', 'created_at'], ratingRows);
  await insertRows(client, 'rating_tag_map', ['ride_id', 'rater_id', 'ratee_id', 'tag_id'], tagRows);
  return { ratings: ratingRows.length, rating_tags: tagRows.length };
}
