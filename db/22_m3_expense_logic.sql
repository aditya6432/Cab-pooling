-- =====================================================================
-- PoolUp Member 3 - triggers + stored functions
-- Convention (same as Members 1 and 5): rule violations are raised with
--   ERRCODE 23514 and CONSTRAINT = '<rule name>'
-- so the API can map them to a business rule.
-- =====================================================================

-- ---------- pure splitting algorithm (largest-remainder, in paise) ----------
-- Splits p_amount in proportion to p_weights. Shares are whole paise and ALWAYS
-- add up to p_amount exactly (leftover paise go to the largest fractions).
CREATE OR REPLACE FUNCTION fn_split_amount(p_amount numeric, p_ids text[], p_weights numeric[])
RETURNS TABLE (who text, share numeric)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  n       int     := COALESCE(array_length(p_ids, 1), 0);
  v_cents numeric := round(p_amount * 100);
  v_total numeric;
BEGIN
  IF n = 0 THEN
    RAISE EXCEPTION 'Choose at least one person to split with'
      USING ERRCODE = '23514', CONSTRAINT = 'rule_split_needs_people';
  END IF;
  IF array_length(p_weights, 1) IS DISTINCT FROM n
     OR EXISTS (SELECT 1 FROM unnest(p_weights) w WHERE w IS NULL OR w < 0) THEN
    RAISE EXCEPTION 'Every person needs a non-negative split value'
      USING ERRCODE = '23514', CONSTRAINT = 'rule_split_weights';
  END IF;
  SELECT sum(w) INTO v_total FROM unnest(p_weights) w;
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'Split values must add up to more than zero'
      USING ERRCODE = '23514', CONSTRAINT = 'rule_split_weights';
  END IF;
  RETURN QUERY
  WITH w AS (
    SELECT i.id, x.wt, i.ord
    FROM unnest(p_ids) WITH ORDINALITY AS i(id, ord)
    JOIN unnest(p_weights) WITH ORDINALITY AS x(wt, ord) ON x.ord = i.ord
  ), base AS (
    SELECT id, ord, floor(v_cents * wt / v_total) AS b,
           (v_cents * wt / v_total) - floor(v_cents * wt / v_total) AS frac
    FROM w
  ), ranked AS (
    SELECT id, ord, b, row_number() OVER (ORDER BY frac DESC, ord) AS rk, sum(b) OVER () AS sb
    FROM base
  )
  SELECT id, ((b + CASE WHEN rk <= v_cents - sb THEN 1 ELSE 0 END) / 100)::numeric(9,2)
  FROM ranked ORDER BY ord;
END $$;

-- ---------- validate inputs + compute every person's share ----------
-- Used by BOTH the "preview" endpoint and fn_add_expense, so what the user
-- sees in the preview is exactly what gets stored.
CREATE OR REPLACE FUNCTION fn_expense_shares(
    p_ride int, p_amount numeric, p_split text,
    p_people text[] DEFAULT NULL, p_values numeric[] DEFAULT NULL)
RETURNS TABLE (who text, share numeric)
LANGUAGE plpgsql STABLE AS $$
DECLARE v_ids text[]; v_w numeric[]; n int;
BEGIN
  IF p_split IS NULL OR p_split NOT IN ('equal','seats','exact','percent') THEN
    RAISE EXCEPTION 'Unknown split type' USING ERRCODE = '23514', CONSTRAINT = 'expense_split_type_valid';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be greater than zero' USING ERRCODE = '23514', CONSTRAINT = 'expense_amount_positive';
  END IF;

  IF p_people IS NULL OR COALESCE(array_length(p_people, 1), 0) = 0 THEN
    SELECT array_agg(m.student_id::text ORDER BY m.joined_at, m.student_id) INTO v_ids
    FROM ride_member m WHERE m.ride_id = p_ride AND m.status = 'confirmed';
  ELSE
    SELECT array_agg(upper(trim(x)) ORDER BY ord) INTO v_ids FROM unnest(p_people) WITH ORDINALITY AS t(x, ord);
  END IF;
  n := COALESCE(array_length(v_ids, 1), 0);
  IF n = 0 THEN
    RAISE EXCEPTION 'Choose at least one person to split with'
      USING ERRCODE = '23514', CONSTRAINT = 'rule_split_needs_people';
  END IF;

  IF p_split = 'equal' THEN
    v_w := array_fill(1::numeric, ARRAY[n]);
  ELSIF p_split = 'seats' THEN
    SELECT array_agg(COALESCE(m.seats_taken, 1)::numeric ORDER BY u.ord) INTO v_w
    FROM unnest(v_ids) WITH ORDINALITY AS u(id, ord)
    LEFT JOIN ride_member m ON m.ride_id = p_ride AND m.student_id = u.id;
  ELSE
    IF array_length(p_values, 1) IS DISTINCT FROM n THEN
      RAISE EXCEPTION 'Give a value for every person in the split'
        USING ERRCODE = '23514', CONSTRAINT = 'rule_split_weights';
    END IF;
    v_w := p_values;
    IF p_split = 'exact' AND (SELECT sum(x) FROM unnest(p_values) x) <> p_amount THEN
      RAISE EXCEPTION 'Exact amounts must add up to the expense amount'
        USING ERRCODE = '23514', CONSTRAINT = 'rule_split_exact_sum';
    END IF;
    IF p_split = 'percent' AND (SELECT sum(x) FROM unnest(p_values) x) <> 100 THEN
      RAISE EXCEPTION 'Percentages must add up to 100'
        USING ERRCODE = '23514', CONSTRAINT = 'rule_split_percent_sum';
    END IF;
  END IF;

  RETURN QUERY SELECT s.who, s.share FROM fn_split_amount(p_amount, v_ids, v_w) s;
