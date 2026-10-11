-- =====================================================================
-- PoolUp — INDEXES  (44_m5_ratings_indexes.sql)
-- Owner: Member 5 (Ratings + Analytics / Dashboard)
-- ---------------------------------------------------------------------
-- PostgreSQL automatically indexes PRIMARY KEY and UNIQUE columns, but
-- NOT foreign-key columns. Every index below exists because a specific
-- query in queries/m5_ratings_analytics.sql / the API would otherwise scan a table.
-- Verify with the "EXPLAIN" button on any dashboard card.
-- =====================================================================

-- rating's PK is (ride_id, rater_id, ratee_id): good for "ratings on a ride",
-- useless for "ratings RECEIVED by a student" (profile, reputation, trust
-- network). Leading column = ratee_id.
CREATE INDEX rating_ratee_idx        ON rating (ratee_id, score);

-- "Ratings I have GIVEN", newest first (profile → Given tab, rater-bias query)
CREATE INDEX rating_rater_time_idx   ON rating (rater_id, created_at DESC);

-- ride_member's PK leads with ride_id; every "rides of student X" join
-- (pending ratings, activity, buddies) needs student_id first.
-- Integration note: Member 1 creates exactly this index, ride_member_student_idx
-- (student_id, status), in 40_m1_indexes.sql, so it is not duplicated here.

-- PARTIAL index: only completed rides are ever rated or analysed for
-- trends, so index just those rows (smaller, faster, cheaper to maintain).
CREATE INDEX ride_completed_idx      ON ride (completed_at) WHERE status = 'completed';

-- Route analytics + Member 1's ride search ("rides to X around time T")
CREATE INDEX ride_dest_time_idx      ON ride (dest_id, depart_start);

-- Per-ride fare totals in v_ride_summary use expense(ride_id): served by
-- Member 3's composite expense_ride_paid_idx (ride_id, paid_by), whose
-- leading column is ride_id, so a separate one-column index is redundant.

-- Tag frequency analytics (FK column)
CREATE INDEX rating_tag_map_tag_idx  ON rating_tag_map (tag_id);

-- Audit trail lookups for one rating
CREATE INDEX rating_audit_key_idx    ON rating_audit (ride_id, rater_id, ratee_id, changed_at DESC);
