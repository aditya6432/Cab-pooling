-- =====================================================================
-- PoolUp — PAYMENTS VIEWS  (33_m4_payments_views.sql)
-- Owner: Member 4 (Payments + Settlement)
--   v_ride_balance (defined in 70_…, used by triggers)  per ride × student
--   v_student_money     per student: owes / owed / in-flight, across rides
--   v_payment_detail    payments with names, route and timing, for lists
-- No balance is ever STORED: every figure is derived from expense,
-- expense_share and payment, so there is nothing to keep in sync.
-- =====================================================================

CREATE VIEW v_student_money AS
SELECT s.student_id,
       s.full_name,
       s.hostel_id,
       COALESCE(SUM(GREATEST(-b.net, 0)), 0)            AS owes,
       COALESCE(SUM(GREATEST( b.net, 0)), 0)            AS owed,
       COALESCE(SUM(b.net), 0)                          AS net,
       COALESCE(SUM(b.pending_out), 0)                  AS pending_out,
       COALESCE(SUM(b.pending_in), 0)                   AS pending_in,
       COUNT(*) FILTER (WHERE b.net < 0)                AS rides_owing,
       COUNT(*) FILTER (WHERE b.net > 0)                AS rides_owed
FROM student s
LEFT JOIN v_ride_balance b ON b.student_id = s.student_id
GROUP BY s.student_id, s.full_name, s.hostel_id;

CREATE VIEW v_payment_detail AS
SELECT p.payment_id,
       p.ride_id,
       p.payer_id,
       sp.full_name                                      AS payer_name,
       p.payee_id,
       sq.full_name                                      AS payee_name,
       p.amount,
       p.method,
       p.utr,
       p.note,
       p.offset_group,
       p.status,
       p.status_reason,
       p.created_at,
       p.status_changed_at,
       p.confirmed_at,
       o.name || ' → ' || d.name                         AS route,
       r.completed_at                                    AS ride_completed_at,
       ROUND(EXTRACT(EPOCH FROM (p.confirmed_at - r.completed_at)) / 3600.0, 1) AS hours_to_settle
FROM payment p
JOIN student  sp ON sp.student_id = p.payer_id
JOIN student  sq ON sq.student_id = p.payee_id
JOIN ride     r  ON r.ride_id     = p.ride_id
JOIN location o  ON o.location_id = r.origin_id
JOIN location d  ON d.location_id = r.dest_id;
