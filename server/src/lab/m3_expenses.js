// Member 3 - Expense Integrity Lab. Every scenario tries something the database must (or must not)
// reject. Each runs inside BEGIN ... ROLLBACK, so nothing is ever persisted.
const q = (s) => `'${s}'`;
const add = (c, amt, split, people, values) =>
  `SELECT fn_add_expense(${c.ride}, ${q(c.a)}, ${amt}, 'Lab expense', '${split}'` +
  `${people ? `, ARRAY[${people.map(q).join(',')}]` : ''}${values ? `, ARRAY[${values.join(',')}]::numeric[]` : ''})`;

export const EXPENSE_SCENARIOS = [
  { id: 'amount-zero', group: 'Amount', title: 'Add an expense of ₹0', rule: 'E1', expect: 'expense_amount_positive',
    steps: (c) => [`INSERT INTO expense (ride_id, paid_by, amount) VALUES (${c.ride}, ${q(c.a)}, 0)`] },
  { id: 'amount-huge', group: 'Amount', title: 'Add an expense of ₹99,999', rule: 'E2', expect: 'expense_amount_cap',
    steps: (c) => [`INSERT INTO expense (ride_id, paid_by, amount) VALUES (${c.ride}, ${q(c.a)}, 99999)`] },
  { id: 'payer-outsider', group: 'Who can pay', title: 'A student who is not on the ride pays', rule: 'E5', expect: 'expense_payer_on_ride',
    steps: (c) => [`INSERT INTO expense (ride_id, paid_by, amount) VALUES (${c.ride}, ${q(c.outsider)}, 100)`] },
  { id: 'payer-noshow', group: 'Who can pay', title: 'A no-show rider pays', rule: 'E7', expect: 'rule_expense_payer_confirmed', needs: 'noshow',
    steps: (c) => [`INSERT INTO expense (ride_id, paid_by, amount) VALUES (${c.noshow.ride}, ${q(c.noshow.student)}, 100)`] },
  { id: 'ride-not-departed', group: 'Ride state', title: 'Add an expense to a ride that has not departed', rule: 'E6', expect: 'rule_expense_ride_state', needs: 'open',
    steps: (c) => [`INSERT INTO expense (ride_id, paid_by, amount) VALUES (${c.open.ride}, ${q(c.open.student)}, 100)`] },
  { id: 'share-outsider', group: 'Shares', title: 'Put a non-rider into the split', rule: 'E8', expect: 'rule_share_confirmed_member',
    steps: (c) => [`INSERT INTO expense (ride_id, paid_by, amount) VALUES (${c.ride}, ${q(c.a)}, 100)`,
      `INSERT INTO expense_share (expense_id, student_id, share_amount)\nVALUES (currval(pg_get_serial_sequence('expense','expense_id')), ${q(c.outsider)}, 100)`] },
  { id: 'share-duplicate', group: 'Shares', title: 'Add the same person to the split twice', rule: 'E9', expect: 'expense_share_pkey',
    steps: (c) => [add(c, 100, 'equal', [c.a, c.a])] },
  { id: 'shares-dont-add-up', group: 'Shares', title: 'Shares that do not add up to the amount', rule: 'E16', expect: 'rule_shares_sum_to_amount',
    steps: (c) => [`INSERT INTO expense (ride_id, paid_by, amount) VALUES (${c.ride}, ${q(c.a)}, 300)`,
      `INSERT INTO expense_share (expense_id, student_id, share_amount)\nVALUES (currval(pg_get_serial_sequence('expense','expense_id')), ${q(c.a)}, 100)`,
      `-- the check is DEFERRED to COMMIT; this forces it now so we can see it fire\nSET CONSTRAINTS ALL IMMEDIATE`] },
  { id: 'exact-wrong-sum', group: 'Split rules', title: 'Exact amounts ₹100 + ₹100 for a ₹300 expense', rule: 'E14', expect: 'rule_split_exact_sum',
    steps: (c) => [add(c, 300, 'exact', [c.a, c.b], [100, 100])] },
  { id: 'percent-not-100', group: 'Split rules', title: 'Percentages 60% + 60%', rule: 'E15', expect: 'rule_split_percent_sum',
    steps: (c) => [add(c, 300, 'percent', [c.a, c.b], [60, 60])] },
  { id: 'edit-amount', group: 'Immutability', title: 'Change the amount of an existing expense', rule: 'E17', expect: 'rule_expense_immutable',
    steps: (c) => [add(c, 300, 'equal'),
      `UPDATE expense SET amount = amount + 50 WHERE expense_id = currval(pg_get_serial_sequence('expense','expense_id'))`] },
  { id: 'delete-not-owner', group: 'Immutability', title: 'Someone else deletes my expense', rule: 'E19', expect: 'rule_expense_owner_only',
    steps: (c) => [add(c, 300, 'equal'),
      `SELECT fn_delete_expense(currval(pg_get_serial_sequence('expense','expense_id'))::int, ${q(c.b)})`] },
  { id: 'delete-after-settlement', group: 'Immutability', title: 'Delete an expense after money was settled on the ride', rule: 'E18', expect: 'rule_expense_locked', needs: 'locked',
    steps: (c) => [`DELETE FROM expense WHERE expense_id = ${c.locked.expense}`] },
  { id: 'rounding', group: 'Workflow', title: 'Split ₹100 three ways (should succeed; shares add up to exactly ₹100)', rule: '-', expect: null,
    steps: () => [`SELECT who, share FROM fn_split_amount(100, ARRAY['A','B','C'], ARRAY[1,1,1]::numeric[])`] },
  { id: 'happy-path', group: 'Workflow', title: 'Valid ₹600 expense split 50% / 30% / 20% (succeeds, then rolls back)', rule: '-', expect: null,
    steps: (c) => [add(c, 600, 'percent', [c.a, c.b, c.c], [50, 30, 20]),
      `SELECT student_id, share_amount FROM expense_share WHERE expense_id = currval(pg_get_serial_sequence('expense','expense_id')) ORDER BY share_amount DESC`] },
];

