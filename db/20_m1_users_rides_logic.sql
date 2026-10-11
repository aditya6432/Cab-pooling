-- =====================================================================
-- PoolUp Member 1 - triggers + stored functions
-- Trigger errors use ERRCODE 23514 + CONSTRAINT = rule name so the API can
-- map them to a business rule (same convention as the Ratings module).
-- Seeding sets  SET LOCAL poolup.seeding = 'on'  to load historical rides.
-- =====================================================================

CREATE OR REPLACE FUNCTION fn_haversine_km(lat1 numeric, lon1 numeric, lat2 numeric, lon2 numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT (2 * 6371 * asin(sqrt(
      power(sin(radians(lat2 - lat1) / 2), 2) +
      cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2)
  )))::numeric
$$;

-- Road distance ~ 1.3 x straight line, summed over origin -> stops -> destination
CREATE OR REPLACE FUNCTION fn_route_km(p_origin int, p_dest int, p_stops int[] DEFAULT '{}')
RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE pts int[] := ARRAY[p_origin] || COALESCE(p_stops, '{}') || ARRAY[p_dest];
        i int; km numeric := 0; a location; b location;
BEGIN
  FOR i IN 1 .. array_length(pts, 1) - 1 LOOP
    SELECT * INTO a FROM location WHERE location_id = pts[i];
    SELECT * INTO b FROM location WHERE location_id = pts[i+1];
    IF a.location_id IS NULL OR b.location_id IS NULL THEN
      RAISE EXCEPTION 'Unknown location' USING ERRCODE = '23503', CONSTRAINT = 'ride_origin_id_fkey';
    END IF;
    km := km + fn_haversine_km(a.latitude, a.longitude, b.latitude, b.longitude);
  END LOOP;
  RETURN round(km * 1.3, 1);
END $$;

CREATE OR REPLACE FUNCTION fn_estimate_fare(p_cab text, p_km numeric)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT round(base_fare + per_km * p_km, 2) FROM cab_type WHERE cab_type = p_cab
$$;

CREATE OR REPLACE FUNCTION fn_seats_left(p_ride int)
RETURNS int LANGUAGE sql STABLE AS $$
  SELECT (c.max_seats - COALESCE((SELECT sum(m.seats_taken) FROM ride_member m
                                   WHERE m.ride_id = r.ride_id AND m.status = 'confirmed'), 0))::int
  FROM ride r JOIN cab_type c USING (cab_type) WHERE r.ride_id = p_ride
$$;

-- ---------- trigger: normalise student data ----------
CREATE OR REPLACE FUNCTION trg_student_normalize() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.full_name  := regexp_replace(trim(NEW.full_name), '\s+', ' ', 'g');
  NEW.email      := lower(trim(NEW.email));
  NEW.student_id := upper(trim(NEW.student_id));
  RETURN NEW;
END $$;
CREATE TRIGGER student_normalize BEFORE INSERT OR UPDATE ON student
  FOR EACH ROW EXECUTE FUNCTION trg_student_normalize();

-- ---------- trigger: validate a new ride ----------
CREATE OR REPLACE FUNCTION trg_ride_validate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('poolup.seeding', true) = 'on' THEN RETURN NEW; END IF;
  IF NEW.depart_start < now() + interval '15 minutes' THEN
    RAISE EXCEPTION 'A ride must start at least 15 minutes from now'
      USING ERRCODE = '23514', CONSTRAINT = 'rule_ride_in_future';
  END IF;
  IF NEW.depart_start > now() + interval '60 days' THEN
    RAISE EXCEPTION 'Rides can be created at most 60 days ahead'
      USING ERRCODE = '23514', CONSTRAINT = 'rule_ride_horizon';
  END IF;
  IF NEW.status <> 'open' THEN
    RAISE EXCEPTION 'A new ride must be open' USING ERRCODE = '23514', CONSTRAINT = 'rule_ride_starts_open';
  END IF;
  IF EXISTS (
      SELECT 1 FROM ride_member m JOIN ride r USING (ride_id)
      WHERE m.student_id = NEW.creator_id AND m.status = 'confirmed'
        AND r.status IN ('open','full','departed')
        AND r.depart_start < NEW.depart_end AND r.depart_end > NEW.depart_start) THEN
    RAISE EXCEPTION 'You already have a ride in this time window'
      USING ERRCODE = '23514', CONSTRAINT = 'rule_no_overlap';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ride_validate BEFORE INSERT ON ride
  FOR EACH ROW EXECUTE FUNCTION trg_ride_validate();

