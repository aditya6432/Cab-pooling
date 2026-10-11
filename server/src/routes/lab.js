// /api/lab: the Integrity Lab for all five modules (81 scenarios).
// ---------------------------------------------------------------------
// Each scenario fires real SQL at PostgreSQL (often straight INSERT/UPDATE
// statements that bypass the API) and shows which mechanism rejects it:
// CHECK, FOREIGN KEY, PRIMARY KEY / UNIQUE, EXCLUDE, a trigger, a deferred
// constraint trigger or a stored function. Every scenario runs inside a
// transaction that is ALWAYS rolled back, so the lab never changes data and
// can be demoed any number of times. The one exception is Member 4's
// two-session race, which needs two real connections and a COMMIT; it cleans
// up after itself through the normal payment state machine.
// ---------------------------------------------------------------------
import { Router } from 'express';
import { inSandbox, pool } from '../db.js';
import { HttpError } from '../errors.js';
import { requireAuth } from '../auth.js';
import { adapt } from '../lab/adapter.js';
import { SCENARIOS as M1 } from '../lab/m1_users_rides.js';
import { BOOKING_SCENARIOS as M2 } from '../lab/m2_booking.js';
import { EXPENSE_SCENARIOS as M3, labContext } from '../lab/m3_expenses.js';
import { PAYMENT_SCENARIOS as M4 } from '../lab/m4_payments.js';
import { RATINGS_SCENARIOS as M5, fixtures as ratingFixtures } from '../lab/m5_ratings.js';

const router = Router();
router.use(requireAuth);

// Members 1 and 2: a far-future day (31–58 days ahead) on which the acting student has
// no active ride, so each scenario fails only for the reason it demonstrates.
async function freeDay(c, actor) {
  const { rows } = await c.query(
    `SELECT d FROM generate_series(31, 58) d
     WHERE NOT EXISTS (SELECT 1 FROM ride_member m JOIN ride r USING (ride_id)
                       WHERE m.student_id = $1 AND m.status = 'confirmed' AND r.status IN ('open','full','departed')
                         AND r.depart_start < now() + make_interval(days => d + 2) AND r.depart_end > now() + make_interval(days => d - 1))
     ORDER BY d LIMIT 1`, [actor]);
  if (!rows.length) throw new HttpError(409, 'No free day found for the lab: cancel some far-future rides first');
  return [actor, rows[0].d];
}
async function expenseContext(c, _actor, sc) {
  const ctx = await labContext(c);
  if (!ctx || !ctx.outsider || (sc.needs && !ctx[sc.needs])) throw new HttpError(409, 'The demo data this scenario needs is missing. Re-seed with npm run db:setup.');
  return [ctx];
}

export const ALL = [
  ...adapt(M1, { module: 'users-rides', prefix: 'u_', context: freeDay }),
  ...adapt(M2, { module: 'booking', prefix: 'b_', context: freeDay }),
  ...adapt(M3, { module: 'expenses', prefix: 'e_', context: expenseContext }),
  ...M4.map((s) => ({ ...s, module: 'payments' })),
  ...M5.map((s) => ({ ...s, id: `r_${s.id}`, module: 'ratings', fixtures: ratingFixtures })),
];
{
  const ids = new Set();
  for (const s of ALL) { if (ids.has(s.id)) throw new Error(`Duplicate lab scenario id ${s.id}`); ids.add(s.id); }
}

// verdict: did the database behave as the scenario expects?
function verdict(sc, steps) {
  const failed = steps.find((s) => s.ok === false);
  if (sc.check) return { passed: sc.check(steps), error: failed?.error || null };
  if (sc.expect === 'accept') return { passed: !failed, error: failed?.error || null };
  return { passed: Boolean(failed) && (sc.rule === 'ACID' || failed.error.rule === sc.rule), error: failed?.error || null };
}

router.get('/scenarios', (req, res) => {
  const mod = req.query.module;
  res.json(ALL.filter((s) => !mod || s.module === mod)
    .map(({ id, module, group, title, story, expect, rule, commits, expectConstraint, expectState }) =>
      ({ id, module, group, title, story, expect, rule, commits: Boolean(commits), expectConstraint: expectConstraint ?? null, expectState: expectState ?? null })));
});

router.post('/scenarios/:id/run', async (req, res) => {
  const sc = ALL.find((s) => s.id === req.params.id);
  if (!sc) throw new HttpError(404, `Unknown scenario ${req.params.id}`);
  const actor = req.studentId;
  const t0 = Date.now();
  const steps = sc.commits
    ? await sc.runLive({ pool, actor })                                   // two real sessions + COMMIT
    : await inSandbox((c) => sc.run(c, sc.fixtures ? sc.fixtures(c, actor) : null, actor));
  res.json({ id: sc.id, module: sc.module, title: sc.title, expect: sc.expect, rule: sc.rule, steps,
    ...verdict(sc, steps), rolledBack: !sc.commits, ms: Date.now() - t0 });
});

export default router;
