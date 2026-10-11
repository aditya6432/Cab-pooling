-- =====================================================================
-- PoolUp — Member 2 (Booking + ride pooling / seat management): named queries
-- =====================================================================

-- name: fill_by_route
-- title: Which routes fill their cars best? (window function RANK)
-- concepts: GROUP BY, HAVING, RANK() OVER, view, derived table
-- params: 
SELECT * FROM (
  SELECT lo.name AS origin, ld.name AS destination, count(*)::int AS rides,
         round(avg(o.fill_pct), 1) AS avg_fill_pct,
         RANK() OVER (ORDER BY avg(o.fill_pct) DESC) AS fill_rank
  FROM v_ride_occupancy o
  JOIN ride r ON r.ride_id = o.ride_id
  JOIN location lo ON lo.location_id = r.origin_id
  JOIN location ld ON ld.location_id = r.dest_id
  WHERE o.status = 'completed'
  GROUP BY lo.name, ld.name HAVING count(*) >= 8) t
WHERE fill_rank <= 10 ORDER BY fill_rank, origin;

-- name: cancellation_lead_time
-- title: How early do riders cancel? (CASE buckets + share of total)
-- concepts: CASE, derived table, GROUP BY, window function (share of total)
-- params: 
SELECT bucket, count(*)::int AS cancellations,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS share_pct
FROM (SELECT CASE WHEN hrs < 2  THEN '1. under 2 h (late)'
                  WHEN hrs < 12 THEN '2. 2 to 12 h'
                  WHEN hrs < 24 THEN '3. 12 to 24 h'
                  WHEN hrs < 72 THEN '4. 1 to 3 days'
                  ELSE               '5. over 3 days' END AS bucket
      FROM (SELECT EXTRACT(EPOCH FROM (r.depart_start - m.cancelled_at)) / 3600 AS hrs
            FROM ride_member m JOIN ride r ON r.ride_id = m.ride_id
            WHERE m.status = 'cancelled' AND m.cancel_reason = 'self') x) y
GROUP BY bucket ORDER BY bucket;

-- name: request_funnel
-- title: Approval requests: how are they decided? (CTE + FILTER)
-- concepts: CTE, FILTER, conditional aggregation, interval arithmetic
-- params: 
WITH decided AS (
  SELECT status, EXTRACT(EPOCH FROM (decided_at - created_at)) / 60 AS minutes
  FROM booking_request)
SELECT status, count(*)::int AS requests,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS share_pct,
       round(avg(minutes) FILTER (WHERE status <> 'pending')::numeric, 0) AS avg_minutes_to_decide
FROM decided GROUP BY status ORDER BY requests DESC;

-- name: waitlist_queue
-- title: Full rides with a queue (aggregate over a view, HAVING)
-- concepts: view, JOIN x3, GROUP BY, HAVING, aggregate
-- params: 
SELECT o.ride_id, lo.name AS origin, ld.name AS destination, o.depart_start::date AS day,
       count(*)::int AS people_waiting, sum(w.seats)::int AS seats_wanted,
       round(max(EXTRACT(EPOCH FROM (now() - w.joined_at)) / 3600)::numeric, 1) AS longest_wait_h
FROM v_ride_occupancy o
JOIN ride r ON r.ride_id = o.ride_id
JOIN location lo ON lo.location_id = r.origin_id
JOIN location ld ON ld.location_id = r.dest_id
JOIN ride_waitlist w ON w.ride_id = o.ride_id
WHERE o.status = 'full'
GROUP BY o.ride_id, lo.name, ld.name, o.depart_start
HAVING count(*) >= 1 ORDER BY people_waiting DESC, longest_wait_h DESC LIMIT 12;

-- name: no_show_by_hostel
-- title: No-show rate by hostel (conditional aggregation, HAVING)
-- concepts: JOIN x3, FILTER, HAVING, NULLIF
-- params: 
SELECT h.name AS hostel, count(*)::int AS rider_bookings,
       count(*) FILTER (WHERE m.status = 'no_show')::int AS no_shows,
       round(100.0 * count(*) FILTER (WHERE m.status = 'no_show') / NULLIF(count(*), 0), 1) AS no_show_pct
FROM ride_member m
JOIN ride r ON r.ride_id = m.ride_id AND r.status = 'completed' AND r.creator_id <> m.student_id
JOIN student s ON s.student_id = m.student_id
JOIN hostel h ON h.hostel_id = s.hostel_id
WHERE m.status IN ('confirmed', 'no_show')
GROUP BY h.name HAVING count(*) >= 20 ORDER BY no_show_pct DESC;

