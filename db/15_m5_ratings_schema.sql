-- =====================================================================
-- PoolUp — RATINGS MODULE SCHEMA  (15_m5_ratings_schema.sql)
-- Owner: Member 5 (Ratings + Analytics / Dashboard)
-- ---------------------------------------------------------------------
-- Entities
--   rating          : one student's review of one co-rider for one ride
--   rating_tag      : fixed vocabulary of quick tags ("Punctual", "Late"…)
--   rating_tag_map  : multivalued attribute  rating —< tags  (1NF mapping)
--   rating_audit    : append-only history of every insert/update/delete
--
-- Business rules enforced DECLARATIVELY here (rules that need other
-- tables / time are enforced by triggers in 24_m5_ratings_logic.sql):
--   BR1  score is an integer 1..5                         -> CHECK
--   BR2  nobody rates themself                            -> CHECK
--   BR3  rater AND ratee were both members of that ride   -> composite FKs
--   BR4  one rating per (ride, rater, ratee)              -> PRIMARY KEY
--   BR5  a 1★/2★ rating must carry a comment (>=10 chars) -> CHECK
--   BR6  tags come from a fixed vocabulary                -> FK
--   BR7  each tag at most once per rating                 -> PRIMARY KEY
-- =====================================================================

-- ---------------------------------------------------------------------
-- rating_tag : controlled vocabulary
-- ---------------------------------------------------------------------
CREATE TABLE rating_tag (
    tag_id     SMALLSERIAL  PRIMARY KEY,
    label      VARCHAR(30)  NOT NULL,
    sentiment  VARCHAR(8)   NOT NULL,
    CONSTRAINT rating_tag_label_unique   UNIQUE (label),          -- candidate key
    CONSTRAINT rating_tag_sentiment_enum CHECK (sentiment IN ('positive','negative'))
);

-- ---------------------------------------------------------------------
-- rating : the core relation of this module
-- ---------------------------------------------------------------------
CREATE TABLE rating (
    ride_id     INT           NOT NULL,
    rater_id    CHAR(13)      NOT NULL,
    ratee_id    CHAR(13)      NOT NULL,
    score       SMALLINT      NOT NULL,
    comment     VARCHAR(280),
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ,

    -- BR4: identifying key — a rater rates a given co-rider once per ride
    CONSTRAINT rating_pk PRIMARY KEY (ride_id, rater_id, ratee_id),

    -- BR1
    CONSTRAINT rating_score_range CHECK (score BETWEEN 1 AND 5),

    -- BR2
    CONSTRAINT rating_no_self CHECK (rater_id <> ratee_id),

    -- BR3: composite foreign keys into ride_member(ride_id, student_id).
    -- This makes "you can only rate someone you shared THIS ride with"
    -- a property the DBMS guarantees, with zero application code.
    CONSTRAINT rating_rater_on_ride FOREIGN KEY (ride_id, rater_id)
        REFERENCES ride_member (ride_id, student_id) ON DELETE CASCADE,
    CONSTRAINT rating_ratee_on_ride FOREIGN KEY (ride_id, ratee_id)
        REFERENCES ride_member (ride_id, student_id) ON DELETE CASCADE,

    -- BR5: harsh ratings must be justified
    CONSTRAINT rating_low_needs_comment
        CHECK (score >= 3 OR (comment IS NOT NULL AND length(trim(comment)) >= 10)),

    CONSTRAINT rating_comment_not_blank
        CHECK (comment IS NULL OR length(trim(comment)) > 0),

    CONSTRAINT rating_updated_after_created
        CHECK (updated_at IS NULL OR updated_at >= created_at)
);

COMMENT ON TABLE  rating IS 'Peer review of a co-rider after a completed ride (Member 5)';
COMMENT ON COLUMN rating.score IS '1 (poor) .. 5 (excellent)';

-- ---------------------------------------------------------------------
-- rating_tag_map : multivalued attribute "tags" of rating
-- (weak w.r.t. rating — identified by the rating key + tag)
-- ---------------------------------------------------------------------
CREATE TABLE rating_tag_map (
    ride_id   INT       NOT NULL,
    rater_id  CHAR(13)  NOT NULL,
    ratee_id  CHAR(13)  NOT NULL,
    tag_id    SMALLINT  NOT NULL,
    CONSTRAINT rating_tag_map_pk PRIMARY KEY (ride_id, rater_id, ratee_id, tag_id),   -- BR7
    CONSTRAINT rating_tag_map_rating_fk FOREIGN KEY (ride_id, rater_id, ratee_id)
        REFERENCES rating (ride_id, rater_id, ratee_id) ON DELETE CASCADE,
    CONSTRAINT rating_tag_map_tag_fk FOREIGN KEY (tag_id)
        REFERENCES rating_tag (tag_id)                                                -- BR6
);

-- ---------------------------------------------------------------------
-- rating_audit : append-only change log (filled ONLY by trigger)
-- Deliberately NO foreign key to rating: the audit row must survive
-- after the rating it describes has been deleted.
-- ---------------------------------------------------------------------
CREATE TABLE rating_audit (
    audit_id     BIGSERIAL    PRIMARY KEY,
    ride_id      INT          NOT NULL,
    rater_id     CHAR(13)     NOT NULL,
    ratee_id     CHAR(13)     NOT NULL,
    action       CHAR(1)      NOT NULL CONSTRAINT rating_audit_action CHECK (action IN ('I','U','D')),
    old_score    SMALLINT,
    new_score    SMALLINT,
    old_comment  VARCHAR(280),
    new_comment  VARCHAR(280),
    changed_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    db_user      TEXT         NOT NULL DEFAULT current_user,
    CONSTRAINT rating_audit_shape CHECK (
        (action = 'I' AND old_score IS NULL     AND new_score IS NOT NULL) OR
        (action = 'U' AND old_score IS NOT NULL AND new_score IS NOT NULL) OR
        (action = 'D' AND old_score IS NOT NULL AND new_score IS NULL)
    )
);
