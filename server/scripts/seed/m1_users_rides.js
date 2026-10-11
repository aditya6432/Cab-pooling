// Deterministic demo-data generator (seeded PRNG -> every teammate gets the same data).
// Dates are relative to "now" so there are always upcoming open rides to search.
// Historical rides are inserted with  SET LOCAL poolup.seeding = 'on'  (skips the
// "must be in the future" rule only). Every CHECK / FK / UNIQUE constraint still applies.
import { hashPassword } from '../../src/auth.js';

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261003);
const randint = (a, b) => Math.floor(a + (b - a + 1) * rand());
const chance = (p) => rand() < p;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const weighted = (items) => {
  let r = rand() * items.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of items) if ((r -= w) <= 0) return v;
  return items[items.length - 1][0];
};
const HOUR = 3600e3, DAY = 24 * HOUR;

export const DEMO_PASSWORD = 'poolup123';
export const HOSTELS = ['Gautam', 'Krishna', 'Vyas', 'Ram', 'Budh', 'Shankar', 'Gandhi', 'Valmiki', 'Viswakarma', 'Malaviya', 'Meera', 'Ganga'];
const FIRST = ['Aarav','Vivaan','Aditya','Vihaan','Arjun','Sai','Reyansh','Krishna','Ishaan','Rohan','Ananya','Diya','Saanvi','Aadhya','Kavya','Isha','Meera','Riya','Sneha','Pooja','Karthik','Rahul','Nikhil','Varun','Siddharth','Harsha','Pranav','Abhinav','Tejas','Yash','Lakshmi','Divya','Nandini','Shreya','Tanvi','Aditi','Neha','Bhavya','Keerthi','Swathi'];
const LAST = ['Sharma','Reddy','Rao','Iyer','Gupta','Verma','Nair','Menon','Patel','Kulkarni','Agarwal','Joshi','Bose','Das','Mishra','Pillai','Naidu','Singh','Kapoor','Bhat','Hegde','Shetty','Jain','Goyal','Krishnan'];
const BRANCHES = ['A7','A7','A7','A3','A4','A8','AA','A1','A5'];
export const LOCATIONS = [
  ['BPHC Main Gate','campus',17.5449,78.5718], ['BPHC Hostel Circle','campus',17.542,78.574],
  ['RGIA Airport (Shamshabad)','airport',17.2403,78.4294], ['Secunderabad Jn','railway',17.4337,78.5016],
  ['Hyderabad Deccan (Nampally)','railway',17.3924,78.4675], ['Kacheguda','railway',17.3893,78.4997],
  ['Cherlapally Terminal','railway',17.4613,78.597], ['Lingampally','railway',17.4834,78.3175],
  ['MGBS Bus Station','bus',17.3784,78.4836], ['JBS Secunderabad','bus',17.4504,78.4981],
  ['Inorbit Mall','mall',17.4344,78.3866], ['Sarath City Capital Mall','mall',17.4589,78.3633],
  ['GVK One','mall',17.4189,78.4497], ['Lulu Mall Kukatpally','mall',17.4847,78.4105],
  ['Hitech City','hub',17.4474,78.3762], ['Ameerpet','hub',17.4375,78.4482],
];
export const CAB_TYPES = [['auto',3,30,18], ['mini',4,60,16], ['sedan',4,80,18], ['suv',6,120,22]];

