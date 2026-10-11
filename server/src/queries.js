// Loads every named-query file in db/queries/ and exposes each "-- name:" block.
// One file per module; the file prefix says which:
//   m1_users_rides.sql · m2_booking.sql · m3_expenses.sql · m4_payments.sql ·
//   m5_ratings_analytics.sql · x_integration.sql (cross-module)
// The SQL text served to the UI is byte-for-byte what is executed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const QUERY_DIR = path.resolve(here, '../../db/queries');
export const MODULES = {
  m1: { id: 'users-rides', member: 'Member 1', label: 'Users + rides' },
  m2: { id: 'booking', member: 'Member 2', label: 'Booking + seats' },
  m3: { id: 'expenses', member: 'Member 3', label: 'Expense splitting' },
  m4: { id: 'payments', member: 'Member 4', label: 'Payments + settlement' },
  m5: { id: 'ratings', member: 'Member 5', label: 'Ratings + analytics' },
  x: { id: 'integration', member: 'Whole team', label: 'Cross-module' },
};
export const QUERY_FILES = fs.readdirSync(QUERY_DIR).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => ({ file: path.join(QUERY_DIR, f), module: MODULES[f.split('_')[0]]?.id ?? 'other' }));

function parseParams(spec) {
  // "hostel_id:int=0, min_ratings:int=5"  →  [{name,type,default}]
  if (!spec || !spec.trim()) return [];
  return spec.split(',').map((p) => {
    const m = p.trim().match(/^(\w+):(int|text)(?:=(.*))?$/);
    if (!m) throw new Error(`Bad param spec "${p}"`);
    return { name: m[1], type: m[2], default: m[3] };
  });
}

export function loadQueries(files = QUERY_FILES) {
  const out = new Map();
  for (const { file, module } of files) parseFile(file, module, out);
  return out;
}

function parseFile(file, module, out) {
  const text = fs.readFileSync(file, 'utf8');
  const blocks = text.split(/^-- name:\s*/m).slice(1);
  for (const block of blocks) {
    const lines = block.split('\n');
    const name = lines.shift().trim();
    const meta = { title: '', concepts: '', params: '' };
    while (lines.length && lines[0].startsWith('-- ')) {
      const m = lines[0].match(/^-- (title|concepts|params):\s?(.*)$/);
      if (!m) break;
      meta[m[1]] = m[2].trim();
      lines.shift();
    }
    // drop trailing section-divider comments that belong to the next block
    const sql = lines.join('\n')
      .replace(/\n-- =+[\s\S]*$/m, '')
      .trim()
      .replace(/;\s*$/, '');
    if (out.has(name)) throw new Error(`Duplicate query name "${name}" in ${path.basename(file)}`);
    out.set(name, { name, module, title: meta.title, concepts: meta.concepts, params: parseParams(meta.params), sql });
  }
}

// Coerce + validate request query-string values against the declared params.
export function bindParams(def, input = {}) {
  return def.params.map((p) => {
    let v = input[p.name];
    if (p.name === 'me') {                       // always the logged-in student, never from the URL
      if (!v) { const e = new Error('Please log in'); e.status = 401; throw e; }
      return String(v);
    }
    if (v === undefined || v === '') v = p.default;
    if (v === undefined) {
      const e = new Error(`Missing required parameter "${p.name}"`);
      e.status = 400; throw e;
    }
    if (p.type === 'int') {
      if (!/^-?\d+$/.test(String(v))) {
        const e = new Error(`Parameter "${p.name}" must be an integer`);
        e.status = 400; throw e;
      }
      return Number(v);
    }
    return String(v);
  });
}
