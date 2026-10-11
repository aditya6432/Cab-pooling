-- Member 2 views: seat inventory, passenger manifest, waitlist positions, rider reliability
CREATE VIEW v_ride_occupancy AS
SELECT r.ride_id, r.status, r.creator_id, r.origin_id, r.dest_id, r.depart_start, r.depart_end, r.cab_type, c.max_seats,
       COALESCE(m.used, 0)::int                              AS seats_taken,
       (c.max_seats - COALESCE(m.used, 0))::int              AS seats_left,
       COALESCE(m.riders, 0)::int                            AS riders,
       COALESCE(w.n, 0)::int                                 AS waitlist_size,
       COALESCE(w.seats, 0)::int                             AS waitlist_seats,
       COALESCE(q.n, 0)::int                                 AS pending_requests,
       COALESCE(p.join_mode, 'instant')                      AS join_mode,
       round(100.0 * COALESCE(m.used, 0) / c.max_seats, 1)   AS fill_pct
FROM ride r
JOIN cab_type c ON c.cab_type = r.cab_type
LEFT JOIN (SELECT ride_id, sum(seats_taken) AS used, count(*) AS riders FROM ride_member WHERE status = 'confirmed' GROUP BY ride_id) m ON m.ride_id = r.ride_id
LEFT JOIN (SELECT ride_id, count(*) AS n, sum(seats) AS seats FROM ride_waitlist GROUP BY ride_id) w ON w.ride_id = r.ride_id
LEFT JOIN (SELECT ride_id, count(*) AS n FROM booking_request WHERE status = 'pending' GROUP BY ride_id) q ON q.ride_id = r.ride_id
LEFT JOIN ride_booking_policy p ON p.ride_id = r.ride_id;

CREATE VIEW v_ride_manifest AS
SELECT m.ride_id, m.student_id, s.full_name, h.name AS hostel, m.seats_taken, m.status, m.joined_at,
       m.cancelled_at, m.cancel_reason, (m.student_id = r.creator_id) AS is_creator,
       lp.name AS pickup, ld.name AS dropoff
FROM ride_member m
JOIN ride r      ON r.ride_id = m.ride_id
JOIN student s   ON s.student_id = m.student_id
JOIN hostel h    ON h.hostel_id = s.hostel_id
JOIN location lp ON lp.location_id = COALESCE(m.pickup_id, r.origin_id)
JOIN location ld ON ld.location_id = COALESCE(m.dropoff_id, r.dest_id);

CREATE VIEW v_waitlist_position AS
SELECT w.ride_id, w.student_id, s.full_name, w.seats, w.joined_at,
       row_number() OVER (PARTITION BY w.ride_id ORDER BY w.joined_at, w.student_id)::int AS position
FROM ride_waitlist w JOIN student s ON s.student_id = w.student_id;

-- bookings a student made as a rider (rides they created are excluded)
CREATE VIEW v_student_booking_stats AS
SELECT s.student_id, s.full_name,
       count(m.ride_id)::int                                                             AS bookings,
       count(*) FILTER (WHERE m.status = 'cancelled' AND m.cancel_reason = 'self')::int  AS self_cancelled,
       count(*) FILTER (WHERE m.status = 'no_show')::int                                 AS no_shows,
       count(*) FILTER (WHERE m.status = 'confirmed' AND r.status = 'completed')::int    AS trips_taken,
       round(100.0 * (count(m.ride_id) - count(*) FILTER (WHERE m.status = 'no_show')
                      - count(*) FILTER (WHERE m.status = 'cancelled' AND m.cancel_reason = 'self'))
             / NULLIF(count(m.ride_id), 0), 1)                                           AS reliability_pct
FROM student s
LEFT JOIN ride_member m ON m.student_id = s.student_id
LEFT JOIN ride r ON r.ride_id = m.ride_id AND r.creator_id <> s.student_id
WHERE r.ride_id IS NOT NULL OR m.ride_id IS NULL
GROUP BY s.student_id, s.full_name;