-- name: boarding_points
-- title: Where do riders board or leave mid-route? (UNION ALL + FILTER)
-- concepts: UNION ALL, derived table, FILTER, JOIN
-- params: 
SELECT l.name AS stop,
       count(*) FILTER (WHERE x.kind = 'boards')::int  AS boardings,
       count(*) FILTER (WHERE x.kind = 'leaves')::int  AS alightings
FROM (SELECT pickup_id AS loc, 'boards' AS kind FROM ride_member WHERE pickup_id IS NOT NULL AND status <> 'cancelled'
      UNION ALL
      SELECT dropoff_id, 'leaves' FROM ride_member WHERE dropoff_id IS NOT NULL AND status <> 'cancelled') x
JOIN location l ON l.location_id = x.loc
GROUP BY l.name ORDER BY count(*) DESC LIMIT 10;

-- name: rider_reliability
-- title: Reliability quartiles of regular riders (NTILE)
-- concepts: view, NTILE() OVER, window function, derived table
-- params: 
SELECT * FROM (
  SELECT student_id, full_name, bookings, self_cancelled, no_shows, reliability_pct,
         NTILE(4) OVER (ORDER BY reliability_pct DESC, bookings DESC) AS quartile
  FROM v_student_booking_stats WHERE bookings >= 6) t
ORDER BY quartile DESC, reliability_pct, bookings DESC LIMIT 12;

-- name: co_rider_pairs
-- title: Pairs who keep sharing rides (self-join)
-- concepts: self-join, a.student_id < b.student_id, HAVING, JOIN x2
-- params: 
SELECT sa.full_name AS rider_a, sb.full_name AS rider_b, count(*)::int AS shared_rides
FROM ride_member a
JOIN ride_member b ON b.ride_id = a.ride_id AND a.student_id < b.student_id
JOIN student sa ON sa.student_id = a.student_id
JOIN student sb ON sb.student_id = b.student_id
WHERE a.status IN ('confirmed','no_show') AND b.status IN ('confirmed','no_show')
GROUP BY sa.full_name, sb.full_name HAVING count(*) >= 2
ORDER BY shared_rides DESC, rider_a LIMIT 10;

-- name: seat_utilisation
-- title: Seat utilisation by cab and status (ROLLUP subtotals)
-- concepts: ROLLUP, GROUPING(), view, aggregate
-- params: 
SELECT CASE WHEN GROUPING(cab_type) = 1 THEN 'ALL CABS' ELSE cab_type END AS cab_type,
       CASE WHEN GROUPING(status) = 1 THEN 'all statuses' ELSE status END AS ride_status,
       count(*)::int AS rides, sum(max_seats)::int AS seats_offered, sum(seats_taken)::int AS seats_used,
       round(100.0 * sum(seats_taken) / NULLIF(sum(max_seats), 0), 1) AS utilisation_pct
FROM v_ride_occupancy
WHERE status IN ('completed', 'open', 'full')
GROUP BY ROLLUP (cab_type, status) ORDER BY GROUPING(cab_type), cab_type, GROUPING(status), status;

-- name: booking_lead_time
-- title: How far ahead do people book? (percentile_cont)
-- concepts: percentile_cont, ordered-set aggregate, derived table, GROUP BY
-- params: 
SELECT cab_type, count(*)::int AS bookings,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY hrs))::numeric, 1) AS median_hours_ahead,
       round((percentile_cont(0.9) WITHIN GROUP (ORDER BY hrs))::numeric, 1) AS p90_hours_ahead
FROM (SELECT r.cab_type, EXTRACT(EPOCH FROM (r.depart_start - m.joined_at)) / 3600 AS hrs
      FROM ride_member m JOIN ride r ON r.ride_id = m.ride_id
      WHERE m.student_id <> r.creator_id AND r.status = 'completed') x
GROUP BY cab_type ORDER BY bookings DESC;

-- name: seat_inventory_now
-- title: Upcoming seat inventory with a running total (window frame)
-- concepts: view, SUM() OVER (ORDER BY), running total, JOIN
-- params: 
SELECT o.ride_id, lo.name AS origin, ld.name AS destination, o.depart_start, o.status,
       o.seats_left, o.waitlist_size, o.pending_requests,
       sum(o.seats_left) OVER (ORDER BY o.depart_start, o.ride_id) AS free_seats_so_far
FROM v_ride_occupancy o
JOIN ride r ON r.ride_id = o.ride_id
JOIN location lo ON lo.location_id = r.origin_id
JOIN location ld ON ld.location_id = r.dest_id
WHERE o.status IN ('open', 'full') AND o.depart_end > now()
ORDER BY o.depart_start, o.ride_id LIMIT 15;
