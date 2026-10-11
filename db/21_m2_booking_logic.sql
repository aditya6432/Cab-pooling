-- =====================================================================
-- PoolUp Member 2 - Booking + seat management : triggers + stored functions
-- Convention (shared with Members 1 and 5): a trigger rule raises ERRCODE 23514 with
-- CONSTRAINT = rule_...  so the API reports trigger rules and CHECK failures the same way.
-- Authorisation failures ("only the creator may ...") use SQLSTATE 42501 -> HTTP 403.
-- PostgreSQL fires triggers of one event in ALPHABETICAL order, so the numeric prefixes
-- (member_10_..., member_20_...) make the firing order explicit.
-- Runs after 20_m1_users_rides_logic.sql (uses fn_seats_left, fn_estimate_fare).
-- =====================================================================

CREATE OR REPLACE FUNCTION fn_seeding() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('poolup.seeding', true), '') = 'on'
$$;

-- ---------- the path of a ride: origin (0) -> stops (1..3) -> destination (99) ----------
CREATE OR REPLACE FUNCTION fn_ride_path(p_ride int)
RETURNS TABLE (seq int, location_id int, name text) LANGUAGE sql STABLE AS $$
  SELECT 0, r.origin_id::int, l.name::text FROM ride r JOIN location l ON l.location_id = r.origin_id WHERE r.ride_id = p_ride
  UNION ALL
  SELECT s.stop_seq::int, s.location_id::int, l.name::text FROM ride_stop s JOIN location l USING (location_id) WHERE s.ride_id = p_ride
  UNION ALL
  SELECT 99, r.dest_id::int, l.name::text FROM ride r JOIN location l ON l.location_id = r.dest_id WHERE r.ride_id = p_ride
  ORDER BY 1
$$;

-- pickup and dropoff (both optional) must be points of the ride's path, pickup strictly before dropoff
CREATE OR REPLACE FUNCTION fn_check_segment(p_ride int, p_pickup int, p_dropoff int)
RETURNS void LANGUAGE plpgsql STABLE AS $$
DECLARE a int; b int;
BEGIN
  IF p_pickup IS NULL AND p_dropoff IS NULL THEN RETURN; END IF;
  IF p_pickup  IS NULL THEN a := 0;  ELSE SELECT seq INTO a FROM fn_ride_path(p_ride) WHERE location_id = p_pickup;  END IF;
  IF p_dropoff IS NULL THEN b := 99; ELSE SELECT seq INTO b FROM fn_ride_path(p_ride) WHERE location_id = p_dropoff; END IF;
  IF a IS NULL OR b IS NULL OR a >= b THEN
    RAISE EXCEPTION 'Pickup and drop-off must be points on this ride''s route, pickup first'
      USING ERRCODE = '23514', CONSTRAINT = 'rule_bad_segment';
  END IF;
END $$;

-- =====================================================================
-- TRIGGERS ON ride_member
-- =====================================================================

-- (10) status state machine + cancellation bookkeeping
CREATE OR REPLACE FUNCTION trg_member_status_flow() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v ride%ROWTYPE;
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT ((OLD.status = 'confirmed' AND NEW.status IN ('cancelled', 'no_show'))
       OR (OLD.status = 'cancelled' AND NEW.status = 'confirmed')) THEN
    RAISE EXCEPTION 'Illegal booking status change: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514', CONSTRAINT = 'rule_member_status_flow';
  END IF;
  SELECT * INTO v FROM ride WHERE ride_id = NEW.ride_id;
  IF NEW.status IN ('cancelled', 'no_show') AND NEW.student_id = v.creator_id THEN
    RAISE EXCEPTION 'The creator''s seat belongs to the ride - cancel the ride instead'
      USING ERRCODE = '23514', CONSTRAINT = 'rule_creator_seat_locked';
  END IF;
  IF NEW.status = 'cancelled' THEN
    IF v.status IN ('departed', 'completed') AND NOT fn_seeding() THEN
      RAISE EXCEPTION 'The ride has already departed - a booking can no longer be cancelled'
        USING ERRCODE = '23514', CONSTRAINT = 'rule_cancel_after_departure';
    END IF;
    NEW.cancelled_at  := COALESCE(NEW.cancelled_at, now());
    NEW.cancel_reason := COALESCE(NEW.cancel_reason, 'self');
  ELSIF NEW.status = 'no_show' THEN
    IF v.status NOT IN ('departed', 'completed') THEN
      RAISE EXCEPTION 'A no-show can only be recorded once the ride has departed'
        USING ERRCODE = '23514', CONSTRAINT = 'rule_no_show_needs_departure';
    END IF;
  ELSE  -- cancelled -> confirmed (re-booking): clear the cancellation
    NEW.cancelled_at := NULL; NEW.cancel_reason := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_10_status_flow BEFORE UPDATE OF status ON ride_member
  FOR EACH ROW EXECUTE FUNCTION trg_member_status_flow();

