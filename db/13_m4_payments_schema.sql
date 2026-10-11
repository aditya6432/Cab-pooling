-- =====================================================================
-- PoolUp — PAYMENTS + SETTLEMENT SCHEMA  (13_m4_payments_schema.sql)
-- Owner: Member 4 (Payments + Settlement)
-- ---------------------------------------------------------------------
-- Money model: every RIDE is a group ledger (like a Splitwise group).
--   balance(ride, student) = Σ expenses they paid − Σ their shares
--                          + Σ confirmed payments they SENT
--                          − Σ confirmed payments they RECEIVED
--   balance > 0  → the group owes them        balance < 0 → they owe the group
--   Σ balances of one ride = ₹0 always (because Σ shares = expense amount)
--
-- Entities
--   payment_method      a student's UPI IDs (VPAs); one may be the default
--   payment             one settlement transfer payer → payee for a ride
--   payment_transition  the payment state machine, stored AS DATA
--   payment_event       append-only history of every status change
--   payment_reminder    "please pay" nudges, rate-limited by an EXCLUDE
--
-- Rules enforced DECLARATIVELY in this file (trigger rules: 23_m4_payments_logic.sql)
--   PR1  0 < amount ≤ ₹50,000                                  CHECK
--   PR2  nobody pays themself                                   CHECK
--   PR3  payer AND payee are members of that ride               composite FKs
--   PR4  UPI needs a 12-digit UTR; cash/offset must not have one CHECK
--   PR5  a UTR can be used only once                            UNIQUE
--   PR6  every submission carries a unique idempotency key      UNIQUE
--   PR7  a rejection / reversal must state a reason             CHECK
--   PR16 ≤ 1 reminder per (ride, creditor, debtor) per 24 h      EXCLUDE (gist)
--   PR17 ≤ 1 default UPI ID per student; VPA format              partial UNIQUE index, CHECK
-- =====================================================================

-- GiST operator classes for "=" on scalar types (needed by the EXCLUDE below)
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------
-- Single source of truth for the module's time windows
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_payment_expiry()   RETURNS INTERVAL LANGUAGE sql IMMUTABLE AS $$ SELECT INTERVAL '7 days'   $$;
CREATE OR REPLACE FUNCTION fn_reversal_window()  RETURNS INTERVAL LANGUAGE sql IMMUTABLE AS $$ SELECT INTERVAL '72 hours' $$;

-- The 24-hour window a reminder "occupies". Declared IMMUTABLE so it can be
-- used inside an index/EXCLUDE expression. This is genuinely immutable:
-- adding a pure-hours interval to an absolute instant never depends on the
-- session time zone (unlike adding '1 day' or '1 month').
CREATE OR REPLACE FUNCTION fn_reminder_window(p_sent TIMESTAMPTZ) RETURNS TSTZRANGE
LANGUAGE sql IMMUTABLE AS $$ SELECT tstzrange(p_sent, p_sent + INTERVAL '24 hours', '[)') $$;

-- ---------------------------------------------------------------------
-- payment_method : UPI IDs
-- ---------------------------------------------------------------------
CREATE TABLE payment_method (
    method_id   SERIAL        PRIMARY KEY,
    student_id  CHAR(13)      NOT NULL REFERENCES student(student_id) ON DELETE CASCADE,
    vpa         VARCHAR(100)  NOT NULL,
    label       VARCHAR(30),
    is_default  BOOLEAN       NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT payment_method_vpa_unique UNIQUE (vpa),
    -- name@bank, lower-case, e.g. aarav.mehta@okhdfc
    CONSTRAINT payment_method_vpa_format
        CHECK (vpa ~ '^[a-z0-9][a-z0-9._-]{1,63}@[a-z][a-z0-9]{1,31}$')
);

-- PR17: at most ONE default UPI ID per student. A PARTIAL unique index —
-- uniqueness applies only to rows where is_default is true, so a student
-- may have many non-default IDs.
CREATE UNIQUE INDEX payment_method_one_default ON payment_method (student_id) WHERE is_default;

-- ---------------------------------------------------------------------
-- payment_transition : the state machine as data
--   (from_status, to_status, actor_role) = "this role may make this move"
-- ---------------------------------------------------------------------
CREATE TABLE payment_transition (
    from_status  VARCHAR(10)  NOT NULL,
    to_status    VARCHAR(10)  NOT NULL,
    actor_role   VARCHAR(6)   NOT NULL,
    meaning      VARCHAR(120) NOT NULL,
    CONSTRAINT payment_transition_pk PRIMARY KEY (from_status, to_status, actor_role),
    CONSTRAINT payment_transition_status_enum CHECK (
        from_status IN ('pending','confirmed','rejected','cancelled','expired','reversed') AND
        to_status   IN ('pending','confirmed','rejected','cancelled','expired','reversed')),
    CONSTRAINT payment_transition_role_enum CHECK (actor_role IN ('payer','payee','system')),
    CONSTRAINT payment_transition_no_self_loop CHECK (from_status <> to_status)
);

