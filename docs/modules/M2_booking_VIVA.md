# Viva prep: Booking + Ride Pooling / Seat Management (Member 2)

> **Module deep-dive, written by Member 2 while building the module on its own.** In the integrated repository the files are numbered by layer (`db/1x` tables, `2x` logic, `3x` views, `4x` indexes, `db/queries/` named queries) and the references below have been updated to those names. Stand-in tables and the temporary `X-Student-Id` header mentioned in some passages were replaced at integration by the real tables and by Member 1's login; see `../INTEGRATION_NOTES.md`.


## 60-second pitch
"Member 1 lets people offer rides; my module answers 'how do I get a seat?'. A booking is a row in `ride_member`. The database, not the app, guarantees that seats never exceed the cab, nobody holds two overlapping rides, full rides get a FIFO waitlist that promotes people automatically, and every change is logged. The API only calls stored functions and translates error codes."

## Demo script (5 minutes, login 2023A7PS0001H / poolup123)
1. **Find a ride**, Main Gate → Airport. Open the ride with the note "Aarav can book this seat instantly" → **Book seat** → toast shows seats left.
2. **Search Main Gate → Secunderabad Jn**, the "approval" ride → send a request. (Policy per ride, request state machine.)
3. **Search Main Gate → Hitech City**: no free seats, scroll to *Full rides on this route* → **Join waitlist** (position #2).
4. **Bookings → My seats**: the ride to Ameerpet has a waitlist behind it. **Cancel my seat** → open *Activity*: the database promoted the next person (`promoted` event) and the ride is full again. *Say:* promotion happens in an AFTER trigger inside the same transaction as the cancel.
5. **Bookings → Hosting**: ride to Inorbit Mall has two requests (1 seat, 2 seats). Accept the 1-seat one; the 2-seat one now cannot be accepted (capacity), show the error with the rule chip.
6. **Booking Lab → Run all**: 20 scenarios, every rejection names the rule and the mechanism; the happy paths show the proof row. Everything is rolled back.
7. **Booking SQL**: open `seat_utilisation` (ROLLUP) and `fill_by_route` (RANK), show EXPLAIN ANALYZE.

## Questions you will probably get
**Why is capacity a trigger and not a CHECK?** A CHECK sees one row. Capacity depends on the other bookings of the ride, so it needs a trigger that takes a row lock on the ride and sums the other rows.

**What stops two people taking the last seat?** `SELECT … FOR UPDATE` on the ride row (in `fn_book_seat` and again in the capacity trigger). The second transaction waits, then re-reads the committed seat count (READ COMMITTED gives each statement a fresh snapshot) and is rejected. Test: 6 parallel bookings for 2 seats → exactly 2 succeed.

**Why not SERIALIZABLE?** The only cross-row invariants are capacity and overlap; explicit row locks protect exactly those, with no retry loops.

**How do you avoid deadlocks?** One lock order: ride first, then student. (`fn_decide_request` reads the request unlocked, locks the ride, then the request.)

**Why are booking, request and waitlist three tables?** Different keys and rules: a student may re-request after a rejection (surrogate key + partial unique index on pending), waitlist has FIFO order, `ride_member` rows are the only ones that count as seats.

**Is it in 3NF/BCNF? Anything denormalised?** Yes, BCNF. Nothing derived is stored (seats left, position, reliability are views). `ride.status` full/open mirrors the seat count and is kept in step by a trigger; a test asserts the invariant.

**What does the waitlist promotion do exactly?** `fn_promote_waitlist`: loop over the queue ordered by `joined_at`, book each entry that fits the free seats (first-fit), skip those that do not fit or now clash (EXCEPTION block = sub-transaction), stop when full.

**What happens when the creator cancels the ride?** `ride_lifecycle` trigger: pending requests rejected, waitlist cleared, every rider's booking cancelled with reason `ride_cancelled`; the creator's own seat row stays.

**Trigger order?** Alphabetical per event, so names carry numeric prefixes: `member_10_status_flow`, `20_capacity`, `30_no_overlap`, `40_segment`, `90_after`.

**Which index mattered most?** `event_student_idx` (feed, 124 ms → 0.05 ms at 1.2 M events) and the covering partial index `member_confirmed_seats_idx` (3.7×). One index I proposed (`waitlist_fifo_idx`) gave no gain and was removed; say that, it shows you measured.

**Limits?** Seats are held for the whole trip even if a rider leaves at a stop; demo history is generated.

## Rule IDs cheat-sheet
B1-B16 booking rules · W1-W3 waitlist · Q1-Q3 requests · P1 policy · L1-L2 lifecycle · A1 authorisation · E1 audit. Full table in the design document §1.5.