-- (20) capacity + bookable window. Locks the ride row, so concurrent bookings of one ride are serialised
-- and the sum of confirmed seats can never exceed the cab's capacity.
CREATE OR REPLACE FUNCTION trg_member_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v record; used int;
BEGIN
  IF NEW.status <> 'confirmed' THEN RETURN NEW; END IF;
  SELECT r.status, r.depart_end, c.max_seats INTO v
    FROM ride r JOIN cab_type c USING (cab_type) WHERE r.ride_id = NEW.ride_id FOR UPDATE OF r;
  IF NOT FOUND THEN RETURN NEW; END IF;                     -- the foreign key reports the missing ride
  IF (TG_OP = 'INSERT' OR OLD.status <> 'confirmed') AND NOT fn_seeding() THEN
    IF v.status = 'full' THEN
      RAISE EXCEPTION 'This ride is full' USING ERRCODE = '23514', CONSTRAINT = 'rule_ride_full';
    ELSIF v.status <> 'open' THEN
      RAISE EXCEPTION 'Only open rides can be booked (this ride is %)', v.status
        USING ERRCODE = '23514', CONSTRAINT = 'rule_ride_not_bookable';
    ELSIF now() >= v.depart_end THEN
      RAISE EXCEPTION 'Booking closed: the departure window has ended'
        USING ERRCODE = '23514', CONSTRAINT = 'rule_booking_closed';
    END IF;
  END IF;
  SELECT COALESCE(sum(seats_taken), 0) INTO used FROM ride_member
   WHERE ride_id = NEW.ride_id AND status = 'confirmed' AND student_id <> NEW.student_id;
  IF used + NEW.seats_taken > v.max_seats THEN
    RAISE EXCEPTION 'Not enough seats: % left, % requested', v.max_seats - used, NEW.seats_taken
      USING ERRCODE = '23514', CONSTRAINT = 'rule_seat_capacity';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_20_capacity BEFORE INSERT OR UPDATE OF status, seats_taken ON ride_member
  FOR EACH ROW EXECUTE FUNCTION trg_member_capacity();

-- (30) a student cannot hold confirmed seats on two rides whose departure windows overlap
-- (row lock on the student serialises two simultaneous bookings by the same person)
CREATE OR REPLACE FUNCTION trg_member_no_overlap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE me record;
BEGIN
  IF NEW.status <> 'confirmed' OR fn_seeding() THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'confirmed' THEN RETURN NEW; END IF;
  PERFORM 1 FROM student WHERE student_id = NEW.student_id FOR UPDATE;
  SELECT depart_start, depart_end INTO me FROM ride WHERE ride_id = NEW.ride_id;
  IF EXISTS (SELECT 1 FROM ride_member m JOIN ride r USING (ride_id)
              WHERE m.student_id = NEW.student_id AND m.status = 'confirmed' AND m.ride_id <> NEW.ride_id
                AND r.status IN ('open', 'full', 'departed')
                AND r.depart_start < me.depart_end AND r.depart_end > me.depart_start) THEN
    RAISE EXCEPTION 'You already have a seat on another ride in this time window'
      USING ERRCODE = '23514', CONSTRAINT = 'rule_member_overlap';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_30_no_overlap BEFORE INSERT OR UPDATE OF status ON ride_member
  FOR EACH ROW EXECUTE FUNCTION trg_member_no_overlap();

-- (40) pickup / drop-off must lie on the ride's route
CREATE OR REPLACE FUNCTION trg_member_segment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fn_check_segment(NEW.ride_id, NEW.pickup_id, NEW.dropoff_id);
  RETURN NEW;
END $$;
CREATE TRIGGER member_40_segment BEFORE INSERT OR UPDATE OF pickup_id, dropoff_id ON ride_member
  FOR EACH ROW EXECUTE FUNCTION trg_member_segment();

