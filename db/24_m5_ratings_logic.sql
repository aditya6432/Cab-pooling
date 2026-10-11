-- =====================================================================
-- PoolUp — RATINGS MODULE LOGIC  (24_m5_ratings_logic.sql)
-- Owner: Member 5 (Ratings + Analytics / Dashboard)
-- ---------------------------------------------------------------------
-- Rules that need OTHER tables or the CLOCK cannot be CHECK constraints,
-- so they are enforced here with triggers:
--   BR8   a ride can be rated only after it is 'completed'
--   BR9   both rater and ratee must have actually travelled ('confirmed')
--   BR10  ratings may be submitted only within 7 days of completion
--   BR11  a rating may be edited / withdrawn only within 24 h of submission
--   BR12  the identifying key of a rating can never change
--   BR13  at most 3 tags per rating
--   BR14  no negative tag on a 5★ rating, no positive tag on a 1★ rating
--   BR15  once a ride/member has ratings, it cannot be "un-completed" /
--         re-labelled as cancelled or no-show (protects rating history)
--   BR16  every insert/update/delete of a rating is audited
--
-- All rule violations are raised with SQLSTATE 23514 (check_violation)
-- and a CONSTRAINT name starting with "rule_", so the API can report
-- them exactly like a declarative CHECK failure.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Single source of truth for the two time windows
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_rating_window() RETURNS INTERVAL
LANGUAGE sql IMMUTABLE AS $$ SELECT INTERVAL '7 days' $$;

CREATE OR REPLACE FUNCTION fn_edit_window() RETURNS INTERVAL
LANGUAGE sql IMMUTABLE AS $$ SELECT INTERVAL '24 hours' $$;

-- ---------------------------------------------------------------------
-- Reputation maths
--   Bayesian average  = (C·m + Σscores) / (C + n)
--     m = campus-wide mean score (prior), C = prior weight (5 "virtual" ratings)
--   A student with one 5★ rating does not outrank one with fifty 4.8★ ratings.
--
--   Trust score (0–100) = 80% rating component + 20% reliability component
--     rating component      = (bayes − 1) / 4         (maps 1..5 -> 0..1)
--     reliability component = 1 − no_show_rate
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_bayesian_score(p_sum NUMERIC, p_n BIGINT,
                                             p_prior NUMERIC, p_weight INT DEFAULT 5)
RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$
    SELECT ROUND((p_weight * p_prior + COALESCE(p_sum, 0)) / (p_weight + COALESCE(p_n, 0)), 3)
$$;

CREATE OR REPLACE FUNCTION fn_trust_score(p_bayes NUMERIC, p_no_show_rate NUMERIC)
RETURNS SMALLINT LANGUAGE sql IMMUTABLE AS $$
    SELECT GREATEST(0, LEAST(100, ROUND(
             100 * (0.8 * (p_bayes - 1) / 4.0 + 0.2 * (1 - COALESCE(p_no_show_rate, 0)))
           )))::SMALLINT
$$;

-- =====================================================================
-- TRIGGERS ON rating
-- =====================================================================

-- BR8, BR9, BR10 -------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_rating_before_insert() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_status        ride.status%TYPE;
    v_completed_at  ride.completed_at%TYPE;
    v_rater_status  ride_member.status%TYPE;
    v_ratee_status  ride_member.status%TYPE;
