// The five team modules (+ the cross-module layer), as the UI names them.
export const MODULES = [
  { id: 'users-rides', member: 'Member 1', label: 'Users + rides', short: 'Rides', file: 'db/queries/m1_users_rides.sql' },
  { id: 'booking', member: 'Member 2', label: 'Booking + seats', short: 'Booking', file: 'db/queries/m2_booking.sql' },
  { id: 'expenses', member: 'Member 3', label: 'Expense splitting', short: 'Expenses', file: 'db/queries/m3_expenses.sql' },
  { id: 'payments', member: 'Member 4', label: 'Payments + settlement', short: 'Payments', file: 'db/queries/m4_payments.sql' },
  { id: 'ratings', member: 'Member 5', label: 'Ratings + analytics', short: 'Ratings', file: 'db/queries/m5_ratings_analytics.sql' },
  { id: 'integration', member: 'Whole team', label: 'Cross-module', short: 'Cross-module', file: 'db/queries/x_integration.sql' },
];
export const moduleById = Object.fromEntries(MODULES.map((m) => [m.id, m]));
export const memberOf = (id) => moduleById[id]?.member ?? '';
