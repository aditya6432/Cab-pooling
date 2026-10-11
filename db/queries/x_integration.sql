-- =====================================================================
-- PoolUp — CROSS-MODULE named queries   (db/queries/x_integration.sql)
-- Owner: whole team. Each query below needs tables from at least three
-- modules, so it could only be written once the database was integrated.
-- Same block format as the other files; "me" = the logged-in student.
-- =====================================================================

-- name: my_todo
-- title: My to-do list across all five modules (one UNION ALL over six sources)
-- concepts: UNION ALL, set-returning function, views, anti-join (NOT EXISTS), format(), cross-module
-- params: me:text
SELECT * FROM (
    -- M2: riders waiting for my approval on rides I host
    SELECT 'booking' AS module, 'approve_request' AS kind, q.created_at AS at,
           format('%s asks for %s seat(s) on your ride to %s', s.full_name, q.seats, ld.name) AS text,
           q.ride_id, NULL::numeric AS amount, '/bookings' AS link
    FROM booking_request q
    JOIN ride r      ON r.ride_id = q.ride_id
    JOIN student s   ON s.student_id = q.student_id
    JOIN location ld ON ld.location_id = r.dest_id
    WHERE r.creator_id = $1 AND q.status = 'pending'
  UNION ALL
    -- M1/M2: a ride I host has left but is not marked completed yet
    SELECT 'booking', 'complete_ride', r.depart_start,
           format('Mark your ride to %s as completed so riders can split and rate', ld.name),
           r.ride_id, NULL, '/bookings'
    FROM ride r JOIN location ld ON ld.location_id = r.dest_id
    WHERE r.creator_id = $1 AND r.status = 'departed'
  UNION ALL
    -- M3: a shared ride I took has no fare recorded yet
    SELECT 'expenses', 'add_expense', r.completed_at,
           format('No fare recorded yet for %s → %s', lo.name, ld.name),
           r.ride_id, NULL, '/expenses/' || r.ride_id
    FROM ride r
    JOIN ride_member m ON m.ride_id = r.ride_id AND m.student_id = $1 AND m.status = 'confirmed'
    JOIN location lo   ON lo.location_id = r.origin_id
    JOIN location ld   ON ld.location_id = r.dest_id
    WHERE r.status = 'completed' AND r.completed_at > now() - INTERVAL '30 days'
      AND NOT EXISTS (SELECT 1 FROM expense e WHERE e.ride_id = r.ride_id)
      AND (SELECT count(*) FROM ride_member x WHERE x.ride_id = r.ride_id AND x.status = 'confirmed') >= 2
  UNION ALL
    -- M4: someone says they paid me; only I can confirm it
    SELECT 'payments', 'confirm_payment', p.created_at,
           format('%s says they paid you by %s', s.full_name, upper(p.method)),
           p.ride_id, p.amount, '/money/payments'
    FROM payment p JOIN student s ON s.student_id = p.payer_id
    WHERE p.payee_id = $1 AND p.status = 'pending'
  UNION ALL
    -- M4: rides where I still owe money (pending payments already counted)
    SELECT 'payments', 'pay', r.completed_at,
           format('You still owe on the ride to %s', ld.name),
           b.ride_id, -b.open, '/money'
    FROM v_ride_balance b
    JOIN ride r      ON r.ride_id = b.ride_id
    JOIN location ld ON ld.location_id = r.dest_id
    WHERE b.student_id = $1 AND b.open < 0
  UNION ALL
    -- M5: co-riders I can still rate (the 7-day window is open)
    SELECT 'ratings', 'rate', p.completed_at,
           format('Rate %s (%s), closes %s', p.ratee_name, p.route,
                  to_char(p.closes_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI')),
           p.ride_id, NULL, '/rate'
    FROM fn_pending_ratings($1) p
) t
ORDER BY CASE kind WHEN 'confirm_payment' THEN 1 WHEN 'approve_request' THEN 2 WHEN 'pay' THEN 3
                   WHEN 'rate' THEN 4 ELSE 5 END, at DESC;

-- name: ride_lifecycle_funnel
-- title: Ride lifecycle funnel: booked → travelled → split → settled → rated (all five modules)
-- concepts: CTE, EXISTS per stage, FILTER, window function (share of first stage), cross-module
-- params:
WITH rides AS (
    SELECT r.ride_id,
           (SELECT count(*) FROM ride_member m
             WHERE m.ride_id = r.ride_id AND m.status = 'confirmed') AS riders,
           EXISTS (SELECT 1 FROM expense e WHERE e.ride_id = r.ride_id) AS has_expense,
           EXISTS (SELECT 1 FROM expense e WHERE e.ride_id = r.ride_id)
             AND NOT EXISTS (SELECT 1 FROM v_ride_balance b
                              WHERE b.ride_id = r.ride_id AND b.net <> 0) AS settled,
           EXISTS (SELECT 1 FROM rating x WHERE x.ride_id = r.ride_id) AS rated
    FROM ride r
    WHERE r.status = 'completed'
), stages AS (
    SELECT 1 AS step, 'Completed rides (M1)' AS stage, count(*) AS rides FROM rides
    UNION ALL SELECT 2, 'Shared by 2+ riders (M2)', count(*) FILTER (WHERE riders >= 2) FROM rides
    UNION ALL SELECT 3, 'Fare split (M3)',          count(*) FILTER (WHERE riders >= 2 AND has_expense) FROM rides
    UNION ALL SELECT 4, 'Fully settled (M4)',       count(*) FILTER (WHERE riders >= 2 AND settled) FROM rides
    UNION ALL SELECT 5, 'Rated by a co-rider (M5)', count(*) FILTER (WHERE riders >= 2 AND rated) FROM rides
)
SELECT step, stage, rides,
       round(100.0 * rides / NULLIF(first_value(rides) OVER (ORDER BY step), 0), 1) AS pct_of_completed
FROM stages
ORDER BY step;

-- name: reliability_vs_money
-- title: Do trusted riders pay faster? Trust-score quartiles vs payment speed and no-shows
-- concepts: NTILE() window, LATERAL subquery, percentile_cont, views from 3 modules
-- params:
WITH q AS (
    SELECT v.student_id, v.trust_score, v.no_shows,
           NTILE(4) OVER (ORDER BY v.trust_score DESC) AS quartile
    FROM v_student_overview v
    WHERE v.ratings_received >= 3
), delays AS (
    SELECT p.payer_id,
           EXTRACT(EPOCH FROM (p.confirmed_at - r.completed_at)) / 86400.0 AS days_to_pay
    FROM payment p JOIN ride r ON r.ride_id = p.ride_id
    WHERE p.status = 'confirmed' AND p.method <> 'offset' AND p.confirmed_at > r.completed_at
)
SELECT q.quartile,
       CASE q.quartile WHEN 1 THEN 'Top 25% trust' WHEN 4 THEN 'Bottom 25% trust' ELSE 'Middle' END AS band,
       count(DISTINCT q.student_id)                                         AS students,
       round(avg(q.trust_score), 1)                                         AS avg_trust,
       round(avg(q.no_shows), 2)                                            AS avg_no_shows,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY d.days_to_pay))::numeric, 2) AS median_days_to_pay,
       count(d.days_to_pay)                                                 AS payments