-- ---------------------------------------------------------------------
-- payment : one settlement transfer
-- ---------------------------------------------------------------------
CREATE TABLE payment (
    payment_id         BIGSERIAL     PRIMARY KEY,
    client_ref         UUID          NOT NULL,       -- idempotency key from the client
    ride_id            INT           NOT NULL,
    payer_id           CHAR(13)      NOT NULL,
    payee_id           CHAR(13)      NOT NULL,
    amount             NUMERIC(10,2) NOT NULL,
    method             VARCHAR(6)    NOT NULL,
    utr                CHAR(12),                     -- UPI transaction reference
    note               VARCHAR(140),
    offset_group       UUID,                         -- links the two halves of a net-off
    status             VARCHAR(10)   NOT NULL DEFAULT 'pending',
    status_reason      VARCHAR(200),
    created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
    status_changed_at  TIMESTAMPTZ   NOT NULL,         -- set by trigger on insert / every transition
    confirmed_at       TIMESTAMPTZ,

    CONSTRAINT payment_client_ref_key UNIQUE (client_ref),                         -- PR6
    CONSTRAINT payment_utr_unique     UNIQUE (utr),                                -- PR5
    CONSTRAINT payment_amount_range   CHECK (amount > 0 AND amount <= 50000),      -- PR1
    CONSTRAINT payment_not_self       CHECK (payer_id <> payee_id),                -- PR2
    -- PR3: both parties must be members of THIS ride (composite FKs, as in ratings)
    CONSTRAINT payment_payer_on_ride FOREIGN KEY (ride_id, payer_id)
        REFERENCES ride_member (ride_id, student_id),
    CONSTRAINT payment_payee_on_ride FOREIGN KEY (ride_id, payee_id)
        REFERENCES ride_member (ride_id, student_id),
    CONSTRAINT payment_method_enum    CHECK (method IN ('upi','cash','offset')),
    -- PR4: UPI ⇔ a 12-digit UTR
    CONSTRAINT payment_utr_format CHECK (
        (method = 'upi' AND utr ~ '^[0-9]{12}$') OR (method <> 'upi' AND utr IS NULL)),
    CONSTRAINT payment_offset_group_consistent CHECK ((method = 'offset') = (offset_group IS NOT NULL)),
    CONSTRAINT payment_status_enum CHECK (
        status IN ('pending','confirmed','rejected','cancelled','expired','reversed')),
    -- PR7: a "no" must be explained
    CONSTRAINT payment_reason_required CHECK (
        status NOT IN ('rejected','reversed') OR length(trim(COALESCE(status_reason, ''))) >= 5),
    -- confirmed_at present ⇔ the payment was (at some point) confirmed
    CONSTRAINT payment_confirmed_at_consistent CHECK (
        (confirmed_at IS NOT NULL) = (status IN ('confirmed','reversed'))),
    CONSTRAINT payment_times_ordered CHECK (
        status_changed_at >= created_at AND (confirmed_at IS NULL OR confirmed_at >= created_at))
);

COMMENT ON TABLE payment IS 'Settlement transfer within a ride group (Member 4). Append-only: never updated except for status transitions, never deleted.';

-- ---------------------------------------------------------------------
-- payment_event : history of every status change (written ONLY by trigger)
-- ---------------------------------------------------------------------
CREATE TABLE payment_event (
    event_id     BIGSERIAL    PRIMARY KEY,
    payment_id   BIGINT       NOT NULL REFERENCES payment(payment_id),
    from_status  VARCHAR(10),                 -- NULL for the creation event
    to_status    VARCHAR(10)  NOT NULL,
    actor_role   VARCHAR(6)   NOT NULL,
    actor_id     CHAR(13)     REFERENCES student(student_id),
    reason       VARCHAR(200),
    changed_at   TIMESTAMPTZ  NOT NULL,
    CONSTRAINT payment_event_role_enum CHECK (actor_role IN ('payer','payee','system'))
);

-- ---------------------------------------------------------------------
-- payment_reminder : nudges from a creditor to a debtor on one ride
-- ---------------------------------------------------------------------
CREATE TABLE payment_reminder (
    reminder_id  BIGSERIAL     PRIMARY KEY,
    ride_id      INT           NOT NULL,
    creditor_id  CHAR(13)      NOT NULL,
    debtor_id    CHAR(13)      NOT NULL,
    amount_due   NUMERIC(10,2) NOT NULL CHECK (amount_due > 0),   -- snapshot, set by trigger
    message      VARCHAR(140),
    sent_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT reminder_not_self CHECK (creditor_id <> debtor_id),
    CONSTRAINT reminder_creditor_on_ride FOREIGN KEY (ride_id, creditor_id) REFERENCES ride_member (ride_id, student_id),
    CONSTRAINT reminder_debtor_on_ride   FOREIGN KEY (ride_id, debtor_id)   REFERENCES ride_member (ride_id, student_id),
    -- PR16: no two reminders for the same debt whose 24-hour windows overlap.
    -- An EXCLUDE constraint generalises UNIQUE: "no two rows where ALL of these
    -- operators return true" — here three equalities plus a range overlap (&&).
    CONSTRAINT reminder_rate_limit EXCLUDE USING gist (
        ride_id     WITH =,
        creditor_id WITH =,
        debtor_id   WITH =,
        fn_reminder_window(sent_at) WITH &&)
);
