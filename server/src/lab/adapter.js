// Turns the Integrity Lab scenarios of Members 1, 2 and 3 (lists of SQL strings
// that must fail with a given constraint / SQLSTATE, or succeed) into the shared
// lab format used by Members 4 and 5: each statement runs as one `step` under a
// SAVEPOINT inside a transaction that is always rolled back, and the verdict
// compares what PostgreSQL said with what the scenario expects.
import { RULES } from '../errors.js';
import { step } from './common.js';

// plain-English meaning for the few rules whose catalogue entry deliberately has no text
// (the API shows PostgreSQL's own message for them, because it contains the numbers)
const MEANING = {
  rule_seat_capacity: "The confirmed seats on a ride can never exceed the cab's capacity.",
  rule_ride_not_bookable: 'Only open rides can be booked.',
  rule_member_status_flow: 'A booking moves only confirmed → cancelled / no-show, or cancelled → confirmed.',
  rule_request_flow: 'A join request moves only from pending to accepted, rejected or withdrawn.',
};

function storyFor(sc) {
  if (sc.expectState === '42501') {
    return 'Authorisation lives in the database too: the stored function checks who is calling and raises SQLSTATE 42501 (insufficient privilege), which the API maps to HTTP 403.';
  }
  if (!sc.expect) return 'Valid input: every rule passes, the database accepts it, and the transaction is then rolled back so nothing is saved.';
  const r = RULES[sc.expect];
  return r ? `${r.text || MEANING[sc.expect] || 'PostgreSQL refuses it.'} Enforced by a ${r.mechanism.toLowerCase()} (${sc.expect}), not by application code.`
    : `PostgreSQL must refuse this with ${sc.expect}.`;
}

/**
 * @param list      the module's scenario array ({ id, group, title, rule, expect, expectState, steps })
 * @param module    module id ('users-rides' | 'booking' | 'expenses')
 * @param prefix    id prefix that keeps ids unique across modules
 * @param context   async (client, actor) => array of arguments for sc.steps(...)
 */
export function adapt(list, { module, prefix, context }) {
  return list.map((sc) => ({
    id: `${prefix}${sc.id}`,
    module,
    group: sc.group,
    title: sc.title,
    rule: sc.rule && sc.rule !== '-' ? sc.rule : null,
    expect: sc.expect || sc.expectState ? 'reject' : 'accept',
    expectConstraint: sc.expect ?? null,
    expectState: sc.expectState ?? null,
    story: storyFor(sc),
    async run(c, _fixtures, actor) {
      const sqls = sc.steps(...(await context(c, actor, sc)));
      const out = [];
      for (const sql of sqls) {
        const s = await step(c, sql);
        out.push(s);
        if (!s.ok) break;            // the scenario stops at the first rejection, like the original module lab
      }
      return out;
    },
    check(steps) {
      const failed = steps.find((s) => s.ok === false);
      if (sc.expectState) return Boolean(failed) && failed.error.sqlstate === sc.expectState;
      if (sc.expect) return Boolean(failed) && failed.error.constraint === sc.expect;
      return !failed;
    },
  }));
}
