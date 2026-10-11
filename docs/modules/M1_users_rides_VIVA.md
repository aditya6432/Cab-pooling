# Viva prep: Users + Ride creation / search (Member 1)

> **Module deep-dive, written by Member 1 while building the module on its own.** In the integrated repository the files are numbered by layer (`db/1x` tables, `2x` logic, `3x` views, `4x` indexes, `db/queries/` named queries) and the references below have been updated to those names. Stand-in tables and the temporary `X-Student-Id` header mentioned in some passages were replaced at integration by the real tables and by Member 1's login; see `../INTEGRATION_NOTES.md`.


Numbers below are from the seeded database (700 rides, 120 students, ~2,700 rows total) and the 200,000-ride scratch test.

## Part A: 6-minute live demo script
1. **(0:00) Login page.** "Everything you see is backed by PostgreSQL; the API has no business rules." Log in as `2023A7PS0001H` / `poolup123`.
2. **(0:30) Campus dashboard.** Point at the KPI card (money saved, occupancy, upcoming rides). Click **SQL** on *Rides per month*: show `LAG() OVER`, the CTE KPI query, `RANK()` for popular routes. "Each chart is one query; concepts are listed as chips."
3. **(1:45) Find a ride.** Main Gate -> RGIA Airport. Open **Show SQL**. Explain: path = origin -> stops -> destination; match when origin's seq < destination's seq. Then search *Main Gate -> Ameerpet* and show a "Via route" result (a ride that merely passes through Ameerpet).
4. **(2:45) Offer a ride.** Main Gate -> Airport, add stops Ameerpet + Hitech City, 6-7 PM window. Point at the live **distance and fare estimate** ("computed by `fn_route_km` / `fn_estimate_fare`, not by JavaScript"). Create it -> *My rides* shows it with seat 1 already taken ("trigger `ride_creator_joins`").
5. **(3:45) Break it on purpose.** Offer a second ride 30 min later -> red box: *Rejected by the database · Trigger (row lock) · R10 · rule_no_overlap*.
6. **(4:15) Integrity Lab -> Run all.** 12/12: 11 rejections each naming the exact constraint, 1 valid ride accepted then rolled back. "Everything runs in BEGIN...ROLLBACK, so nothing is saved."
7. **(5:15) SQL library -> EXPLAIN ANALYZE.** "At 200,000 rides the open-rides query dropped from 27.6 ms to 0.08 ms with the partial index."
8. **(5:45) Close:** "47 constraints, 6 triggers, 6 functions, 2 views, 8 indexes, 12 automated tests."

## Part B: likely questions with answers

### Design & modelling
**Why is RIDE_STOP a weak entity?** A stop has no meaning without its ride. Its key is (ride_id, stop_seq) - the sequence both orders the stops and caps them at 3 via `CHECK (stop_seq BETWEEN 1 AND 3)`. It cascades on ride delete.

**Why not store stops as an array/JSON column on ride?** That violates 1NF, can't carry a foreign key to LOCATION, and can't be indexed for "rides passing through X". A child table gives FK integrity, a UNIQUE (ride_id, location_id) and an index (`ride_stop_loc_idx`).

**Why are origin_id and dest_id two FKs to the same table?** One entity (LOCATION) plays two roles. `CHECK (origin_id <> dest_id)` forbids zero-length rides; a trigger keeps stops from equalling either end.

**Which normal form is STUDENT in and why?** BCNF - every determinant (student_id, email, phone) is a candidate key. Hostel name lives in HOSTEL to remove student -> hostel_id -> name.

**Is anything denormalized?** `distance_km` on RIDE - a snapshot of static reference data needed on every search row. Seats left, fare per head and rider counts are derived (never stored) so they can't go stale.

**Why CHAR(13) for student_id and CHAR(10) for phone?** Fixed-length identifiers, validated by regex CHECK; phone is an identifier, not a number.

**Why NUMERIC for money and coordinates, TIMESTAMPTZ for time?** Exact decimals (no float rounding for money); time-zone-safe instants (the UI shows IST, analytics convert with `AT TIME ZONE 'Asia/Kolkata'`).

### Constraints, triggers, functions
**Which rules are declarative and which triggers, and why?** One-row rules (formats, uniqueness, window length, origin != destination) are CHECK/UNIQUE/FK. Rules needing other rows or the clock (start >= 15 min ahead, no overlapping ride, status transitions, immutable route) are triggers.

**How does the API know which rule fired?** Triggers raise `ERRCODE 23514` with `CONSTRAINT = 'rule_...'`, the same shape as a CHECK failure. `errors.js` maps SQLSTATE -> HTTP status and constraint name -> rule id and message.

