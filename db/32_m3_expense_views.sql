-- =====================================================================
-- PoolUp Member 3 - views
-- Sign convention: net > 0  => others owe this student; net < 0 => student owes.
-- =====================================================================

-- THE ONLY PLACE the expense module reads Member 4's data.
-- Integration: Member 4's `payment` table replaced the old `settlement` stand-in.
-- Money has "flowed" only when the payee CONFIRMED it (pending / rejected /
-- cancelled / expired / reversed payments never moved money). Net-off entries
-- (method 'offset') are included: they are confirmed, mirrored transfers that
-- cancel a debt on one ride against a debt on another, exactly like a payment.
-- With this definition v_ride_ledger.net = v_ride_balance.net for every row
-- (checked by the cross-module query ledger_agreement and by the test suite).
CREATE VIEW v_settlement_flow AS
SELECT p.payer_id AS from_id, p.payee_id AS to_id, p.ride_id, p.amount, p.method,
       p.confirmed_at AS settled_at
FROM payment p
WHERE p.status = 'confirmed';

CREATE VIEW v_expense_detail AS
SELECT e.expense_id, e.ride_id, e.paid_by, p.full_name AS paid_by_name,
       e.amount, e.note, e.split_type, e.created_at,
       (SELECT count(*) FROM expense_share s WHERE s.expense_id = e.expense_id)::int AS participants,
       lo.name AS origin, ld.name AS destination, r.depart_start, r.status AS ride_status
FROM expense e
JOIN student  p  ON p.student_id    = e.paid_by
JOIN ride     r  ON r.ride_id       = e.ride_id
JOIN location lo ON lo.location_id  = r.origin_id
JOIN location ld ON ld.location_id  = r.dest_id;

-- per ride, per student: what they paid, what they owe, what they already settled
CREATE VIEW v_ride_ledger AS
WITH paid AS (SELECT ride_id, paid_by AS student_id, sum(amount) AS amt FROM expense GROUP BY 1, 2),
     owed AS (SELECT e.ride_id, s.student_id, sum(s.share_amount) AS amt
              FROM expense_share s JOIN expense e USING (expense_id) GROUP BY 1, 2),
     sent AS (SELECT ride_id, from_id AS student_id, sum(amount) AS amt FROM v_settlement_flow
              WHERE ride_id IS NOT NULL GROUP BY 1, 2),
     recv AS (SELECT ride_id, to_id AS student_id, sum(amount) AS amt FROM v_settlement_flow
              WHERE ride_id IS NOT NULL GROUP BY 1, 2),
     keys AS (SELECT ride_id, student_id FROM paid UNION SELECT ride_id, student_id FROM owed
              UNION SELECT ride_id, student_id FROM sent UNION SELECT ride_id, student_id FROM recv)
SELECT k.ride_id, k.student_id,
       COALESCE(paid.amt, 0) AS paid, COALESCE(owed.amt, 0) AS owed,
       COALESCE(sent.amt, 0) AS settled_out, COALESCE(recv.amt, 0) AS settled_in,
       COALESCE(paid.amt, 0) - COALESCE(owed.amt, 0) + COALESCE(sent.amt, 0) - COALESCE(recv.amt, 0) AS net
FROM keys k
LEFT JOIN paid ON paid.ride_id = k.ride_id AND paid.student_id = k.student_id
LEFT JOIN owed ON owed.ride_id = k.ride_id AND owed.student_id = k.student_id
LEFT JOIN sent ON sent.ride_id = k.ride_id AND sent.student_id = k.student_id
LEFT JOIN recv ON recv.ride_id = k.ride_id AND recv.student_id = k.student_id
WHERE k.ride_id IN (SELECT ride_id FROM expense);

-- every debt as an edge debtor -> creditor; settlements are negative edges
CREATE VIEW v_debt_edge AS
SELECT s.student_id AS debtor_id, e.paid_by AS creditor_id, e.ride_id, s.share_amount AS amount
FROM expense_share s JOIN expense e USING (expense_id)
WHERE s.student_id <> e.paid_by
UNION ALL
SELECT from_id, to_id, ride_id, -amount FROM v_settlement_flow;

-- net position between every pair of students across ALL rides (Splitwise "friends")
CREATE VIEW v_pairwise_balance AS
SELECT CASE WHEN net > 0 THEN a ELSE b END AS debtor_id,
       CASE WHEN net > 0 THEN b ELSE a END AS creditor_id,
       abs(net) AS amount
FROM (SELECT LEAST(debtor_id, creditor_id) AS a, GREATEST(debtor_id, creditor_id) AS b,
             sum(CASE WHEN debtor_id < creditor_id THEN amount ELSE -amount END) AS net
      FROM v_debt_edge GROUP BY 1, 2) t
WHERE net <> 0;
