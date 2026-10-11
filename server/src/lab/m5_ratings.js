// Integrity Lab: Ratings scenarios (Member 5).
// Each scenario fires real SQL at PostgreSQL inside BEGIN … ROLLBACK and shows
// which mechanism (CHECK, FK, PK, trigger) rejects it. Fixtures are discovered
// live from the database, so the lab keeps working after you use the app.
import { HttpError } from '../errors.js';
import { step } from './common.js';

const INSERT = `INSERT INTO rating (ride_id, rater_id, ratee_id, score, comment) VALUES ($1, $2, $3, $4, $5)`;
const SUBMIT = `SELECT ride_id, rater_id, ratee_id, score FROM fn_submit_rating($1::int, $2::char(13), $3::char(13), $4::smallint, $5::text, $6::smallint[])`;

// ---------- live fixtures ----------
export function fixtures(c, actor) {
  const one = async (sql, params, what) => {
    const { rows } = await c.query(sql, params);
    if (!rows[0]) throw new HttpError(409, `No suitable data found for this scenario (${what}). Re-seed with npm run db:setup.`);
    return rows[0];
  };
  return {
    // a rater with unrated co-riders on a completed ride inside the window
    fresh: () => one(`
      SELECT r.ride_id, a.student_id AS rater, array_agg(b.student_id::TEXT ORDER BY b.student_id) AS ratees
      FROM ride r
      JOIN ride_member a ON a.ride_id = r.ride_id AND a.status = 'confirmed'
      JOIN ride_member b ON b.ride_id = r.ride_id AND b.status = 'confirmed' AND b.student_id <> a.student_id
      WHERE r.status = 'completed' AND now() <= r.completed_at + fn_rating_window()
        AND NOT EXISTS (SELECT 1 FROM rating x
                        WHERE (x.ride_id, x.rater_id, x.ratee_id) = (r.ride_id, a.student_id, b.student_id))
      GROUP BY r.ride_id, a.student_id
      ORDER BY (a.student_id = $1) DESC, count(*) DESC, r.completed_at DESC
      LIMIT 1`, [actor], 'unrated co-riders'),
    outsider: (rideId) => one(`
      SELECT student_id FROM student s
      WHERE NOT EXISTS (SELECT 1 FROM ride_member m WHERE m.ride_id = $1 AND m.student_id = s.student_id)
      ORDER BY student_id LIMIT 1`, [rideId], 'outsider'),
    open: () => one(`
      SELECT r.ride_id, r.status, a.student_id AS rater, b.student_id AS ratee
      FROM ride r
      JOIN ride_member a ON a.ride_id = r.ride_id AND a.status = 'confirmed'
      JOIN ride_member b ON b.ride_id = r.ride_id AND b.status = 'confirmed' AND b.student_id <> a.student_id
      WHERE r.status IN ('open', 'full')
      ORDER BY (a.student_id = $1) DESC, r.depart_start LIMIT 1`, [actor], 'upcoming ride'),
    expired: () => one(`
      SELECT r.ride_id, r.completed_at, a.student_id AS rater, b.student_id AS ratee
      FROM ride r
      JOIN ride_member a ON a.ride_id = r.ride_id AND a.status = 'confirmed'
      JOIN ride_member b ON b.ride_id = r.ride_id AND b.status = 'confirmed' AND b.student_id <> a.student_id
      WHERE r.status = 'completed' AND now() > r.completed_at + fn_rating_window()
        AND NOT EXISTS (SELECT 1 FROM rating x WHERE (x.ride_id, x.rater_id, x.ratee_id) = (r.ride_id, a.student_id, b.student_id))
      ORDER BY (a.student_id = $1) DESC, r.completed_at DESC LIMIT 1`, [actor], 'expired ride'),
    noShow: () => one(`
      SELECT r.ride_id, a.student_id AS rater, b.student_id AS ratee
      FROM ride r
      JOIN ride_member a ON a.ride_id = r.ride_id AND a.status = 'confirmed'
      JOIN ride_member b ON b.ride_id = r.ride_id AND b.status = 'no_show'
      WHERE r.status = 'completed'
      ORDER BY (a.student_id = $1) DESC, r.completed_at DESC LIMIT 1`, [actor], 'no-show'),
    oldRating: () => one(`
      SELECT ride_id, rater_id, ratee_id, score, created_at FROM rating
      WHERE now() > created_at + fn_edit_window()
      ORDER BY (rater_id = $1) DESC, created_at DESC LIMIT 1`, [actor], 'rating older than 24 h'),
    ratedRide: () => one(`
      SELECT r.ride_id, count(x.*) AS ratings FROM ride r JOIN rating x ON x.ride_id = r.ride_id
      WHERE r.status = 'completed' GROUP BY r.ride_id ORDER BY r.ride_id DESC LIMIT 1`, [], 'rated ride'),
    tagIds: async () => {
      const { rows } = await c.query('SELECT tag_id, label, sentiment FROM rating_tag ORDER BY tag_id');
      return {
        positive: rows.filter((t) => t.sentiment === 'positive').map((t) => t.tag_id),
        negative: rows.filter((t) => t.sentiment === 'negative').map((t) => t.tag_id),
        byId: Object.fromEntries(rows.map((t) => [t.tag_id, t.label])),
      };
    },
  };
}

