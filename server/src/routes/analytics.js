// /api/analytics: every named query of every module (the SQL library and all dashboards).
//   GET  /api/analytics?module=payments    catalogue
//   GET  /api/analytics/:name?param=…      run one query (rows + exact SQL + timing)
//   GET  /api/analytics/:name/explain      EXPLAIN ANALYZE in a read-only, rolled-back transaction
//   POST /api/analytics/refresh            REFRESH MATERIALIZED VIEW CONCURRENTLY (Member 5)
// A query parameter called "me" is ALWAYS the logged-in student: any ?me= in the URL is ignored.
import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { queries, runNamed, explainNamed } from '../analytics.js';
import { MODULES } from '../queries.js';

const router = Router();
router.use(requireAuth);
const input = (req) => ({ ...req.query, me: req.studentId });

router.get('/', (req, res) => {
  const mod = req.query.module;
  res.json([...queries().values()].filter((q) => !mod || q.module === mod)
    .map(({ name, module, title, concepts, params, sql }) => ({ name, module, title, concepts, params, sql })));
});

router.get('/modules', (_req, res) => {
  const counts = {};
  for (const q of queries().values()) counts[q.module] = (counts[q.module] || 0) + 1;
  res.json(Object.values(MODULES).map((m) => ({ ...m, queries: counts[m.id] || 0 })));
});

router.post('/refresh', async (_req, res) => {
  const t0 = Date.now();
  const { rows } = await pool.query('SELECT fn_refresh_reputation() AS refreshed_at');
  res.json({ refreshedAt: rows[0].refreshed_at, ms: Date.now() - t0 });
});

router.get('/:name', async (req, res) => res.json(await runNamed(req.params.name, input(req))));
router.get('/:name/explain', async (req, res) => res.json(await explainNamed(req.params.name, input(req))));

export default router;