-- ---------- waitlist promotion: first-fit FIFO ----------
-- Walks the waiting list in joined_at order and books every entry that fits the free seats.
-- An entry that does not fit (or has meanwhile become illegal, e.g. a clashing ride) is skipped and
-- keeps its place in the queue.
CREATE OR REPLACE FUNCTION fn_promote_waitlist(p_ride int) RETURNS int LANGUAGE plpgsql AS $$
DECLARE w ride_waitlist%ROWTYPE; st text; n int := 0; v_left int;
BEGIN
  SELECT status INTO st FROM ride WHERE ride_id = p_ride FOR UPDATE;
  IF st IS NULL OR st NOT IN ('open', 'full') THEN RETURN 0; END IF;
  FOR w IN SELECT * FROM ride_waitlist WHERE ride_id = p_ride ORDER BY joined_at, student_id FOR UPDATE LOOP
    v_left := fn_seats_left(p_ride);
    EXIT WHEN v_left <= 0;
    CONTINUE WHEN w.seats > v_left;
    BEGIN
      PERFORM set_config('poolup.promoting', 'on', true);          -- tells trg_member_after to log 'promoted', not 'booked'
      INSERT INTO ride_member (ride_id, student_id, seats_taken, status, pickup_id, dropoff_id, joined_at)
      VALUES (p_ride, w.student_id, w.seats, 'confirmed', w.pickup_id, w.dropoff_id, now())
      ON CONFLICT (ride_id, student_id) DO UPDATE
        SET status = 'confirmed', seats_taken = EXCLUDED.seats_taken, pickup_id = EXCLUDED.pickup_id,
            dropoff_id = EXCLUDED.dropoff_id, joined_at = EXCLUDED.joined_at;
      PERFORM set_config('poolup.promoting', 'off', true);
      DELETE FROM ride_waitlist WHERE ride_id = p_ride AND student_id = w.student_id;
      n := n + 1;
    EXCEPTION WHEN check_violation THEN
      PERFORM set_config('poolup.promoting', 'off', true);
      CONTINUE;
    END;
  END LOOP;
  RETURN n;
END $$;

-- (AFTER) keep ride.status in step with the seats, write the audit trail, promote the waitlist
CREATE OR REPLACE FUNCTION trg_member_after() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v ride%ROWTYPE; v_left int; v_event text;
BEGIN
  SELECT * INTO v FROM ride WHERE ride_id = NEW.ride_id;
  v_left := fn_seats_left(NEW.ride_id);
  IF v.status = 'open' AND v_left <= 0 THEN
    UPDATE ride SET status = 'full' WHERE ride_id = NEW.ride_id;
  ELSIF v.status = 'full' AND v_left > 0 THEN
    UPDATE ride SET status = 'open' WHERE ride_id = NEW.ride_id;
    v.status := 'open';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.student_id <> v.creator_id AND NEW.status = 'confirmed' THEN
      INSERT INTO booking_event (ride_id, student_id, event, seats, created_at)
      VALUES (NEW.ride_id, NEW.student_id,
              CASE WHEN COALESCE(current_setting('poolup.promoting', true), '') = 'on' THEN 'promoted' ELSE 'booked' END,
              NEW.seats_taken, NEW.joined_at);
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    v_event := CASE
      WHEN NEW.status = 'confirmed' THEN CASE WHEN COALESCE(current_setting('poolup.promoting', true), '') = 'on' THEN 'promoted' ELSE 'booked' END
      WHEN NEW.status = 'no_show'   THEN 'no_show'
      WHEN NEW.cancel_reason = 'removed'        THEN 'removed'
      WHEN NEW.cancel_reason = 'ride_cancelled' THEN 'ride_cancelled'
      WHEN NEW.cancelled_at > v.depart_start - interval '2 hours' THEN 'late_cancel'
      ELSE 'cancelled' END;
    INSERT INTO booking_event (ride_id, student_id, event, seats, created_at)
    VALUES (NEW.ride_id, NEW.student_id, v_event, NEW.seats_taken,
            CASE WHEN NEW.status = 'cancelled' THEN NEW.cancelled_at ELSE
                 CASE WHEN NEW.status = 'confirmed' THEN NEW.joined_at ELSE now() END END);
    IF OLD.status = 'confirmed' AND NEW.status = 'cancelled' AND v.status IN ('open', 'full') THEN
      PERFORM fn_promote_waitlist(NEW.ride_id);
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER member_90_after AFTER INSERT OR UPDATE OF status, seats_taken ON ride_member
  FOR EACH ROW EXECUTE FUNCTION trg_member_after();