const km = (a, b) => {
  const r = (d) => (d * Math.PI) / 180, R = 6371;
  const h = Math.sin(r(b[3] - a[3]) / 2) ** 2 * 0 + Math.sin(r(b[2] - a[2]) / 2) ** 2 +
    Math.cos(r(a[2])) * Math.cos(r(b[2])) * Math.sin(r(b[3] - a[3]) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
async function bulk(client, table, cols, rows, returning = '') {
  const out = [];
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500), params = [];
    const tuples = part.map((row) => '(' + row.map((v) => { params.push(v); return '$' + params.length; }).join(',') + ')');
    out.push(...(await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')} ${returning}`, params)).rows);
  }
  return out;
}

export async function seed(client, { now = new Date(), nStudents = 120, nRides = 700 } = {}) {
  const NOW = now.getTime();
  await client.query(`SET LOCAL poolup.seeding = 'on'`);

  const hostelRows = await bulk(client, 'hostel', ['name'], HOSTELS.map((h) => [h]), 'RETURNING hostel_id');
  const locRows = await bulk(client, 'location', ['name', 'loc_type', 'latitude', 'longitude'], LOCATIONS, 'RETURNING location_id');
  await bulk(client, 'cab_type', ['cab_type', 'max_seats', 'base_fare', 'per_km'], CAB_TYPES);
  const loc = LOCATIONS.map((l, i) => ({ id: locRows[i].location_id, raw: l, type: l[1] }));
  const campus = loc.filter((l) => l.type === 'campus'), off = loc.filter((l) => l.type !== 'campus');

  // ---- students ----
  const pwHash = hashPassword(DEMO_PASSWORD);
  const names = new Set(), phones = new Set(), students = [];
  for (let i = 0; i < nStudents; i++) {
    let name; do { name = `${pick(FIRST)} ${pick(LAST)}`; } while (names.has(name));
    names.add(name);
    let phone; do { phone = String(randint(6, 9)) + String(randint(0, 999999999)).padStart(9, '0'); } while (phones.has(phone));
    phones.add(phone);
    const year = weighted([[2022, 2], [2023, 3], [2024, 3], [2025, 2]]);
    const roll = String(1 + i).padStart(4, '0');
    students.push({ id: `${year}${pick(BRANCHES)}PS${roll}H`, name, phone, email: `f${year}${roll}@hyderabad.bits-pilani.ac.in`,
      hostel: pick(hostelRows).hostel_id, activity: weighted([[0.4, 3], [1, 5], [2.5, 2]]) });
  }
  students[0].name = 'Aarav Mehta'; students[0].id = '2023A7PS0001H'; students[0].email = 'f20230001@hyderabad.bits-pilani.ac.in';
  students[0].activity = 2.5;
  await bulk(client, 'student', ['student_id', 'full_name', 'email', 'phone', 'hostel_id', 'password_hash', 'created_at'],
    students.map((s) => [s.id, s.name, s.email, s.phone, s.hostel, pwHash, new Date(NOW - randint(220, 400) * DAY)]));

  // ---- rides: 75% past, 25% upcoming; popular routes + weekday/hour pattern ----
  // (route popularity is skewed on purpose: the airport dominates, as on a real campus)
  const rides = [];
  for (let i = 0; i < nRides; i++) {
    const upcoming = i >= nRides * 0.86;
    const creator = students[Math.floor(Math.pow(rand(), 1.6) * students.length)];   // skew: some power users
    const toCampus = chance(0.4);
    const campusLoc = chance(0.8) ? campus[0] : campus[1];
    const named = (n) => off.find((l) => l.raw[0].startsWith(n));
    const offLoc = chance(0.72)
      ? named(weighted([['RGIA', 9], ['Secunderabad', 4], ['Hitech', 3], ['Ameerpet', 2.5], ['GVK', 2], ['Inorbit', 2], ['Hyderabad Deccan', 1.5], ['Kacheguda', 1], ['Cherlapally', 0.8]]))
      : pick(off);
    const [o, d] = toCampus ? [offLoc, campusLoc] : [campusLoc, offLoc];
    const stopsPool = off.filter((l) => l.id !== o.id && l.id !== d.id);
    const stops = chance(0.3) ? [pick(stopsPool)].concat(chance(0.3) ? [pick(stopsPool)] : []).filter((v, i, a) => a.indexOf(v) === i) : [];
    const cab = weighted([['auto', 2], ['mini', 4], ['sedan', 5], ['suv', 2]]);
    const base = upcoming ? NOW + randint(2, 336) * HOUR : NOW - randint(2, 210 * 24) * HOUR;
    const start = new Date(Math.round(base / 900e3) * 900e3 + (weighted([[7, 3], [9, 2], [12, 2], [16, 3], [19, 4], [21, 2]]) - 12) * 0 * HOUR);
    const startH = new Date(start); startH.setUTCHours(weighted([[1, 3], [4, 2], [7, 3], [10, 3], [13, 4], [16, 2]]), pick([0, 15, 30, 45]), 0, 0);
    const begin = upcoming ? new Date(Math.max(startH.getTime(), NOW + 2 * HOUR)) : startH;
    const end = new Date(begin.getTime() + pick([0.5, 1, 1.5, 2, 3]) * HOUR);
    const pts = [o.raw, ...stops.map((s) => s.raw), d.raw];
    let dist = 0; for (let k = 0; k < pts.length - 1; k++) dist += km(pts[k], pts[k + 1]);
    const status = upcoming ? (chance(0.06) ? 'cancelled' : 'open') : weighted([['completed', 88], ['cancelled', 8], ['completed', 4]]);
    rides.push({ creator, o, d, cab, stops, begin, end, dist: Math.max(0.5, Math.round(dist * 13) / 10), status, upcoming,
      max: CAB_TYPES.find((c) => c[0] === cab)[1] });
  }
  const rideRows = await bulk(client, 'ride',
    ['creator_id', 'origin_id', 'dest_id', 'cab_type', 'depart_start', 'depart_end', 'distance_km', 'note', 'status', 'completed_at', 'created_at'],
    rides.map((r) => [r.creator.id, r.o.id, r.d.id, r.cab, r.begin, r.end, r.dist,
      chance(0.25) ? pick(['Meet at the gate', 'Two small bags only', 'Flight at 6 PM, need to leave early', 'Happy to wait 10 min', null]) : null,
      r.status === 'open' && false ? 'open' : (r.status === 'completed' ? 'completed' : r.status),
      r.status === 'completed' ? new Date(r.begin.getTime() + (1 + rand()) * HOUR) : null,
      new Date(Math.min(r.begin.getTime() - 20 * 60e3, NOW - 60e3) - randint(1, 72) * HOUR)]),
    'RETURNING ride_id');
  rides.forEach((r, i) => { r.id = rideRows[i].ride_id; });

  const stopRows = rides.flatMap((r) => r.stops.map((s, k) => [r.id, k + 1, s.id]));
  if (stopRows.length) await bulk(client, 'ride_stop', ['ride_id', 'stop_seq', 'location_id'], stopRows);

  // Other members (the creator was added by the AFTER INSERT trigger). Never exceed capacity.
  const memberRows = [], extra = new Map();
  for (const r of rides) {
    if (r.status === 'cancelled') continue;
    const want = r.upcoming ? randint(0, Math.min(r.max - 1, 2)) : randint(0, r.max - 1);
    const used = new Set([r.creator.id]);
    for (let k = 0; k < want; k++) {
      const s = students[Math.floor(rand() * students.length)];
      if (used.has(s.id)) continue;
      used.add(s.id);
      memberRows.push([r.id, s.id, 1, !r.upcoming && chance(0.04) ? 'no_show' : 'confirmed', new Date(r.begin.getTime() - randint(1, 40) * HOUR)]);
    }
    extra.set(r.id, used.size);
  }
  if (memberRows.length) await bulk(client, 'ride_member', ['ride_id', 'student_id', 'seats_taken', 'status', 'joined_at'], memberRows);
  // mark full rides (upcoming rides whose confirmed seats == capacity)
  await client.query(`UPDATE ride r SET status = 'full' FROM cab_type c
    WHERE c.cab_type = r.cab_type AND r.status = 'open' AND r.depart_start > now()
      AND (SELECT count(*) FROM ride_member m WHERE m.ride_id = r.ride_id AND m.status = 'confirmed') >= c.max_seats`);
  // Status history for the historical rides. They were bulk-loaded already in their final
  // state, so the ride_status trigger never saw them change; replay the moves it would have logged.
  await client.query(`INSERT INTO ride_status_log (ride_id, old_status, new_status, changed_at)
    SELECT ride_id, 'open', 'departed', depart_start FROM ride WHERE status = 'completed'
    UNION ALL SELECT ride_id, 'departed', 'completed', completed_at FROM ride WHERE status = 'completed'
    UNION ALL SELECT ride_id, 'open', 'cancelled', LEAST(depart_start - interval '3 hours', now() - interval '1 hour')
              FROM ride WHERE status = 'cancelled'`);
  // the demo storyline for the demo student is added by Member 2's seed and seed/demo_story.js
  return { demoStudentId: students[0].id, password: DEMO_PASSWORD };
}
