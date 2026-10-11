# Viva prep: Ratings + Analytics module (Member 5)

> **Module deep-dive, written by Member 5 while building the module on its own.** In the integrated repository the files are numbered by layer (`db/1x` tables, `2x` logic, `3x` views, `4x` indexes, `db/queries/` named queries) and the references below have been updated to those names. Stand-in tables and the temporary `X-Student-Id` header mentioned in some passages were replaced at integration by the real tables and by Member 1's login; see `../INTEGRATION_NOTES.md`.


## Part A: 6-minute live demo script

Run `npm run db:setup` (in `server/`) **just before** the demo. Data is generated relative to "now", so the pending ratings and the 24-hour edit window are always fresh.

| # | Time | Do this | Say this |
|---|---|---|---|
| 1 | 0:00 | Open **Campus dashboard** | "Everything here is computed live by PostgreSQL. Every card has an SQL button." |
| 2 | 0:30 | Reliability watchlist → **SQL** → **Run EXPLAIN ANALYZE** | "A correlated subquery: each student is compared with *their own hostel's* average. This is the exact SQL that ran, with bind parameters." |
| 3 | 1:15 | **Rate co-riders** → ride with 3 co-riders → give 5★, **2★ with no comment**, 4★ → Submit | "All three go in one transaction. The 2★ breaks BR5 (a CHECK constraint), so PostgreSQL rejects it and the *whole batch* rolls back. Notice the pending count didn't change." |
| 4 | 2:00 | Add a comment to the 2★ → Submit | "Now it commits. Three `rating` rows, their tags, and three audit rows written by a trigger." |
| 5 | 2:30 | Scroll to **Ratings you've given** → on an old one click **Try to edit** → Save | "The UI lets me try; the BEFORE UPDATE trigger refuses because 24 hours have passed." |
| 6 | 3:00 | **Leaderboard** | "This reads a *materialized view*. It says 3 changes aren't reflected yet, which is my new ratings. Refresh → `REFRESH MATERIALIZED VIEW CONCURRENTLY`." |
| 7 | 3:45 | **My reputation** | "Bayesian average shrinks small samples toward the campus mean; here is the formula with my real numbers. Below is the trust network, a recursive CTE." |
| 8 | 4:30 | **Integrity Lab** → **Run all scenarios** | "Fourteen attacks, mostly raw INSERTs that bypass the API. Each is rejected by a specific CHECK, FK, PK or trigger. Every scenario runs inside BEGIN … ROLLBACK, so the lab never changes data." |
| 9 | 5:30 | **SQL library** | "All 24 queries, loaded from one SQL file; the showcase tab lists the non-trivial ones." |

**If asked to show it in psql:**
```sql
\d rating                                  -- keys, constraints, triggers in one view
SELECT * FROM fn_pending_ratings('2023A7PS0001H');
SELECT * FROM fn_trust_network('2023A7PS0001H', 2);
SELECT * FROM rating_audit ORDER BY audit_id DESC LIMIT 5;
EXPLAIN ANALYZE SELECT * FROM rating WHERE ratee_id = '2023A7PS0001H';
```

---

## Part B: likely questions with answers

### Design & modelling

**Q1. Why is "you can only rate a co-rider" a foreign key and not a trigger?**
A rating has two composite FKs: `(ride_id, rater_id)` and `(ride_id, ratee_id)` → `ride_member(ride_id, student_id)`. A pair that isn't a membership can't exist, and that's declarative, so it can't be bypassed or forgotten. A trigger is procedural code that could have bugs or be disabled. Prefer declarative whenever the rule fits on one row plus FK references.

**Q2. Then why are BR8–BR10 triggers and not CHECK constraints?**
A CHECK can only see the **current row**. "Ride must be completed" needs `ride.status` (another table). "Within 7 days" needs the ride's `completed_at` and the clock. PostgreSQL CHECK expressions can't contain subqueries. Using `now()` in a CHECK is unsafe because it is only evaluated at insert time and never re-validated, which breaks dumps and restores.

