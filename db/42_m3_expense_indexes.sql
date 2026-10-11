-- =====================================================================
-- PoolUp Member 3 - expense indexes (42_m3_expense_indexes.sql)
-- PostgreSQL does not index foreign-key columns automatically.
-- =====================================================================
-- per-ride ledger / "expenses on this ride"; leading ride_id also serves
-- Member 5's per-ride fare totals (v_ride_summary)
CREATE INDEX expense_ride_paid_idx      ON expense (ride_id, paid_by);
-- what a student paid (statement, v_student_money, pairwise balances)
CREATE INDEX expense_paid_by_idx        ON expense (paid_by);
-- what a student owes (statement, v_student_money, pairwise balances)
CREATE INDEX expense_share_student_idx  ON expense_share (student_id);
-- audit trail of one ride, newest first
CREATE INDEX expense_audit_ride_idx     ON expense_audit (ride_id, happened_at DESC);
