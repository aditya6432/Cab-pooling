// /api/database: the schema explained by the database itself (system catalogs).
// Used by the "Database" page so that, in the viva, every table, constraint,
// trigger, index, view and function can be shown live, grouped by module.
import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';

const router = Router();
router.use(requireAuth);

// which member owns which table (mirrors the db/1x_mN_*.sql files)
export const TABLE_MODULE = {
  hostel: 'users-rides', student: 'users-rides', auth_session: 'users-rides', location: 'users-rides',
  cab_type: 'users-rides', ride: 'users-rides', ride_stop: 'users-rides', ride_status_log: 'users-rides',
  ride_member: 'booking', ride_booking_policy: 'booking', booking_request: 'booking', ride_waitlist: 'booking', booking_event: 'booking',
  expense: 'expenses', expense_share: 'expenses', expense_audit: 'expenses',
  payment_method: 'payments', payment_transition: 'payments', payment: 'payments', payment_event: 'payments', payment_reminder: 'payments',
  rating: 'ratings', rating_tag: 'ratings', rating_tag_map: 'ratings', rating_audit: 'ratings',
};
// role of each table in the design (justifies the relation count in the design document)
export const TABLE_ROLE = {
  hostel: 'reference', location: 'reference', cab_type: 'reference', rating_tag: 'reference', payment_transition: 'reference',
  ride_status_log: 'history', booking_event: 'history', expense_audit: 'history', payment_event: 'history', rating_audit: 'history',
  auth_session: 'support',
};

const MODULE_OF_NAME = [
  [/^(fn_(haversine|route_km|estimate_fare|seats_left|create_ride|search_rides)|trg_(student|ride_validate|ride_creator|ride_status|ride_frozen|stop))/, 'users-rides'],
  [/^(fn_(seeding|ride_path|check_segment|promote_waitlist|book_seat|cancel_booking|require_creator|remove_rider|leave_waitlist|withdraw_request|decide_request|set_join_mode|start_ride|complete_ride|mark_no_show)|trg_(member|ride_lifecycle|pre_booking|waitlist|request|event))/, 'booking'],
  [/^(fn_(split_amount|expense_shares|add_expense|delete_expense|simplify_debts)|trg_(expense|share))/, 'expenses'],
  [/^(fn_(payment|reversal|reminder|actor|record_payment|transition_payment|expire|settlement_plan|net_off|set_default_vpa)|trg_(payment|offset|reminder))/, 'payments'],
  [/^(fn_(rating|edit_window|bayesian|trust|submit_rating|update_rating|pending_ratings|refresh_reputation)|trg_(rating|protect))/, 'ratings'],
  [/^fn_integrity/, 'integration'],
];
const moduleOfRoutine = (name) => MODULE_OF_NAME.find(([re]) => re.test(name))?.[1] ?? 'other';
const VIEW_MODULE = {
  v_ride_board: 'users-rides', v_student_ride_stats: 'users-rides',
  v_ride_occupancy: 'booking', v_ride_manifest: 'booking', v_waitlist_position: 'booking', v_student_booking_stats: 'booking',
  v_settlement_flow: 'expenses', v_expense_detail: 'expenses', v_ride_ledger: 'expenses', v_debt_edge: 'expenses', v_pairwise_balance: 'expenses',
  v_ride_balance: 'payments', v_student_money: 'payments', v_payment_detail: 'payments',
  v_ride_summary: 'ratings', v_student_activity: 'ratings', v_student_reputation: 'ratings', mv_student_reputation: 'ratings',
  v_student_overview: 'integration',
};