BEGIN
    SELECT status, completed_at INTO v_status, v_completed_at
    FROM ride WHERE ride_id = NEW.ride_id;

    IF NOT FOUND THEN
        RETURN NEW;          -- let the foreign key report the missing ride
    END IF;

    IF v_status <> 'completed' THEN
        RAISE EXCEPTION 'Ride % is "%" — co-riders can be rated only after the ride is completed',
                        NEW.ride_id, v_status
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_ride_completed',
                    TABLE = 'rating';
    END IF;

    SELECT status INTO v_rater_status FROM ride_member
     WHERE ride_id = NEW.ride_id AND student_id = NEW.rater_id;
    SELECT status INTO v_ratee_status FROM ride_member
     WHERE ride_id = NEW.ride_id AND student_id = NEW.ratee_id;

    -- if either is NULL the composite FK will raise the proper error
    IF v_rater_status IS NOT NULL AND v_rater_status <> 'confirmed' THEN
        RAISE EXCEPTION 'Rater % did not travel on ride % (status: %)',
                        NEW.rater_id, NEW.ride_id, v_rater_status
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_both_travelled', TABLE = 'rating';
    END IF;
    IF v_ratee_status IS NOT NULL AND v_ratee_status <> 'confirmed' THEN
        RAISE EXCEPTION 'Ratee % did not travel on ride % (status: %)',
                        NEW.ratee_id, NEW.ride_id, v_ratee_status
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_both_travelled', TABLE = 'rating';
    END IF;

    IF NEW.created_at < v_completed_at
       OR NEW.created_at > v_completed_at + fn_rating_window()
       OR NEW.created_at > now() + INTERVAL '1 minute' THEN
        RAISE EXCEPTION 'Rating window for ride % closed on % IST (ratings are accepted for % after completion)',
                        NEW.ride_id,
                        to_char((v_completed_at + fn_rating_window()) AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH24:MI'),
                        fn_rating_window()
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_rating_window', TABLE = 'rating';
    END IF;

    NEW.updated_at := NULL;
    RETURN NEW;
END $$;

CREATE TRIGGER rating_before_insert
BEFORE INSERT ON rating
FOR EACH ROW EXECUTE FUNCTION trg_rating_before_insert();

-- BR11, BR12, BR14 (on score change) ----------------------------------
CREATE OR REPLACE FUNCTION trg_rating_before_update() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.ride_id, NEW.rater_id, NEW.ratee_id, NEW.created_at)
       IS DISTINCT FROM (OLD.ride_id, OLD.rater_id, OLD.ratee_id, OLD.created_at) THEN
        RAISE EXCEPTION 'The ride, rater, ratee and submission time of a rating cannot be changed'
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_rating_key_immutable', TABLE = 'rating';
    END IF;

    IF now() > OLD.created_at + fn_edit_window() THEN
        RAISE EXCEPTION 'Rating can no longer be edited — edits are allowed for % hours after submission (submitted %)',
                        (EXTRACT(EPOCH FROM fn_edit_window()) / 3600)::INT,
                        to_char(OLD.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH24:MI "IST"')
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_edit_window', TABLE = 'rating';
    END IF;

    IF NEW.score <> OLD.score AND EXISTS (
        SELECT 1
        FROM rating_tag_map m JOIN rating_tag t ON t.tag_id = m.tag_id
        WHERE (m.ride_id, m.rater_id, m.ratee_id) = (NEW.ride_id, NEW.rater_id, NEW.ratee_id)
          AND ((t.sentiment = 'negative' AND NEW.score = 5) OR
               (t.sentiment = 'positive' AND NEW.score = 1))) THEN
        RAISE EXCEPTION 'New score % conflicts with the tags already attached to this rating', NEW.score
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_tag_sentiment', TABLE = 'rating';
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
END $$;

CREATE TRIGGER rating_before_update
BEFORE UPDATE ON rating
FOR EACH ROW EXECUTE FUNCTION trg_rating_before_update();

-- BR11 for deletes ----------------------------------------------------
CREATE OR REPLACE FUNCTION trg_rating_before_delete() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    -- pg_trigger_depth() > 1 means this delete is a cascade fired by a
    -- foreign-key action (e.g. an admin deleting a whole ride), not a
    -- user withdrawing their own rating — allow it.
    IF pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;

    IF now() > OLD.created_at + fn_edit_window() THEN
        RAISE EXCEPTION 'Rating can no longer be withdrawn — allowed only within % hours of submission',
                        (EXTRACT(EPOCH FROM fn_edit_window()) / 3600)::INT
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_edit_window', TABLE = 'rating';
    END IF;
    RETURN OLD;
END $$;

CREATE TRIGGER rating_before_delete
BEFORE DELETE ON rating
FOR EACH ROW EXECUTE FUNCTION trg_rating_before_delete();

-- BR16 ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_rating_audit() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO rating_audit (ride_id, rater_id, ratee_id, action, new_score, new_comment, changed_at)
        VALUES (NEW.ride_id, NEW.rater_id, NEW.ratee_id, 'I', NEW.score, NEW.comment, NEW.created_at);
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO rating_audit (ride_id, rater_id, ratee_id, action,
                                  old_score, new_score, old_comment, new_comment, changed_at)
        VALUES (NEW.ride_id, NEW.rater_id, NEW.ratee_id, 'U',
                OLD.score, NEW.score, OLD.comment, NEW.comment, COALESCE(NEW.updated_at, now()));
        RETURN NEW;
    ELSE
        INSERT INTO rating_audit (ride_id, rater_id, ratee_id, action, old_score, old_comment)
        VALUES (OLD.ride_id, OLD.rater_id, OLD.ratee_id, 'D', OLD.score, OLD.comment);
        RETURN OLD;
    END IF;
END $$;

CREATE TRIGGER rating_audit_trg
AFTER INSERT OR UPDATE OR DELETE ON rating
FOR EACH ROW EXECUTE FUNCTION trg_rating_audit();

-- =====================================================================
-- TRIGGER ON rating_tag_map — BR13, BR14
-- =====================================================================
CREATE OR REPLACE FUNCTION trg_rating_tag_guard() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_score      rating.score%TYPE;
    v_sentiment  rating_tag.sentiment%TYPE;
    v_count      INT;
BEGIN
    -- Lock the parent rating row: two concurrent transactions adding tags
    -- to the same rating are serialised here, so the "max 3" count below
    -- cannot be raced past.
    SELECT score INTO v_score
    FROM rating
    WHERE (ride_id, rater_id, ratee_id) = (NEW.ride_id, NEW.rater_id, NEW.ratee_id)
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN NEW;          -- the foreign key will report it
    END IF;

    SELECT count(*) INTO v_count
    FROM rating_tag_map
    WHERE (ride_id, rater_id, ratee_id) = (NEW.ride_id, NEW.rater_id, NEW.ratee_id)
      AND tag_id <> NEW.tag_id;

    IF v_count >= 3 THEN
        RAISE EXCEPTION 'A rating can carry at most 3 tags'
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_max_tags', TABLE = 'rating_tag_map';
    END IF;

    SELECT sentiment INTO v_sentiment FROM rating_tag WHERE tag_id = NEW.tag_id;

    IF (v_sentiment = 'negative' AND v_score = 5) OR (v_sentiment = 'positive' AND v_score = 1) THEN
        RAISE EXCEPTION 'A % tag cannot be attached to a %★ rating', v_sentiment, v_score
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_tag_sentiment', TABLE = 'rating_tag_map';
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER rating_tag_guard
BEFORE INSERT OR UPDATE ON rating_tag_map
FOR EACH ROW EXECUTE FUNCTION trg_rating_tag_guard();

-- =====================================================================
-- BR15 — cross-module protection of rating history
-- (triggers live on teammates' tables but protect THIS module's data)
-- =====================================================================
CREATE OR REPLACE FUNCTION trg_protect_rated_ride() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'completed' AND NEW.status <> 'completed'
       AND EXISTS (SELECT 1 FROM rating WHERE ride_id = OLD.ride_id) THEN
        RAISE EXCEPTION 'Ride % already has ratings — it cannot be changed from completed to %',
                        OLD.ride_id, NEW.status
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_rated_ride_locked', TABLE = 'ride';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER ride_protect_rated
BEFORE UPDATE OF status ON ride
FOR EACH ROW EXECUTE FUNCTION trg_protect_rated_ride();

CREATE OR REPLACE FUNCTION trg_protect_rated_member() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'confirmed' AND NEW.status <> 'confirmed'
       AND EXISTS (SELECT 1 FROM rating
                   WHERE ride_id = OLD.ride_id
                     AND OLD.student_id IN (rater_id, ratee_id)) THEN
        RAISE EXCEPTION 'Student % has ratings on ride % — their status cannot change to %',
                        OLD.student_id, OLD.ride_id, NEW.status
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_rated_member_locked', TABLE = 'ride_member';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER ride_member_protect_rated
BEFORE UPDATE OF status ON ride_member
FOR EACH ROW EXECUTE FUNCTION trg_protect_rated_member();

-- =====================================================================
-- STORED FUNCTIONS (called by the API)
-- =====================================================================

-- Submit one rating together with its tags — atomic: if any tag fails a
-- rule, the rating itself is rolled back too.
CREATE OR REPLACE FUNCTION fn_submit_rating(
    p_ride     INT,
    p_rater    CHAR(13),
    p_ratee    CHAR(13),
    p_score    SMALLINT,
    p_comment  TEXT,
    p_tags     SMALLINT[] DEFAULT '{}'
) RETURNS rating
LANGUAGE plpgsql AS $$
DECLARE
    v rating;
BEGIN
    INSERT INTO rating (ride_id, rater_id, ratee_id, score, comment)
    VALUES (p_ride, p_rater, p_ratee, p_score, NULLIF(trim(p_comment), ''))
    RETURNING * INTO v;

    INSERT INTO rating_tag_map (ride_id, rater_id, ratee_id, tag_id)
    SELECT p_ride, p_rater, p_ratee, t
    FROM unnest(COALESCE(p_tags, '{}'::SMALLINT[])) AS t;

    RETURN v;
END $$;

-- Edit a rating (score, comment, tags) — replaces the tag set atomically.
CREATE OR REPLACE FUNCTION fn_update_rating(
    p_ride     INT,
    p_rater    CHAR(13),
    p_ratee    CHAR(13),
    p_score    SMALLINT,
    p_comment  TEXT,
    p_tags     SMALLINT[] DEFAULT '{}'
) RETURNS rating
LANGUAGE plpgsql AS $$
DECLARE
    v rating;
BEGIN
    DELETE FROM rating_tag_map
    WHERE (ride_id, rater_id, ratee_id) = (p_ride, p_rater, p_ratee);

    UPDATE rating
       SET score = p_score, comment = NULLIF(trim(p_comment), '')
     WHERE (ride_id, rater_id, ratee_id) = (p_ride, p_rater, p_ratee)
    RETURNING * INTO v;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No rating by % for % on ride %', p_rater, p_ratee, p_ride
              USING ERRCODE = 'no_data_found';
    END IF;

    INSERT INTO rating_tag_map (ride_id, rater_id, ratee_id, tag_id)
    SELECT p_ride, p_rater, p_ratee, t
    FROM unnest(COALESCE(p_tags, '{}'::SMALLINT[])) AS t;

    RETURN v;
END $$;

-- Co-riders the student still has to rate (anti-join with NOT EXISTS)
CREATE OR REPLACE FUNCTION fn_pending_ratings(p_student CHAR(13))
RETURNS TABLE (
    ride_id       INT,
    route         TEXT,
    depart_start  TIMESTAMPTZ,
    completed_at  TIMESTAMPTZ,
    closes_at     TIMESTAMPTZ,
    ratee_id      CHAR(13),
    ratee_name    VARCHAR,
    ratee_hostel  VARCHAR
)
LANGUAGE sql STABLE AS $$
    SELECT r.ride_id,
           o.name || ' → ' || d.name,
           r.depart_start,
           r.completed_at,
           r.completed_at + fn_rating_window(),
           co.student_id,
           s.full_name,
           h.name
    FROM ride r
    JOIN ride_member me ON me.ride_id = r.ride_id
                       AND me.student_id = p_student
                       AND me.status = 'confirmed'
    JOIN ride_member co ON co.ride_id = r.ride_id
                       AND co.student_id <> p_student
                       AND co.status = 'confirmed'
    JOIN student  s ON s.student_id  = co.student_id
    JOIN hostel   h ON h.hostel_id   = s.hostel_id
    JOIN location o ON o.location_id = r.origin_id
    JOIN location d ON d.location_id = r.dest_id
    WHERE r.status = 'completed'
      AND now() <= r.completed_at + fn_rating_window()
      AND NOT EXISTS (SELECT 1 FROM rating x
                      WHERE x.ride_id  = r.ride_id
                        AND x.rater_id = p_student
                        AND x.ratee_id = co.student_id)
    ORDER BY r.completed_at + fn_rating_window(), r.ride_id, s.full_name
$$;

-- ---------------------------------------------------------------------
-- RECURSIVE CTE — "Trust network"
-- Edge A → B exists when A's average rating of B is >= 4.5 ("strong trust").
-- Walk outward from a student up to p_max_depth hops, never revisiting a
-- node already on the current path (cycle prevention), and keep the
-- SHORTEST route to every reachable student.
-- Answers: "who is trusted by people I trust?"  → safe co-rider suggestions
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_trust_network(p_student CHAR(13), p_max_depth INT DEFAULT 3)
RETURNS TABLE (
    student_id  CHAR(13),
    full_name   VARCHAR,
    hostel      VARCHAR,
    hops        INT,
    path_ids    TEXT[],
    path_names  TEXT[],
    via_score   NUMERIC
)
LANGUAGE sql STABLE AS $$
    WITH RECURSIVE trust_edge AS (
        SELECT rater_id AS src, ratee_id AS dst, AVG(score) AS avg_score
        FROM rating
        GROUP BY rater_id, ratee_id
        HAVING AVG(score) >= 4.5
    ),
    walk (node, hops, path, via_score) AS (
        -- anchor: people I directly trust
        SELECT e.dst::TEXT, 1, ARRAY[e.src::TEXT, e.dst::TEXT], e.avg_score
        FROM trust_edge e
        WHERE e.src = p_student
      UNION ALL
        -- recursive step: people trusted by someone already reached
        SELECT e.dst::TEXT, w.hops + 1, w.path || e.dst::TEXT, e.avg_score
        FROM walk w
        JOIN trust_edge e ON e.src = w.node
        WHERE w.hops < LEAST(p_max_depth, 4)
          AND NOT (e.dst::TEXT = ANY (w.path))          -- cycle prevention
    ),
    shortest AS (
        SELECT DISTINCT ON (node) node, hops, path, via_score
        FROM walk
        ORDER BY node, hops, via_score DESC
    )
    SELECT s.student_id,
           s.full_name,
           h.name,
           sh.hops,
           sh.path,
           (SELECT array_agg(p.full_name::TEXT ORDER BY u.ord)
              FROM unnest(sh.path) WITH ORDINALITY AS u(id, ord)
              JOIN student p ON p.student_id = u.id),
           ROUND(sh.via_score, 2)
    FROM shortest sh
    JOIN student s ON s.student_id = sh.node
    JOIN hostel  h ON h.hostel_id  = s.hostel_id
    ORDER BY sh.hops, sh.via_score DESC, s.full_name
$$;
