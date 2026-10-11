// =====================================================================
// One-command database setup:   npm run db:setup     (or --no-seed)
//   1. creates the database if it does not exist
//   2. runs every db/NN_*.sql file in order: reset → tables (all modules)
//      → logic → views → indexes → cross-module integration
//   3. seeds deterministic demo data, module by module, in ONE transaction:
//        M1 users + rides → M2 bookings → M3 expenses → demo story
//        → M4 payments → M5 ratings → refresh the materialized view
// Uses DATABASE_URL from server/.env (see .env.example).
// =====================================================================
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { seed as seedUsersRides } from './seed/m1_users_rides.js';
import { seedBooking } from './seed/m2_booking.js';
import { seedDemoStory } from './seed/demo_story.js';
import { seedExpenses } from './seed/m3_expenses.js';
import { seedPayments } from './seed/m4_payments.js';
import { seedRatings } from './seed/m5_ratings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DB_DIR = path.resolve(here, '../../db');

// db/00_reset.sql … db/50_integration.sql, in numeric order (queries/ is not executed)
export const SQL_FILES = fs.readdirSync(DB_DIR).filter((f) => /^\d\d_.*\.sql$/.test(f)).sort();

export const TABLES = [
  // M1
  'hostel', 'student', 'auth_session', 'location', 'cab_type', 'ride', 'ride_stop', 'ride_status_log',
  // M2
  'ride_member', 'ride_booking_policy', 'booking_request', 'ride_waitlist', 'booking_event',
  // M3
  'expense', 'expense_share', 'expense_audit',
  // M4
  'payment_method', 'payment_transition', 'payment', 'payment_event', 'payment_reminder',
  // M5
  'rating', 'rating_tag', 'rating_tag_map', 'rating_audit',
];

async function ensureDatabase(url) {
  const dbName = new URL(url).pathname.slice(1);
  const admin = new URL(url); admin.pathname = '/postgres';
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  try {
    const { rowCount } = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!rowCount) await c.query(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`);
  } finally { await c.end(); }
}

export async function setupDatabase(url, { withSeed = true, log = console.log, now = new Date() } = {}) {
  await ensureDatabase(url);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    for (const f of SQL_FILES) {
      await client.query(fs.readFileSync(path.join(DB_DIR, f), 'utf8'));
      log(`→ ${f} … ok`);
    }
    let result = null;
    if (withSeed) {
      await client.query('BEGIN');
      const m1 = await seedUsersRides(client, { now });                 // Member 1
      const m2 = await seedBooking(client, { now });                    // Member 2
      const m3 = await seedExpenses(client, { now });                   // Member 3
      const story = await seedDemoStory(client, { now });               // whole team: the demo student's story
      const m4 = await seedPayments(client, { now, story });            // Member 4
      const m5 = await seedRatings(client, { now, story });             // Member 5
      await client.query('SELECT fn_refresh_reputation()');
      await client.query('COMMIT');
      result = { demoStudentId: m1.demoStudentId, password: m1.password, m2, story: story.labels, m3, m4, m5 };
      log('→ demo data seeded');
    }
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

// ---- CLI ----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/poolup';
  try {
    const t0 = Date.now();
    const res = await setupDatabase(url, { withSeed: !process.argv.includes('--no-seed') });
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    const { rows } = await c.query(TABLES.map((t) => `SELECT '${t}' AS "table", count(*)::int AS "rows" FROM ${t}`).join(' UNION ALL '));
    const { rows: checks } = await c.query('SELECT * FROM fn_integrity_report()');
    await c.end();
    console.table(rows);
    const total = rows.reduce((a, r) => a + r.rows, 0);
    const bad = checks.filter((x) => Number(x.violations) !== 0);
    console.log(`✓ Database ready: ${total.toLocaleString('en-IN')} rows in ${rows.length} tables (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    console.log(bad.length ? `✗ ${bad.length} integrity check(s) failed: ${bad.map((b) => b.check_id).join(', ')}`
      : `✓ All ${checks.length} cross-module integrity checks pass`);
    if (res) console.log(`  Demo login: ${res.demoStudentId} / ${res.password}  (Aarav Mehta). Every seeded student uses the same password.`);
  } catch (err) {
    console.error('\n✗ Setup failed:', err.message, err.constraint ? `(constraint: ${err.constraint})` : '');
    process.exitCode = 1;
  }
}