FROM q LEFT JOIN delays d ON d.payer_id = q.student_id
GROUP BY q.quartile
ORDER BY q.quartile;

-- name: ledger_agreement
-- title: Two modules, one truth: M3's expense ledger vs M4's payment ledger (FULL OUTER JOIN)
-- concepts: FULL OUTER JOIN, COALESCE, aggregate, views from two modules
-- params:
SELECT count(*)                                                        AS rows_compared,
       count(DISTINCT COALESCE(l.ride_id, b.ride_id))                  AS rides_compared,
       count(*) FILTER (WHERE COALESCE(l.net, 0) <> COALESCE(b.net, 0)) AS mismatches,
       COALESCE(sum(abs(COALESCE(l.net, 0) - COALESCE(b.net, 0))), 0)  AS total_difference,
       sum(GREATEST(COALESCE(b.net, 0), 0))                             AS rupees_still_owed
FROM v_ride_ledger l
FULL JOIN v_ride_balance b ON b.ride_id = l.ride_id AND b.student_id = l.student_id;

-- name: integrity_report
-- title: Cross-module integrity report (every count must be 0)
-- concepts: stored function (LANGUAGE sql), UNION ALL of 13 invariant checks, views from all modules
-- params:
SELECT * FROM fn_integrity_report();

-- name: student_overview
-- title: My student 360: one row joining a view from every module
-- concepts: view over 5 views, LEFT JOIN, cross-module
-- params: me:text
SELECT * FROM v_student_overview WHERE student_id = $1;

-- name: table_sizes
-- title: Every table, its row count and size (system catalog pg_class / pg_namespace)
-- concepts: system catalog, pg_total_relation_size, reltuples, ORDER BY
-- params:
SELECT c.relname                                     AS table_name,
       c.reltuples::bigint                           AS approx_rows,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
       (SELECT count(*) FROM pg_index i WHERE i.indrelid = c.oid)        AS indexes,
       (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal) AS triggers,
       (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = c.oid)   AS constraints
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY pg_total_relation_size(c.oid) DESC;
