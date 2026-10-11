// Member 1: log in / register. Every format and uniqueness rule (BITS ID pattern, campus e-mail,
// 10-digit phone, unique e-mail / phone) is enforced by the student table; the form shows which rule fired.
import { useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../hooks.js';
import { DbError } from '../components/ui.jsx';

const FEATURES = [
  ['Find or offer a ride', 'Airport, Secunderabad, Kacheguda, malls. Search matches rides that pass through your stop.', 'M1'],
  ['Book a seat', 'Instant or creator-approved, with a fair waitlist that promotes people automatically.', 'M2'],
  ['Split the fare', 'Equal, by seats, exact or percent. Shares always add up to the paisa.', 'M3'],
  ['Settle up', 'Pay by UPI or cash, confirm, net off mutual debts. Nothing is ever double-paid.', 'M4'],
  ['Rate co-riders', 'Trust scores, a leaderboard and a trust network built with a recursive query.', 'M5'],
];

export default function AuthPage() {
  const { meta, login } = useApp();
  const demo = meta.demoLogin;
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ login: '', password: '', studentId: '', fullName: '', email: '', phone: '', hostelId: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      await login(mode === 'login'
        ? await api('/auth/login', { method: 'POST', body: { login: f.login, password: f.password } })
        : await api('/auth/register', { method: 'POST', body: { ...f, hostelId: Number(f.hostelId) } }));
    } catch (x) { setErr(x); } finally { setBusy(false); }
  }

  return (
    <div className="auth-wrap">
      <section className="auth-hero">
        <div className="brand">
          <div className="brand-mark"><svg width="18" height="18" viewBox="0 0 32 32" aria-hidden><path d="M6 19h20l-3-8H9z" fill="#fff" /><circle cx="10" cy="22" r="3" fill="#fff" /><circle cx="22" cy="22" r="3" fill="#fff" /></svg></div>
          <div><div className="brand-name">PoolUp</div><div className="brand-sub">BITS Pilani, Hyderabad Campus</div></div>
        </div>
        <h1 className="auth-title">Share the cab.<br />Split the fare.<br />Settle up fairly.</h1>
        <p className="secondary" style={{ maxWidth: 460 }}>Campus cab-pooling to the airport, railway stations and malls, with Splitwise-style splitting. Every rule lives in the database, so the app can never get it wrong.</p>
        <ol className="auth-steps">
          {FEATURES.map(([t, d, m]) => (
            <li key={t}><div><strong>{t}</strong> <span className="badge">{m}</span></div><div className="small secondary">{d}</div></li>
          ))}
        </ol>
      </section>

      <section className="card auth-card">
        <div className="seg" role="tablist" aria-label="Account" style={{ marginBottom: 14 }}>
          <button role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'on' : ''} onClick={() => { setMode('login'); setErr(null); }}>Log in</button>
          <button role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'on' : ''} onClick={() => { setMode('register'); setErr(null); }}>Register</button>
        </div>
        <form className="stack" style={{ gap: 12 }} onSubmit={submit}>
          {mode === 'login' ? (<>
            <label className="field">BITS ID or e-mail<input type="text" autoComplete="username" value={f.login} onChange={set('login')} required placeholder="2023A7PS0001H" /></label>
            <label className="field">Password<input type="password" autoComplete="current-password" value={f.password} onChange={set('password')} required /></label>
            {demo && (
              <div className="alert info small">
                <div className="title">Demo account</div>
                <div><span className="mono">{demo.studentId}</span> / <span className="mono">{demo.password}</span> ({demo.name}). Every seeded student uses the same password.</div>
                <button type="button" className="btn sm" style={{ marginTop: 8 }} onClick={() => setF({ ...f, login: demo.studentId, password: demo.password })}>Fill in the demo login</button>
              </div>
            )}
          </>) : (<>
            <label className="field">BITS ID<input type="text" placeholder="2024A7PS0123H" value={f.studentId} onChange={set('studentId')} required /></label>
            <label className="field">Full name<input type="text" value={f.fullName} onChange={set('fullName')} required /></label>
            <label className="field">BITS e-mail<input type="email" placeholder="f20240123@hyderabad.bits-pilani.ac.in" value={f.email} onChange={set('email')} required /></label>
            <div className="grid g-2" style={{ gap: 10 }}>
              <label className="field">Phone<input type="text" inputMode="numeric" maxLength={10} value={f.phone} onChange={set('phone')} required /></label>
              <label className="field">Hostel<select value={f.hostelId} onChange={set('hostelId')} required>
                <option value="">Select…</option>{meta.hostels.map((h) => <option key={h.hostel_id} value={h.hostel_id}>{h.name}</option>)}</select></label>
            </div>
            <label className="field">Password (8+ characters)<input type="password" autoComplete="new-password" minLength={8} value={f.password} onChange={set('password')} required /></label>
            <div className="small muted">Try a Gmail address or a 9-digit phone: PostgreSQL's CHECK constraints reject them and tell you which rule fired.</div>
          </>)}
          <DbError error={err} title={err?.status === 401 ? 'Could not log in' : undefined} />
          <button className="btn primary" disabled={busy} style={{ justifyContent: 'center' }}>{busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}</button>
        </form>
      </section>
    </div>
  );
}