-- ---------- trigger: creator automatically occupies a seat ----------
CREATE OR REPLACE FUNCTION trg_ride_creator_joins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO ride_member (ride_id, student_id, seats_taken, status, joined_at)
  VALUES (NEW.ride_id, NEW.creator_id, 1, 'confirmed', NEW.created_at);
  RETURN NEW;
END $$;
CREATE TRIGGER ride_creator_joins AFTER INSERT ON ride
  FOR EACH ROW EXECUTE FUNCTION trg_ride_creator_joins();

-- ---------- trigger: ride status state machine + history ----------
CREATE OR REPLACE FUNCTION trg_ride_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF current_setting('poolup.seeding', true) IS DISTINCT FROM 'on' AND NOT (
         (OLD.status = 'open'     AND NEW.status IN ('full','departed','cancelled')) OR
         (OLD.status = 'full'     AND NEW.status IN ('open','departed','cancelled')) OR
         (OLD.status = 'departed' AND NEW.status = 'completed')) THEN
      RAISE EXCEPTION 'Illegal ride status change: % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514', CONSTRAINT = 'rule_ride_status_flow';
    END IF;
    INSERT INTO ride_status_log (ride_id, old_status, new_status) VALUES (OLD.ride_id, OLD.status, NEW.status);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ride_status BEFORE UPDATE OF status ON ride
  FOR EACH ROW EXECUTE FUNCTION trg_ride_status();

-- ---------- trigger: creator / route / cab are frozen after creation ----------
CREATE OR REPLACE FUNCTION trg_ride_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.creator_id, NEW.origin_id, NEW.dest_id, NEW.cab_type)
       IS DISTINCT FROM (OLD.creator_id, OLD.origin_id, OLD.dest_id, OLD.cab_type) THEN
    RAISE EXCEPTION 'Creator, route and cab type of a ride cannot be changed'
      USING ERRCODE = '23514', CONSTRAINT = 'rule_ride_core_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ride_frozen BEFORE UPDATE ON ride
  FOR EACH ROW EXECUTE FUNCTION trg_ride_frozen();

-- ---------- trigger: a stop is never the origin or destination ----------
CREATE OR REPLACE FUNCTION trg_stop_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r ride;
BEGIN
  SELECT * INTO r FROM ride WHERE ride_id = NEW.ride_id;
  IF NEW.location_id IN (r.origin_id, r.dest_id) THEN
    RAISE EXCEPTION 'A stop cannot be the same as the origin or destination'
      USING ERRCODE = '23514', CONSTRAINT = 'rule_stop_not_endpoint';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stop_validate BEFORE INSERT ON ride_stop
  FOR EACH ROW EXECUTE FUNCTION trg_stop_validate();

-- ---------- atomic ride creation ----------
-- Locks the creator row so two simultaneous requests from the same student
-- cannot both pass the overlap check (row-level locking). Ride + stops +
-- creator's seat are all-or-nothing because a function runs in one transaction.
CREATE OR REPLACE FUNCTION fn_create_ride(
    p_creator text, p_origin int, p_dest int, p_cab text,
    p_start timestamptz, p_end timestamptz, p_stops int[] DEFAULT '{}', p_note text DEFAULT NULL)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE v_id int; v_km numeric; i int;
BEGIN
  PERFORM 1 FROM student WHERE student_id = p_creator FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown student' USING ERRCODE = 'P0002';
  END IF;
  p_stops := COALESCE(p_stops, '{}');
  IF cardinality(p_stops) > 3 THEN
    RAISE EXCEPTION 'At most 3 stops are allowed' USING ERRCODE = '23514', CONSTRAINT = 'ride_stop_stop_seq_check';
  END IF;
  v_km := fn_route_km(p_origin, p_dest, p_stops);
  INSERT INTO ride (creator_id, origin_id, dest_id, cab_type, depart_start, depart_end, distance_km, note)
  VALUES (p_creator, p_origin, p_dest, p_cab, p_start, p_end, v_km, NULLIF(trim(p_note), ''))
  RETURNING ride_id INTO v_id;
  FOR i IN 1 .. cardinality(p_stops) LOOP
    INSERT INTO ride_stop (ride_id, stop_seq, location_id) VALUES (v_id, i, p_stops[i]);
  END LOOP;
  RETURN v_id;
