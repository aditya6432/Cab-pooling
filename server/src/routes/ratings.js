// /api/ratings — Workflow 1 (transactional rating) lives here.
import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { HttpError } from '../errors.js';
import { runNamed } from '../analytics.js';
import { requireAuth, actingStudent } from '../auth.js';

const router = Router();
// The rater is ALWAYS the logged-in student (Member 1's session), never a
// field of the request body, so a student can only rate AS THEMSELVES.
router.use(requireAuth);

function asTagArray(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) throw new HttpError(400, '"tags" must be an array of tag ids');
  return tags;
}

const SUBMIT_SQL = `SELECT * FROM fn_submit_rating($1::int, $2::char(13), $3::char(13), $4::smallint, $5::text, $6::smallint[])`;
const UPDATE_SQL = `SELECT * FROM fn_update_rating($1::int, $2::char(13), $3::char(13), $4::smallint, $5::text, $6::smallint[])`;

// GET /api/ratings/tags — tag vocabulary
router.get('/tags', async (_req, res) => {
  const { rows } = await pool.query('SELECT tag_id, label, sentiment FROM rating_tag ORDER BY sentiment DESC, tag_id');
  res.json(rows);
});

// GET /api/ratings/pending — co-riders the acting student still has to rate
router.get('/pending', async (req, res) => {
  const result = await runNamed('pending_ratings', { me: actingStudent(req) });
  res.json(result);
});

// POST /api/ratings — submit one rating (+ tags) atomically
router.post('/', async (req, res) => {
  const rater = actingStudent(req);
  const { rideId, rateeId, score, comment = null } = req.body || {};
  const { rows } = await pool.query(SUBMIT_SQL, [rideId, rater, rateeId, score, comment, asTagArray(req.body?.tags)]);
  res.status(201).json(rows[0]);
});

// POST /api/ratings/batch — rate several co-riders in ONE transaction.
// All-or-nothing: if any single rating breaks a rule, none are saved.
router.post('/batch', async (req, res) => {
  const rater = actingStudent(req);
  const items = req.body?.items;
  if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, '"items" must be a non-empty array');
  if (items.length > 6) throw new HttpError(400, 'At most 6 ratings per batch (largest cab has 6 seats)');

  const saved = await withTransaction(async (client) => {
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      try {
        const { rows } = await client.query(SUBMIT_SQL,
          [it.rideId, rater, it.rateeId, it.score, it.comment ?? null, asTagArray(it.tags)]);
        out.push(rows[0]);
      } catch (err) {
        err.failedItem = i;            // tell the UI which card failed
        throw err;                     // → withTransaction issues ROLLBACK
      }
    }
    return out;
  });
  res.status(201).json({ saved: saved.length, ratings: saved });
});

// PUT /api/ratings/:rideId/:rateeId — edit own rating (24-h window, trigger-enforced)
router.put('/:rideId/:rateeId', async (req, res) => {
  const rater = actingStudent(req);
  const { score, comment = null } = req.body || {};
  const { rows } = await pool.query(UPDATE_SQL,
    [req.params.rideId, rater, req.params.rateeId, score, comment, asTagArray(req.body?.tags)]);
  res.json(rows[0]);
});

// DELETE /api/ratings/:rideId/:rateeId — withdraw own rating (24-h window)
router.delete('/:rideId/:rateeId', async (req, res) => {
  const rater = actingStudent(req);
  const { rowCount } = await pool.query(
    'DELETE FROM rating WHERE ride_id = $1 AND rater_id = $2 AND ratee_id = $3',
    [req.params.rideId, rater, req.params.rateeId]);
  if (rowCount === 0) throw new HttpError(404, 'No such rating');
  res.status(204).end();
});

// GET /api/ratings/:rideId/:raterId/:rateeId/audit — trigger-written history
router.get('/:rideId/:raterId/:rateeId/audit', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT audit_id, action, old_score, new_score, old_comment, new_comment, changed_at
       FROM rating_audit
      WHERE ride_id = $1 AND rater_id = $2 AND ratee_id = $3
      ORDER BY changed_at, audit_id`,
    [req.params.rideId, req.params.raterId, req.params.rateeId]);
  res.json(rows);
});

export default router;
