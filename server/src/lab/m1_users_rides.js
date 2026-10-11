// Integrity Lab: each scenario tries something the database must (or must not) reject.
// Every scenario runs inside BEGIN ... ROLLBACK, so nothing is ever persisted.
const MAIN = `(SELECT location_id FROM location WHERE name = 'BPHC Main Gate')`;
const AIRPORT = `(SELECT location_id FROM location WHERE name LIKE 'RGIA%')`;
const AMEER = `(SELECT location_id FROM location WHERE name = 'Ameerpet')`;
const GVK = `(SELECT location_id FROM location WHERE name = 'GVK One')`;
const INORBIT = `(SELECT location_id FROM location WHERE name = 'Inorbit Mall')`;
const HITECH = `(SELECT location_id FROM location WHERE name = 'Hitech City')`;
const KACH = `(SELECT location_id FROM location WHERE name = 'Kacheguda')`;
const create = (me, d, extra = '') =>
  `SELECT fn_create_ride('${me}', ${MAIN}, ${AIRPORT}, 'sedan', now() + interval '${d} days', now() + interval '${d} days 1 hour'${extra})`;

export const SCENARIOS = [
  { id: 'student-email', group: 'Users', title: 'Register with a Gmail address', rule: 'U2', expect: 'student_email_domain',
    steps: () => [`INSERT INTO student (student_id, full_name, email, phone, hostel_id, password_hash)
VALUES ('2024A7PS0777H', 'Test User', 'test@gmail.com', '9876543210', 1, repeat('x', 64))`] },
  { id: 'student-phone', group: 'Users', title: 'Register with an invalid phone number', rule: 'U3', expect: 'student_phone_format',
    steps: () => [`INSERT INTO student (student_id, full_name, email, phone, hostel_id, password_hash)
VALUES ('2024A7PS0777H', 'Test User', 'f20240777@hyderabad.bits-pilani.ac.in', '1234567890', 1, repeat('x', 64))`] },
  { id: 'student-dup-email', group: 'Users', title: 'Register with an e-mail that already exists', rule: 'U6', expect: 'student_email_key',
    steps: () => [`INSERT INTO student (student_id, full_name, email, phone, hostel_id, password_hash)
SELECT '2024A7PS0777H', 'Clone', email, '9876543210', 1, repeat('x', 64) FROM student LIMIT 1`] },
  { id: 'ride-same-endpoints', group: 'Rides', title: 'Offer a ride from a place to itself', rule: 'R1', expect: 'ride_distinct_endpoints',
    steps: (me, d) => [`INSERT INTO ride (creator_id, origin_id, dest_id, cab_type, depart_start, depart_end, distance_km)
VALUES ('${me}', ${MAIN}, ${MAIN}, 'mini', now() + interval '${d} days', now() + interval '${d} days 1 hour', 5)`] },
  { id: 'ride-long-window', group: 'Rides', title: 'Departure window longer than 3 hours', rule: 'R3', expect: 'ride_window_max_3h',
    steps: (me, d) => [`INSERT INTO ride (creator_id, origin_id, dest_id, cab_type, depart_start, depart_end, distance_km)
VALUES ('${me}', ${MAIN}, ${AIRPORT}, 'mini', now() + interval '40 days', now() + interval '40 days 5 hours', 48)`] },
  { id: 'ride-past', group: 'Rides', title: 'Create a ride that starts in 5 minutes', rule: 'R7', expect: 'rule_ride_in_future',
    steps: (me, d) => [`SELECT fn_create_ride('${me}', ${MAIN}, ${AIRPORT}, 'sedan', now() + interval '5 minutes', now() + interval '1 hour')`] },
  { id: 'ride-overlap', group: 'Rides', title: 'Create two overlapping rides as the same student', rule: 'R10', expect: 'rule_no_overlap',
    steps: (me, d) => { return [create(me, d), `-- second ride, 30 minutes later, same student\nSELECT fn_create_ride('${me}', ${MAIN}, ${GVK}, 'mini', now() + interval '${d} days 30 minutes', now() + interval '${d} days 90 minutes')`]; } },
  { id: 'ride-4-stops', group: 'Rides', title: 'Add four intermediate stops', rule: 'R6', expect: 'ride_stop_stop_seq_check',
    steps: (me, d) => [create(me, d, `, ARRAY[${GVK}, ${INORBIT}, ${HITECH}, ${KACH}]`)] },
  { id: 'stop-is-dest', group: 'Rides', title: 'Make the destination also a stop', rule: 'R13', expect: 'rule_stop_not_endpoint',
    steps: (me, d) => [create(me, d, `, ARRAY[${AIRPORT}]`)] },
  { id: 'status-reopen', group: 'State machine', title: 'Re-open a cancelled ride', rule: 'R11', expect: 'rule_ride_status_flow',
    steps: (me, d) => { return [`WITH r AS (${create(me, d)} AS id) SELECT id FROM r`, `UPDATE ride SET status = 'cancelled' WHERE creator_id = '${me}' AND status = 'open' AND depart_start > now() + interval '${d - 1} days' AND depart_start < now() + interval '${d + 1} days'`, `-- cancelled -> open is not an allowed transition\nUPDATE ride SET status = 'open' WHERE creator_id = '${me}' AND status = 'cancelled' AND depart_start > now() + interval '${d - 1} days' AND depart_start < now() + interval '${d + 1} days'`]; } },
  { id: 'ride-frozen', group: 'State machine', title: 'Change the destination after creation', rule: 'R12', expect: 'rule_ride_core_immutable',
    steps: (me, d) => { return [create(me, d), `UPDATE ride SET dest_id = ${GVK} WHERE creator_id = '${me}' AND depart_start > now() + interval '${d - 1} days' AND depart_start < now() + interval '${d + 1} days'`]; } },
  { id: 'happy-path', group: 'Workflow', title: 'Valid ride with 2 stops (should succeed, then roll back)', rule: '-', expect: null,
    steps: (me, d) => [create(me, d, `, ARRAY[${AMEER}, ${HITECH}]`)] },
];
export const publicList = () => SCENARIOS.map(({ id, group, title, rule, expect }) => ({ id, group, title, rule, expect }));
