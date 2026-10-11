-- =====================================================================
-- PoolUp Member 3 - Expense splitting : SCHEMA
-- expense / expense_share keep the exact names + types the Ratings module
-- reads (expense.ride_id, expense.amount; composite FK into ride_member).
-- Extra columns (split_type) have DEFAULTs, so other modules' INSERTs that
-- only know the original columns keep working.
-- Requires: student, ride, ride_member (Member 2) to exist already.
-- =====================================================================

CREATE TABLE expense (
    expense_id  SERIAL        PRIMARY KEY,
    ride_id     INT           NOT NULL,
    paid_by     CHAR(13)      NOT NULL,
    amount      NUMERIC(9,2)  NOT NULL
                CONSTRAINT expense_amount_positive CHECK (amount > 0)
                CONSTRAINT expense_amount_cap      CHECK (amount <= 50000),
    note        VARCHAR(60)   NOT NULL DEFAULT 'Cab fare'
                CONSTRAINT expense_note_not_blank CHECK (length(trim(note)) >= 1),
    split_type  VARCHAR(8)    NOT NULL DEFAULT 'equal'
                CONSTRAINT expense_split_type_valid CHECK (split_type IN ('equal','seats','exact','percent')),
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
    -- the payer must be a member of that ride
    CONSTRAINT expense_payer_on_ride
        FOREIGN KEY (ride_id, paid_by) REFERENCES ride_member(ride_id, student_id) ON DELETE CASCADE
);

-- Weak entity: a share exists only as part of its expense
CREATE TABLE expense_share (
    expense_id   INT          NOT NULL REFERENCES expense(expense_id) ON DELETE CASCADE,
    student_id   CHAR(13)     NOT NULL REFERENCES student(student_id),
    share_amount NUMERIC(9,2) NOT NULL
                 CONSTRAINT expense_share_nonneg CHECK (share_amount >= 0),
    PRIMARY KEY (expense_id, student_id)
);

-- Trigger-maintained history. No FK on purpose: history must outlive the expense.
CREATE TABLE expense_audit (
    audit_id    BIGSERIAL     PRIMARY KEY,
    expense_id  INT           NOT NULL,
    ride_id     INT           NOT NULL,
    action      VARCHAR(6)    NOT NULL CHECK (action IN ('create','delete')),
    actor_id    CHAR(13),
    paid_by     CHAR(13)      NOT NULL,
    amount      NUMERIC(9,2)  NOT NULL,
    note        VARCHAR(60),
    split_type  VARCHAR(8),
    happened_at TIMESTAMPTZ   NOT NULL DEFAULT now()
);
