-- =====================================================================
-- PoolUp — Member 1 (Users + Ride creation / search): named queries
-- Read-only, parameterised SQL served to the dashboards and the SQL library.
-- Format: "-- name:", "-- title:", "-- concepts:", "-- params:" then the SQL.
-- A parameter called "me" is always bound to the logged-in student.
-- =====================================================================

-- name: popular_routes
-- title: Most popular routes (window function RANK)
-- concepts: GROUP BY, RANK() OVER, JOIN x2, derived table
-- params: 
SELECT * FROM (
  SELECT lo.name AS origin, ld.name AS destination, count(*)::int AS rides,
         round(avg(r.distance_km), 1) AS avg_km,
         RANK() OVER (ORDER BY count(*) DESC) AS popularity_rank
  FROM ride r
  JOIN location lo ON lo.location_id = r.origin_id
  JOIN location ld ON ld.location_id = r.dest_id
  WHERE r.status <> 'cancelled'
  GROUP BY lo.name, ld.name) t
WHERE popularity_rank <= 10 ORDER BY popularity_rank, origin;

-- name: busiest_hours
-- title: Departure demand by hour of day
-- concepts: EXTRACT, GROUP BY, timezone conversion
-- params: 
SELECT EXTRACT(HOUR FROM depart_start AT TIME ZONE 'Asia/Kolkata')::int AS hour,
       count(*)::int AS rides
FROM ride WHERE status <> 'cancelled'
GROUP BY 1 ORDER BY 1;

-- name: hostel_ride_league
-- title: Hostel league: who creates the most rides?
-- concepts: LEFT JOIN, GROUP BY, HAVING, aggregate
-- params: 
SELECT h.name AS hostel, count(DISTINCT s.student_id)::int AS students,
       count(r.ride_id)::int AS rides_created,
       round(count(r.ride_id)::numeric / NULLIF(count(DISTINCT s.student_id), 0), 2) AS rides_per_student
FROM hostel h
JOIN student s ON s.hostel_id = h.hostel_id
LEFT JOIN ride r ON r.creator_id = s.student_id
GROUP BY h.name ORDER BY rides_created DESC;

-- name: top_creators
-- title: Top ride creators (correlated subquery vs average)
-- concepts: correlated subquery, scalar subquery, HAVING
-- params: 
SELECT s.student_id, s.full_name, count(*)::int AS rides_created
FROM student s JOIN ride r ON r.creator_id = s.student_id
GROUP BY s.student_id, s.full_name
HAVING count(*) > (SELECT avg(c) FROM (SELECT count(*) AS c FROM ride GROUP BY creator_id) x)
ORDER BY rides_created DESC LIMIT 10;

-- name: fare_by_cab
-- title: Estimated fare per head by cab type and fill level
-- concepts: JOIN, CASE, stored function, aggregate
-- params: 
SELECT r.cab_type, COUNT(*)::int AS rides,
       round(avg(fn_estimate_fare(r.cab_type, r.distance_km)), 0) AS avg_total_fare,
       round(avg(fn_estimate_fare(r.cab_type, r.distance_km) / NULLIF(m.used, 0)), 0) AS avg_fare_per_head
FROM ride r
JOIN (SELECT ride_id, sum(seats_taken) AS used FROM ride_member WHERE status = 'confirmed' GROUP BY ride_id) m
  ON m.ride_id = r.ride_id
WHERE r.status = 'completed'
GROUP BY r.cab_type ORDER BY avg_fare_per_head;

-- name: unfilled_rides
-- title: Open rides still looking for riders (anti-join + view)
-- concepts: view, NOT EXISTS, ORDER BY
-- params: 
SELECT b.ride_id, b.origin, b.destination, b.depart_start, b.cab_type, b.seats_left, b.creator_name
FROM v_ride_board b
WHERE b.status = 'open' AND b.depart_start > now() AND b.seats_left > 0
  AND NOT EXISTS (SELECT 1 FROM ride_member m WHERE m.ride_id = b.ride_id AND m.student_id <> b.creator_id)
ORDER BY b.depart_start LIMIT 15;

-- name: stop_hotspots
-- title: Where do rides make intermediate stops? (weak entity join)
-- concepts: weak entity, JOIN, GROUP BY
-- params: 
SELECT l.name AS stop, l.loc_type, count(*)::int AS rides_with_stop
FROM ride_stop s JOIN location l USING (location_id)
GROUP BY l.name, l.loc_type ORDER BY rides_with_stop DESC LIMIT 10;

-- name: monthly_growth
-- title: Rides per month with growth (LAG)
-- concepts: date_trunc, LAG() OVER, window function
-- params: 
WITH m AS (
  SELECT date_trunc('month', depart_start)::date AS month, count(*)::int AS rides
  FROM ride WHERE status <> 'cancelled' AND depart_start < now() GROUP BY 1)
SELECT to_char(month, 'YYYY-MM') AS month, rides,
       rides - LAG(rides) OVER (ORDER BY month) AS change_vs_prev
FROM m ORDER BY month;

-- name: campus_kpis
-- title: Headline KPIs (CTE + conditional aggregation)
-- concepts: CTE, FILTER, scalar subqueries, stored function
-- params: 
WITH seats AS (
  SELECT r.ride_id, r.status, r.depart_start, fn_estimate_fare(r.cab_type, r.distance_km) AS fare,
         count(*) FILTER (WHERE m.status = 'confirmed') AS riders, c.max_seats
  FROM ride r JOIN cab_type c USING (cab_type) LEFT JOIN ride_member m ON m.ride_id = r.ride_id
  GROUP BY r.ride_id, c.max_seats)
SELECT (SELECT count(*) FROM student)::int                                            AS students,
       (SELECT count(DISTINCT creator_id) FROM ride)::int                             AS active_creators,
       count(*)::int                                                                  AS rides_total,
       count(*) FILTER (WHERE status = 'completed')::int                              AS rides_completed,
       count(*) FILTER (WHERE status IN ('open','full') AND depart_start > now())::int AS rides_upcoming,
       count(*) FILTER (WHERE status = 'cancelled')::int                              AS rides_cancelled,
       round(100.0 * avg(riders::numeric / max_seats) FILTER (WHERE status = 'completed'), 1) AS avg_occupancy_pct,
       round(sum(fare * (riders - 1)) FILTER (WHERE status = 'completed' AND riders > 1), 0)  AS money_saved,
       (SELECT round(avg(distance_km), 1) FROM ride WHERE status = 'completed')       AS avg_km
FROM seats;

-- name: cab_mix
-- title: Cab type mix and occupancy
-- concepts: GROUP BY, JOIN, derived table, aggregate
-- params: 
SELECT r.cab_type, count(*)::int AS rides,
       round(100.0 * avg(x.riders::numeric / c.max_seats), 1) AS avg_occupancy_pct
FROM ride r
JOIN cab_type c USING (cab_type)
JOIN (SELECT ride_id, count(*) AS riders FROM ride_member WHERE status = 'confirmed' GROUP BY ride_id) x
  ON x.ride_id = r.ride_id
WHERE r.status = 'completed'
GROUP BY r.cab_type ORDER BY rides DESC;

-- name: status_mix
-- title: Ride status breakdown
-- concepts: GROUP BY, window function (share of total)
-- params: 
SELECT status, count(*)::int AS rides,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS share_pct
FROM ride GROUP BY status ORDER BY rides DESC;