END $$;

-- ---------- ride search ----------
-- A ride matches when the searcher's origin comes BEFORE the searcher's
-- destination along the ride's path  origin -> stop1..3 -> dest, so
-- "Main Gate -> Ameerpet" finds a ride going Main Gate -> Ameerpet -> Airport.
CREATE OR REPLACE FUNCTION fn_search_rides(
    p_origin int, p_dest int, p_from timestamptz, p_to timestamptz,
    p_seats int DEFAULT 1, p_cab text DEFAULT NULL, p_exclude text DEFAULT NULL)
RETURNS TABLE (
    ride_id int, creator_id text, creator_name text, creator_hostel text,
    origin_id int, origin_name text, dest_id int, dest_name text, stops text[],
    cab_type text, depart_start timestamptz, depart_end timestamptz,
    distance_km numeric, seats_left int, fare_total numeric, fare_per_head numeric,
    exact_route boolean, note text)
LANGUAGE sql STABLE AS $$
  WITH path AS (
    SELECT r.ride_id, 0 AS seq, r.origin_id::int AS loc FROM ride r WHERE r.status = 'open'
    UNION ALL SELECT s.ride_id, s.stop_seq::int, s.location_id::int FROM ride_stop s
    UNION ALL SELECT r.ride_id, 99, r.dest_id::int FROM ride r WHERE r.status = 'open'
  ),
  matched AS (
    SELECT DISTINCT a.ride_id
    FROM path a JOIN path b ON b.ride_id = a.ride_id AND b.seq > a.seq
    WHERE (p_origin IS NULL OR a.loc = p_origin) AND (p_dest IS NULL OR b.loc = p_dest)
  ),
  occupied AS (
    SELECT m.ride_id, sum(m.seats_taken)::int AS used FROM ride_member m WHERE m.status = 'confirmed' GROUP BY m.ride_id
  )
  SELECT r.ride_id, r.creator_id::text, s.full_name::text, h.name::text,
         r.origin_id::int, lo.name::text, r.dest_id::int, ld.name::text,
         COALESCE((SELECT array_agg(l.name::text ORDER BY st.stop_seq) FROM ride_stop st
                    JOIN location l USING (location_id) WHERE st.ride_id = r.ride_id), '{}'::text[]),
         r.cab_type::text, r.depart_start, r.depart_end, r.distance_km,
         (c.max_seats - COALESCE(o.used, 0))::int,
         fn_estimate_fare(r.cab_type, r.distance_km),
         round(fn_estimate_fare(r.cab_type, r.distance_km) / GREATEST(COALESCE(o.used, 0) + 1, 1), 2),
         COALESCE(r.origin_id = p_origin AND r.dest_id = p_dest, false),
         r.note::text
  FROM matched m
  JOIN ride r       ON r.ride_id = m.ride_id
  JOIN cab_type c   ON c.cab_type = r.cab_type
  JOIN student s    ON s.student_id = r.creator_id
  JOIN hostel h     ON h.hostel_id = s.hostel_id
  JOIN location lo  ON lo.location_id = r.origin_id
  JOIN location ld  ON ld.location_id = r.dest_id
  LEFT JOIN occupied o ON o.ride_id = r.ride_id
  WHERE r.depart_end >= COALESCE(p_from, now())
    AND (p_to IS NULL OR r.depart_start <= p_to)
    AND (p_cab IS NULL OR r.cab_type = p_cab)
    AND c.max_seats - COALESCE(o.used, 0) >= GREATEST(p_seats, 1)
    AND (p_exclude IS NULL OR r.creator_id <> p_exclude)
  ORDER BY COALESCE(r.origin_id = p_origin AND r.dest_id = p_dest, false) DESC, r.depart_start
$$;
