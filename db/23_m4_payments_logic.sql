-- =====================================================================
-- PoolUp — PAYMENTS + SETTLEMENT LOGIC  (23_m4_payments_logic.sql)
-- Owner: Member 4 (Payments + Settlement)
-- ---------------------------------------------------------------------
-- Rules that need OTHER rows, the CLOCK, the ACTOR or a COMMIT-time view
-- of the data are enforced here:
--   PR8   the payer must owe money on that ride                 trigger
--   PR9   the payee must be owed money on that ride             trigger
--   PR10  no overpayment — pending payments count as reserved;   trigger +
--         concurrent payments on one ride are serialised         ride row lock
--   PR11  a new payment starts 'pending' (net-off starts confirmed)
--   PR12  status changes follow payment_transition, by the right role
--   PR13  reversal ≤ 72 h after confirmation; expiry only after 7 days
--   PR14  payments are append-only: never edited, never deleted
--   PR15  net-off rows come in balanced mirrored pairs — checked at COMMIT
--         by a DEFERRABLE constraint trigger; net-offs are final
--   PR16  a reminder can only be sent for money actually owed
--   PR18  every status change is written to payment_event
--   PR19  only the payer or payee may act on a payment           function
-- Violations raise SQLSTATE 23514 with CONSTRAINT 'rule_…' so the API can
-- report them exactly like a declarative CHECK failure.
--
-- Who is acting? Functions set two TRANSACTION-SCOPED settings with
-- set_config(…, is_local => true): poolup.actor_role and poolup.actor_id.
-- If nothing set them (e.g. a raw UPDATE in psql) the actor is 'system',
-- which may only expire stale payments.
-- =====================================================================

-- ---------------------------------------------------------------------
-- v_ride_balance — the group ledger. One row per (ride, student).
--   net  = balance counting CONFIRMED payments only (the real position)
--   open = net + pending sent − pending received
--          (what is still left to pay / receive once in-flight payments land)
-- Written as UNION ALL + GROUP BY (not CTEs) so a filter on ride_id is
-- pushed down into every branch and uses the per-ride indexes.
-- ---------------------------------------------------------------------
CREATE VIEW v_ride_balance AS
SELECT f.ride_id,
       f.student_id,
       SUM(f.paid)                                                    AS paid,
       SUM(f.share)                                                   AS share,
       SUM(f.sent)                                                    AS sent,
       SUM(f.received)                                                AS received,
       SUM(f.pending_out)                                             AS pending_out,
       SUM(f.pending_in)                                              AS pending_in,
       SUM(f.paid - f.share + f.sent - f.received)                    AS net,
       SUM(f.paid - f.share + f.sent - f.received
           + f.pending_out - f.pending_in)                            AS open
FROM (
        SELECT e.ride_id, e.paid_by AS student_id,
               e.amount::NUMERIC AS paid, 0::NUMERIC AS share, 0::NUMERIC AS sent,
               0::NUMERIC AS received, 0::NUMERIC AS pending_out, 0::NUMERIC AS pending_in
        FROM expense e
    UNION ALL
        SELECT e.ride_id, s.student_id, 0, s.share_amount, 0, 0, 0, 0
        FROM expense_share s
        JOIN expense e ON e.expense_id = s.expense_id
    UNION ALL
        SELECT p.ride_id, p.payer_id, 0, 0,
               CASE WHEN p.status = 'confirmed' THEN p.amount ELSE 0 END, 0,
               CASE WHEN p.status = 'pending'   THEN p.amount ELSE 0 END, 0
        FROM payment p
        WHERE p.status IN ('confirmed', 'pending')
    UNION ALL
        SELECT p.ride_id, p.payee_id, 0, 0, 0,
               CASE WHEN p.status = 'confirmed' THEN p.amount ELSE 0 END, 0,
               CASE WHEN p.status = 'pending'   THEN p.amount ELSE 0 END
        FROM payment p
        WHERE p.status IN ('confirmed', 'pending')
) f
GROUP BY f.ride_id, f.student_id;

