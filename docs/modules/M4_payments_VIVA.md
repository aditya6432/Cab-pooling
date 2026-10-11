# Viva prep: Payments + Settlement module (Member 4)

> **Module deep-dive, written by Member 4 while building the module on its own.** In the integrated repository the files are numbered by layer (`db/1x` tables, `2x` logic, `3x` views, `4x` indexes, `db/queries/` named queries) and the references below have been updated to those names. Stand-in tables and the temporary `X-Student-Id` header mentioned in some passages were replaced at integration by the real tables and by Member 1's login; see `../INTEGRATION_NOTES.md`.


## Part A: 6-minute live demo script

Run `npm run db:setup` (in `server/`) **just before** the demo. Acting student: **Aarav Mehta**.

| # | Time | Do this | Say this |
|---|---|---|---|
| 1 | 0:00 | **Money dashboard**: point at "✓ Books balance" | "No balance is stored anywhere. Every rupee is derived from expenses and payments, and this card re-proves on every load that all 460-odd rides sum to exactly ₹0." |
| 2 | 0:40 | **Settle up**: "You owe / owed", then expand a ride | "Each ride is a small ledger: paid − share + sent − received. The plan is the fewest transfers, computed by a PL/pgSQL function." |
| 3 | 1:20 | **Net off** with the suggested co-rider | "I owe them on one ride; they owe me on another. One transaction writes two mirrored offset entries. A **deferred constraint trigger** checks the pair at COMMIT, and rides are locked in ID order so this can't deadlock." |
| 4 | 2:00 | **Pay** someone → UPI → type a 5-digit UTR → submit | "Refused by a CHECK constraint: UPI needs a 12-digit UTR." Then enter 12 digits → recorded **pending**. "Only the payee can confirm. The pending amount is now reserved, so I can't pay this debt twice." |
| 5 | 2:40 | **Payments** → on an incoming payment click **Try cancel**, then **Confirm received** | "The trigger looks the move up in the `payment_transition` table: the payee can't cancel, the payer can't confirm. The state machine is data. Every move lands in `payment_event`." |
| 6 | 3:20 | **Settle up** → click **Remind** twice | "The second is refused by an **EXCLUDE constraint**: no two reminders for the same debt with overlapping 24-hour windows." |
| 7 | 3:50 | **Integrity Lab → Payments → Run all** | "Twenty attacks. Watch the race: two real sessions pay the same debt; B waits ~900 ms on A's lock, then re-reads and is refused." |
| 8 | 5:00 | **Statement** | "Five event sources glued with UNION ALL; the running balance is `SUM() OVER (ORDER BY seq)`, and it ends exactly at my net position." |
| 9 | 5:30 | **Money dashboard → "Payment delayed" card** | "Cross-module: people tagged 'Payment delayed' in ratings really do take days longer to pay." |

**psql one-liners**
```sql
-- use any ride id shown on the Settle up page (ids depend on the seed date)
SELECT * FROM v_ride_balance WHERE ride_id = 480;
SELECT * FROM fn_settlement_plan(480);
SELECT * FROM payment_transition;
SELECT ride_id, SUM(net) FROM v_ride_balance GROUP BY ride_id HAVING SUM(net) <> 0;  -- always empty
```

---

## Part B: likely questions with answers

### Modelling

**Q1. Why store no balance column?**
A balance is derived data: it is a function of expenses, shares and payments. Storing it creates an update anomaly. Every insert, update or delete in three modules would have to maintain it, and one missed path makes it silently wrong. `v_ride_balance` computes it on demand; at campus scale that costs a few milliseconds, and `ledger_integrity` proves it consistent.

**Q2. Why a per-ride ledger instead of pairwise debts?**
In a group ride, debts are naturally to "the group". With pairwise debts, C paying A ₹300 when C also covered A's toll would be an overpayment on one pair and an underpayment on another. With the group model a ride's balances always sum to ₹0, which is easy to verify and lets the planner find the fewest transfers.

**Q3. What is `open` vs `net`?**
`net` counts only **confirmed** payments: the real position. `open` also counts **pending** payments as if they'll succeed. It is what's still left to ask for. The overpayment rule and the settlement plan use `open`, so in-flight money is never requested twice.

**Q4. Why is the state machine a table?**
Rules as data. The trigger has no `IF status = … THEN` ladder; it asks "does `(old, new, role)` exist in `payment_transition`?" Adding a step (say, `disputed`) is an INSERT, not a code change. The table is also self-documenting, and the error message lists the allowed moves straight from it.

**Q5. Is PAYMENT in BCNF? It has three candidate keys.**
Yes. `payment_id`, `client_ref` and `utr` (when present) each determine every attribute. Every non-trivial FD's left side is a candidate key, so it is BCNF. Multiple candidate keys don't violate any normal form.

**Q6. Why NUMERIC and not FLOAT for money?**
FLOAT is binary floating point: 0.1 + 0.2 = 0.30000000000000004, and summing thousands of shares drifts. NUMERIC(10,2) is exact decimal, so the zero-sum invariant can be checked with `=`.

### Concurrency & transactions

