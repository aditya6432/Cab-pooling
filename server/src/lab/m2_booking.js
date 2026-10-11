// Member 2 Integrity Lab: each scenario tries something the booking rules forbid (or runs a happy path).
// Every scenario runs inside BEGIN ... ROLLBACK, so nothing is persisted. Setup steps use other students'
// rides on a far-future day `d`, so the only thing that can fail is the rule being demonstrated.
const MAIN = `(SELECT location_id FROM location WHERE name = 'BPHC Main Gate')`;
const AIRPORT = `(SELECT location_id FROM location WHERE name LIKE 'RGIA%')`;
const AMEER = `(SELECT location_id FROM location WHERE name = 'Ameerpet')`;
const INORBIT = `(SELECT location_id FROM location WHERE name = 'Inorbit Mall')`;

const other = (me, n) => `(SELECT student_id FROM student WHERE student_id <> '${me}' ORDER BY student_id OFFSET ${n} LIMIT 1)`;
// a ride by another student on day d (optionally shifted by `mins` minutes, with stops)
const mk = (me, d, n, { cab = 'auto', mins = 0, stops = '' } = {}) =>
  `SELECT fn_create_ride(${other(me, n)}, ${MAIN}, ${AIRPORT}, '${cab}', now() + interval '${d} days ${mins} minutes', now() + interval '${d} days ${mins + 60} minutes'${stops})`;
const rideOf = (me, d, n) => `(SELECT ride_id FROM ride WHERE creator_id = ${other(me, n)} AND depart_start > now() + interval '${d - 1} days' AND depart_start < now() + interval '${d + 1} days' ORDER BY ride_id DESC LIMIT 1)`;
const book = (who, ride, extra = '') => `SELECT fn_book_seat(${who}, ${ride}, 1${extra})`;

