# Viva prep: Expense splitting module (Member 3)

> Written at integration from Member 3's code (`db/12_m3_expense_schema.sql`, `db/22_m3_expense_logic.sql`, `db/32_m3_expense_views.sql`, `server/src/routes/expenses.js`, `server/src/lab/m3_expenses.js`).

## 3-minute demo

| Step | Do this | Say this |
|---|---|---|
| 1 | **Expenses** | "Net balance and balances with each friend come from `v_pairwise_balance`: shares are debt edges, confirmed payments (Member 4) are opposite edges, netted per pair." |
| 2 | Open a completed ride → **Add an expense**: ₹100 equally among 3 | "The live preview calls the same function that stores the shares, `fn_expense_shares`. ₹100 / 3 = 33.34 + 33.33 + 33.33: largest-remainder rounding in paise." |
| 3 | Switch to **Percent**, type 60 / 60 | "Refused by the function: rule E15, percentages must add up to 100. Nothing is written." |
| 4 | Add a valid expense, then try **Delete** as another student | "Only the payer may delete (E19 → HTTP 403). The audit trigger records create and delete with the actor." |
| 5 | Open a ride where money moved, try **Delete** | "Locked (E18): a trigger refuses deleting an expense once a payment was confirmed, or is pending, on that ride." |
| 6 | **Integrity Lab → M3** | "15 scenarios: ₹0, ₹99,999, an outsider paying, a no-show paying, an expense on an open ride, shares that don't add up (caught by the deferred trigger), editing an amount…" |

## Questions and answers

**Q1. Why is `expense_share` a weak entity?** A share exists only as part of its expense: its key is (expense_id, student_id) and it is deleted with the expense (ON DELETE CASCADE).

**Q2. Why does the expense reference `ride_member` and not `student`?** `FOREIGN KEY (ride_id, paid_by) REFERENCES ride_member (ride_id, student_id)`: the payer must have been on that ride. A plain FK to `student` could not express that.

**Q3. How do the shares always add up to the amount?** `fn_split_amount` works in paise: floor every proportional share, then give the leftover paise, one each, to the largest fractional parts (largest-remainder method). The sum is exact by construction; the deferred trigger double-checks it.

**Q4. Why a DEFERRABLE INITIALLY DEFERRED constraint trigger?** The expense row and its share rows are inserted one statement at a time. An immediate check after the expense row would see zero shares and fail. Deferred, it runs at COMMIT when every share exists. The lab forces it early with `SET CONSTRAINTS ALL IMMEDIATE` to show it firing.

**Q5. Why can't an expense be edited?** Changing the amount would silently invalidate every share and every payment computed from it. A trigger freezes ride, payer, amount and split type; to correct one you delete it (if no money moved) and add a new one. The note may change.

**Q6. Why does `expense_audit` have no foreign key?** History must outlive the row it describes: after a delete, the audit row still says who deleted what. A FK would cascade or block the delete.

**Q7. How does the delete guard tell a user delete from a cascade?** `pg_trigger_depth() > 1` means the delete was caused by another trigger or cascade (a ride being deleted); only direct deletes are guarded.

**Q8. What do the four split types do?** equal (weights 1), seats (weights = seats booked), exact (₹ values that must sum to the amount, E14), percent (must sum to 100, E15). All four go through one function, so the preview and the stored result can never differ.

**Q9. How does the module see payments?** Only through `v_settlement_flow`, which at integration became `payment WHERE status = 'confirmed'`. With that, `v_ride_ledger` (paid − owed + sent − received) equals Member 4's `v_ride_balance` for every row; invariant I8 proves it.

**Q10. What does `fn_simplify_debts` do?** Greedy min-cash-flow on one ride: repeatedly match the largest debtor with the largest creditor and transfer the smaller amount, so n people need at most n − 1 transfers. Member 4's `fn_settlement_plan` produces the same total; a test pays the suggested transfers through Member 4's state machine and checks that both ledgers reach zero.