-- Who is acting right now (set by the functions below)
CREATE OR REPLACE FUNCTION fn_actor_role() RETURNS TEXT
LANGUAGE sql STABLE AS $$ SELECT COALESCE(NULLIF(current_setting('poolup.actor_role', true), ''), 'system') $$;

CREATE OR REPLACE FUNCTION fn_actor_id() RETURNS TEXT
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('poolup.actor_id', true), '') $$;

-- =====================================================================
-- TRIGGERS ON payment
-- =====================================================================

-- PR8–PR11 + idempotency + ride lock ------------------------------------
CREATE OR REPLACE FUNCTION trg_payment_before_insert() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_payer_net   NUMERIC;
    v_payer_open  NUMERIC;
    v_payee_net   NUMERIC;
    v_payee_open  NUMERIC;
    v_room        NUMERIC;
BEGIN
    -- Serialise every money movement on this ride. A second transaction
    -- paying on the same ride WAITS here until the first commits or rolls
    -- back, then re-reads balances that include the first payment.
    PERFORM 1 FROM ride WHERE ride_id = NEW.ride_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NEW;                        -- the foreign key reports the bad ride
    END IF;

    -- Idempotency: once we hold the lock, a duplicate submission (same
    -- client_ref) that raced us is visible — silently skip this row.
    IF EXISTS (SELECT 1 FROM payment WHERE client_ref = NEW.client_ref) THEN
        RETURN NULL;
    END IF;

    -- PR11: initial state
    IF NEW.method = 'offset' THEN
        IF NEW.status <> 'confirmed' THEN
            RAISE EXCEPTION 'A net-off entry is created already confirmed (no money moves)'
                  USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_payment_initial_state', TABLE = 'payment';
        END IF;
    ELSIF NEW.status <> 'pending' THEN
        RAISE EXCEPTION 'A new payment must start as pending — only the payee can confirm it (got "%")', NEW.status
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_payment_initial_state', TABLE = 'payment';
    END IF;

    -- Single-row and referential rules belong to the DECLARATIVE constraints
    -- (PR1–PR3). BEFORE triggers run before CHECK/FK, so if one of those is
    -- about to fail, step aside and let the constraint report it.
    IF NEW.payer_id = NEW.payee_id OR NEW.amount <= 0 OR NEW.amount > 50000
       OR NOT EXISTS (SELECT 1 FROM ride_member WHERE ride_id = NEW.ride_id AND student_id = NEW.payer_id)
       OR NOT EXISTS (SELECT 1 FROM ride_member WHERE ride_id = NEW.ride_id AND student_id = NEW.payee_id) THEN
        NEW.status_changed_at := NEW.created_at;
        RETURN NEW;
    END IF;

    IF NEW.created_at > now() + INTERVAL '1 minute' THEN
        RAISE EXCEPTION 'A payment cannot be dated in the future'
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_payment_time', TABLE = 'payment';
    END IF;
    NEW.status_changed_at := NEW.created_at;
    NEW.confirmed_at      := CASE WHEN NEW.status = 'confirmed' THEN NEW.created_at END;
    NEW.status_reason     := NULL;

    SELECT net, open INTO v_payer_net, v_payer_open
    FROM v_ride_balance WHERE ride_id = NEW.ride_id AND student_id = NEW.payer_id;
    SELECT net, open INTO v_payee_net, v_payee_open
    FROM v_ride_balance WHERE ride_id = NEW.ride_id AND student_id = NEW.payee_id;

    -- PR8
    IF COALESCE(v_payer_net, 0) >= 0 THEN
        RAISE EXCEPTION '% owes nothing on ride % (balance ₹%)', NEW.payer_id, NEW.ride_id, COALESCE(v_payer_net, 0)
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_payer_not_debtor', TABLE = 'payment';
    END IF;
    -- PR9
    IF COALESCE(v_payee_net, 0) <= 0 THEN
        RAISE EXCEPTION '% is not owed anything on ride % (balance ₹%)', NEW.payee_id, NEW.ride_id, COALESCE(v_payee_net, 0)
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_payee_not_creditor', TABLE = 'payment';
    END IF;
    -- PR10: the most this payer may still send this payee
    v_room := GREATEST(LEAST(-v_payer_open, v_payee_open), 0);
    IF NEW.amount > v_room THEN
        RAISE EXCEPTION 'Payment of ₹% exceeds what is still payable from % to % on ride % (₹%, after payments already awaiting confirmation)',
                        NEW.amount, NEW.payer_id, NEW.payee_id, NEW.ride_id, v_room
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_no_overpayment', TABLE = 'payment';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER payment_before_insert
BEFORE INSERT ON payment
FOR EACH ROW EXECUTE FUNCTION trg_payment_before_insert();