router.get('/overview', async (_req, res) => {
  const tables = Object.keys(TABLE_MODULE);
  const [counts, tableMeta, constraints, partialUnique, triggers, indexes, views, routines, integrity] = await Promise.all([
    pool.query(tables.map((t) => `SELECT '${t}' AS name, count(*)::int AS rows FROM ${t}`).join(' UNION ALL ')),
    pool.query(`
      SELECT c.relname AS name,
             (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped)::int AS columns,
             pg_total_relation_size(c.oid)::bigint AS bytes,
             obj_description(c.oid) AS comment
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`),
    pool.query(`
      SELECT k.conname AS name, t.relname AS "table", k.contype AS type,
             pg_get_constraintdef(k.oid) AS definition, k.condeferrable AS deferrable
      FROM pg_constraint k JOIN pg_class t ON t.oid = k.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND t.relkind = 'r'
      ORDER BY t.relname, k.contype, k.conname`),
    pool.query(`
      SELECT i.relname AS name, t.relname AS "table", pg_get_indexdef(x.indexrelid) AS definition
      FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND x.indisunique AND x.indpred IS NOT NULL`),
    pool.query(`
      SELECT tg.tgname AS name, t.relname AS "table", p.proname AS function,
             pg_get_triggerdef(tg.oid) AS definition,
             (tg.tgconstraint <> 0) AS is_constraint_trigger, tg.tgdeferrable AS deferrable
      FROM pg_trigger tg JOIN pg_class t ON t.oid = tg.tgrelid JOIN pg_proc p ON p.oid = tg.tgfoid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND NOT tg.tgisinternal
      ORDER BY t.relname, tg.tgname`),
    pool.query(`
      SELECT i.relname AS name, t.relname AS "table", pg_get_indexdef(x.indexrelid) AS definition,
             x.indisunique AS is_unique, x.indisprimary AS is_primary, (x.indpred IS NOT NULL) AS is_partial,
             am.amname AS method
      FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_am am ON am.oid = i.relam JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
      ORDER BY t.relname, i.relname`),
    pool.query(`
      SELECT c.relname AS name, CASE c.relkind WHEN 'm' THEN 'materialized view' ELSE 'view' END AS kind,
             pg_get_viewdef(c.oid, true) AS definition
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm') ORDER BY c.relname`),
    pool.query(`
      SELECT p.proname AS name, l.lanname AS language, pg_get_function_identity_arguments(p.oid) AS args,
             pg_get_function_result(p.oid) AS returns,
             CASE p.provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE' ELSE 'VOLATILE' END AS volatility
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname = 'public' AND (p.proname LIKE 'fn\\_%' OR p.proname LIKE 'trg\\_%')
      ORDER BY p.proname`),
    pool.query('SELECT * FROM fn_integrity_report()'),
  ]);
  const TYPE = { p: 'PRIMARY KEY', f: 'FOREIGN KEY', u: 'UNIQUE', c: 'CHECK', x: 'EXCLUDE', t: 'CONSTRAINT TRIGGER', n: 'NOT NULL' };
  const rowsBy = Object.fromEntries(counts.rows.map((r) => [r.name, r.rows]));
  const metaBy = Object.fromEntries(tableMeta.rows.map((r) => [r.name, r]));
  const cons = constraints.rows.filter((k) => k.type !== 'n' && k.type !== 't')
    .map((k) => ({ ...k, type: TYPE[k.type] || k.type, module: TABLE_MODULE[k.table] }))
    .concat(partialUnique.rows.map((x) => ({ ...x, type: 'UNIQUE (partial index)', deferrable: false, module: TABLE_MODULE[x.table] })));
  const notNull = (await pool.query(`
      SELECT count(*)::int AS n FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace s ON s.oid = c.relnamespace
      WHERE s.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND a.attnotnull AND NOT a.attisdropped`)).rows[0].n;

  res.json({
    tables: tables.map((t) => ({
      name: t, module: TABLE_MODULE[t], role: TABLE_ROLE[t] || 'entity', rows: rowsBy[t], columns: metaBy[t]?.columns,
      bytes: metaBy[t]?.bytes, comment: metaBy[t]?.comment || null,
      constraints: cons.filter((k) => k.table === t).length,
      triggers: triggers.rows.filter((x) => x.table === t).length,
      indexes: indexes.rows.filter((x) => x.table === t).length,
    })),
    constraints: cons,
    notNullColumns: notNull,
    triggers: triggers.rows.map((x) => ({ ...x, module: moduleOfRoutine(x.function) })),
    indexes: indexes.rows.map((x) => ({ ...x, module: TABLE_MODULE[x.table] })),
    views: views.rows.map((v) => ({ ...v, module: VIEW_MODULE[v.name] || 'other' })),
    routines: routines.rows.map((r) => ({ ...r, module: moduleOfRoutine(r.name), kind: r.name.startsWith('trg_') ? 'trigger function' : 'function' })),
    integrity: integrity.rows,
    totals: {
      tables: tables.length, rows: counts.rows.reduce((a, r) => a + r.rows, 0),
      constraints: cons.length, notNull, triggers: triggers.rows.length, indexes: indexes.rows.length,
      views: views.rows.length, functions: routines.rows.filter((r) => r.name.startsWith('fn_')).length,
      triggerFunctions: routines.rows.filter((r) => r.name.startsWith('trg_')).length,
    },
  });
});

export default router;