**Q3. What is the primary key of `rating` and why not a surrogate `rating_id`?**
`(ride_id, rater_id, ratee_id)`. The natural key *is* the business rule BR4 (one rating per pair per ride). With a surrogate key we would still need a UNIQUE on those three columns. Trade-off: `rating_tag_map` has to carry a 3-column FK. That's acceptable because it also makes the map's PK self-explanatory.

**Q4. Is `rating_tag_map` a weak entity?**
Yes. It represents the **multivalued attribute** "tags" of RATING. It has no key of its own (its key = owner's key + `tag_id`) and existence-depends on the rating (`ON DELETE CASCADE`). Storing tags as a list in `rating` would violate 1NF and couldn't be FK-checked.

**Q5. What kind of relationship is RATING in the ER model?**
A recursive (STUDENT–STUDENT) relationship qualified by RIDE, effectively ternary. Modelled through **aggregation**: it relates two RIDE_MEMBER instances, which is the M:N relationship between STUDENT and RIDE treated as an entity.

**Q6. Why does `rating_audit` have no foreign key?**
An audit trail must survive the deletion of what it describes. With an FK, withdrawing a rating would either be blocked or cascade-delete its own history.

**Q7. Prove `rating` is in BCNF.**
The only non-trivial FD is `(ride_id, rater_id, ratee_id) → score, comment, created_at, updated_at`. Its left side is the key, so every determinant is a superkey and the relation is in BCNF. There are no partial dependencies, because the score depends on all three columns (2NF), and no transitive dependencies, because names and routes aren't stored (3NF).

**Q8. Why don't you store `avg_rating` in `student`?**
It's derived, so storing it creates update anomalies: every insert, update or delete of a rating would have to maintain it, and a missed path would make it wrong. We compute it in `v_student_reputation`. The only stored copy is the materialized view, which is regenerated, never edited.

### Triggers, functions, transactions

**Q9. BEFORE vs AFTER triggers: why which?**
Validation (BR8–BR14) runs **BEFORE**, so a bad row is rejected before it's written and the trigger can also modify `NEW` (e.g. stamp `updated_at`). Audit runs **AFTER**, so it only logs changes that actually passed every constraint.

**Q10. What does `pg_trigger_depth() > 1` do in the delete trigger?**
It distinguishes a user withdrawing a rating (depth 1) from a **cascade** fired by a foreign-key action (depth 2, e.g. an admin deleting a ride). The 24-hour rule applies only to users.

**Q11. Why `SELECT … FOR UPDATE` in the tag trigger?**
To prevent a race. Two concurrent transactions each adding a 3rd/4th tag to the same rating could both count 2 existing tags and both succeed (4 tags). Locking the parent rating row serialises them, so the second one waits, then sees 3 and fails.

**Q12. Which ACID properties does the batch rating demonstrate?**
**Atomicity**: one bad item → ROLLBACK, zero rows saved. **Consistency**: every constraint and trigger holds at commit. **Isolation**: other users never see a half-saved batch (READ COMMITTED). **Durability**: after COMMIT the ratings survive a crash (WAL).

**Q13. What isolation level do you use?**
PostgreSQL's default, **READ COMMITTED**. Duplicates are already prevented by the PK (unique index), and the one read-then-write race (max 3 tags) is closed with a row lock, so SERIALIZABLE isn't needed.

**Q14. Why is `fn_submit_rating` a function instead of two INSERTs from Node?**
A function call is a single statement, so it is atomic on its own. The rating and its tags can't be half-saved even if the caller forgets a transaction. The batch endpoint still wraps several calls in BEGIN/COMMIT.

### Queries

**Q15. Correlated vs non-correlated subquery: show me one.**
`no_show_watchlist`: the inner `SELECT … WHERE s2.hostel_id = s.hostel_id` refers to the outer row's `s.hostel_id`, so it is (logically) re-evaluated per outer row. The KPI query's `(SELECT AVG(score) FROM rating)` is non-correlated: it is evaluated once.

**Q16. Explain the recursive CTE.**
The **anchor** selects people I directly trust (edges with avg ≥ 4.5 from me). The **recursive term** joins the current frontier to trust edges to reach the next ring. It terminates because of the depth limit (`hops < p_max_depth`) and the cycle check (`NOT dst = ANY(path)`). `DISTINCT ON (node) … ORDER BY node, hops` keeps the shortest path to each person.

**Q17. RANK vs DENSE_RANK vs ROW_NUMBER?**
For scores 95, 91, 91, 90: RANK gives 1,2,2,**4**; DENSE_RANK gives 1,2,2,**3**; ROW_NUMBER gives 1,2,3,4 (arbitrary tiebreak). The leaderboard uses DENSE_RANK so ties don't leave gaps. `top_routes_by_weekday` uses RANK so a tie for 3rd can show 4 rows.

**Q18. How does `ride_buddies` avoid counting each pair twice?**
Self-join `ride_member a JOIN ride_member b ON a.ride_id = b.ride_id AND a.student_id < b.student_id`. The `<` keeps one ordering per pair and also excludes self-pairs.

**Q19. What's the Bayesian average and why use it?**
`(C·m + Σscores)/(C + n)` with m = campus mean and C = 5. It behaves as if everyone starts with 5 average ratings. One lucky 5★ can't beat fifty 4.8★s. The leaderboard shows raw-average rank next to trust rank to prove it.

### Performance

**Q20. Why did you create an index on `ride_member(student_id)` when there's already a PK?**
The PK is `(ride_id, student_id)`. A B-tree is ordered by its **leading** column, so it can't efficiently answer "all rides of student X". PostgreSQL also does **not** auto-index FK columns.

**Q21. What's a partial index and where do you use one?**
`ride_completed_idx ON ride(completed_at) WHERE status = 'completed'` indexes only completed rides, because only those are ever rated or trended. It's smaller and cheaper to maintain, and the planner uses it when the query repeats the predicate.

**Q22. EXPLAIN shows a Seq Scan for some queries. Is your index useless?**
No. With ~500 rides the whole table fits in a few pages, so a sequential scan is cheaper than random index lookups. The planner is cost-based. Pending ratings (selective by student) does use `ride_member_student_idx`; the API test asserts this.

**Q23. Materialized view vs view?**
A view is a stored *query*, recomputed on every read, so it's always fresh. A materialized view is a stored *result*: fast to read but stale until refreshed. `REFRESH … CONCURRENTLY` lets reads continue during the refresh, but it requires a UNIQUE index, so it can diff old vs new rows by key.

### Application & security

**Q24. How do you prevent SQL injection?**
(1) Every value is a **bind parameter** (`$1`, `$2`) sent separately from the SQL text. (2) The analytics endpoint only runs **whitelisted named queries** from the SQL file. (3) Integer params are validated before binding. A test sends `1; DROP TABLE rating` and expects 400.

**Q25. Can a student rate as someone else?**
No. The rater comes from the acting-user header (later, Member 1's session), never from the request body.

**Q26. How did you get 500+ records?**
`server/scripts/seed.js` is a deterministic generator (seeded PRNG, so everyone gets identical data). It produces ~10,500 rows with realistic patterns: weekday/hour/semester demand, friend circles, flaky students with more no-shows (who then receive lower ratings and "Late" tags), and late payers. It inserts **through** all constraints and triggers, so seeding itself is an integrity test.

**Q27. What would you change at 1 lakh students?**
Refresh the MV on a schedule (or incrementally); partition `rating_audit` by month; precompute trust edges into a table maintained by trigger instead of aggregating in the recursive CTE; add a covering index for the leaderboard filter.