-- PR12–PR14: the state machine guard -----------------------------------
CREATE OR REPLACE FUNCTION trg_payment_before_update() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_role     TEXT := fn_actor_role();
    v_allowed  TEXT;
BEGIN
    -- PR14: everything except the status fields is frozen
    IF (NEW.payment_id, NEW.client_ref, NEW.ride_id, NEW.payer_id, NEW.payee_id, NEW.amount,
        NEW.method, NEW.utr, NEW.note, NEW.offset_group, NEW.created_at)
       IS DISTINCT FROM
       (OLD.payment_id, OLD.client_ref, OLD.ride_id, OLD.payer_id, OLD.payee_id, OLD.amount,
        OLD.method, OLD.utr, OLD.note, OLD.offset_group, OLD.created_at) THEN
        RAISE EXCEPTION 'A recorded payment cannot be edited — only its status can move forward. Record a new payment instead.'
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_payment_immutable', TABLE = 'payment';
    END IF;

    IF NEW.status = OLD.status THEN
        RAISE EXCEPTION 'Payment % is already %', OLD.payment_id, OLD.status
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_payment_immutable', TABLE = 'payment';
    END IF;

    -- PR15: net-off entries are final (reversing one half would unbalance the pair)
    IF OLD.method = 'offset' THEN
        RAISE EXCEPTION 'Net-off entries are final and cannot change status'
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_offset_final', TABLE = 'payment';
    END IF;

    -- PR12: is (old → new) allowed for this role?
    IF NOT EXISTS (SELECT 1 FROM payment_transition t
                   WHERE t.from_status = OLD.status AND t.to_status = NEW.status AND t.actor_role = v_role) THEN
        SELECT string_agg(format('%s (by %s)', t.to_status, t.actor_role), ', ' ORDER BY t.to_status)
          INTO v_allowed
          FROM payment_transition t WHERE t.from_status = OLD.status;
        RAISE EXCEPTION 'The % cannot move a payment from % to %. Allowed from %: %',
                        v_role, OLD.status, NEW.status, OLD.status, COALESCE(v_allowed, 'nothing — it is a final state')
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_illegal_transition', TABLE = 'payment';
    END IF;

    -- When did it happen? (callers normally leave it to us → now())
    IF NEW.status_changed_at IS NOT DISTINCT FROM OLD.status_changed_at THEN
        NEW.status_changed_at := now();
    END IF;
    IF NEW.status_changed_at < OLD.status_changed_at OR NEW.status_changed_at > now() + INTERVAL '1 minute' THEN
        RAISE EXCEPTION 'A status change cannot be back-dated or dated in the future'
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_payment_time', TABLE = 'payment';
    END IF;

    -- PR13: time windows
    IF NEW.status = 'expired' AND NEW.status_changed_at < OLD.created_at + fn_payment_expiry() THEN
        RAISE EXCEPTION 'Payment % can only expire % after it was recorded', OLD.payment_id, fn_payment_expiry()
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_expiry_too_early', TABLE = 'payment';
    END IF;
    IF NEW.status = 'reversed' AND NEW.status_changed_at > OLD.confirmed_at + fn_reversal_window() THEN
        RAISE EXCEPTION 'A confirmation can only be reversed within % hours (confirmed %)',
                        (EXTRACT(EPOCH FROM fn_reversal_window()) / 3600)::INT,
                        to_char(OLD.confirmed_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH24:MI "IST"')
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_reversal_window', TABLE = 'payment';
    END IF;

    NEW.confirmed_at := CASE WHEN NEW.status = 'confirmed' THEN NEW.status_changed_at ELSE OLD.confirmed_at END;
    RETURN NEW;
END $$;

CREATE TRIGGER payment_before_update
BEFORE UPDATE ON payment
FOR EACH ROW EXECUTE FUNCTION trg_payment_before_update();

-- PR14: never deleted ---------------------------------------------------
CREATE OR REPLACE FUNCTION trg_payment_no_delete() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Payments are financial records and are never deleted — cancel, reject or reverse instead'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_payment_no_delete', TABLE = 'payment';
END $$;

CREATE TRIGGER payment_no_delete
BEFORE DELETE ON payment
FOR EACH ROW EXECUTE FUNCTION trg_payment_no_delete();

-- PR18: history ---------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_payment_event() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_role TEXT := CASE
                     WHEN TG_OP = 'INSERT' AND NEW.method = 'offset' THEN 'system'
                     WHEN TG_OP = 'INSERT' THEN 'payer'
                     ELSE fn_actor_role()
                   END;
BEGIN
    INSERT INTO payment_event (payment_id, from_status, to_status, actor_role, actor_id, reason, changed_at)
    VALUES (NEW.payment_id,
            CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END,
            NEW.status,
            v_role,
            CASE v_role WHEN 'payer' THEN NEW.payer_id
                        WHEN 'payee' THEN NEW.payee_id
                        ELSE fn_actor_id() END,
            CASE WHEN TG_OP = 'UPDATE' THEN NEW.status_reason END,
            NEW.status_changed_at);
    RETURN NULL;
END $$;

CREATE TRIGGER payment_event_trg
AFTER INSERT OR UPDATE ON payment
FOR EACH ROW EXECUTE FUNCTION trg_payment_event();

-- PR15: net-off pairs must balance — checked at COMMIT ------------------
CREATE OR REPLACE FUNCTION trg_offset_balanced() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_rows   INT;
    v_mirror BOOLEAN;
BEGIN
    SELECT count(*) INTO v_rows FROM payment WHERE offset_group = NEW.offset_group;
    SELECT EXISTS (
        SELECT 1
        FROM payment a
        JOIN payment b ON b.offset_group = a.offset_group AND b.payment_id > a.payment_id
        WHERE a.offset_group = NEW.offset_group
          AND a.payer_id = b.payee_id AND a.payee_id = b.payer_id   -- mirrored parties
          AND a.amount   = b.amount                                 -- same amount
          AND a.ride_id <> b.ride_id)                               -- across two rides
      INTO v_mirror;
    IF v_rows <> 2 OR NOT v_mirror THEN
        RAISE EXCEPTION 'Net-off group % is unbalanced: it needs exactly two mirrored entries of equal amount on different rides (found %)',
                        NEW.offset_group, v_rows
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_offset_unbalanced', TABLE = 'payment';
    END IF;
    RETURN NULL;
END $$;

-- DEFERRABLE INITIALLY DEFERRED: runs at COMMIT, after BOTH halves exist.
-- (An ordinary trigger would fire after the first half and always fail.)
CREATE CONSTRAINT TRIGGER payment_offset_balanced
AFTER INSERT ON payment
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.method = 'offset')
EXECUTE FUNCTION trg_offset_balanced();