**Q7. Two people pay the same debt at the same instant. What happens?**
The insert trigger runs `SELECT 1 FROM ride WHERE ride_id = … FOR UPDATE`, so the second transaction **blocks** on that row lock. When the first commits, PostgreSQL (READ COMMITTED) gives the next statement a fresh snapshot. The trigger re-reads `v_ride_balance`, now including the first payment, and refuses the second (PR10). Without the lock both would read the old balance and both would pass. That is a classic lost-update / write-skew. The lab and an automated test fire three concurrent payments and assert exactly one succeeds.

**Q8. Why lock the *ride* row rather than the payment rows?**
The thing being protected is the ride's balance, which is derived from many rows, and the new payment doesn't exist yet to lock. Locking the parent row turns "all money movement on ride N" into a serialised critical section. Different rides proceed in parallel.

**Q9. How does net-off avoid deadlocks?**
It locks every involved ride with `ORDER BY ride_id FOR UPDATE`. If A nets off with B while B nets off with A, both try to lock rides in the same global order, so one simply waits; there is no cycle. Deadlocks need two transactions acquiring the same locks in opposite orders.

**Q10. What is a deferred constraint trigger and why is it needed here?**
`CREATE CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` fires at **COMMIT** instead of after each row. A net-off writes two rows; an ordinary AFTER trigger would fire after the first row, see only half the pair and fail. Deferred, it sees both. In the lab, `SET CONSTRAINTS … IMMEDIATE` forces it to fire early to demonstrate a half-written pair being caught.

**Q11. What is idempotency and how is it implemented?**
Doing the same request twice has the same effect as doing it once. The client generates a UUID per payment attempt (`client_ref`, UNIQUE). `fn_record_payment` first returns an existing row with that key. Inside the insert trigger, after taking the ride lock, it re-checks the key; this closes the race where two identical requests arrive together. The same key with a different amount is an error (`rule_idempotency_mismatch`).

**Q12. How do triggers know who is acting?**
The functions call `set_config('poolup.actor_role', 'payee', true)`. The `true` makes it **transaction-local**, so it vanishes at COMMIT/ROLLBACK and can't leak to another request on a pooled connection. With no setting (a raw UPDATE in psql), the role is `system`, which may only expire stale payments.

### Constraints

**Q13. EXCLUDE vs UNIQUE?**
UNIQUE says "no two rows are *equal* on these columns". EXCLUDE generalises it to "no two rows where *all these operators* return true". Ours uses `=` on ride, creditor and debtor plus `&&` (overlaps) on a 24-hour time range, which UNIQUE cannot express. It needs a GiST index; `btree_gist` supplies GiST support for plain `=` on text and integers.

**Q14. Why is `fn_reminder_window()` marked IMMUTABLE?**
Index and constraint expressions must be immutable. `timestamptz + interval` is only STABLE in general because adding '1 day' or '1 month' depends on the session time zone (DST). Adding exactly 24 *hours* to an absolute instant never does, so the function is genuinely immutable and the declaration is honest.

**Q15. Why must "set default UPI ID" be two statements?**
The one-default rule is a partial unique **index**, and unique indexes are checked row by row and can't be deferred (only UNIQUE *constraints* can be DEFERRABLE). A single `UPDATE … SET is_default = (id = X)` might set the new default before clearing the old one and fail. So we clear first, then set.

**Q16. Why does the insert trigger "step aside" for some violations?**
BEFORE triggers run before CHECK and FK constraints. Paying yourself would otherwise be reported as "payee is not owed anything" (a trigger message) instead of the CHECK that owns that rule. The trigger returns early when a declarative rule is about to fail, so every violation is reported by its proper mechanism.

**Q17. Payments can never be deleted. What if one was a mistake?**
Financial records are append-only, like a bank. A mistaken pending payment is **cancelled** (payer) or **rejected** (payee). A mistaken confirmation is **reversed** within 72 h. The history in `payment_event` shows everything. The FK from payment to ride has no cascade, so even deleting a ride can't remove its payments.

### Queries

**Q18. Explain the settlement plan algorithm.**
Collect debtors (`open < 0`) and creditors (`open > 0`), each sorted by amount. Two pointers: transfer `min(debt_i, credit_j)`, subtract, and advance whichever reached zero. Each step fully settles at least one person, so there are at most d + c − 1 transfers. A test checks that every ride's plan moves exactly the outstanding amount within that bound. (The true minimum is NP-hard in general; greedy is the standard practical choice.)

**Q19. How does the statement's running balance work?**
Five sources are combined with UNION ALL: fares you paid (+), your shares (−), payments you sent (+), payments you received (−), and reversals (undo). `ROW_NUMBER() OVER (ORDER BY at, …)` gives a stable order, then `SUM(delta) OVER (ORDER BY seq ROWS UNBOUNDED PRECEDING)` accumulates. A test asserts that the final balance equals `v_student_money.net`.

**Q20. What does `CROSS JOIN LATERAL fn_settlement_plan(r.ride_id)` do?**
LATERAL lets the right side refer to columns of the left. The planner calls the set-returning function once per ride row and joins its output. That is how one query lists every transfer involving me across all my rides.

**Q21. The cross-module query: why is it meaningful?**
It joins ratings data (`rating_tag_map`, 'Payment delayed') with payments data (time from ride end to payment). Students tagged by co-riders pay a median of about 6 days after the ride; others about a day. Two independently recorded datasets agree, which validates both modules.