// ---------- scenarios ----------
export const RATINGS_SCENARIOS = [
  {
    id: 'control', group: 'Control', expect: 'accept', rule: null,
    title: 'A valid rating is accepted',
    story: 'Rate a real co-rider on a completed ride, inside the 7-day window, with two positive tags. The function inserts the rating and its tags atomically, and the audit trigger writes a history row.',
    async run(c, f) {
      const p = await f.fresh(); const t = await f.tagIds();
      const s1 = await step(c, SUBMIT, [p.ride_id, p.rater, p.ratees[0], 5, 'Super punctual, great company!', t.positive.slice(0, 2)]);
      const s2 = await step(c, `SELECT action, new_score, changed_at FROM rating_audit WHERE ride_id = $1 AND rater_id = $2 AND ratee_id = $3`,
        [p.ride_id, p.rater, p.ratees[0]]);
      return [s1, s2];
    },
  },
  {
    id: 'self', group: 'Declarative constraints', expect: 'reject', rule: 'BR2',
    title: 'Rate yourself',
    story: 'A plain INSERT straight into the table, bypassing the API. The CHECK (rater_id <> ratee_id) constraint rejects it.',
    async run(c, f) { const p = await f.fresh(); return [await step(c, INSERT, [p.ride_id, p.rater, p.rater, 5, null])]; },
  },
  {
    id: 'outsider', group: 'Declarative constraints', expect: 'reject', rule: 'BR3',
    title: 'Rate someone who was not on the ride',
    story: 'The ratee exists as a student but never travelled on this ride. The composite FOREIGN KEY (ride_id, ratee_id) → ride_member rejects it with no trigger or application code involved.',
    async run(c, f) { const p = await f.fresh(); const o = await f.outsider(p.ride_id); return [await step(c, INSERT, [p.ride_id, p.rater, o.student_id, 4, null])]; },
  },
  {
    id: 'range', group: 'Declarative constraints', expect: 'reject', rule: 'BR1',
    title: 'Give 6 stars',
    story: 'Scores live in a SMALLINT column with CHECK (score BETWEEN 1 AND 5).',
    async run(c, f) { const p = await f.fresh(); return [await step(c, INSERT, [p.ride_id, p.rater, p.ratees[0], 6, null])]; },
  },
  {
    id: 'low_comment', group: 'Declarative constraints', expect: 'reject', rule: 'BR5',
    title: '1★ with no explanation',
    story: 'Business rule: harsh ratings must be justified. CHECK (score >= 3 OR length(trim(comment)) >= 10).',
    async run(c, f) { const p = await f.fresh(); return [await step(c, INSERT, [p.ride_id, p.rater, p.ratees[0], 1, null])]; },
  },
  {
    id: 'duplicate', group: 'Declarative constraints', expect: 'reject', rule: 'BR4',
    title: 'Rate the same co-rider twice',
    story: 'The first INSERT succeeds; the second hits PRIMARY KEY (ride_id, rater_id, ratee_id).',
    async run(c, f) {
      const p = await f.fresh();
      return [await step(c, INSERT, [p.ride_id, p.rater, p.ratees[0], 4, null]),
              await step(c, INSERT, [p.ride_id, p.rater, p.ratees[0], 2, 'Changed my mind about this one'])];
    },
  },
  {
    id: 'not_completed', group: 'Trigger rules', expect: 'reject', rule: 'BR8',
    title: 'Rate before the ride happens',
    story: 'Both people are booked on an upcoming ride. The BEFORE INSERT trigger looks up ride.status, which is in a different table, so a CHECK constraint could not do this.',
    async run(c, f) { const p = await f.open(); return [await step(c, INSERT, [p.ride_id, p.rater, p.ratee, 5, null])]; },
  },
  {
    id: 'window', group: 'Trigger rules', expect: 'reject', rule: 'BR10',
    title: 'Rate after the 7-day window',
    story: 'The ride finished more than 7 days ago. The trigger compares the submission time with ride.completed_at + fn_rating_window().',
    async run(c, f) { const p = await f.expired(); return [await step(c, INSERT, [p.ride_id, p.rater, p.ratee, 4, null])]; },
  },
  {
    id: 'no_show', group: 'Trigger rules', expect: 'reject', rule: 'BR9',
    title: 'Rate a no-show',
    story: 'The ratee booked a seat but never turned up (ride_member.status = no_show). The FK passes because they are a member, but the trigger rejects it because they never travelled.',
    async run(c, f) { const p = await f.noShow(); return [await step(c, INSERT, [p.ride_id, p.rater, p.ratee, 1, 'Never showed up at the gate at all'])]; },
  },
  {
    id: 'max_tags', group: 'Trigger rules', expect: 'reject', rule: 'BR13',
    title: 'Attach 4 tags (and check the rating was NOT saved)',
    story: 'fn_submit_rating inserts the rating and then its tags. The 4th tag trips the trigger, and because the function is atomic the rating itself is undone too. The follow-up SELECT proves it.',
    async run(c, f) {
      const p = await f.fresh(); const t = await f.tagIds();
      return [await step(c, SUBMIT, [p.ride_id, p.rater, p.ratees[0], 5, null, t.positive.slice(0, 4)]),
              await step(c, `SELECT count(*) AS ratings_saved FROM rating WHERE ride_id = $1 AND rater_id = $2 AND ratee_id = $3`,
                [p.ride_id, p.rater, p.ratees[0]])];
    },
  },
  {
    id: 'sentiment', group: 'Trigger rules', expect: 'reject', rule: 'BR14',
    title: '5★ tagged "Late"',
    story: 'A negative tag on a perfect score is contradictory. The tag trigger reads the parent rating\'s score, which it locks with FOR UPDATE.',
    async run(c, f) {
      const p = await f.fresh(); const t = await f.tagIds();
      return [await step(c, SUBMIT, [p.ride_id, p.rater, p.ratees[0], 5, null, [t.negative[0]]])];
    },
  },
  {
    id: 'edit_window', group: 'Trigger rules', expect: 'reject', rule: 'BR11',
    title: 'Edit a rating after 24 hours',
    story: 'Ratings can be changed only within 24 h of submission. The BEFORE UPDATE trigger checks now() against created_at + fn_edit_window().',
    async run(c, f) {
      const p = await f.oldRating();
      return [await step(c, `UPDATE rating SET score = $4 WHERE ride_id = $1 AND rater_id = $2 AND ratee_id = $3`,
        [p.ride_id, p.rater_id, p.ratee_id, p.score === 5 ? 4 : 5])];
    },
  },
  {
    id: 'unrate_ride', group: 'Trigger rules', expect: 'reject', rule: 'BR15',
    title: 'Cancel a ride that already has ratings',
    story: 'This is a cross-module guard: a trigger on ride (Member 1\'s table) protects rating history (Member 5\'s data) from being orphaned.',
    async run(c, f) {
      const p = await f.ratedRide();
      return [await step(c, `UPDATE ride SET status = 'cancelled', completed_at = NULL WHERE ride_id = $1`, [p.ride_id])];
    },
  },
  {
    id: 'batch', group: 'Transactions', expect: 'reject', rule: 'ACID',
    title: 'Batch of 3 ratings where the last one is invalid → none are saved',
    story: 'This is exactly what POST /api/ratings/batch does. Two valid ratings succeed, then the third (a self-rating) fails, and ROLLBACK undoes all three. The counts before and after are identical: atomicity.',
    async run(c, f) {
      const p = await f.fresh();
      const count = `SELECT count(*) AS ratings_by_rater_on_ride FROM rating WHERE ride_id = $1 AND rater_id = $2`;
      const before = await step(c, count, [p.ride_id, p.rater]);
      await c.query('SAVEPOINT batch');
      const items = [
        [p.ride_id, p.rater, p.ratees[0], 5, 'Great ride, very friendly', []],
        ...(p.ratees[1] ? [[p.ride_id, p.rater, p.ratees[1], 4, null, []]] : []),
        [p.ride_id, p.rater, p.rater, 5, null, []],
      ];
      const steps = [{ sql: 'BEGIN;', ok: true, note: 'transaction starts' }];
      for (const it of items) {
        const s = await step(c, SUBMIT, it);
        steps.push(s);
        if (!s.ok) break;
      }
      await c.query('ROLLBACK TO SAVEPOINT batch');
      steps.push({ sql: 'ROLLBACK;', ok: true, note: 'any failure → whole batch undone' });
      const after = await step(c, count, [p.ride_id, p.rater]);
      return [before, ...steps, after];
    },
  },
];
