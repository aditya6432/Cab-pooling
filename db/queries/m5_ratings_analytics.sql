-- =====================================================================
-- PoolUp — NAMED ANALYTICS QUERIES  (db/queries/m5_ratings_analytics.sql)
-- Owner: Member 5 (Ratings + Analytics / Dashboard)
-- ---------------------------------------------------------------------
-- The API loads every db/queries/*.sql file and serves each block by name, so
-- the SQL shown in the dashboard's "Show SQL" drawer is exactly what runs.
--
-- Block format:
--   -- name:     identifier used by GET /api/analytics/:name
--   -- title:    human title
--   -- concepts: DBMS concepts demonstrated (shown in the UI)
--   -- params:   name:type=default, ...   (bound as $1, $2 … in order;
--                a parameter named "me" is always the logged-in student)
--
-- This file is NOT meant to be run top-to-bottom with psql (it has bind
-- parameters). Try a block in psql by replacing $1, $2 with values.
-- =====================================================================


-- name: kpi_overview
-- title: Campus pooling at a glance
-- concepts: CTE over a view, aggregate FILTER, scalar subqueries, derived metrics
-- params:
WITH done AS (
    SELECT * FROM v_ride_summary WHERE status = 'completed'
)
SELECT
    (SELECT COUNT(*) FROM ride)                                         AS rides_total,
    COUNT(*)                                                            AS rides_completed,
    (SELECT COUNT(*) FROM ride WHERE status IN ('open','full'))         AS rides_upcoming,
    COALESCE(SUM(riders), 0)                                            AS seats_travelled,
    (SELECT COUNT(DISTINCT student_id) FROM ride_member
      WHERE status = 'confirmed')                                       AS active_riders,
    ROUND(100 * AVG(occupancy), 1)                                      AS avg_occupancy_pct,
    COALESCE(SUM(GREATEST(riders - 1, 0)), 0)                           AS cab_trips_avoided,
    ROUND(COALESCE(SUM(total_fare * GREATEST(riders - 1, 0)), 0))       AS rupees_saved,
    ROUND(COALESCE(SUM(distance_km * GREATEST(riders - 1, 0)), 0) * 0.15) AS co2_kg_saved,
    (SELECT ROUND(AVG(score), 2) FROM rating)                           AS avg_rating,
    (SELECT COUNT(*) FROM rating)                                       AS ratings_total,
    -- of all (rater, co-rider) pairs on completed rides, how many got rated?
    (SELECT ROUND(100.0 * COUNT(r.ride_id) / NULLIF(COUNT(*), 0), 1)
       FROM ride_member a
       JOIN ride_member b ON b.ride_id = a.ride_id AND b.student_id <> a.student_id
       JOIN ride x        ON x.ride_id = a.ride_id AND x.status = 'completed'
       LEFT JOIN rating r ON (r.ride_id, r.rater_id, r.ratee_id) = (a.ride_id, a.student_id, b.student_id)
       WHERE a.status = 'confirmed' AND b.status = 'confirmed')         AS rating_coverage_pct
FROM done;


-- name: monthly_trend
-- title: Monthly rides, money saved and rating trend
-- concepts: date_trunc GROUP BY, two CTEs joined, window SUM (running total), LAG (month-on-month %)
-- params:
WITH rides AS (
    SELECT date_trunc('month', depart_start AT TIME ZONE 'Asia/Kolkata')::DATE AS month,
           COUNT(*)                                          AS rides,
           SUM(riders)                                       AS riders,
           ROUND(SUM(total_fare * GREATEST(riders - 1, 0)))  AS saved
    FROM v_ride_summary
    WHERE status = 'completed'
    GROUP BY 1
),
ratings AS (
    SELECT date_trunc('month', created_at AT TIME ZONE 'Asia/Kolkata')::DATE AS month,
           COUNT(*)              AS ratings,
           ROUND(AVG(score), 2)  AS avg_rating
    FROM rating
    GROUP BY 1
)
SELECT to_char(r.month, 'Mon YY')                                   AS label,
       to_char(r.month, 'YYYY-MM')                                  AS month,
       r.rides,
       r.riders,
       r.saved,
       COALESCE(g.ratings, 0)                                       AS ratings,
       g.avg_rating,
       SUM(r.rides) OVER (ORDER BY r.month)                         AS cumulative_rides,
       ROUND(100.0 * (r.rides - LAG(r.rides) OVER (ORDER BY r.month))
             / NULLIF(LAG(r.rides) OVER (ORDER BY r.month), 0), 1)  AS mom_change_pct
FROM rides r
LEFT JOIN ratings g ON g.month = r.month
ORDER BY r.month;


-- name: demand_heatmap
-- title: When do people leave? (day × hour, IST)
-- concepts: GROUP BY two derived columns, parameterised filter, view reuse
-- params: dest_type:text=all
SELECT dow,
       hour_ist  AS hour,
       COUNT(*)  AS rides
FROM v_ride_summary
WHERE status <> 'cancelled'
  AND ($1 = 'all' OR dest_type = $1 OR origin_type = $1)
GROUP BY dow, hour_ist
ORDER BY dow, hour;


-- name: top_routes_by_weekday
-- title: Top 3 routes for each day of the week
-- concepts: GROUP BY, RANK() OVER (PARTITION BY …), filtering on a window result via CTE
-- params:
WITH counts AS (
    SELECT dow,
           origin || ' → ' || destination AS route,
           COUNT(*)                       AS rides,
           ROUND(AVG(riders), 1)          AS avg_riders
    FROM v_ride_summary
    WHERE status = 'completed'
    GROUP BY dow, origin, destination
),
ranked AS (
    SELECT counts.*,
           RANK() OVER (PARTITION BY dow ORDER BY rides DESC, avg_riders DESC) AS rnk
    FROM counts
)
SELECT dow,
       (ARRAY['Mon','Tue','Wed','Thu','Fri','Sat','Sun'])[dow] AS day,
       rnk,
       route,
       rides,
       avg_riders
FROM ranked
WHERE rnk <= 3
ORDER BY dow, rnk, route;


-- name: route_economics
-- title: Busiest routes and how much pooling saves on each
-- concepts: GROUP BY + HAVING, AVG of ratios, multi-table view
-- params: min_rides:int=5
SELECT origin || ' → ' || destination                 AS route,
       COUNT(*)                                       AS rides,
       ROUND(AVG(riders), 2)                          AS avg_riders,
       ROUND(AVG(total_fare))                         AS avg_cab_fare,
       ROUND(AVG(total_fare / NULLIF(riders, 0)))     AS avg_fare_per_rider,
       ROUND(100 * (1 - AVG(1.0 / NULLIF(riders, 0))), 1) AS avg_saving_pct
FROM v_ride_summary
WHERE status = 'completed'
GROUP BY origin, destination
HAVING COUNT(*) >= $1
ORDER BY rides DESC
LIMIT 10;


-- name: occupancy_by_cab
-- title: How full do cabs get?
-- concepts: GROUP BY, aggregate FILTER, conditional percentage
-- params:
SELECT cab_type,
       max_seats,
       COUNT(*)                                                         AS rides,
       ROUND(AVG(seats_filled), 2)                                      AS avg_seats_filled,
       ROUND(100 * AVG(occupancy), 1)                                   AS occupancy_pct,
       ROUND(100.0 * COUNT(*) FILTER (WHERE seats_filled >= max_seats)
             / COUNT(*), 1)                                             AS full_pct,
       ROUND(AVG(total_fare / NULLIF(riders, 0)))                       AS avg_fare_per_rider
FROM v_ride_summary
WHERE status = 'completed'
GROUP BY cab_type, max_seats
ORDER BY max_seats, cab_type;


-- name: rating_distribution
-- title: Distribution of all ratings
-- concepts: generate_series LEFT JOIN (shows empty buckets), window SUM() OVER () for percentages
-- params:
SELECT g.score,
       COUNT(r.score)                                                  AS ratings,
       ROUND(100.0 * COUNT(r.score) / NULLIF(SUM(COUNT(r.score)) OVER (), 0), 1) AS pct
FROM generate_series(1, 5) AS g(score)
LEFT JOIN rating r ON r.score = g.score
GROUP BY g.score
ORDER BY g.score;


-- name: tag_frequency
-- title: What do riders praise and complain about?
-- concepts: 3-table LEFT JOIN with composite key (USING), GROUP BY, AVG
-- params:
SELECT t.label,
       t.sentiment,
       COUNT(m.tag_id)        AS uses,
       ROUND(AVG(r.score), 2) AS avg_score_when_used
FROM rating_tag t
LEFT JOIN rating_tag_map m ON m.tag_id = t.tag_id
LEFT JOIN rating r USING (ride_id, rater_id, ratee_id)
GROUP BY t.tag_id, t.label, t.sentiment
ORDER BY uses DESC, t.label;


-- name: leaderboard
-- title: Trust leaderboard (materialized view)
-- concepts: MATERIALIZED VIEW, DENSE_RANK vs RANK, parameterised filters, Bayesian vs raw ranking
-- params: hostel_id:int=0, min_ratings:int=5
SELECT DENSE_RANK() OVER (ORDER BY trust_score DESC, bayes_score DESC)  AS rank,
       RANK()       OVER (ORDER BY raw_avg DESC NULLS LAST)              AS raw_avg_rank,
       student_id,
       full_name,
       hostel,
       ratings_received,
       raw_avg,
       bayes_score,
       rides_completed,
       no_show_rate,
       trust_score,
       refreshed_at
FROM mv_student_reputation
WHERE ($1 = 0 OR hostel_id = $1)
  AND ratings_received >= $2
ORDER BY rank, full_name
LIMIT 50;


-- name: mv_staleness
-- title: How stale is the materialized view?
-- concepts: MATERIALIZED VIEW snapshot time vs live audit table, scalar subqueries
-- params:
SELECT (SELECT max(refreshed_at) FROM mv_student_reputation)               AS refreshed_at,
       (SELECT count(*) FROM rating_audit
         WHERE changed_at > (SELECT max(refreshed_at) FROM mv_student_reputation)) AS changes_since_refresh;


-- name: hostel_league
-- title: Hostel league table
-- concepts: GROUP BY over a view, COUNT FILTER, AVG FILTER, participation ratio
-- params:
SELECT hostel,
       COUNT(*)                                                       AS students,
       COUNT(*) FILTER (WHERE rides_completed > 0)                    AS active_riders,
       ROUND(100.0 * COUNT(*) FILTER (WHERE rides_completed > 0) / COUNT(*), 1) AS participation_pct,
       SUM(rides_completed)                                           AS seat_trips,
       ROUND(AVG(trust_score) FILTER (WHERE ratings_received >= 3), 1) AS avg_trust,
       ROUND(AVG(raw_avg), 2)                                         AS avg_rating,
       ROUND(100.0 * SUM(no_shows) / NULLIF(SUM(rides_completed + no_shows), 0), 1) AS no_show_pct
FROM v_student_reputation
GROUP BY hostel_id, hostel
ORDER BY avg_trust DESC NULLS LAST, hostel;


-- name: no_show_watchlist
-- title: Students less reliable than their own hostel's average
-- concepts: CORRELATED SUBQUERY (inner query depends on outer row's hostel), multi-join
-- params: min_bookings:int=4
SELECT a.student_id,
       s.full_name,
       h.name                                                           AS hostel,
       a.rides_completed,
       a.no_shows,
       ROUND(a.no_shows::NUMERIC / (a.rides_completed + a.no_shows), 3) AS no_show_rate,
       (SELECT ROUND(SUM(a2.no_shows)::NUMERIC
                     / NULLIF(SUM(a2.rides_completed + a2.no_shows), 0), 3)
          FROM v_student_activity a2
          JOIN student s2 ON s2.student_id = a2.student_id
         WHERE s2.hostel_id = s.hostel_id)                              AS hostel_rate
FROM v_student_activity a
JOIN student s ON s.student_id = a.student_id
JOIN hostel  h ON h.hostel_id  = s.hostel_id
WHERE a.rides_completed + a.no_shows >= $1
  AND a.no_shows >= 2
  AND a.no_shows::NUMERIC / (a.rides_completed + a.no_shows) >
      (SELECT SUM(a2.no_shows)::NUMERIC / NULLIF(SUM(a2.rides_completed + a2.no_shows), 0)
         FROM v_student_activity a2
         JOIN student s2 ON s2.student_id = a2.student_id
        WHERE s2.hostel_id = s.hostel_id)            -- ← correlated on s.hostel_id
ORDER BY no_show_rate DESC, a.no_shows DESC
LIMIT 12;


-- name: ride_buddies
-- title: Ride buddies — pairs who keep pooling together
-- concepts: SELF-JOIN of ride_member (a.student_id < b.student_id removes mirror pairs), HAVING, LEFT JOIN on composite keys
-- params: min_shared:int=3
SELECT a.student_id                AS a_id,
       sa.full_name                AS a_name,
       b.student_id                AS b_id,
       sb.full_name                AS b_name,
       COUNT(*)                    AS shared_rides,
       ROUND(AVG(rab.score), 2)    AS a_rates_b,
       ROUND(AVG(rba.score), 2)    AS b_rates_a
FROM ride_member a
JOIN ride_member b  ON b.ride_id = a.ride_id AND a.student_id < b.student_id
JOIN ride r         ON r.ride_id = a.ride_id AND r.status = 'completed'
JOIN student sa     ON sa.student_id = a.student_id
JOIN student sb     ON sb.student_id = b.student_id
LEFT JOIN rating rab ON (rab.ride_id, rab.rater_id, rab.ratee_id) = (a.ride_id, a.student_id, b.student_id)
LEFT JOIN rating rba ON (rba.ride_id, rba.rater_id, rba.ratee_id) = (a.ride_id, b.student_id, a.student_id)
WHERE a.status = 'confirmed' AND b.status = 'confirmed'
GROUP BY a.student_id, sa.full_name, b.student_id, sb.full_name
HAVING COUNT(*) >= $1
ORDER BY shared_rides DESC, a_name
LIMIT 12;


-- name: rater_bias
-- title: Harsh critics and generous raters
-- concepts: correlated subquery per row inside a CTE, then GROUP BY/HAVING, CASE labelling
-- params: min_given:int=8
WITH scored AS (
    SELECT r.rater_id,
           r.score,
           r.score - (SELECT AVG(o.score)               -- what OTHER people gave this ratee
                        FROM rating o
                       WHERE o.ratee_id = r.ratee_id
                         AND o.rater_id <> r.rater_id) AS deviation
    FROM rating r
),
per_rater AS (
    SELECT rater_id,
           COUNT(*)        AS given,
           AVG(score)      AS avg_given,
           AVG(deviation)  AS bias
    FROM scored
    WHERE deviation IS NOT NULL
    GROUP BY rater_id
    HAVING COUNT(*) >= $1
)
SELECT p.rater_id,
       s.full_name,
       p.given,
       ROUND(p.avg_given, 2) AS avg_given,
       ROUND(p.bias, 2)      AS bias,
       CASE WHEN p.bias <= -0.5 THEN 'Harsh critic'
            WHEN p.bias >=  0.5 THEN 'Generous'
            ELSE 'Balanced' END AS label
FROM per_rater p
JOIN student s ON s.student_id = p.rater_id
ORDER BY ABS(p.bias) DESC
LIMIT 12;


-- name: audit_recent
-- title: Rating audit trail (trigger-maintained)
-- concepts: trigger-populated audit table, joins for names, CASE
-- params: limit:int=25
SELECT a.audit_id,
       a.changed_at,
       CASE a.action WHEN 'I' THEN 'Submitted' WHEN 'U' THEN 'Edited' ELSE 'Withdrawn' END AS action,
       a.ride_id,
       sr.full_name AS rater,
       se.full_name AS ratee,
       a.old_score,
       a.new_score
FROM rating_audit a
JOIN student sr ON sr.student_id = a.rater_id
JOIN student se ON se.student_id = a.ratee_id
ORDER BY a.changed_at DESC, a.audit_id DESC
LIMIT $1;


-- =====================================================================
-- PER-STUDENT QUERIES (profile page)
-- =====================================================================

-- name: profile_summary
-- title: Student reputation (live view) with campus rank
-- concepts: VIEW, window RANK/PERCENT_RANK over the whole campus, then filter to one row
-- params: student_id:text
SELECT *
FROM (
    SELECT v.*,
           RANK()         OVER (ORDER BY trust_score DESC)  AS trust_rank,
           COUNT(*)       OVER ()                           AS campus_size,
           ROUND((100 * (1 - PERCENT_RANK() OVER (ORDER BY trust_score DESC)))::NUMERIC, 0) AS percentile,
           (SELECT ROUND(AVG(score), 3) FROM rating)                 AS prior_mean,
           5                                                         AS prior_weight
    FROM v_student_reputation v
) ranked
WHERE student_id = $1;


-- name: profile_histogram
-- title: Stars received
-- concepts: generate_series + LEFT JOIN with filter in ON clause
-- params: student_id:text
SELECT g.score,
       COUNT(r.score) AS ratings
FROM generate_series(1, 5) AS g(score)
LEFT JOIN rating r ON r.score = g.score AND r.ratee_id = $1
GROUP BY g.score
ORDER BY g.score DESC;


-- name: profile_tags
-- title: Tags received
-- concepts: JOIN through multivalued-attribute table, GROUP BY
-- params: student_id:text
SELECT t.label,
       t.sentiment,
       COUNT(*) AS times
FROM rating_tag_map m
JOIN rating_tag t ON t.tag_id = m.tag_id
WHERE m.ratee_id = $1
GROUP BY t.label, t.sentiment
ORDER BY times DESC, t.label
LIMIT 8;


-- name: profile_reviews
-- title: Recent reviews received
-- concepts: correlated ARRAY subquery to aggregate tags per row, ORDER/LIMIT
-- params: student_id:text
SELECT r.ride_id,
       r.score,
       r.comment,
       r.created_at,
       s.full_name                      AS rater_name,
       o.name || ' → ' || d.name        AS route,
       ARRAY(SELECT t.label
               FROM rating_tag_map m JOIN rating_tag t ON t.tag_id = m.tag_id
              WHERE (m.ride_id, m.rater_id, m.ratee_id) = (r.ride_id, r.rater_id, r.ratee_id)
              ORDER BY t.label)         AS tags
FROM rating r
JOIN student  s ON s.student_id  = r.rater_id
JOIN ride     x ON x.ride_id     = r.ride_id
JOIN location o ON o.location_id = x.origin_id
JOIN location d ON d.location_id = x.dest_id
WHERE r.ratee_id = $1
ORDER BY r.created_at DESC
LIMIT 12;


-- name: profile_given
-- title: Ratings given (editable within 24 h)
-- concepts: derived boolean from time window function, correlated ARRAY subquery
-- params: student_id:text
SELECT r.ride_id,
       r.ratee_id,
       s.full_name                                   AS ratee_name,
       r.score,
       r.comment,
       r.created_at,
       r.updated_at,
       now() <= r.created_at + fn_edit_window()      AS editable,
       r.created_at + fn_edit_window()               AS editable_until,
       ARRAY(SELECT m.tag_id
               FROM rating_tag_map m
              WHERE (m.ride_id, m.rater_id, m.ratee_id) = (r.ride_id, r.rater_id, r.ratee_id)
              ORDER BY m.tag_id)                     AS tag_ids
FROM rating r
JOIN student s ON s.student_id = r.ratee_id
WHERE r.rater_id = $1
ORDER BY r.created_at DESC
LIMIT 15;


-- name: profile_buddies
-- title: Your ride buddies
-- concepts: self-join anchored on one student, GROUP BY, ORDER BY aggregate
-- params: student_id:text
SELECT b.student_id,
       s.full_name,
       h.name          AS hostel,
       COUNT(*)        AS shared_rides,
       MAX(r.depart_start) AS last_ride
FROM ride_member a
JOIN ride_member b ON b.ride_id = a.ride_id AND b.student_id <> a.student_id
JOIN ride r        ON r.ride_id = a.ride_id AND r.status = 'completed'
JOIN student s     ON s.student_id = b.student_id
JOIN hostel  h     ON h.hostel_id  = s.hostel_id
WHERE a.student_id = $1
  AND a.status = 'confirmed' AND b.status = 'confirmed'
GROUP BY b.student_id, s.full_name, h.name
ORDER BY shared_rides DESC, last_ride DESC
LIMIT 6;


-- name: trust_network
-- title: Trust network (recursive CTE)
-- concepts: WITH RECURSIVE, cycle prevention with path arrays, DISTINCT ON for shortest path
-- params: student_id:text, depth:int=3
SELECT * FROM fn_trust_network($1, $2);


-- name: pending_ratings
-- title: Co-riders you still need to rate
-- concepts: SQL function, anti-join with NOT EXISTS, time-window predicate
-- params: me:text
SELECT * FROM fn_pending_ratings($1);

