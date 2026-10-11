-- Views used by the board and profile pages
CREATE VIEW v_ride_board AS
SELECT r.ride_id, r.status, r.depart_start, r.depart_end, r.distance_km, r.cab_type,
       lo.name AS origin, ld.name AS destination,
       s.student_id AS creator_id, s.full_name AS creator_name,
       c.max_seats,
       COALESCE(SUM(m.seats_taken) FILTER (WHERE m.status = 'confirmed'), 0)::int AS seats_taken,
       (c.max_seats - COALESCE(SUM(m.seats_taken) FILTER (WHERE m.status = 'confirmed'), 0))::int AS seats_left
FROM ride r
JOIN cab_type c  ON c.cab_type = r.cab_type
JOIN student s   ON s.student_id = r.creator_id
JOIN location lo ON lo.location_id = r.origin_id
JOIN location ld ON ld.location_id = r.dest_id
LEFT JOIN ride_member m ON m.ride_id = r.ride_id
GROUP BY r.ride_id, c.max_seats, lo.name, ld.name, s.student_id, s.full_name;

CREATE VIEW v_student_ride_stats AS
SELECT s.student_id, s.full_name, h.name AS hostel,
       (SELECT count(*) FROM ride r WHERE r.creator_id = s.student_id)::int AS rides_created,
       (SELECT count(*) FROM ride_member m WHERE m.student_id = s.student_id AND m.status = 'confirmed')::int AS rides_joined
FROM student s JOIN hostel h ON h.hostel_id = s.hostel_id;
