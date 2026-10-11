# Integration notes: how five modules became one database

Each member built and tested their module on its own, against a shared contract of table and column names (`student`, `ride`, `ride_member (ride_id, student_id)`, `expense`, …) and with small "stand-in" copies of the other members' tables. This file records every decision taken when the five were merged, so that anyone can explain it in the viva.

## 1. One schema, one file order

| Before (five repositories) | After (`db/`) |
|---|---|
| Each module had its own `00_…sql` that dropped and re-created the schema, plus stand-in tables | `00_reset.sql` (Member 1) is the only reset; **all stand-in tables were deleted** |
| Files numbered independently (`10_ratings_schema.sql`, `60_payments_schema.sql`, `20_logic.sql`, …) | Layered numbering: `1x` tables → `2x` logic → `3x` views → `4x` indexes → `50` integration; the second digit is the member (`13_m4_payments_schema.sql`) |
| SQL-language functions in one module referenced tables of another that might not exist yet | Every table of every module is created before any function, because PostgreSQL validates `LANGUAGE sql` bodies at `CREATE` time |
| Named queries: JS objects (M1–M3) or `.sql` files (M4, M5) | All 84 in `db/queries/*.sql`, one file per module, one loader, one SQL library page |

The setup script (`server/scripts/setup-db.js`) simply runs every `db/NN_*.sql` in numeric order, then seeds.

## 2. Conflicts found and how they were resolved

| # | Conflict | Resolution |
|---|---|---|
| 1 | Member 3's `v_settlement_flow` read a stand-in `settlement` table; Member 4 had built a richer `payment` table | `v_settlement_flow` now reads `payment WHERE status = 'confirmed'` (UPI, cash **and** net-off rows). With that one change Member 3's ledger and Member 4's ledger compute identical balances; check **I8** and the query `ledger_agreement` prove it on every load |
| 2 | Member 3's "expenses are locked once money moved" trigger did not know about *pending* payments | The guard also refuses a delete while a payment is pending on that ride, otherwise a deletion could turn a pending payment into an overpayment |
| 3 | The Σ shares = amount invariant was enforced twice (Member 3's `expense_balanced` and a copy in Member 5's stand-ins) | Member 3's deferred constraint trigger is the only one |
| 4 | Duplicate indexes: `ride_member_student_idx` (M1 and M5), `expense_paid_by_idx` and `expense_share_student_idx` (M3 and M4), and M5's `expense_ride_idx`, which M3's `expense_ride_paid_idx (ride_id, paid_by)` already covers | Kept one of each; the removed ones are documented in the index files. Duplicate indexes cost write time and buy nothing |
| 5 | Two copies of a query called `hostel_league` (M1 rides per hostel, M5 reputation per hostel) | Member 1's is now `hostel_ride_league` |
| 6 | Rule id `E1` meant "booking history is append-only" (M2) and "amount must be > 0" (M3) | Member 2's rule is now **B17**. The merged catalogue (123 rules in `server/src/rules/`) refuses to start if a constraint name or rule id is defined twice |
| 7 | Members 4 and 5 identified the actor with an `X-Student-Id` header (a stand-in) | Every route now uses Member 1's login: `Authorization: Bearer <token>`, only the SHA-256 of the token is stored in `auth_session`. Named-query parameters called `me` are always bound to the logged-in student on the server, so nobody can read another student's statement or inbox through the SQL library |
| 8 | Two demo students (`2023A7PS0001H` in M1–M3, `2022A3PS0106H` in M4–M5), both called Aarav Mehta | One demo student, `2023A7PS0001H` / `poolup123` |
| 9 | Five seed generators, each creating its own students and rides | One pipeline in one transaction: M1 users + rides → M2 bookings → M3 expenses (through `fn_add_expense`) → demo story → M4 payments (from `fn_settlement_plan`, through the state machine) → M5 ratings (checked by the insert trigger) |
| 10 | Members 4 and 5 used ride statuses and member statuses written straight into their stand-ins | Their seeds now run on Member 1 and 2's real rows. Member 2's triggers (capacity, status flow) and Member 1's (state machine) see every seeded row; only the clock-based rules are skipped while `poolup.seeding = 'on'` |
| 11 | Payments make a ride undeletable (Member 4's composite FKs have no cascade), which broke a Member 3 test that deleted a "settled" ride | The test now shows both behaviours: a ride with expenses but no payments cascades away; a ride with payments is protected (financial history is append-only) |
| 12 | Four separate Integrity Labs, three SQL libraries, four UIs | One app shell (Member 5's design system), one Integrity Lab (81 scenarios, filter by module), one SQL library, one Database page |

## 3. What only exists because the modules were merged

- `v_student_overview`: one row per student joining a view from every module (Home page, profile).
- `fn_integrity_report()`: 13 invariants the modules promise each other, counted live (Database page, setup output, tests).
- Cross-module queries in `db/queries/x_integration.sql`: `my_todo`, `ride_lifecycle_funnel`, `reliability_vs_money`, `ledger_agreement`, `integrity_report`, `student_overview`, `table_sizes`.
- The **demo story** (`server/scripts/seed/demo_story.js`): recent rides for the demo student whose booking, money and rating state is hand-crafted, so that every workflow of every module has something live to show.
- Cross-links in the UI: a completed hosted ride offers "Record the fare" (M2 → M3); a ride's expenses page offers "Pay what you owe" (M3 → M4); profile pages show reputation (M5) next to ride and booking records (M1, M2).

## 4. Test and lab results after the merge

| Suite | Tests |
|---|---|
| `m1_users_rides.test.js` | 12 |
| `m2_booking.test.js` | 13 |
| `m3_expenses.test.js` | 14 |
| `m4_payments.test.js` | 12 |
| `m5_ratings.test.js` | 12 |
| **Total** | **63 passing**, each file on a freshly built and seeded `poolup_test` database |

Integrity Lab: **81 / 81** scenarios behave as documented. Integrity report: **13 / 13** invariants hold after seeding and after the test suites.