END $$;

-- ---------- trigger: validate a new expense ----------
CREATE OR REPLACE FUNCTION trg_expense_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_ride_status text; v_member_status text;
BEGIN
  NEW.note := trim(NEW.note);
  SELECT status INTO v_ride_status FROM ride WHERE ride_id = NEW.ride_id;
  IF FOUND AND v_ride_status NOT IN ('departed', 'completed') THEN
    RAISE EXCEPTION 'Expenses can only be added once the ride has departed (ride is %)', v_ride_status
      USING ERRCODE = '23514', CONSTRAINT = 'rule_expense_ride_state';
  END IF;
  SELECT status INTO v_member_status FROM ride_member WHERE ride_id = NEW.ride_id AND student_id = NEW.paid_by;
  IF FOUND AND v_member_status <> 'confirmed' THEN
    RAISE EXCEPTION 'Only a confirmed rider can pay for the ride'
      USING ERRCODE = '23514', CONSTRAINT = 'rule_expense_payer_confirmed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expense_validate BEFORE INSERT ON expense
  FOR EACH ROW EXECUTE FUNCTION trg_expense_validate();

-- ---------- trigger: ride, payer, amount and split type are frozen ----------
CREATE OR REPLACE FUNCTION trg_expense_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.ride_id, NEW.paid_by, NEW.amount, NEW.split_type)
       IS DISTINCT FROM (OLD.ride_id, OLD.paid_by, OLD.amount, OLD.split_type) THEN
    RAISE EXCEPTION 'An expense cannot be edited; delete it and add a new one'
      USING ERRCODE = '23514', CONSTRAINT = 'rule_expense_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expense_frozen BEFORE UPDATE ON expense
  FOR EACH ROW EXECUTE FUNCTION trg_expense_frozen();

-- ---------- trigger: only confirmed riders of that ride can be in a split ----------
CREATE OR REPLACE FUNCTION trg_share_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_ride int;
BEGIN
  SELECT ride_id INTO v_ride FROM expense WHERE expense_id = NEW.expense_id;
  IF FOUND AND NOT EXISTS (SELECT 1 FROM ride_member
                           WHERE ride_id = v_ride AND student_id = NEW.student_id AND status = 'confirmed') THEN
    RAISE EXCEPTION 'Only confirmed riders of this ride can share its expenses'
      USING ERRCODE = '23514', CONSTRAINT = 'rule_share_confirmed_member';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER share_validate BEFORE INSERT ON expense_share
  FOR EACH ROW EXECUTE FUNCTION trg_share_validate();

-- ---------- trigger: shares are immutable ----------
CREATE OR REPLACE FUNCTION trg_share_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Shares cannot be edited; delete the expense and add a new one'
    USING ERRCODE = '23514', CONSTRAINT = 'rule_expense_immutable';
END $$;
CREATE TRIGGER share_frozen BEFORE UPDATE ON expense_share
  FOR EACH ROW EXECUTE FUNCTION trg_share_frozen();

-- ---------- deferred trigger: shares must add up to the amount (checked at COMMIT) ----------
CREATE OR REPLACE FUNCTION trg_expense_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_id int; v_amt numeric; v_sum numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN v_id := OLD.expense_id; ELSE v_id := NEW.expense_id; END IF;
  SELECT amount INTO v_amt FROM expense WHERE expense_id = v_id;
  IF NOT FOUND THEN RETURN NULL; END IF;            -- expense itself was deleted (cascade)
  SELECT COALESCE(sum(share_amount), 0) INTO v_sum FROM expense_share WHERE expense_id = v_id;
  IF v_sum <> v_amt THEN
    RAISE EXCEPTION 'Shares add up to % but the expense is %', v_sum, v_amt
      USING ERRCODE = '23514', CONSTRAINT = 'rule_shares_sum_to_amount';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER expense_balanced AFTER INSERT OR UPDATE ON expense
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_expense_balanced();
CREATE CONSTRAINT TRIGGER expense_share_balanced AFTER INSERT OR UPDATE OR DELETE ON expense_share
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_expense_balanced();

