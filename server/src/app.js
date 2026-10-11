// PoolUp REST API: one Express app for all five modules.
//   Member 1  /api/auth, /api/rides, /api/students (search + public profile)
//   Member 2  /api/bookings
//   Member 3  /api/expenses
//   Member 4  /api/payments
//   Member 5  /api/ratings, /api/students/:id/profile|network, /api/analytics (dashboards)
//   Shared    /api/meta, /api/lab (Integrity Lab), /api/database (schema explorer)
// Every business rule lives in PostgreSQL; routes call stored functions or run
// parameterised SQL, and errors.js reports which database mechanism said no.
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';
import { errorHandler } from './errors.js';
import auth from './routes/auth.js';
import students, { meta } from './routes/students.js';
import rides from './routes/rides.js';
import bookings from './routes/bookings.js';
import expenses from './routes/expenses.js';
import payments from './routes/payments.js';
import ratings from './routes/ratings.js';
import analytics from './routes/analytics.js';
import lab from './routes/lab.js';
import database from './routes/database.js';

export const app = express();
app.use(cors());
app.use(express.json({ limit: '50kb' }));

app.get('/api/health', async (_req, res) => {
  const { rows } = await pool.query('SELECT now() AS db_time, version() AS version');
  res.json({ ok: true, ...rows[0] });
});
app.get('/api/meta', meta);
app.use('/api/auth', auth);            // M1
app.use('/api/students', students);    // M1 + M5
app.use('/api/rides', rides);          // M1
app.use('/api/bookings', bookings);    // M2
app.use('/api/expenses', expenses);    // M3
app.use('/api/payments', payments);    // M4
app.use('/api/ratings', ratings);      // M5
app.use('/api/analytics', analytics);  // all modules' named queries
app.use('/api/lab', lab);              // Integrity Lab, all modules
app.use('/api/database', database);    // schema explorer
app.use('/api', (_req, res) => res.status(404).json({ error: { message: 'Not found', kind: 'Request error' } }));

// Serve the built React app (client/dist) if present: one process in demo mode
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../../client/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use(errorHandler);