-- =====================================================================
-- TRIGGER ON payment_reminder — PR16
-- =====================================================================
CREATE OR REPLACE FUNCTION trg_reminder_before_insert() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_debtor   NUMERIC;
    v_creditor NUMERIC;
    v_due      NUMERIC;
BEGIN
    IF NEW.creditor_id = NEW.debtor_id THEN
        RETURN NEW;                        -- CHECK reminder_not_self reports it
    END IF;
    SELECT open INTO v_debtor   FROM v_ride_balance WHERE ride_id = NEW.ride_id AND student_id = NEW.debtor_id;
    SELECT open INTO v_creditor FROM v_ride_balance WHERE ride_id = NEW.ride_id AND student_id = NEW.creditor_id;
    v_due := LEAST(-COALESCE(v_debtor, 0), COALESCE(v_creditor, 0));
    IF v_due <= 0 THEN
        RAISE EXCEPTION '% does not currently owe % anything on ride % (payments awaiting confirmation count as paid)',
                        NEW.debtor_id, NEW.creditor_id, NEW.ride_id
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_nothing_owed', TABLE = 'payment_reminder';
    END IF;
    IF NEW.sent_at > now() + INTERVAL '1 minute' THEN
        RAISE EXCEPTION 'A reminder cannot be dated in the future'
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_payment_time', TABLE = 'payment_reminder';
    END IF;
    NEW.amount_due := v_due;           -- snapshot of what was owed at the time
    RETURN NEW;