export const BOOKING_SCENARIOS = [
  { id: 'own-ride', group: 'Booking rules', title: 'Book a seat on your own ride', rule: 'B9', expect: 'rule_own_ride',
    steps: (me, d) => [`SELECT fn_create_ride('${me}', ${MAIN}, ${AIRPORT}, 'sedan', now() + interval '${d} days', now() + interval '${d} days 1 hour')`,
      book(`'${me}'`, `(SELECT ride_id FROM ride WHERE creator_id = '${me}' AND depart_start > now() + interval '${d - 1} days' ORDER BY ride_id DESC LIMIT 1)`)] },
  { id: 'overbook', group: 'Booking rules', title: 'Insert a 3-seat booking into an auto with 2 seats left', rule: 'B6', expect: 'rule_seat_capacity',
    steps: (me, d) => [mk(me, d, 0), `INSERT INTO ride_member (ride_id, student_id, seats_taken) VALUES (${rideOf(me, d, 0)}, '${me}', 3)`] },
  { id: 'full-ride', group: 'Booking rules', title: 'Book a ride that is already full', rule: 'B7', expect: 'rule_ride_full',
    steps: (me, d) => [mk(me, d, 0), `INSERT INTO ride_member (ride_id, student_id, seats_taken) VALUES (${rideOf(me, d, 0)}, ${other(me, 1)}, 2)  -- fills the auto: trigger flips the ride to 'full'`,
      book(`'${me}'`, rideOf(me, d, 0))] },
  { id: 'cancelled-ride', group: 'Booking rules', title: 'Book a ride whose creator cancelled it', rule: 'B7', expect: 'rule_ride_not_bookable',
    steps: (me, d) => [mk(me, d, 0), `UPDATE ride SET status = 'cancelled' WHERE ride_id = ${rideOf(me, d, 0)}`, book(`'${me}'`, rideOf(me, d, 0))] },
  { id: 'overlap', group: 'Booking rules', title: 'Hold seats on two rides with overlapping windows', rule: 'B8', expect: 'rule_member_overlap',
    steps: (me, d) => [mk(me, d, 0), mk(me, d, 1, { mins: 30 }), book(`'${me}'`, rideOf(me, d, 0)), book(`'${me}'`, rideOf(me, d, 1))] },
  { id: 'bad-segment', group: 'Booking rules', title: 'Board after the stop where you want to get off', rule: 'B5', expect: 'rule_bad_segment',
    steps: (me, d) => [mk(me, d, 0, { cab: 'sedan', stops: `, ARRAY[${AMEER}]` }),
      `SELECT fn_book_seat('${me}', ${rideOf(me, d, 0)}, 1, ${AIRPORT}, ${MAIN})  -- pickup = airport, drop-off = Main Gate`] },
  { id: 'off-route', group: 'Booking rules', title: 'Pick a pickup that is not on the ride route', rule: 'B5', expect: 'rule_bad_segment',
    steps: (me, d) => [mk(me, d, 0, { cab: 'sedan' }), `SELECT fn_book_seat('${me}', ${rideOf(me, d, 0)}, 1, ${INORBIT}, NULL)`] },
  { id: 'bad-status', group: 'Booking rules', title: 'Invent a booking status', rule: 'B2', expect: 'member_status_values',
    steps: (me, d) => [mk(me, d, 0), `INSERT INTO ride_member (ride_id, student_id, status) VALUES (${rideOf(me, d, 0)}, '${me}', 'waiting')`] },
  { id: 'already-booked', group: 'Booking rules', title: 'Book the same ride twice', rule: 'B11', expect: 'rule_already_member',
    steps: (me, d) => [mk(me, d, 0, { cab: 'sedan' }), book(`'${me}'`, rideOf(me, d, 0)), book(`'${me}'`, rideOf(me, d, 0))] },
  { id: 'waitlist-needless', group: 'Waitlist and approval', title: 'Join the waitlist of a ride that still has seats', rule: 'W2', expect: 'rule_waitlist_not_needed',
    steps: (me, d) => [mk(me, d, 0, { cab: 'sedan' }), `INSERT INTO ride_waitlist (ride_id, student_id) VALUES (${rideOf(me, d, 0)}, '${me}')`] },
  { id: 'double-request', group: 'Waitlist and approval', title: 'Send two pending requests for the same ride', rule: 'Q1', expect: 'request_one_pending',
    steps: (me, d) => [mk(me, d, 0, { cab: 'sedan' }), `SELECT fn_set_join_mode(${other(me, 0)}, ${rideOf(me, d, 0)}, 'approval')`,
      book(`'${me}'`, rideOf(me, d, 0)), book(`'${me}'`, rideOf(me, d, 0))] },
  { id: 'not-creator', group: 'Waitlist and approval', title: 'Approve a request on a ride you did not create', rule: 'authz', expectState: '42501', expect: null,
    steps: (me, d) => [mk(me, d, 0, { cab: 'sedan' }), `SELECT fn_set_join_mode(${other(me, 0)}, ${rideOf(me, d, 0)}, 'approval')`,
      book(`'${me}'`, rideOf(me, d, 0)),
      `SELECT fn_decide_request('${me}', (SELECT request_id FROM booking_request WHERE student_id = '${me}' ORDER BY request_id DESC LIMIT 1), true)`] },
  { id: 'creator-seat', group: 'Cancellation and lifecycle', title: 'Cancel the creator\'s own seat', rule: 'B13', expect: 'rule_creator_seat_locked',
    steps: (me, d) => [`SELECT fn_create_ride('${me}', ${MAIN}, ${AIRPORT}, 'sedan', now() + interval '${d} days', now() + interval '${d} days 1 hour')`,
      `SELECT fn_cancel_booking('${me}', (SELECT ride_id FROM ride WHERE creator_id = '${me}' AND depart_start > now() + interval '${d - 1} days' ORDER BY ride_id DESC LIMIT 1))`] },
  { id: 'cancel-departed', group: 'Cancellation and lifecycle', title: 'Cancel a booking after the ride has departed', rule: 'B14', expect: 'rule_cancel_after_departure',
    steps: (me, d) => [mk(me, d, 0, { cab: 'sedan' }), book(`'${me}'`, rideOf(me, d, 0)),
      `UPDATE ride SET status = 'departed' WHERE ride_id = ${rideOf(me, d, 0)}`, `SELECT fn_cancel_booking('${me}', ${rideOf(me, d, 0)})`] },
  { id: 'status-flow', group: 'Cancellation and lifecycle', title: 'Turn a cancelled booking into a no-show', rule: 'B12', expect: 'rule_member_status_flow',
    steps: (me, d) => [mk(me, d, 0, { cab: 'sedan' }), book(`'${me}'`, rideOf(me, d, 0)), `SELECT fn_cancel_booking('${me}', ${rideOf(me, d, 0)})`,
      `UPDATE ride_member SET status = 'no_show' WHERE ride_id = ${rideOf(me, d, 0)} AND student_id = '${me}'`] },
  { id: 'early-no-show', group: 'Cancellation and lifecycle', title: 'Mark a no-show before the ride departed', rule: 'B15', expect: 'rule_no_show_needs_departure',
    steps: (me, d) => [mk(me, d, 0, { cab: 'sedan' }), book(`'${me}'`, rideOf(me, d, 0)), `SELECT fn_mark_no_show(${other(me, 0)}, ${rideOf(me, d, 0)}, '${me}')`] },
  { id: 'history-immutable', group: 'Cancellation and lifecycle', title: 'Rewrite the booking history', rule: 'E1', expect: 'rule_event_immutable',
    steps: (me, d) => [mk(me, d, 0, { cab: 'sedan' }), book(`'${me}'`, rideOf(me, d, 0)), `UPDATE booking_event SET event = 'cancelled' WHERE student_id = '${me}' AND ride_id = ${rideOf(me, d, 0)}`] },
  { id: 'promote', group: 'Happy paths', title: 'Waitlist: a cancellation promotes the first person in the queue', rule: '-', expect: null,
    steps: (me, d) => [mk(me, d, 0), `INSERT INTO ride_member (ride_id, student_id, seats_taken) VALUES (${rideOf(me, d, 0)}, ${other(me, 1)}, 2)  -- ride is now full`,
      `SELECT fn_book_seat('${me}', ${rideOf(me, d, 0)}, 1, NULL, NULL, NULL, true)  -- returns 'waitlisted'`,
      `SELECT fn_cancel_booking(${other(me, 1)}, ${rideOf(me, d, 0)})  -- frees 2 seats; trigger promotes me`,
      `SELECT m.status, m.seats_taken, r.status AS ride_status, (SELECT count(*) FROM ride_waitlist WHERE ride_id = r.ride_id) AS still_waiting FROM ride_member m JOIN ride r USING (ride_id) WHERE m.ride_id = ${rideOf(me, d, 0)} AND m.student_id = '${me}'`] },
  { id: 'approval', group: 'Happy paths', title: 'Approval mode: request, creator accepts, seat is booked', rule: '-', expect: null,
    steps: (me, d) => [mk(me, d, 0, { cab: 'sedan' }), `SELECT fn_set_join_mode(${other(me, 0)}, ${rideOf(me, d, 0)}, 'approval')`,
      `SELECT fn_book_seat('${me}', ${rideOf(me, d, 0)})  -- returns 'requested'`,
      `SELECT fn_decide_request(${other(me, 0)}, (SELECT request_id FROM booking_request WHERE student_id = '${me}' ORDER BY request_id DESC LIMIT 1), true)`,
      `SELECT m.status, (SELECT status FROM booking_request WHERE student_id = '${me}' ORDER BY request_id DESC LIMIT 1) AS request, fn_seats_left(m.ride_id) AS seats_left FROM ride_member m WHERE m.ride_id = ${rideOf(me, d, 0)} AND m.student_id = '${me}'`] },
  { id: 'ride-cancel-cascade', group: 'Happy paths', title: 'Creator cancels the ride: riders and waitlist are released', rule: '-', expect: null,
    steps: (me, d) => [mk(me, d, 0), `INSERT INTO ride_member (ride_id, student_id, seats_taken) VALUES (${rideOf(me, d, 0)}, ${other(me, 1)}, 2)`,
      `SELECT fn_book_seat('${me}', ${rideOf(me, d, 0)}, 1, NULL, NULL, NULL, true)`,
      `UPDATE ride SET status = 'cancelled' WHERE ride_id = ${rideOf(me, d, 0)}`,
      `SELECT (SELECT status FROM ride_member WHERE ride_id = ${rideOf(me, d, 0)} AND student_id = ${other(me, 1)}) AS rider_status, (SELECT cancel_reason FROM ride_member WHERE ride_id = ${rideOf(me, d, 0)} AND student_id = ${other(me, 1)}) AS reason, (SELECT count(*) FROM ride_waitlist WHERE ride_id = ${rideOf(me, d, 0)}) AS waitlist_left`] },
];
export const publicBookingList = () => BOOKING_SCENARIOS.map(({ id, group, title, rule, expect, expectState }) => ({ id, group, title, rule, expect: expect ?? null, expectState: expectState ?? null }));
