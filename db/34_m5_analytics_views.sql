-- =====================================================================
-- PoolUp — ANALYTICS VIEWS  (34_m5_analytics_views.sql)
-- Owner: Member 5 (Ratings + Analytics / Dashboard)
-- ---------------------------------------------------------------------
--   v_ride_summary         one row per ride with derived metrics
--                          (riders, occupancy, fare, IST day/hour)
--   v_student_activity     per-student ride counts / no-shows
--   v_student_reputation   LIVE reputation (Bayesian avg + trust score)
--   mv_student_reputation  MATERIALIZED snapshot of the above, used by the
--                          leaderboard (read-heavy, tolerates staleness)
--
-- Why both a view and a materialized view of the same logic?
--   * Profile page  -> must reflect a rating the moment it is submitted
--                      -> plain VIEW (computed on every read)
--   * Leaderboard   -> ranks ALL students, read far more often than ratings
--                      change -> MATERIALIZED VIEW, refreshed on demand
--                      (REFRESH ... CONCURRENTLY so readers never block)
-- =====================================================================

-- ---------------------------------------------------------------------
CREATE VIEW v_ride_summary AS
SELECT r.ride_id,
       r.creator_id,
       r.status,
       r.cab_type,
       c.max_seats,
       r.origin_id,
       o.name                                                          AS origin,
       o.loc_type                                                      AS origin_type,
       r.dest_id,
       d.name                                                          AS destination,
       d.loc_type                                                      AS dest_type,
       r.depart_start,
       r.completed_at,
       r.distance_km,
       EXTRACT(ISODOW FROM r.depart_start AT TIME ZONE 'Asia/Kolkata')::INT AS dow,      -- 1=Mon … 7=Sun
       EXTRACT(HOUR   FROM r.depart_start AT TIME ZONE 'Asia/Kolkata')::INT AS hour_ist,
       COALESCE(m.riders, 0)                                           AS riders,
       COALESCE(m.seats_filled, 0)                                     AS seats_filled,
       COALESCE(m.no_shows, 0)                                         AS no_shows,
       ROUND(COALESCE(m.seats_filled, 0)::NUMERIC / c.max_seats, 3)    AS occupancy,
       COALESCE(e.total_fare, 0)                                       AS total_fare
FROM ride r
JOIN cab_type c ON c.cab_type    = r.cab_type
JOIN location o ON o.location_id = r.origin_id
JOIN location d ON d.location_id = r.dest_id
LEFT JOIN (
        SELECT ride_id,
               COUNT(*)         FILTER (WHERE status = 'confirmed') AS riders,
               SUM(seats_taken) FILTER (WHERE status = 'confirmed') AS seats_filled,
               COUNT(*)         FILTER (WHERE status = 'no_show')   AS no_shows
        FROM ride_member
        GROUP BY ride_id
     ) m ON m.ride_id = r.ride_id
LEFT JOIN (
        SELECT ride_id, SUM(amount) AS total_fare
        FROM expense
        GROUP BY ride_id
     ) e ON e.ride_id = r.ride_id;

-- ---------------------------------------------------------------------
CREATE VIEW v_student_activity AS
SELECT s.student_id,
       COUNT(*) FILTER (WHERE r.status = 'completed' AND m.status = 'confirmed') AS rides_completed,
       COUNT(*) FILTER (WHERE r.status = 'completed' AND m.status = 'no_show')   AS no_shows,
       COUNT(*) FILTER (WHERE m.status = 'cancelled')                            AS cancellations,
       COUNT(*) FILTER (WHERE r.creator_id = s.student_id)                       AS rides_created
FROM student s
LEFT JOIN ride_member m ON m.student_id = s.student_id
LEFT JOIN ride        r ON r.ride_id    = m.ride_id
GROUP BY s.student_id;

-- ---------------------------------------------------------------------
CREATE VIEW v_student_reputation AS
WITH prior AS (                       -- campus-wide mean = Bayesian prior
        SELECT COALESCE(AVG(score), 4.0) AS m FROM rating
     ),
     received AS (
        SELECT ratee_id,
               COUNT(*)   AS n,
               SUM(score) AS total,
               AVG(score) AS avg_score
        FROM rating
        GROUP BY ratee_id
     ),
     given AS (
        SELECT rater_id, COUNT(*) AS n_given, AVG(score) AS avg_given
        FROM rating
        GROUP BY rater_id
     ),
     base AS (
        SELECT s.student_id,
               s.full_name,
               s.hostel_id,
               h.name                                                   AS hostel,
               COALESCE(rc.n, 0)::INT                                   AS ratings_received,
               ROUND(rc.avg_score, 2)                                   AS raw_avg,
               fn_bayesian_score(rc.total, rc.n, p.m)                   AS bayes_score,
               a.rides_completed::INT                                   AS rides_completed,
               a.no_shows::INT                                          AS no_shows,
               ROUND(a.no_shows::NUMERIC
                     / NULLIF(a.rides_completed + a.no_shows, 0), 3)    AS no_show_rate,
               COALESCE(g.n_given, 0)::INT                              AS ratings_given,
               ROUND(g.avg_given, 2)                                    AS avg_given
        FROM student s
        JOIN hostel h             ON h.hostel_id  = s.hostel_id
        JOIN v_student_activity a ON a.student_id = s.student_id
        CROSS JOIN prior p
        LEFT JOIN received rc     ON rc.ratee_id  = s.student_id
        LEFT JOIN given g         ON g.rater_id   = s.student_id
     )
SELECT base.*,
       fn_trust_score(bayes_score, no_show_rate) AS trust_score
FROM base;

-- ---------------------------------------------------------------------
CREATE MATERIALIZED VIEW mv_student_reputation AS
SELECT v.*, now() AS refreshed_at
FROM v_student_reputation v
WITH DATA;

-- A UNIQUE index is mandatory for REFRESH MATERIALIZED VIEW CONCURRENTLY
CREATE UNIQUE INDEX mv_student_reputation_pk    ON mv_student_reputation (student_id);
CREATE INDEX        mv_student_reputation_trust ON mv_student_reputation (trust_score DESC, bayes_score DESC);

CREATE OR REPLACE FUNCTION fn_refresh_reputation() RETURNS TIMESTAMPTZ
LANGUAGE plpgsql AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_student_reputation;
    RETURN (SELECT max(refreshed_at) FROM mv_student_reputation);
END $$;