-- ---------- trigger: no deletes once money has been settled on the ride ----------
-- pg_trigger_depth() > 1 means the DELETE came from a cascade (ride/member
-- removed) - those must keep working, so only direct deletes are guarded.
-- Integration with Member 4: a PENDING payment also locks the ride's expenses.
-- Deleting an expense would shrink what is owed underneath a payment that is
-- still waiting for confirmation and could turn it into an overpayment.
CREATE OR REPLACE FUNCTION trg_expense_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  IF EXISTS (SELECT 1 FROM v_settlement_flow WHERE ride_id = OLD.ride_id)
     OR EXISTS (SELECT 1 FROM payment WHERE ride_id = OLD.ride_id AND status = 'pending') THEN
    RAISE EXCEPTION 'Payments were already recorded for this ride, so its expenses are locked'
      USING ERRCODE = '23514', CONSTRAINT = 'rule_expense_locked';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER expense_delete_guard BEFORE DELETE ON expense
  FOR EACH ROW EXECUTE FUNCTION trg_expense_delete_guard();

-- ---------- trigger: audit trail ----------
CREATE OR REPLACE FUNCTION trg_expense_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_actor text := NULLIF(current_setting('poolup.actor', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO expense_audit (expense_id, ride_id, action, actor_id, paid_by, amount, note, split_type)
    VALUES (NEW.expense_id, NEW.ride_id, 'create', COALESCE(v_actor, NEW.paid_by), NEW.paid_by, NEW.amount, NEW.note, NEW.split_type);
    RETURN NEW;
  END IF;
  INSERT INTO expense_audit (expense_id, ride_id, action, actor_id, paid_by, amount, note, split_type)
  VALUES (OLD.expense_id, OLD.ride_id, 'delete', v_actor, OLD.paid_by, OLD.amount, OLD.note, OLD.split_type);
  RETURN OLD;
END $$;
CREATE TRIGGER expense_audit_trg AFTER INSERT OR DELETE ON expense
  FOR EACH ROW EXECUTE FUNCTION trg_expense_audit();

-- ---------- atomic: expense + all its shares ----------
CREATE OR REPLACE FUNCTION fn_add_expense(
    p_ride int, p_paid_by text, p_amount numeric, p_note text, p_split text,
    p_people text[] DEFAULT NULL, p_values numeric[] DEFAULT NULL)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE v_id int;
BEGIN
  PERFORM set_config('poolup.actor', p_paid_by, true);
  -- compute (and validate) the split first: nothing is written if it is invalid
  PERFORM 1 FROM fn_expense_shares(p_ride, p_amount, p_split, p_people, p_values);
  INSERT INTO expense (ride_id, paid_by, amount, note, split_type)
  VALUES (p_ride, p_paid_by, p_amount, COALESCE(NULLIF(trim(p_note), ''), 'Cab fare'), p_split)
  RETURNING expense_id INTO v_id;
  INSERT INTO expense_share (expense_id, student_id, share_amount)
  SELECT v_id, s.who, s.share FROM fn_expense_shares(p_ride, p_amount, p_split, p_people, p_values) s;
  RETURN v_id;
END $$;

-- ---------- delete (only the payer may) ----------
CREATE OR REPLACE FUNCTION fn_delete_expense(p_expense int, p_actor text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_payer text;
BEGIN
  SELECT paid_by INTO v_payer FROM expense WHERE expense_id = p_expense FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such expense' USING ERRCODE = 'P0002';
  END IF;
  IF v_payer <> upper(trim(p_actor)) THEN
    RAISE EXCEPTION 'Only the person who paid can delete this expense'
      USING ERRCODE = '23514', CONSTRAINT = 'rule_expense_owner_only';
  END IF;
  PERFORM set_config('poolup.actor', p_actor, true);
  DELETE FROM expense WHERE expense_id = p_expense;
END $$;

-- ---------- fewest-transfers settlement plan for one ride ----------
-- Greedy min-cash-flow: repeatedly match the biggest debtor with the biggest creditor.
CREATE OR REPLACE FUNCTION fn_simplify_debts(p_ride int)
RETURNS TABLE (from_id text, to_id text, amount numeric)
LANGUAGE plpgsql STABLE AS $$
DECLARE ids text[]; bal numeric[]; n int; i int; j int; k int; x numeric; guard int := 0;
BEGIN
  SELECT array_agg(l.student_id::text ORDER BY l.student_id), array_agg(l.net ORDER BY l.student_id)
    INTO ids, bal FROM v_ride_ledger l WHERE l.ride_id = p_ride AND l.net <> 0;
  IF ids IS NULL THEN RETURN; END IF;
  n := array_length(ids, 1);
  LOOP
    i := 1; j := 1;
    FOR k IN 2 .. n LOOP
      IF bal[k] < bal[i] THEN i := k; END IF;
      IF bal[k] > bal[j] THEN j := k; END IF;
    END LOOP;
    EXIT WHEN bal[i] >= 0 OR bal[j] <= 0 OR guard > n * n + 5;
    x := LEAST(-bal[i], bal[j]);
    from_id := ids[i]; to_id := ids[j]; amount := x;
    RETURN NEXT;
    bal[i] := bal[i] + x; bal[j] := bal[j] - x;
    guard := guard + 1;
  END LOOP;
END $$;
