// =====================================================================
// Translates PostgreSQL errors into clear API responses, for all modules.
// The API deliberately does NOT re-implement business rules in JavaScript:
// the database is the single enforcer (constraints + triggers + functions),
// and this file only reports WHICH database mechanism rejected a request,
// WHICH business rule that is, and WHY.
//
// Every module raises trigger-rule violations the same way:
//   RAISE EXCEPTION ... USING ERRCODE = '23514', CONSTRAINT = 'rule_...'
// so a trigger rule and a declarative CHECK are reported identically.
// =====================================================================
import { USERS_RIDES_RULES } from './rules/m1_users_rides.js';
import { BOOKING_RULES } from './rules/m2_booking.js';
import { EXPENSE_RULES } from './rules/m3_expenses.js';
import { PAYMENTS_RULES } from './rules/m4_payments.js';
import { RATINGS_RULES } from './rules/m5_ratings.js';

const CATALOGUES = [
  ['M1', USERS_RIDES_RULES], ['M2', BOOKING_RULES], ['M3', EXPENSE_RULES], ['M4', PAYMENTS_RULES], ['M5', RATINGS_RULES],
];

// constraint / rule name → { rule, mechanism, text, module, status? }
export const RULES = {};
for (const [module, cat] of CATALOGUES) {
  for (const [name, r] of Object.entries(cat)) {
    if (RULES[name]) throw new Error(`Rule "${name}" is defined by both ${RULES[name].module} and ${module}`);
    RULES[name] = { ...r, module };
  }
}

const PG = {
  '23514': { status: 422, kind: 'CHECK violation' },
  '23503': { status: 422, kind: 'FOREIGN KEY violation' },
  '23505': { status: 409, kind: 'UNIQUE / PRIMARY KEY violation' },
  '23P01': { status: 409, kind: 'EXCLUDE constraint violation' },
  '23502': { status: 422, kind: 'NOT NULL violation' },
  '42501': { status: 403, kind: 'Not allowed' },
  '22P02': { status: 400, kind: 'Invalid data type' },
  '22003': { status: 400, kind: 'Numeric value out of range' },
  '22007': { status: 400, kind: 'Invalid date/time' },
  '22008': { status: 400, kind: 'Invalid date/time' },
  '22001': { status: 400, kind: 'Value too long' },
  'P0002': { status: 404, kind: 'Not found' },
};

export function describePgError(err) {
  const base = PG[err?.code];
  if (!base) return null;
  const rule = err.constraint ? RULES[err.constraint] : undefined;
  const isTrigger = /^(Trigger|Deferred|Function|Stored)/.test(rule?.mechanism || '');
  return {
    status: rule?.status || base.status,
    body: {
      error: {
        message: rule?.text || err.message,       // human sentence (rule text, or the DB's own when it has numbers)
        kind: isTrigger ? 'Trigger rule violation' : base.kind,
        sqlstate: err.code,
        constraint: err.constraint || null,
        table: err.table || null,
        detail: err.detail || null,
        rule: rule?.rule || null,
        module: rule?.module || null,
        mechanism: rule?.mechanism || base.kind,
        explanation: rule?.text || null,
        dbMessage: err.message,                    // exactly what PostgreSQL said
      },
    },
  };
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Express error handler (Express 5 forwards rejected promises here)
export function errorHandler(err, _req, res, _next) {
  const pgErr = describePgError(err);
  if (pgErr) {
    if (err.failedItem !== undefined) {
      pgErr.body.error.failedItem = err.failedItem;
      pgErr.body.error.rolledBack = true;
    }
    return res.status(pgErr.status).json(pgErr.body);
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { message: 'Malformed JSON body', kind: 'Request error' } });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: { message: status >= 500 ? 'Internal server error' : err.message, kind: 'Request error' } });
}
