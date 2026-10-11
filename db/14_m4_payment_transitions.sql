-- =====================================================================
-- PoolUp — PAYMENT STATE MACHINE  (14_m4_payment_transitions.sql)
-- Owner: Member 4. Reference data, not demo data: the trigger in
-- 23_m4_payments_logic.sql allows a status change ONLY if a row here says
-- that role may make that move. Changing the business process = changing
-- rows here, not code.
--
--            ┌──────── payee confirms ───────► confirmed ── payee reverses (≤72 h) ──► reversed
--   pending ─┼──────── payee rejects  ───────► rejected
--            ├──────── payer cancels  ───────► cancelled
--            └──────── system (after 7 days) ► expired
-- =====================================================================
INSERT INTO payment_transition (from_status, to_status, actor_role, meaning) VALUES
    ('pending',   'confirmed', 'payee',  'Payee confirms the money arrived'),
    ('pending',   'rejected',  'payee',  'Payee says the money never arrived (reason required)'),
    ('pending',   'cancelled', 'payer',  'Payer withdraws the claim before it is confirmed'),
    ('pending',   'expired',   'system', 'Nobody responded within 7 days'),
    ('confirmed', 'reversed',  'payee',  'Payee undoes a confirmation within 72 hours (reason required)');