export const publicExpenseScenarios = () =>
  EXPENSE_SCENARIOS.map(({ id, group, title, rule, expect }) => ({ id, group, title, rule, expect }));

/** Pick real rows to build the scenarios from. Returns null when the data needed is missing. */
export async function labContext(pool) {
  const ride = await pool.query(
    `SELECT r.ride_id, array_agg(m.student_id::text ORDER BY m.joined_at, m.student_id) AS riders
     FROM ride r JOIN ride_member m ON m.ride_id = r.ride_id AND m.status = 'confirmed'
     WHERE r.status = 'completed' AND NOT EXISTS (SELECT 1 FROM v_settlement_flow f WHERE f.ride_id = r.ride_id)
     GROUP BY r.ride_id HAVING count(*) >= 3 ORDER BY r.ride_id DESC LIMIT 1`);
  if (!ride.rows.length) return null;
  const [rr] = ride.rows;
  const outsider = await pool.query(
    `SELECT student_id::text AS student FROM student s WHERE NOT EXISTS (SELECT 1 FROM ride_member m WHERE m.ride_id = $1 AND m.student_id = s.student_id)
     ORDER BY student_id LIMIT 1`, [rr.ride_id]);
  const open = await pool.query(
    `SELECT r.ride_id AS ride, r.creator_id::text AS student FROM ride r WHERE r.status IN ('open','full') ORDER BY r.ride_id LIMIT 1`);
  const noshow = await pool.query(
    `SELECT m.ride_id AS ride, m.student_id::text AS student FROM ride_member m JOIN ride r USING (ride_id)
     WHERE m.status = 'no_show' AND r.status = 'completed' ORDER BY m.ride_id LIMIT 1`);
  const locked = await pool.query(
    `SELECT e.expense_id AS expense FROM expense e WHERE EXISTS (SELECT 1 FROM v_settlement_flow f WHERE f.ride_id = e.ride_id) ORDER BY 1 LIMIT 1`);
  return { ride: rr.ride_id, a: rr.riders[0], b: rr.riders[1], c: rr.riders[2], outsider: outsider.rows[0]?.student,
           open: open.rows[0] || null, noshow: noshow.rows[0] || null, locked: locked.rows[0] || null };
}