END $$;

CREATE TRIGGER payment_reminder_before_insert
BEFORE INSERT ON payment_reminder
FOR EACH ROW EXECUTE FUNCTION trg_reminder_before_insert();

-- =====================================================================
-- STORED FUNCTIONS (called by the API)
-- =====================================================================

-- Record a payment idempotently. Calling it twice with the same client_ref
-- returns the SAME payment (a double-click or network retry never pays twice).
CREATE OR REPLACE FUNCTION fn_record_payment(
    p_client_ref  UUID,
    p_actor       CHAR(13),
    p_ride        INT,
    p_payee       CHAR(13),
    p_amount      NUMERIC,
    p_method      TEXT,
    p_utr         TEXT DEFAULT NULL,
    p_note        TEXT DEFAULT NULL
) RETURNS payment
LANGUAGE plpgsql AS $$
DECLARE
    v payment;
BEGIN
    -- replay of an earlier submission?
    SELECT * INTO v FROM payment WHERE client_ref = p_client_ref;
    IF FOUND THEN
        IF (v.payer_id, v.payee_id, v.ride_id, v.amount, v.method)
           IS DISTINCT FROM (p_actor, p_payee, p_ride, round(p_amount, 2), p_method) THEN
            RAISE EXCEPTION 'Idempotency key % was already used for a different payment (#%)', p_client_ref, v.payment_id
                  USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_idempotency_mismatch', TABLE = 'payment';
        END IF;
        RETURN v;
    END IF;

    PERFORM set_config('poolup.actor_role', 'payer', true);
    PERFORM set_config('poolup.actor_id', p_actor, true);

    INSERT INTO payment (client_ref, ride_id, payer_id, payee_id, amount, method, utr, note)
    VALUES (p_client_ref, p_ride, p_actor, p_payee, p_amount, p_method,
            NULLIF(trim(p_utr), ''), NULLIF(trim(p_note), ''))
    RETURNING * INTO v;

    IF NOT FOUND THEN
        -- the trigger saw a concurrent duplicate commit first and skipped us
        SELECT * INTO v FROM payment WHERE client_ref = p_client_ref;
    END IF;
    RETURN v;
END $$;

-- Move a payment through the state machine on behalf of a person.
CREATE OR REPLACE FUNCTION fn_transition_payment(
    p_payment  BIGINT,
    p_actor    CHAR(13),
    p_to       TEXT,
    p_reason   TEXT DEFAULT NULL
) RETURNS payment
LANGUAGE plpgsql AS $$
DECLARE
    v      payment;
    v_role TEXT;
