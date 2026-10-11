-- =====================================================================
-- PoolUp Member 1 - Users + Ride creation / search : SCHEMA
-- Table / column names match docs/INTEGRATION.md of the Ratings module.
-- =====================================================================

CREATE TABLE hostel (
    hostel_id   SMALLSERIAL  PRIMARY KEY,
    name        VARCHAR(40)  NOT NULL UNIQUE
);

CREATE TABLE student (
    student_id    CHAR(13)     PRIMARY KEY
                  CONSTRAINT student_id_format
                  CHECK (student_id ~ '^20[0-9]{2}[A-B][0-9A-Z](PS|TS)[0-9]{4}H$'),
    full_name     VARCHAR(80)  NOT NULL
                  CONSTRAINT student_name_len CHECK (length(trim(full_name)) >= 2),
    email         VARCHAR(120) NOT NULL UNIQUE
                  CONSTRAINT student_email_domain
                  CHECK (email ~ '^[a-z0-9._]+@hyderabad\.bits-pilani\.ac\.in$'),
    phone         CHAR(10)     NOT NULL UNIQUE
                  CONSTRAINT student_phone_format CHECK (phone ~ '^[6-9][0-9]{9}$'),
    hostel_id     SMALLINT     NOT NULL REFERENCES hostel(hostel_id),
    password_hash TEXT         NOT NULL CHECK (length(password_hash) >= 40),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Login sessions (opaque random token; only its SHA-256 is stored)
CREATE TABLE auth_session (
    token_hash  CHAR(64)    PRIMARY KEY,
    student_id  CHAR(13)    NOT NULL REFERENCES student(student_id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    CONSTRAINT session_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE TABLE location (
    location_id SMALLSERIAL  PRIMARY KEY,
    name        VARCHAR(80)  NOT NULL UNIQUE,
    loc_type    VARCHAR(10)  NOT NULL
                CHECK (loc_type IN ('campus','airport','railway','bus','mall','hub')),
    latitude    NUMERIC(8,5) NOT NULL CHECK (latitude  BETWEEN -90  AND 90),
    longitude   NUMERIC(8,5) NOT NULL CHECK (longitude BETWEEN -180 AND 180)
);

CREATE TABLE cab_type (
    cab_type    VARCHAR(10)  PRIMARY KEY,
    max_seats   SMALLINT     NOT NULL CHECK (max_seats BETWEEN 1 AND 7),
    base_fare   NUMERIC(7,2) NOT NULL CHECK (base_fare >= 0),
    per_km      NUMERIC(6,2) NOT NULL CHECK (per_km   >  0)
);

CREATE TABLE ride (
    ride_id      SERIAL       PRIMARY KEY,
    creator_id   CHAR(13)     NOT NULL REFERENCES student(student_id),
    origin_id    SMALLINT     NOT NULL REFERENCES location(location_id),
    dest_id      SMALLINT     NOT NULL REFERENCES location(location_id),
    cab_type     VARCHAR(10)  NOT NULL REFERENCES cab_type(cab_type),
    depart_start TIMESTAMPTZ  NOT NULL,
    depart_end   TIMESTAMPTZ  NOT NULL,
    distance_km  NUMERIC(6,1) NOT NULL CHECK (distance_km > 0),
    note         VARCHAR(200),
    status       VARCHAR(10)  NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','full','departed','completed','cancelled')),
    completed_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT ride_distinct_endpoints CHECK (origin_id <> dest_id),
    CONSTRAINT ride_window_valid       CHECK (depart_end > depart_start),
    CONSTRAINT ride_window_max_3h      CHECK (depart_end - depart_start <= interval '3 hours'),
    CONSTRAINT ride_completed_consistent CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
    CONSTRAINT ride_completed_after_departure CHECK (completed_at IS NULL OR completed_at >= depart_start)
);

-- Weak entity: an intermediate stop exists only as part of its ride
CREATE TABLE ride_stop (
    ride_id     INT       NOT NULL REFERENCES ride(ride_id) ON DELETE CASCADE,
    stop_seq    SMALLINT  NOT NULL CHECK (stop_seq BETWEEN 1 AND 3),
    location_id SMALLINT  NOT NULL REFERENCES location(location_id),
    PRIMARY KEY (ride_id, stop_seq),
    CONSTRAINT ride_stop_unique_location UNIQUE (ride_id, location_id)
);

-- Trigger-maintained history of status changes
CREATE TABLE ride_status_log (
    log_id     BIGSERIAL   PRIMARY KEY,
    ride_id    INT         NOT NULL REFERENCES ride(ride_id) ON DELETE CASCADE,
    old_status VARCHAR(10),
    new_status VARCHAR(10) NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ride_member (the seat booking) is owned by Member 2: see 11_m2_booking_schema.sql.