**Explain the ride status state machine.** open <-> full, open/full -> departed -> completed, open/full -> cancelled; completed/cancelled are terminal. Enforced by `trg_ride_status` (BEFORE UPDATE OF status), which also writes `ride_status_log`.

**Why is `completed_at` tied to status?** `CHECK ((status = 'completed') = (completed_at IS NOT NULL))` makes the two impossible to disagree.

**What does `poolup.seeding` do - isn't it a backdoor?** It's a transaction-local setting used only by the seed script to load historical rides (skips the "must start in the future" style trigger rules). All CHECK/FK/UNIQUE constraints still apply. The API never sets it.

**Why does fn_create_ride exist instead of plain INSERTs?** Atomicity (ride + stops + creator seat in one transaction), distance computed in one place, and the row lock that serialises same-student creates.

**What does the AFTER INSERT trigger `ride_creator_joins` do?** Inserts the creator into `ride_member` (seat 1), so a ride is never "empty" and seat counts are right from the start.

### Transactions & concurrency
**What happens if two requests from one student create overlapping rides at the same instant?** `fn_create_ride` first does `SELECT ... FOR UPDATE` on that student's row, so the second waits; when it proceeds, the overlap trigger sees the first ride and rejects. Tested: 4 parallel requests -> exactly 1 ride.

**Why not SERIALIZABLE?** READ COMMITTED + one explicit row lock protects the only cross-row invariant and is cheaper and simpler; SERIALIZABLE would need retry logic.

**Is creating a ride atomic?** Yes - one function call in one transaction. Test: a rejected create leaves no ride, stop or member rows behind.

### Queries
**Explain the search query.** `UNION ALL` builds one row per route point with a sequence (origin 0, stops 1-3, destination 99). Self-join the path on ride_id with `b.seq > a.seq`, filter `a.loc = origin AND b.loc = dest`. Then join seats (cab capacity minus confirmed riders), time window, cab type, exclusion of own rides; exact-route matches sort first.

**Which window functions did you use?** `RANK() OVER (ORDER BY count(*) DESC)` for popular routes; `LAG(rides) OVER (ORDER BY month)` for growth; `sum(count(*)) OVER ()` for status share.

**Where is a correlated/scalar subquery?** `top_creators`: `HAVING count(*) > (SELECT avg(c) FROM (SELECT count(*) c FROM ride GROUP BY creator_id) x)`.

**Where is an anti-join?** `unfilled_rides`: `NOT EXISTS` ride_member rows other than the creator.

**Why `FILTER (WHERE ...)` in the KPI CTE?** Conditional aggregation computes completed / upcoming / cancelled counts in one pass instead of several scans.

**How is "money saved" defined?** For each completed ride with n confirmed riders: fare x (n - 1) - what the other riders would have paid beyond sharing one cab.

### Performance
**Show that your indexes matter.** At 200,000 rides: open rides in a 6-hour window 27.6 ms (Seq Scan, 2,804 buffers) -> 0.08 ms (Bitmap Index Scan, 9 buffers) = ~340x. Latest 20 rides of a creator 11.7 ms -> 0.08 ms = ~140x.

**Why a partial index?** `WHERE status = 'open'`: only joinable rides are indexed (1.7 MB vs 8 MB for the creator index), and search only ever asks for open rides.

**Why did the demo dataset not use the indexes?** With 700 rows a sequential scan is genuinely cheaper; the planner is right. That's why I measured on a 200k-row scratch database.

**What is an expression index here?** `student_name_prefix_idx ON student (lower(full_name) text_pattern_ops)` serves `lower(name) LIKE 'aar%'`.

### Application & security
**How are passwords stored?** scrypt with a per-user random salt; the DB column check only enforces a minimum length so un-hashed values are rejected.

**How do sessions work?** 256-bit random token returned once; only its SHA-256 is stored in `auth_session` with a 7-day expiry. Logout deletes the row.

**SQL injection?** Every query is parameterised (`$1, $2...`); the Integrity Lab only interpolates the logged-in student's ID, which comes from the database and matches a strict regex.

**What does Member 2 need from you?** `ride`, `student`, `ride_member` PK (ride_id, student_id), the state machine (open <-> full allowed), and `requireAuth` for login. See INTEGRATION.md.

## Part C: things to say if asked "what would you improve?"
Real road distances via a routing API instead of 1.3 x haversine; a `ride_request` table for join approvals; PostGIS for geographic search radius; partitioning `ride` by month when it grows past millions of rows.