BEGIN
    -- row lock: a "confirm" racing a "cancel" on the same payment is
    -- serialised; the loser then fails the transition check
    SELECT * INTO v FROM payment WHERE payment_id = p_payment FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No payment %', p_payment USING ERRCODE = 'no_data_found';
    END IF;

    v_role := CASE WHEN p_actor = v.payer_id THEN 'payer'
                   WHEN p_actor = v.payee_id THEN 'payee' END;
    IF v_role IS NULL THEN                                            -- PR19
        RAISE EXCEPTION 'Only the payer or the payee can act on payment %', p_payment
              USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'rule_not_a_party', TABLE = 'payment';
    END IF;

    PERFORM set_config('poolup.actor_role', v_role, true);
    PERFORM set_config('poolup.actor_id', p_actor, true);

    UPDATE payment
       SET status = p_to,
           status_reason = NULLIF(trim(p_reason), '')
     WHERE payment_id = p_payment
    RETURNING * INTO v;
    RETURN v;
END $$;

-- System job: expire payments nobody responded to. Returns how many.
CREATE OR REPLACE FUNCTION fn_expire_stale_payments() RETURNS INT
LANGUAGE plpgsql AS $$
DECLARE
    n INT;
BEGIN
    PERFORM set_config('poolup.actor_role', 'system', true);
    PERFORM set_config('poolup.actor_id', '', true);
    UPDATE payment
       SET status = 'expired',
           status_reason = 'No response within ' || fn_payment_expiry()
     WHERE status = 'pending'
       AND created_at <= now() - fn_payment_expiry();
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

-- ---------------------------------------------------------------------
-- Settlement plan for one ride: the fewest transfers that settle it.
-- Greedy two-pointer over debtors and creditors sorted by amount: each
-- step settles at least one person fully, so a ride with d debtors and
-- c creditors needs at most d + c − 1 transfers.
-- Uses `open` balances, so money already in flight is not asked for twice.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_settlement_plan(p_ride INT)
RETURNS TABLE (from_id CHAR(13), to_id CHAR(13), amount NUMERIC(10,2))
LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
DECLARE
    d_ids CHAR(13)[]; d_amt NUMERIC[];
    c_ids CHAR(13)[]; c_amt NUMERIC[];
    i INT := 1; j INT := 1; x NUMERIC;
BEGIN
    SELECT array_agg(b.student_id ORDER BY b.open ASC, b.student_id),
           array_agg(-b.open      ORDER BY b.open ASC, b.student_id)
      INTO d_ids, d_amt
      FROM v_ride_balance b WHERE b.ride_id = p_ride AND b.open < 0;
    SELECT array_agg(b.student_id ORDER BY b.open DESC, b.student_id),
           array_agg(b.open       ORDER BY b.open DESC, b.student_id)
      INTO c_ids, c_amt
      FROM v_ride_balance b WHERE b.ride_id = p_ride AND b.open > 0;

    WHILE i <= COALESCE(array_length(d_ids, 1), 0) AND j <= COALESCE(array_length(c_ids, 1), 0) LOOP
        x := LEAST(d_amt[i], c_amt[j]);
        from_id := d_ids[i]; to_id := c_ids[j]; amount := x;
        RETURN NEXT;
        d_amt[i] := d_amt[i] - x;
        c_amt[j] := c_amt[j] - x;
        IF d_amt[i] = 0 THEN i := i + 1; END IF;
        IF c_amt[j] = 0 THEN j := j + 1; END IF;
    END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Net-off: if A owes B on one ride and B owes A on another, cancel the
-- overlap with two mirrored, already-confirmed 'offset' entries — no money
-- moves. One transaction; rides are locked in ride_id order so two people
-- netting off at the same moment can never deadlock; the deferred
-- constraint trigger re-checks every pair at COMMIT.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_net_off(p_actor CHAR(13), p_other CHAR(13))
RETURNS TABLE (group_id UUID, actor_owes_on INT, other_owes_on INT, netted NUMERIC(10,2))
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
    r1 INT[]; c1 NUMERIC[];       -- rides where ACTOR owes OTHER, with capacity
    r2 INT[]; c2 NUMERIC[];       -- rides where OTHER owes ACTOR, with capacity
    i INT := 1; j INT := 1; x NUMERIC; g UUID; found_any BOOLEAN := false;
