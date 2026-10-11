// Member 3 (Expense splitting): constraint / trigger name -> rule id, mechanism, text.
// A rule may carry its own HTTP status (E19 is an authorisation failure -> 403).
export const EXPENSE_RULES = {
  expense_amount_positive:      { rule: 'E1',  mechanism: 'CHECK constraint',   text: 'Amount must be greater than zero.' },
  expense_amount_cap:           { rule: 'E2',  mechanism: 'CHECK constraint',   text: 'A single expense can be at most ₹50,000.' },
  expense_note_not_blank:       { rule: 'E3',  mechanism: 'CHECK constraint',   text: 'Please add a short description.' },
  expense_split_type_valid:     { rule: 'E4',  mechanism: 'CHECK constraint',   text: 'Split must be equal, seats, exact or percent.' },
  expense_payer_on_ride:        { rule: 'E5',  mechanism: 'FOREIGN KEY',        text: 'You are not a member of this ride.' },
  rule_expense_ride_state:      { rule: 'E6',  mechanism: 'Trigger',            text: 'Expenses can only be added once the ride has departed.' },
  rule_expense_payer_confirmed: { rule: 'E7',  mechanism: 'Trigger',            text: 'Only a confirmed rider can pay for the ride.' },
  rule_share_confirmed_member:  { rule: 'E8',  mechanism: 'Trigger',            text: 'Only confirmed riders of this ride can be in the split.' },
  expense_share_pkey:           { rule: 'E9',  mechanism: 'PRIMARY KEY',        text: 'The same person was added to the split twice.' },
  expense_share_student_id_fkey:{ rule: 'E10', mechanism: 'FOREIGN KEY',        text: 'Unknown student in the split.' },
  expense_share_nonneg:         { rule: 'E11', mechanism: 'CHECK constraint',   text: 'A share cannot be negative.' },
  rule_split_needs_people:      { rule: 'E12', mechanism: 'Function check',     text: 'Choose at least one person to split with.' },
  rule_split_weights:           { rule: 'E13', mechanism: 'Function check',     text: 'Give a valid, non-negative split value for every person.' },
  rule_split_exact_sum:         { rule: 'E14', mechanism: 'Function check',     text: 'Exact amounts must add up to the expense amount.' },
  rule_split_percent_sum:       { rule: 'E15', mechanism: 'Function check',     text: 'Percentages must add up to 100.' },
  rule_shares_sum_to_amount:    { rule: 'E16', mechanism: 'Deferred trigger',   text: 'Shares must add up to the expense amount.' },
  rule_expense_immutable:       { rule: 'E17', mechanism: 'Trigger',            text: 'Expenses cannot be edited; delete and re-add.' },
  rule_expense_locked:          { rule: 'E18', mechanism: 'Trigger',            text: 'Payments were already recorded for this ride, so its expenses are locked.' },
  rule_expense_owner_only:      { rule: 'E19', mechanism: 'Function check',     text: 'Only the person who paid can delete this expense.', status: 403 },
};
