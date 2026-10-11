-- =====================================================================
-- PoolUp — PAYMENTS INDEXES  (43_m4_payments_indexes.sql)
-- Owner: Member 4. PK/UNIQUE columns are indexed automatically (payment_id,
-- client_ref, utr, vpa, reminder EXCLUDE → a GiST index). Each index below
-- serves a specific trigger or query; verify with EXPLAIN in the UI.
-- =====================================================================

-- Every balance check (insert trigger, plan, reminders) filters payments by
-- ride and status — the hottest path in the module.
CREATE INDEX payment_ride_status_idx     ON payment (ride_id, status);

-- "My payments" history (newest first) and "payments awaiting my confirmation"
CREATE INDEX payment_payer_time_idx      ON payment (payer_id, created_at DESC);
CREATE INDEX payment_payee_status_idx    ON payment (payee_id, status);

-- PARTIAL: only pending rows are ever scanned by the expiry job and inbox;
-- they are a small fraction of all payments.
CREATE INDEX payment_pending_age_idx     ON payment (created_at) WHERE status = 'pending';

-- PARTIAL: the deferred net-off check looks up the other half of a pair.
CREATE INDEX payment_offset_group_idx    ON payment (offset_group) WHERE offset_group IS NOT NULL;

-- Timeline of one payment
CREATE INDEX payment_event_payment_idx   ON payment_event (payment_id, changed_at);

-- "Reminders I received" and the top-debtors query
CREATE INDEX payment_reminder_debtor_idx ON payment_reminder (debtor_id, sent_at DESC);

-- A student's UPI IDs
CREATE INDEX payment_method_student_idx  ON payment_method (student_id);

-- Integration note: the per-student statement and v_student_money also need
-- expense(paid_by) and expense_share(student_id). Member 3 already creates
-- exactly those indexes (42_m3_expense_indexes.sql), so they are not
-- duplicated here (two identical indexes = double write cost, no gain).
