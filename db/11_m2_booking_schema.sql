-- =====================================================================
-- PoolUp Member 2 - Booking + ride pooling / seat management : SCHEMA
-- ---------------------------------------------------------------------
-- ride_member keeps the contract the other modules rely on (docs/INTEGRATION.md):
--   PK (ride_id, student_id), seats_taken, status IN ('confirmed','cancelled','no_show'), joined_at
-- and adds booking columns (pickup/dropoff stop, cancelled_at, cancel_reason).
-- Runs AFTER 10_m1_users_rides_schema.sql (needs ride, student, location) and BEFORE 20_m1_users_rides_logic.sql
-- (SQL-language functions there reference ride_member and are validated at creation time).
-- =====================================================================

-- A seat booking. One row per (ride, student); a cancelled booking can later be re-activated.
CREATE TABLE ride_member (
    ride_id       INT          NOT NULL REFERENCES ride(ride_id) ON DELETE CASCADE,
    student_id    CHAR(13)     NOT NULL REFERENCES student(student_id),
    seats_taken   SMALLINT     NOT NULL DEFAULT 1
                  CONSTRAINT member_seats_range CHECK (seats_taken BETWEEN 1 AND 6),
    -- confirmed = has a seat (travelled, if the ride completed); no_show = booked but did not turn up
    status        VARCHAR(10)  NOT NULL DEFAULT 'confirmed'
                  CONSTRAINT member_status_values CHECK (status IN ('confirmed','cancelled','no_show')),
    joined_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    pickup_id     SMALLINT     REFERENCES location(location_id),   -- NULL = boards at the ride's origin
    dropoff_id    SMALLINT     REFERENCES location(location_id),   -- NULL = leaves at the ride's destination
    cancelled_at  TIMESTAMPTZ,
    cancel_reason VARCHAR(14)
                  CONSTRAINT member_cancel_reason_values CHECK (cancel_reason IN ('self','removed','ride_cancelled')),
    PRIMARY KEY (ride_id, student_id),
    CONSTRAINT member_segment_distinct CHECK (pickup_id IS NULL OR dropoff_id IS NULL OR pickup_id <> dropoff_id),
    CONSTRAINT member_cancel_fields    CHECK ((cancelled_at IS NULL AND cancel_reason IS NULL) OR status = 'cancelled')
);

-- Per-ride booking policy. No row = default policy (instant booking).
CREATE TABLE ride_booking_policy (
    ride_id    INT         PRIMARY KEY REFERENCES ride(ride_id) ON DELETE CASCADE,
    join_mode  VARCHAR(8)  NOT NULL DEFAULT 'instant'
               CONSTRAINT policy_join_mode_values CHECK (join_mode IN ('instant','approval')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Join requests for rides whose creator wants to approve riders
CREATE TABLE booking_request (
    request_id SERIAL       PRIMARY KEY,
    ride_id    INT          NOT NULL REFERENCES ride(ride_id) ON DELETE CASCADE,
    student_id CHAR(13)     NOT NULL REFERENCES student(student_id),
    seats      SMALLINT     NOT NULL DEFAULT 1 CONSTRAINT request_seats_range CHECK (seats BETWEEN 1 AND 6),
    pickup_id  SMALLINT     REFERENCES location(location_id),
    dropoff_id SMALLINT     REFERENCES location(location_id),
    message    VARCHAR(120),
    status     VARCHAR(10)  NOT NULL DEFAULT 'pending'
               CONSTRAINT request_status_values CHECK (status IN ('pending','accepted','rejected','withdrawn')),
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    decided_at TIMESTAMPTZ,
    CONSTRAINT request_decided_consistent CHECK ((status = 'pending') = (decided_at IS NULL)),
    CONSTRAINT request_segment_distinct   CHECK (pickup_id IS NULL OR dropoff_id IS NULL OR pickup_id <> dropoff_id)
);
-- A student can have at most ONE pending request per ride (partial unique index)
CREATE UNIQUE INDEX request_one_pending ON booking_request (ride_id, student_id) WHERE status = 'pending';

-- FIFO waiting list for full rides (position = order of joined_at)
CREATE TABLE ride_waitlist (
    ride_id    INT         NOT NULL REFERENCES ride(ride_id) ON DELETE CASCADE,
    student_id CHAR(13)    NOT NULL REFERENCES student(student_id),
    seats      SMALLINT    NOT NULL DEFAULT 1 CONSTRAINT waitlist_seats_range CHECK (seats BETWEEN 1 AND 6),
    pickup_id  SMALLINT    REFERENCES location(location_id),
    dropoff_id SMALLINT    REFERENCES location(location_id),
    joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (ride_id, student_id),
    CONSTRAINT waitlist_segment_distinct CHECK (pickup_id IS NULL OR dropoff_id IS NULL OR pickup_id <> dropoff_id)
);

-- Append-only audit / notification feed, maintained by triggers and the booking functions
CREATE TABLE booking_event (
    event_id   BIGSERIAL    PRIMARY KEY,
    ride_id    INT          NOT NULL REFERENCES ride(ride_id) ON DELETE CASCADE,
    student_id CHAR(13)     NOT NULL REFERENCES student(student_id),
    event      VARCHAR(14)  NOT NULL
               CONSTRAINT event_values CHECK (event IN ('booked','requested','accepted','rejected','withdrawn','waitlisted',
                                                        'promoted','left_waitlist','cancelled','late_cancel','removed',
                                                        'no_show','ride_cancelled')),
    seats      SMALLINT,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
