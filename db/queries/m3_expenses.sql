-- =====================================================================
-- PoolUp — Member 3 (Expense splitting): named queries
-- =====================================================================

-- name: who_is_owed
-- title: Who is owed the most? (pairwise view + RANK)
-- concepts: VIEW, SUM, GROUP BY, RANK() OVER, JOIN
-- params: 
SELECT * FROM (
  SELECT s.full_name AS creditor, count(*)::int AS people_owing, sum(b.amount) AS total_owed,
         RANK() OVER (ORDER BY sum(b.amount) DESC) AS owed_rank
  FROM v_pairwise_balance b JOIN student s ON s.student_id = b.creditor_id
  GROUP BY s.student_id, s.full_name) t
WHERE owed_rank <= 10 ORDER BY owed_rank, creditor;

-- name: cost_by_cab
-- title: Fare per rider by cab type
-- concepts: JOIN x3, GROUP BY, AVG, derived table
-- params: 
SELECT r.cab_type, count(DISTINCT e.expense_id)::int AS expenses,
       round(avg(e.amount), 2) AS avg_expense,
       round(avg(s.share_amount), 2) AS avg_share_per_rider,
       round(avg(e.amount - s.share_amount), 2) AS avg_saved_vs_solo
FROM expense e JOIN expense_share s USING (expense_id) JOIN ride r ON r.ride_id = e.ride_id
GROUP BY r.cab_type ORDER BY avg_share_per_rider DESC;

-- name: savings_by_destination
-- title: Money saved by pooling, by destination type
-- concepts: JOIN x4, GROUP BY, SUM, ROUND
-- params: 
SELECT ld.loc_type AS destination_type, count(DISTINCT r.ride_id)::int AS rides,
       sum(e.amount - s.share_amount) AS rupees_saved_vs_riding_alone,
       round(avg(s.share_amount), 2) AS avg_share
FROM expense e JOIN expense_share s USING (expense_id)
JOIN ride r ON r.ride_id = e.ride_id JOIN location ld ON ld.location_id = r.dest_id
GROUP BY ld.loc_type ORDER BY rupees_saved_vs_riding_alone DESC;

-- name: split_mix
-- title: How do people split? (by split type)
-- concepts: GROUP BY, COUNT FILTER, percentage of total (window)
-- params: 
SELECT split_type, count(*)::int AS expenses, sum(amount) AS total_amount,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct_of_expenses
FROM expense GROUP BY split_type ORDER BY expenses DESC;

-- name: unsettled_aging
-- title: Unsettled money by age
-- concepts: CASE, view join, date arithmetic, GROUP BY
-- params: 
SELECT CASE WHEN now() - r.depart_start <= interval '7 days'  THEN '0-7 days'
            WHEN now() - r.depart_start <= interval '30 days' THEN '8-30 days'
            ELSE 'over 30 days' END AS age_bucket,
       count(*)::int AS open_debts, sum(-l.net) AS rupees_outstanding
FROM v_ride_ledger l JOIN ride r ON r.ride_id = l.ride_id
WHERE l.net < 0 GROUP BY 1 ORDER BY min(now() - r.depart_start);

-- name: settlement_lag
-- title: How fast do people pay back? (hours after the expense)
-- concepts: percentile_cont, JOIN, EXTRACT
-- params: 
SELECT count(*)::int AS payments,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY lag_h))::numeric, 1) AS median_hours,
       round((percentile_cont(0.9) WITHIN GROUP (ORDER BY lag_h))::numeric, 1) AS p90_hours
FROM (SELECT EXTRACT(EPOCH FROM (f.settled_at - min(e.created_at))) / 3600 AS lag_h
      FROM v_settlement_flow f JOIN expense e ON e.ride_id = f.ride_id
      GROUP BY f.from_id, f.to_id, f.ride_id, f.settled_at
      HAVING f.settled_at >= min(e.created_at)) t;

-- name: my_running_balance
-- title: My running balance over time (window SUM)
-- concepts: SUM() OVER (ORDER BY), UNION ALL, parameter $1
-- params: me:text
SELECT created_at, note, effect, round(sum(effect) OVER (ORDER BY created_at, expense_id), 2) AS running_balance
FROM (
  SELECT e.expense_id, e.created_at, e.note,
         (CASE WHEN e.paid_by = $1 THEN e.amount ELSE 0 END) - COALESCE(s.share_amount, 0) AS effect
  FROM expense e JOIN expense_share s ON s.expense_id = e.expense_id AND s.student_id = $1
  UNION ALL
  SELECT e.expense_id, e.created_at, e.note, e.amount
  FROM expense e WHERE e.paid_by = $1
    AND NOT EXISTS (SELECT 1 FROM expense_share s WHERE s.expense_id = e.expense_id AND s.student_id = $1)
) t ORDER BY created_at DESC, expense_id DESC LIMIT 25;