-- =====================================================================
-- RIDE LIFECYCLE: what happens to the bookings when a ride is cancelled or departs
-- =====================================================================
CREATE OR REPLACE FUNCTION trg_ride_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE booking_request SET status = 'rejected', decided_at = now()
   WHERE ride_id = NEW.ride_id AND status = 'pending';
  INSERT INTO booking_event (ride_id, student_id, event, seats)
    SELECT ride_id, student_id, CASE WHEN NEW.status = 'cancelled' THEN 'ride_cancelled' ELSE 'left_waitlist' END, seats
      FROM ride_waitlist WHERE ride_id = NEW.ride_id;
  DELETE FROM ride_waitlist WHERE ride_id = NEW.ride_id;
  IF NEW.status = 'cancelled' THEN
    UPDATE ride_member SET status = 'cancelled', cancel_reason = 'ride_cancelled'
     WHERE ride_id = NEW.ride_id AND status = 'confirmed' AND student_id <> NEW.creator_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER ride_lifecycle AFTER UPDATE OF status ON ride
  FOR EACH ROW WHEN (NEW.status IN ('cancelled', 'departed') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION trg_ride_lifecycle();

-- =====================================================================
-- TRIGGERS ON ride_waitlist / booking_request / booking_event
-- =====================================================================

-- shared pre-checks for joining the waitlist or sending a request
CREATE OR REPLACE FUNCTION trg_pre_booking_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v ride%ROWTYPE;
BEGIN
  IF fn_seeding() THEN RETURN NEW; END IF;
  SELECT * INTO v FROM ride WHERE ride_id = NEW.ride_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF v.status NOT IN ('open', 'full') THEN
    RAISE EXCEPTION 'Only open or full rides accept requests (this ride is %)', v.status
      USING ERRCODE = '23514', CONSTRAINT = 'rule_ride_not_bookable';
  END IF;
  IF now() >= v.depart_end THEN
    RAISE EXCEPTION 'Booking closed: the departure window has ended'
      USING ERRCODE = '23514', CONSTRAINT = 'rule_booking_closed';
  END IF;
  IF NEW.student_id = v.creator_id THEN
    RAISE EXCEPTION 'You cannot book your own ride' USING ERRCODE = '23514', CONSTRAINT = 'rule_own_ride';
  END IF;
  IF EXISTS (SELECT 1 FROM ride_member WHERE ride_id = NEW.ride_id AND student_id = NEW.student_id AND status = 'confirmed') THEN
    RAISE EXCEPTION 'You already have a seat on this ride' USING ERRCODE = '23514', CONSTRAINT = 'rule_already_member';
  END IF;
  PERFORM fn_check_segment(NEW.ride_id, NEW.pickup_id, NEW.dropoff_id);
  RETURN NEW;
END $$;
CREATE TRIGGER waitlist_10_guard BEFORE INSERT ON ride_waitlist FOR EACH ROW EXECUTE FUNCTION trg_pre_booking_guard();
CREATE TRIGGER request_10_guard  BEFORE INSERT ON booking_request FOR EACH ROW EXECUTE FUNCTION trg_pre_booking_guard();

-- the waitlist is only for rides that cannot take the request right now
CREATE OR REPLACE FUNCTION trg_waitlist_needed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT fn_seeding() AND fn_seats_left(NEW.ride_id) >= NEW.seats THEN
    RAISE EXCEPTION 'Seats are available - book directly instead of waiting'
      USING ERRCODE = '23514', CONSTRAINT = 'rule_waitlist_not_needed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER waitlist_20_needed BEFORE INSERT ON ride_waitlist FOR EACH ROW EXECUTE FUNCTION trg_waitlist_needed();

CREATE OR REPLACE FUNCTION trg_waitlist_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO booking_event (ride_id, student_id, event, seats, created_at) VALUES (NEW.ride_id, NEW.student_id, 'waitlisted', NEW.seats, NEW.joined_at);
  RETURN NULL;
END $$;
CREATE TRIGGER waitlist_90_log AFTER INSERT ON ride_waitlist FOR EACH ROW EXECUTE FUNCTION trg_waitlist_log();

-- request state machine: pending -> accepted | rejected | withdrawn (terminal afterwards)
CREATE OR REPLACE FUNCTION trg_request_flow() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT (OLD.status = 'pending' AND NEW.status IN ('accepted', 'rejected', 'withdrawn')) THEN
    RAISE EXCEPTION 'Illegal request status change: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514', CONSTRAINT = 'rule_request_flow';
  END IF;
  NEW.decided_at := COALESCE(NEW.decided_at, now());
  RETURN NEW;
END $$;
CREATE TRIGGER request_20_flow BEFORE UPDATE OF status ON booking_request FOR EACH ROW EXECUTE FUNCTION trg_request_flow();

CREATE OR REPLACE FUNCTION trg_request_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO booking_event (ride_id, student_id, event, seats, created_at) VALUES (NEW.ride_id, NEW.student_id, 'requested', NEW.seats, NEW.created_at);
  ELSE
    INSERT INTO booking_event (ride_id, student_id, event, seats, created_at) VALUES (NEW.ride_id, NEW.student_id, NEW.status, NEW.seats, NEW.decided_at);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER request_90_log AFTER INSERT OR UPDATE OF status ON booking_request FOR EACH ROW EXECUTE FUNCTION trg_request_log();

-- the audit trail is append-only
CREATE OR REPLACE FUNCTION trg_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'booking_event is append-only' USING ERRCODE = '23514', CONSTRAINT = 'rule_event_immutable';
END $$;
CREATE TRIGGER event_immutable BEFORE UPDATE ON booking_event FOR EACH ROW EXECUTE FUNCTION trg_event_immutable();

-- =====================================================================
-- STORED FUNCTIONS = the booking workflows (each one atomic: a function runs in ONE transaction)
-- =====================================================================

-- Book a seat. Returns the outcome: 'confirmed' | 'requested' (creator must approve) | 'waitlisted'.
-- The ride row is locked first (FOR UPDATE), so two people competing for the last seat are serialised.
CREATE OR REPLACE FUNCTION fn_book_seat(
    p_student text, p_ride int, p_seats int DEFAULT 1, p_pickup int DEFAULT NULL, p_dropoff int DEFAULT NULL,
    p_message text DEFAULT NULL, p_waitlist boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v record; v_mode text; v_left int; m ride_member%ROWTYPE;
BEGIN
  SELECT r.status, r.creator_id, r.depart_end INTO v FROM ride r WHERE r.ride_id = p_ride FOR UPDATE OF r;
  IF NOT FOUND THEN RAISE EXCEPTION 'No such ride' USING ERRCODE = 'P0002'; END IF;
  PERFORM 1 FROM student WHERE student_id = p_student;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown student' USING ERRCODE = 'P0002'; END IF;
  p_seats := COALESCE(p_seats, 1);

  IF v.creator_id = p_student THEN
    RAISE EXCEPTION 'You cannot book your own ride' USING ERRCODE = '23514', CONSTRAINT = 'rule_own_ride';
  END IF;
  SELECT * INTO m FROM ride_member WHERE ride_id = p_ride AND student_id = p_student;
  IF FOUND AND m.status IN ('confirmed', 'no_show') THEN
    RAISE EXCEPTION 'You already have a seat on this ride' USING ERRCODE = '23514', CONSTRAINT = 'rule_already_member';
  END IF;
  IF v.status NOT IN ('open', 'full') THEN
    RAISE EXCEPTION 'Only open rides can be booked (this ride is %)', v.status
      USING ERRCODE = '23514', CONSTRAINT = 'rule_ride_not_bookable';
  END IF;
  IF now() >= v.depart_end THEN
    RAISE EXCEPTION 'Booking closed: the departure window has ended'
      USING ERRCODE = '23514', CONSTRAINT = 'rule_booking_closed';
  END IF;
  PERFORM fn_check_segment(p_ride, p_pickup, p_dropoff);

  v_left := fn_seats_left(p_ride);
  IF v_left < p_seats THEN
    IF p_waitlist THEN
      INSERT INTO ride_waitlist (ride_id, student_id, seats, pickup_id, dropoff_id)
      VALUES (p_ride, p_student, p_seats, p_pickup, p_dropoff);
      RETURN 'waitlisted';
    END IF;
    IF v.status = 'full' OR v_left <= 0 THEN
      RAISE EXCEPTION 'This ride is full - you can join the waitlist' USING ERRCODE = '23514', CONSTRAINT = 'rule_ride_full';
    END IF;
    RAISE EXCEPTION 'Not enough seats: % left, % requested', v_left, p_seats
      USING ERRCODE = '23514', CONSTRAINT = 'rule_seat_capacity';
  END IF;

  SELECT join_mode INTO v_mode FROM ride_booking_policy WHERE ride_id = p_ride;
  IF COALESCE(v_mode, 'instant') = 'approval' THEN
    INSERT INTO booking_request (ride_id, student_id, seats, pickup_id, dropoff_id, message)
    VALUES (p_ride, p_student, p_seats, p_pickup, p_dropoff, NULLIF(trim(p_message), ''));
    RETURN 'requested';
  END IF;

  INSERT INTO ride_member (ride_id, student_id, seats_taken, status, pickup_id, dropoff_id, joined_at)
  VALUES (p_ride, p_student, p_seats, 'confirmed', p_pickup, p_dropoff, now())
  ON CONFLICT (ride_id, student_id) DO UPDATE
    SET status = 'confirmed', seats_taken = EXCLUDED.seats_taken, pickup_id = EXCLUDED.pickup_id,
        dropoff_id = EXCLUDED.dropoff_id, joined_at = EXCLUDED.joined_at;
  DELETE FROM ride_waitlist WHERE ride_id = p_ride AND student_id = p_student;
  RETURN 'confirmed';
END $$;

-- Cancel my booking. Returns the number of seats released. Waitlist promotion happens in the trigger.
CREATE OR REPLACE FUNCTION fn_cancel_booking(p_student text, p_ride int) RETURNS int LANGUAGE plpgsql AS $$
DECLARE v_seats int;
BEGIN
  PERFORM 1 FROM ride WHERE ride_id = p_ride FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No such ride' USING ERRCODE = 'P0002'; END IF;
  UPDATE ride_member SET status = 'cancelled', cancel_reason = 'self'
   WHERE ride_id = p_ride AND student_id = p_student AND status = 'confirmed'
  RETURNING seats_taken INTO v_seats;
  IF NOT FOUND THEN RAISE EXCEPTION 'You have no active booking on this ride' USING ERRCODE = 'P0002'; END IF;
  RETURN v_seats;
END $$;

-- helper: raise 42501 unless p_student created the ride
CREATE OR REPLACE FUNCTION fn_require_creator(p_ride int, p_student text) RETURNS void LANGUAGE plpgsql STABLE AS $$
DECLARE c text;
BEGIN
  SELECT creator_id INTO c FROM ride WHERE ride_id = p_ride;
  IF NOT FOUND THEN RAISE EXCEPTION 'No such ride' USING ERRCODE = 'P0002'; END IF;
  IF c <> p_student THEN RAISE EXCEPTION 'Only the creator of the ride can do this' USING ERRCODE = '42501'; END IF;
END $$;

-- Creator removes a rider (frees the seat; the waitlist is promoted by the trigger)
CREATE OR REPLACE FUNCTION fn_remove_rider(p_creator text, p_ride int, p_student text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fn_require_creator(p_ride, p_creator);
  PERFORM 1 FROM ride WHERE ride_id = p_ride FOR UPDATE;
  UPDATE ride_member SET status = 'cancelled', cancel_reason = 'removed'
   WHERE ride_id = p_ride AND student_id = p_student AND status = 'confirmed';
  IF NOT FOUND THEN RAISE EXCEPTION 'That student has no active booking on this ride' USING ERRCODE = 'P0002'; END IF;
END $$;

CREATE OR REPLACE FUNCTION fn_leave_waitlist(p_student text, p_ride int) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM ride_waitlist WHERE ride_id = p_ride AND student_id = p_student;
  IF NOT FOUND THEN RAISE EXCEPTION 'You are not on this waitlist' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO booking_event (ride_id, student_id, event) VALUES (p_ride, p_student, 'left_waitlist');
END $$;

CREATE OR REPLACE FUNCTION fn_withdraw_request(p_student text, p_request int) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE booking_request SET status = 'withdrawn'
   WHERE request_id = p_request AND student_id = p_student AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'No pending request found' USING ERRCODE = 'P0002'; END IF;
END $$;

-- Creator accepts / rejects a request. Accepting books the seat through the same triggers as a direct booking.
CREATE OR REPLACE FUNCTION fn_decide_request(p_creator text, p_request int, p_accept boolean) RETURNS text LANGUAGE plpgsql AS $$
DECLARE q booking_request%ROWTYPE; v_ride int;
BEGIN
  SELECT ride_id INTO v_ride FROM booking_request WHERE request_id = p_request;
  IF NOT FOUND THEN RAISE EXCEPTION 'No such request' USING ERRCODE = 'P0002'; END IF;
  PERFORM fn_require_creator(v_ride, p_creator);
  PERFORM 1 FROM ride WHERE ride_id = v_ride FOR UPDATE;                 -- lock order: ride, then request
  SELECT * INTO q FROM booking_request WHERE request_id = p_request FOR UPDATE;
  IF q.status <> 'pending' THEN
    RAISE EXCEPTION 'This request was already % ', q.status USING ERRCODE = '23514', CONSTRAINT = 'rule_request_flow';
  END IF;
  IF p_accept THEN
    INSERT INTO ride_member (ride_id, student_id, seats_taken, status, pickup_id, dropoff_id, joined_at)
    VALUES (q.ride_id, q.student_id, q.seats, 'confirmed', q.pickup_id, q.dropoff_id, now())
    ON CONFLICT (ride_id, student_id) DO UPDATE
      SET status = 'confirmed', seats_taken = EXCLUDED.seats_taken, pickup_id = EXCLUDED.pickup_id,
          dropoff_id = EXCLUDED.dropoff_id, joined_at = EXCLUDED.joined_at;
    UPDATE booking_request SET status = 'accepted' WHERE request_id = p_request;
    RETURN 'accepted';
  END IF;
  UPDATE booking_request SET status = 'rejected' WHERE request_id = p_request;
  RETURN 'rejected';
END $$;

CREATE OR REPLACE FUNCTION fn_set_join_mode(p_creator text, p_ride int, p_mode text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  PERFORM fn_require_creator(p_ride, p_creator);
  SELECT status INTO st FROM ride WHERE ride_id = p_ride;
  IF st NOT IN ('open', 'full') THEN
    RAISE EXCEPTION 'Only open or full rides can change their booking policy'
      USING ERRCODE = '23514', CONSTRAINT = 'rule_ride_not_bookable';
  END IF;
  INSERT INTO ride_booking_policy (ride_id, join_mode) VALUES (p_ride, p_mode)
  ON CONFLICT (ride_id) DO UPDATE SET join_mode = EXCLUDED.join_mode, updated_at = now();
END $$;

-- Ride lifecycle driven by the creator: open/full -> departed -> completed
CREATE OR REPLACE FUNCTION fn_start_ride(p_creator text, p_ride int) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v record;
BEGIN
  PERFORM fn_require_creator(p_ride, p_creator);
  SELECT depart_start INTO v FROM ride WHERE ride_id = p_ride FOR UPDATE;
  IF now() < v.depart_start - interval '30 minutes' THEN
    RAISE EXCEPTION 'A ride can be started at most 30 minutes before its departure window'
      USING ERRCODE = '23514', CONSTRAINT = 'rule_too_early_to_depart';
  END IF;
  UPDATE ride SET status = 'departed' WHERE ride_id = p_ride;        -- state machine trigger validates the move
END $$;

CREATE OR REPLACE FUNCTION fn_complete_ride(p_creator text, p_ride int) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v record;
BEGIN
  PERFORM fn_require_creator(p_ride, p_creator);
  SELECT depart_start INTO v FROM ride WHERE ride_id = p_ride FOR UPDATE;
  IF now() < v.depart_start THEN
    RAISE EXCEPTION 'A ride cannot complete before its departure window starts'
      USING ERRCODE = '23514', CONSTRAINT = 'rule_too_early_to_depart';
  END IF;
  UPDATE ride SET status = 'completed', completed_at = now() WHERE ride_id = p_ride;
END $$;

CREATE OR REPLACE FUNCTION fn_mark_no_show(p_creator text, p_ride int, p_student text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fn_require_creator(p_ride, p_creator);
  PERFORM 1 FROM ride WHERE ride_id = p_ride FOR UPDATE;
  UPDATE ride_member SET status = 'no_show' WHERE ride_id = p_ride AND student_id = p_student AND status = 'confirmed';
  IF NOT FOUND THEN RAISE EXCEPTION 'That student has no confirmed seat on this ride' USING ERRCODE = 'P0002'; END IF;
END $$;
