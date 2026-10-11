-- =====================================================================
-- PoolUp — PAYMENTS NAMED QUERIES  (db/queries/m4_payments.sql)
-- Owner: Member 4 (Payments + Settlement)
-- ---------------------------------------------------------------------
-- Loaded by the API like every db/queries/*.sql file: each "-- name:"
-- block is served by GET /api/analytics/:name and the UI shows this SQL
-- verbatim in its "SQL" drawer. Bind parameters are $1, $2 …
-- "me" is bound by the server to the logged-in student (never from the URL),
-- so nobody can read another student's statement or inbox.
-- =====================================================================


-- name: money_kpis
-- title: Money at a glance
-- concepts: scalar subqueries over views, FILTER, percentile_cont (median), bool_and per group
-- params:
WITH bal AS (SELECT * FROM v_ride_balance)
SELECT
    (SELECT COALESCE(SUM(amount), 0) FROM payment
      WHERE status = 'confirmed' AND method <> 'offset')                          AS settled_amount,
    (SELECT COUNT(*) FROM payment
      WHERE status = 'confirmed' AND method <> 'offset')                          AS settled_count,
    (SELECT COALESCE(SUM(amount), 0) FROM payment WHERE method = 'offset')        AS netted_amount,
    (SELECT COALESCE(SUM(GREATEST(share - paid, 0)), 0) FROM bal)                 AS debt_created,
    (SELECT COALESCE(SUM(GREATEST(-net, 0)), 0) FROM bal)                         AS outstanding,
    (SELECT ROUND(100 * (1 - SUM(GREATEST(-net, 0)) / NULLIF(SUM(GREATEST(share - paid, 0)), 0)), 1)
       FROM bal)                                                                  AS settled_pct,
    (SELECT ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY hours_to_settle)::NUMERIC, 1)
       FROM v_payment_detail WHERE status = 'confirmed' AND method <> 'offset')   AS median_hours_to_settle,
    (SELECT ROUND(100.0 * SUM(amount) FILTER (WHERE method = 'upi') / NULLIF(SUM(amount), 0), 1)
       FROM payment WHERE status = 'confirmed' AND method <> 'offset')            AS upi_share_pct,
    (SELECT COUNT(*) FROM payment WHERE status = 'pending')                       AS pending_count,
    (SELECT COALESCE(SUM(amount), 0) FROM payment WHERE status = 'pending')       AS pending_amount,
    (SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE settled) / NULLIF(COUNT(*), 0), 1)
       FROM (SELECT ride_id, bool_and(net = 0) AS settled FROM bal GROUP BY ride_id) x) AS rides_settled_pct,
    (SELECT COUNT(*) FROM payment WHERE status IN ('rejected', 'reversed'))       AS disputed_count;


-- name: money_monthly
-- title: Settled per month
-- concepts: date_trunc GROUP BY, FILTER, percentile_cont per group, SUM(SUM()) OVER running total
-- params:
SELECT to_char(m, 'Mon YY')                                            AS label,
       to_char(m, 'YYYY-MM')                                           AS month,
       payments,
       amount,
       upi_amount,
       cash_amount,
       median_hours,
       SUM(amount) OVER (ORDER BY m)                                   AS cumulative_amount
FROM (
    SELECT date_trunc('month', confirmed_at AT TIME ZONE 'Asia/Kolkata')        AS m,
           COUNT(*)                                                             AS payments,
           SUM(amount)                                                          AS amount,
           COALESCE(SUM(amount) FILTER (WHERE method = 'upi'), 0)               AS upi_amount,
           COALESCE(SUM(amount) FILTER (WHERE method = 'cash'), 0)              AS cash_amount,
           ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY hours_to_settle)::NUMERIC, 1) AS median_hours
    FROM v_payment_detail
    WHERE status = 'confirmed' AND method <> 'offset'
    GROUP BY 1
) monthly
ORDER BY m;


-- name: debt_aging
-- title: How old is the money still owed?
-- concepts: VALUES as an inline bucket table, LEFT JOIN … BETWEEN (empty buckets still show), GROUP BY
-- params:
WITH buckets (lo, hi, label, ord) AS (
    VALUES (0, 2, '0–2 days', 1), (3, 7, '3–7 days', 2), (8, 14, '8–14 days', 3),
           (15, 30, '15–30 days', 4), (31, 100000, 'Over 30 days', 5)
),
open_debts AS (
    SELECT b.ride_id,
           b.student_id,
           -b.net                                                                       AS amount,
           FLOOR(EXTRACT(EPOCH FROM (now() - COALESCE(r.completed_at, r.depart_start))) / 86400)::INT AS age_days
    FROM v_ride_balance b
    JOIN ride r ON r.ride_id = b.ride_id
    WHERE b.net < 0
)
SELECT k.label,
       k.ord,
       COUNT(d.ride_id)               AS debts,
       COUNT(DISTINCT d.student_id)   AS people,
       COALESCE(SUM(d.amount), 0)     AS amount
FROM buckets k
LEFT JOIN open_debts d ON d.age_days BETWEEN k.lo AND k.hi
GROUP BY k.label, k.ord
ORDER BY k.ord;


-- name: settle_time_histogram
-- title: How long until a debt is settled?
-- concepts: CASE bucketing on an interval, ordered buckets, window share of total
-- params:
WITH t AS (
    SELECT hours_to_settle AS h
    FROM v_payment_detail
    WHERE status = 'confirmed' AND method <> 'offset' AND hours_to_settle IS NOT NULL
),
b AS (
    SELECT CASE WHEN h < 6   THEN 1 WHEN h < 24  THEN 2 WHEN h < 48  THEN 3
                WHEN h < 96  THEN 4 WHEN h < 168 THEN 5 ELSE 6 END AS ord
    FROM t
)
SELECT g.ord,
       (ARRAY['Under 6 h', '6–24 h', '1–2 days', '2–4 days', '4–7 days', 'Over 7 days'])[g.ord] AS label,
       COUNT(b.ord)                                                                      AS payments,
       ROUND(100.0 * COUNT(b.ord) / NULLIF(SUM(COUNT(b.ord)) OVER (), 0), 1)             AS pct
FROM generate_series(1, 6) AS g(ord)
LEFT JOIN b ON b.ord = g.ord
GROUP BY g.ord
ORDER BY g.ord;


-- name: payment_funnel
-- title: What happens to recorded payments
-- concepts: GROUP BY with LEFT JOIN to the state-machine table (every status shown), window percentage
-- params:
SELECT s.status,
       COUNT(p.payment_id)                                                         AS payments,
       COALESCE(SUM(p.amount), 0)                                                  AS amount,
       ROUND(100.0 * COUNT(p.payment_id) / NULLIF(SUM(COUNT(p.payment_id)) OVER (), 0), 1) AS pct
FROM (SELECT DISTINCT to_status AS status FROM payment_transition
      UNION SELECT 'pending') s
LEFT JOIN payment p ON p.status = s.status AND p.method <> 'offset'
GROUP BY s.status
ORDER BY CASE s.status WHEN 'pending' THEN 1 WHEN 'confirmed' THEN 2 WHEN 'rejected' THEN 3
                       WHEN 'cancelled' THEN 4 WHEN 'expired' THEN 5 ELSE 6 END;


-- name: rejection_reasons
-- title: Why payments get rejected or reversed
-- concepts: GROUP BY on free text, FILTER, MAX for recency
-- params:
SELECT status_reason                                   AS reason,
       COUNT(*)                                        AS times,
       COUNT(*) FILTER (WHERE status = 'rejected')     AS rejected,
       COUNT(*) FILTER (WHERE status = 'reversed')     AS reversed,
       MAX(status_changed_at)                          AS last_seen
FROM payment
WHERE status IN ('rejected', 'reversed')
GROUP BY status_reason
ORDER BY times DESC
LIMIT 8;


-- name: top_debtors
-- title: Who owes the most right now
-- concepts: view + TWO correlated subqueries (oldest debt, reminders received this week)
-- params: limit:int=10
SELECT m.student_id,
       m.full_name,
       h.name                                                        AS hostel,
       m.owes,
       m.rides_owing,
       m.pending_out,
       (SELECT MIN(COALESCE(r.completed_at, r.depart_start))
          FROM v_ride_balance b JOIN ride r ON r.ride_id = b.ride_id
         WHERE b.student_id = m.student_id AND b.net < 0)            AS oldest_debt_at,
       (SELECT COUNT(*) FROM payment_reminder pr
         WHERE pr.debtor_id = m.student_id
           AND pr.sent_at > now() - INTERVAL '7 days')               AS reminders_7d
FROM v_student_money m
JOIN hostel h ON h.hostel_id = m.hostel_id
WHERE m.owes > 0
ORDER BY m.owes DESC, m.full_name
LIMIT $1;


-- name: creditor_float
-- title: Who is bankrolling the pool
-- concepts: view aggregate, ORDER BY derived amount, payments awaiting confirmation
-- params: limit:int=10
SELECT m.student_id,
       m.full_name,
       h.name          AS hostel,
       m.owed,
       m.rides_owed,
       m.pending_in
FROM v_student_money m
JOIN hostel h ON h.hostel_id = m.hostel_id
WHERE m.owed > 0
ORDER BY m.owed DESC, m.full_name
LIMIT $1;


-- name: hostel_money_league
-- title: Hostel settlement league
-- concepts: two CTEs joined, percentile_cont per hostel, FILTER for on-time share
-- params:
WITH debt AS (
    SELECT s.hostel_id,
           SUM(GREATEST(b.share - b.paid, 0))  AS created,
           SUM(GREATEST(-b.net, 0))            AS outstanding
    FROM v_ride_balance b
    JOIN student s ON s.student_id = b.student_id
    GROUP BY s.hostel_id
),
speed AS (
    SELECT s.hostel_id,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (p.created_at - r.completed_at)) / 3600) AS median_hours_to_pay,
           100.0 * COUNT(*) FILTER (WHERE p.created_at - r.completed_at <= INTERVAL '24 hours') / COUNT(*)         AS on_time_pct
    FROM payment p
    JOIN ride r    ON r.ride_id = p.ride_id
    JOIN student s ON s.student_id = p.payer_id
    WHERE p.method <> 'offset'
    GROUP BY s.hostel_id
)
SELECT h.name                                                     AS hostel,
       d.created                                                  AS debt_created,
       d.outstanding,
       ROUND(100 * (1 - d.outstanding / NULLIF(d.created, 0)), 1) AS settled_pct,
       ROUND(sp.median_hours_to_pay::NUMERIC, 1)                  AS median_hours_to_pay,
       ROUND(sp.on_time_pct, 1)                                   AS on_time_pct
FROM hostel h
JOIN debt d       ON d.hostel_id  = h.hostel_id
LEFT JOIN speed sp ON sp.hostel_id = h.hostel_id
ORDER BY settled_pct DESC NULLS LAST, h.name;


-- name: netoff_opportunities
-- title: Pairs who owe each other on different rides
-- concepts: SELF-JOIN of a view on ride_id, mirrored-pair EXISTS, GROUP BY, LEAST of two aggregates
-- params:
WITH pos AS (
    SELECT ride_id, student_id, open FROM v_ride_balance WHERE open <> 0
),
owes AS (                         -- debtor can pay creditor up to cap on this ride
    SELECT a.student_id AS debtor, b.student_id AS creditor, a.ride_id, LEAST(-a.open, b.open) AS cap
    FROM pos a
    JOIN pos b ON b.ride_id = a.ride_id AND a.open < 0 AND b.open > 0
),
pair AS (
    SELECT debtor, creditor, SUM(cap) AS total, COUNT(*) AS rides
    FROM owes GROUP BY debtor, creditor
)
SELECT x.debtor            AS a_id,
       sa.full_name        AS a_name,
       x.creditor          AS b_id,
       sb.full_name        AS b_name,
       x.total             AS a_owes_b,
       y.total             AS b_owes_a,
       LEAST(x.total, y.total) AS nettable
FROM pair x
JOIN pair y    ON y.debtor = x.creditor AND y.creditor = x.debtor
JOIN student sa ON sa.student_id = x.debtor
JOIN student sb ON sb.student_id = x.creditor
WHERE x.debtor < x.creditor
ORDER BY nettable DESC
LIMIT 10;


-- name: ledger_integrity
-- title: Do the books balance?
-- concepts: HAVING on a view, correlated subquery per expense, anti-join (NOT EXISTS), invariants as queries
-- params:
SELECT
    (SELECT COUNT(DISTINCT ride_id) FROM v_ride_balance)                               AS rides_with_money,
    (SELECT COUNT(*) FROM (SELECT ride_id FROM v_ride_balance
                            GROUP BY ride_id HAVING SUM(net) <> 0) x)                   AS unbalanced_rides,
    (SELECT COALESCE(SUM(net), 0) FROM v_ride_balance)                                 AS campus_sum,
    (SELECT COUNT(*) FROM expense e
      WHERE e.amount <> (SELECT COALESCE(SUM(s.share_amount), 0)
                           FROM expense_share s WHERE s.expense_id = e.expense_id))     AS bad_expenses,
    (SELECT COUNT(*) FROM (SELECT offset_group FROM payment WHERE offset_group IS NOT NULL
                            GROUP BY offset_group HAVING COUNT(*) <> 2) x)              AS bad_offsets,
    (SELECT COUNT(*) FROM payment p
      WHERE NOT EXISTS (SELECT 1 FROM payment_event e WHERE e.payment_id = p.payment_id)) AS payments_without_history,
    -- a position whose in-flight payments flip its sign would mean overpayment
    (SELECT COUNT(*) FROM v_ride_balance
      WHERE (net < 0 AND open > 0) OR (net > 0 AND open < 0))                         AS overpaid_positions;


-- name: tags_vs_payments
-- title: Do "Payment delayed" tags match real payment behaviour?
-- concepts: CROSS-MODULE join (ratings ⨝ payments), cohort CASE, percentile_cont, FILTER
-- params:
WITH pay_delay AS (
    SELECT p.payer_id AS student_id,
           EXTRACT(EPOCH FROM (p.created_at - r.completed_at)) / 3600 AS hours
    FROM payment p
    JOIN ride r ON r.ride_id = p.ride_id
    WHERE p.method <> 'offset'
),
tagged AS (
    SELECT m.ratee_id AS student_id, COUNT(*) AS delayed_tags
    FROM rating_tag_map m
    JOIN rating_tag t ON t.tag_id = m.tag_id
    WHERE t.label = 'Payment delayed'
    GROUP BY m.ratee_id
)
SELECT CASE WHEN t.delayed_tags > 0 THEN 'Tagged "Payment delayed" by co-riders'
            ELSE 'Never tagged' END                                                   AS cohort,
       COUNT(DISTINCT d.student_id)                                                   AS students,
       COUNT(*)                                                                       AS payments,
       ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY d.hours)::NUMERIC, 1)        AS median_hours_to_pay,
       ROUND(100.0 * COUNT(*) FILTER (WHERE d.hours <= 24) / COUNT(*), 1)             AS paid_within_24h_pct
FROM pay_delay d
LEFT JOIN tagged t ON t.student_id = d.student_id
GROUP BY 1
ORDER BY 1 DESC;


-- name: recent_payment_events
-- title: Payment audit trail (trigger-written)
-- concepts: trigger-populated history table, multi-join for names, CASE on role
-- params: limit:int=10
SELECT e.event_id,
       e.changed_at,
       e.payment_id,
       e.from_status,
       e.to_status,
       e.actor_role,
       COALESCE(a.full_name, 'PoolUp system')        AS actor,
       p.amount,
       sp.full_name                                  AS payer,
       sq.full_name                                  AS payee
FROM payment_event e
JOIN payment p  ON p.payment_id  = e.payment_id
JOIN student sp ON sp.student_id = p.payer_id
JOIN student sq ON sq.student_id = p.payee_id
LEFT JOIN student a ON a.student_id = e.actor_id
ORDER BY e.changed_at DESC, e.event_id DESC
LIMIT $1;


-- name: stale_pending
-- title: Payments eligible for expiry
-- concepts: partial-index-friendly predicate (status = 'pending'), interval arithmetic
-- params:
SELECT COUNT(*)                     AS stale,
       COALESCE(SUM(amount), 0)     AS amount,
       MIN(created_at)              AS oldest
FROM payment
WHERE status = 'pending'
  AND created_at <= now() - fn_payment_expiry();


-- =====================================================================
-- PER-STUDENT QUERIES
-- =====================================================================

-- name: my_money
-- title: Your money position
-- concepts: view lookup + scalar subqueries
-- params: me:text
SELECT m.*,
       (SELECT COUNT(*) FROM payment WHERE payee_id = $1 AND status = 'pending') AS awaiting_my_confirmation,
       (SELECT COUNT(*) FROM payment WHERE payer_id = $1 AND status = 'pending') AS awaiting_their_confirmation,
       (SELECT COUNT(*) FROM payment_reminder
         WHERE debtor_id = $1 AND sent_at > now() - INTERVAL '7 days')           AS reminders_received_7d
FROM v_student_money m
WHERE m.student_id = $1;


-- name: my_settle_lines
-- title: What you need to pay and collect
-- concepts: CROSS JOIN LATERAL into a set-returning PL/pgSQL function, correlated subqueries
-- params: me:text
WITH my_rides AS (
    SELECT ride_id FROM v_ride_balance WHERE student_id = $1 AND open <> 0
)
SELECT r.ride_id,
       o.name || ' → ' || d.name                                                      AS route,
       r.completed_at,
       FLOOR(EXTRACT(EPOCH FROM (now() - COALESCE(r.completed_at, r.depart_start))) / 86400)::INT AS age_days,
       CASE WHEN pl.from_id = $1 THEN 'pay' ELSE 'collect' END                       AS direction,
       pl.from_id,
       sf.full_name                                                                   AS from_name,
       pl.to_id,
       st.full_name                                                                   AS to_name,
       pl.amount,
       (SELECT pm.vpa FROM payment_method pm WHERE pm.student_id = pl.to_id AND pm.is_default) AS payee_vpa,
       (SELECT MAX(pr.sent_at) FROM payment_reminder pr
         WHERE pr.ride_id = r.ride_id AND pr.creditor_id = pl.to_id AND pr.debtor_id = pl.from_id) AS last_reminded_at
FROM my_rides m
JOIN ride r     ON r.ride_id = m.ride_id
CROSS JOIN LATERAL fn_settlement_plan(r.ride_id) pl
JOIN student sf ON sf.student_id = pl.from_id
JOIN student st ON st.student_id = pl.to_id
JOIN location o ON o.location_id = r.origin_id
JOIN location d ON d.location_id = r.dest_id
WHERE $1 IN (pl.from_id, pl.to_id)
ORDER BY direction DESC, r.completed_at, pl.amount DESC;


-- name: ride_positions
-- title: Every member's position on one ride
-- concepts: view filtered by ride (predicate pushed into UNION ALL branches)
-- params: ride_id:int
SELECT b.student_id,
       s.full_name,
       b.paid,
       b.share,
       b.sent,
       b.received,
       b.pending_out,
       b.pending_in,
       b.net,
       b.open
FROM v_ride_balance b
JOIN student s ON s.student_id = b.student_id
WHERE b.ride_id = $1
ORDER BY b.net DESC, s.full_name;


-- name: ride_plan
-- title: Fewest transfers that settle one ride
-- concepts: set-returning PL/pgSQL function (greedy two-pointer), joins for names
-- params: ride_id:int
SELECT p.from_id,
       sf.full_name AS from_name,
       p.to_id,
       st.full_name AS to_name,
       p.amount
FROM fn_settlement_plan($1) p
JOIN student sf ON sf.student_id = p.from_id
JOIN student st ON st.student_id = p.to_id;


-- name: my_netoffs
-- title: People you could net off with
-- concepts: self-join on v_ride_balance, mirrored aggregate pairs
-- params: me:text
WITH mine AS (
    SELECT a.ride_id, b.student_id AS other,
           CASE WHEN a.open < 0 AND b.open > 0 THEN LEAST(-a.open, b.open) ELSE 0 END AS i_owe,
           CASE WHEN a.open > 0 AND b.open < 0 THEN LEAST(a.open, -b.open) ELSE 0 END AS they_owe
    FROM v_ride_balance a
    JOIN v_ride_balance b ON b.ride_id = a.ride_id AND b.student_id <> a.student_id
    WHERE a.student_id = $1 AND a.open <> 0 AND b.open <> 0
)
SELECT m.other              AS student_id,
       s.full_name,
       SUM(m.i_owe)          AS i_owe,
       SUM(m.they_owe)       AS they_owe,
       LEAST(SUM(m.i_owe), SUM(m.they_owe)) AS nettable,
       COUNT(DISTINCT m.ride_id) AS rides
FROM mine m
JOIN student s ON s.student_id = m.other
GROUP BY m.other, s.full_name
HAVING SUM(m.i_owe) > 0 AND SUM(m.they_owe) > 0
ORDER BY nettable DESC;


-- name: my_statement
-- title: Your statement with running balance
-- concepts: UNION ALL of five event sources, ROW_NUMBER for a stable order, SUM() OVER running balance
-- params: me:text
WITH ev AS (
        SELECT e.created_at AS at, 1 AS ord, e.ride_id, 'You paid the ' || lower(e.note) AS description, e.amount AS delta
        FROM expense e WHERE e.paid_by = $1
    UNION ALL
        SELECT e.created_at, 2, e.ride_id, 'Your share of the ' || lower(e.note), -s.share_amount
        FROM expense_share s JOIN expense e ON e.expense_id = s.expense_id
        WHERE s.student_id = $1
    UNION ALL
        SELECT p.confirmed_at, 3, p.ride_id,
               CASE WHEN p.method = 'offset' THEN 'Net-off with ' || q.full_name
                    ELSE 'You paid ' || q.full_name || ' (' || upper(p.method) || ')' END,
               p.amount
        FROM payment p JOIN student q ON q.student_id = p.payee_id
        WHERE p.payer_id = $1 AND p.status IN ('confirmed', 'reversed')
    UNION ALL
        SELECT p.confirmed_at, 3, p.ride_id,
               CASE WHEN p.method = 'offset' THEN 'Net-off with ' || q.full_name
                    ELSE q.full_name || ' paid you (' || upper(p.method) || ')' END,
               -p.amount
        FROM payment p JOIN student q ON q.student_id = p.payer_id
        WHERE p.payee_id = $1 AND p.status IN ('confirmed', 'reversed')
    UNION ALL
        SELECT p.status_changed_at, 4, p.ride_id,
               'Reversed: ' || CASE WHEN p.payer_id = $1 THEN 'your payment to ' || q.full_name
                                     ELSE q.full_name || '''s payment to you' END,
               CASE WHEN p.payer_id = $1 THEN -p.amount ELSE p.amount END
        FROM payment p
        JOIN student q ON q.student_id = CASE WHEN p.payer_id = $1 THEN p.payee_id ELSE p.payer_id END
        WHERE $1 IN (p.payer_id, p.payee_id) AND p.status = 'reversed'
),
ordered AS (
    SELECT ev.*, ROW_NUMBER() OVER (ORDER BY at, ord, ride_id, description) AS seq
    FROM ev
)
SELECT seq, at, ride_id, description, delta,
       SUM(delta) OVER (ORDER BY seq ROWS UNBOUNDED PRECEDING) AS balance
FROM ordered
ORDER BY seq DESC;


-- name: my_inbox
-- title: Payments waiting for your confirmation
-- concepts: view filter on (payee, status) — served by payment_payee_status_idx
-- params: me:text
SELECT d.*,
       d.created_at + fn_payment_expiry() AS expires_at
FROM v_payment_detail d
WHERE d.payee_id = $1 AND d.status = 'pending'
ORDER BY d.created_at;


-- name: my_outgoing
-- title: Your payments awaiting the other person
-- concepts: view filter on (payer, status)
-- params: me:text
SELECT d.*,
       d.created_at + fn_payment_expiry() AS expires_at
FROM v_payment_detail d
WHERE d.payer_id = $1 AND d.status = 'pending'
ORDER BY d.created_at;


-- name: my_payment_history
-- title: Your payment history
-- concepts: OR across two indexed columns, derived flags from time windows
-- params: me:text, limit:int=40
SELECT d.*,
       CASE WHEN d.payer_id = $1 THEN 'out' ELSE 'in' END                          AS direction,
       (d.payee_id = $1 AND d.status = 'confirmed' AND d.method <> 'offset'
        AND now() <= d.confirmed_at + fn_reversal_window())                        AS can_reverse,
       d.confirmed_at + fn_reversal_window()                                       AS reversible_until
FROM v_payment_detail d
WHERE $1 IN (d.payer_id, d.payee_id)
ORDER BY d.created_at DESC
LIMIT $2;


-- name: payment_timeline
-- title: Status history of one payment
-- concepts: trigger-written history, LEFT JOIN for the system actor
-- params: payment_id:int
SELECT e.event_id,
       e.from_status,
       e.to_status,
       e.actor_role,
       COALESCE(s.full_name, 'PoolUp system') AS actor,
       e.reason,
       e.changed_at
FROM payment_event e
LEFT JOIN student s ON s.student_id = e.actor_id
WHERE e.payment_id = $1
ORDER BY e.changed_at, e.event_id;


-- name: my_upi_ids
-- title: Your UPI IDs
-- concepts: partial unique index (one default per student)
-- params: me:text
SELECT method_id, vpa, label, is_default, created_at
FROM payment_method
WHERE student_id = $1
ORDER BY is_default DESC, created_at;