BEGIN
    IF p_actor = p_other THEN
        RAISE EXCEPTION 'You cannot net off with yourself'
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_nothing_to_net_off', TABLE = 'payment';
    END IF;

    -- 1. lock every ride where the two have opposite positions, in a fixed order
    PERFORM 1 FROM ride
     WHERE ride_id IN (SELECT a.ride_id
                         FROM v_ride_balance a
                         JOIN v_ride_balance b ON b.ride_id = a.ride_id
                        WHERE a.student_id = p_actor AND b.student_id = p_other
                          AND ((a.open < 0 AND b.open > 0) OR (a.open > 0 AND b.open < 0)))
     ORDER BY ride_id
     FOR UPDATE;

    -- 2. recompute capacities now that nobody else can change these rides
    SELECT array_agg(a.ride_id ORDER BY a.ride_id), array_agg(LEAST(-a.open, b.open) ORDER BY a.ride_id)
      INTO r1, c1
      FROM v_ride_balance a JOIN v_ride_balance b ON b.ride_id = a.ride_id
     WHERE a.student_id = p_actor AND b.student_id = p_other AND a.open < 0 AND b.open > 0;
    SELECT array_agg(a.ride_id ORDER BY a.ride_id), array_agg(LEAST(-b.open, a.open) ORDER BY a.ride_id)
      INTO r2, c2
      FROM v_ride_balance a JOIN v_ride_balance b ON b.ride_id = a.ride_id
     WHERE a.student_id = p_actor AND b.student_id = p_other AND b.open < 0 AND a.open > 0;

    PERFORM set_config('poolup.actor_role', 'system', true);
    PERFORM set_config('poolup.actor_id', p_actor, true);

    -- 3. pair them up greedily
    WHILE i <= COALESCE(array_length(r1, 1), 0) AND j <= COALESCE(array_length(r2, 1), 0) LOOP
        x := LEAST(c1[i], c2[j]);
        g := gen_random_uuid();
        INSERT INTO payment (client_ref, ride_id, payer_id, payee_id, amount, method, offset_group, status, note)
        VALUES (gen_random_uuid(), r1[i], p_actor, p_other, x, 'offset', g, 'confirmed',
                format('Net-off against ride #%s', r2[j]));
        INSERT INTO payment (client_ref, ride_id, payer_id, payee_id, amount, method, offset_group, status, note)
        VALUES (gen_random_uuid(), r2[j], p_other, p_actor, x, 'offset', g, 'confirmed',
                format('Net-off against ride #%s', r1[i]));
        group_id := g; actor_owes_on := r1[i]; other_owes_on := r2[j]; netted := x;
        found_any := true;
        RETURN NEXT;
        c1[i] := c1[i] - x;  c2[j] := c2[j] - x;
        IF c1[i] = 0 THEN i := i + 1; END IF;
        IF c2[j] = 0 THEN j := j + 1; END IF;
    END LOOP;

    IF NOT found_any THEN
        RAISE EXCEPTION 'There is nothing to net off: % and % do not owe each other on different rides', p_actor, p_other
              USING ERRCODE = 'check_violation', CONSTRAINT = 'rule_nothing_to_net_off', TABLE = 'payment';
    END IF;
END $$;

-- Make a UPI ID the default. TWO statements, in this order, because a
-- unique INDEX (unlike a unique CONSTRAINT) cannot be deferred: flipping
-- both rows in one UPDATE could transiently hold two defaults and fail.
CREATE OR REPLACE FUNCTION fn_set_default_vpa(p_student CHAR(13), p_method INT) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM payment_method WHERE method_id = p_method AND student_id = p_student) THEN
        RAISE EXCEPTION 'UPI ID % does not belong to %', p_method, p_student USING ERRCODE = 'no_data_found';
    END IF;
    UPDATE payment_method SET is_default = false WHERE student_id = p_student AND is_default;
    UPDATE payment_method SET is_default = true  WHERE method_id = p_method;
END $$;
