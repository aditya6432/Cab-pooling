import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, hasToken, onUnauthorized, setToken } from './api.js';
import { AppContext, useApi } from './hooks.js';
import { SqlDrawer } from './components/Sql.jsx';
import { Avatar, DbError } from './components/ui.jsx';
import AuthPage from './pages/AuthPage.jsx';
import HomePage from './pages/HomePage.jsx';
import SearchPage from './pages/SearchPage.jsx';
import CreatePage from './pages/CreatePage.jsx';
import MyRidesPage from './pages/MyRidesPage.jsx';
import ExpensesPage from './pages/ExpensesPage.jsx';
import RideExpensesPage from './pages/RideExpensesPage.jsx';
import SettleUpPage from './pages/SettleUpPage.jsx';
import PaymentsPage from './pages/PaymentsPage.jsx';
import StatementPage from './pages/StatementPage.jsx';
import RatePage from './pages/RatePage.jsx';
import ProfilePage from './pages/ProfilePage.jsx';
import LeaderboardPage from './pages/LeaderboardPage.jsx';
import Dashboard from './pages/Dashboard.jsx';
import RidesInsights from './pages/RidesInsights.jsx';
import MoneyDashboard from './pages/MoneyDashboard.jsx';
import LabPage from './pages/LabPage.jsx';
import SqlLibrary from './pages/SqlLibrary.jsx';
import DatabasePage from './pages/DatabasePage.jsx';

const Icon = ({ d }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const ICONS = {
  home: 'M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5',
  plus: 'M12 5v14M5 12h14',
  rides: 'M5 17h14l-2-6H7zM7 19a1.5 1.5 0 100-3M17 19a1.5 1.5 0 100-3M9 11l1.5-4h3L15 11',
  expense: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3',
  dash: 'M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z',
  rate: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z',
  me: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
  board: 'M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0zM17 5h3v2a3 3 0 01-3 3M7 5H4v2a3 3 0 003 3',
  lab: 'M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 006 21h12a1.7 1.7 0 001.5-2.5L14 9V3',
  sql: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  db: 'M4 5h16v4H4zM4 11h16v4H4zM4 17h16v4H4zM7 7h.01M7 13h.01M7 19h.01',
  settle: 'M3 7h18v10H3zM3 11h18M7 15h3',
  inbox: 'M4 13h4l2 3h4l2-3h4M4 13l2-8h12l2 8v6H4z',
  statement: 'M7 3h10v18l-3-2-2 2-2-2-3 2zM10 8h4M10 12h4',
  money: 'M4 19V9M10 19V5M16 19v-7M22 19H2',
  trend: 'M3 17l6-6 4 4 8-8M15 7h6v6',
};

/** Demo helper: log in as any seeded student (they all share the demo password). */
function AccountSwitcher({ me, onSwitch, onLogout }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [err, setErr] = useState(null);
  const { data } = useApi(open ? '/students' : null, { query: { q } }, [open]);
  const ref = useRef(null);
  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  return (
    <div className="picker" ref={ref}>
      <button className="btn" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog">
        <Avatar name={me.full_name} />
        <span style={{ textAlign: 'left', lineHeight: 1.2 }}>
          <span className="small muted" style={{ display: 'block' }}>Signed in as</span>
          {me.full_name}
        </span>
        <span className="muted" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="picker-pop" role="dialog" aria-label="Account">
          <div className="row" style={{ padding: '2px 6px 8px' }}>
            <div style={{ flex: 1, minWidth: 0 }}><div><strong>{me.full_name}</strong></div><div className="small muted mono">{me.student_id} · {me.hostel}</div></div>
            <button className="btn sm" onClick={onLogout}>Log out</button>
          </div>
          <div className="small muted" style={{ padding: '6px 8px', borderTop: '1px solid var(--border)' }}>
            Demo: switch to another seeded student (all share the password <span className="mono">poolup123</span>), e.g. to confirm a payment as its payee.
          </div>
          <input type="search" autoFocus placeholder="Name or BITS ID…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search students" />
          {err && <DbError error={err} title="Could not switch" />}
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {(data || []).filter((s) => s.student_id !== me.student_id).map((s) => (
              <button key={s.student_id} className="picker-item" onClick={async () => {
                setErr(null);
                try { await onSwitch(s.student_id); setOpen(false); setQ(''); } catch (e) { setErr(e); }
              }}>
                <Avatar name={s.full_name} />
                <div style={{ textAlign: 'left' }}><div>{s.full_name}</div><div className="small muted mono">{s.student_id} · {s.hostel}</div></div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Nav({ me, counts }) {
  const n = (k) => (counts[k] > 0 ? <span className="count">{counts[k]}</span> : null);
  return (
    <nav className="nav" aria-label="Main">
      <NavLink to="/home"><Icon d={ICONS.home} />Home{n('total')}</NavLink>
      <div className="nav-label">Rides <span className="nav-who">M1 · M2</span></div>
      <NavLink to="/search"><Icon d={ICONS.search} />Find a ride</NavLink>
      <NavLink to="/create"><Icon d={ICONS.plus} />Offer a ride</NavLink>
      <NavLink to="/rides"><Icon d={ICONS.rides} />My rides{n('booking')}</NavLink>
      <div className="nav-label">Money <span className="nav-who">M3 · M4</span></div>
      <NavLink to="/expenses"><Icon d={ICONS.expense} />Expenses{n('expenses')}</NavLink>
      <NavLink to="/money" end><Icon d={ICONS.settle} />Settle up{n('pay')}</NavLink>
      <NavLink to="/money/payments"><Icon d={ICONS.inbox} />Payments{n('confirm')}</NavLink>
      <NavLink to="/money/statement"><Icon d={ICONS.statement} />Statement</NavLink>
      <div className="nav-label">Community <span className="nav-who">M5</span></div>
      <NavLink to="/rate"><Icon d={ICONS.rate} />Rate co-riders{n('rate')}</NavLink>
      <NavLink to={`/profile/${me.student_id}`}><Icon d={ICONS.me} />My profile</NavLink>
      <NavLink to="/leaderboard"><Icon d={ICONS.board} />Leaderboard</NavLink>
      <div className="nav-label">Insights</div>
      <NavLink to="/dashboard"><Icon d={ICONS.dash} />Campus dashboard</NavLink>
      <NavLink to="/insights/rides"><Icon d={ICONS.trend} />Rides &amp; bookings</NavLink>
      <NavLink to="/money/dashboard"><Icon d={ICONS.money} />Money dashboard</NavLink>
      <div className="nav-label">For the viva</div>
      <NavLink to="/lab"><Icon d={ICONS.lab} />Integrity Lab</NavLink>
      <NavLink to="/sql"><Icon d={ICONS.sql} />SQL library</NavLink>
      <NavLink to="/database"><Icon d={ICONS.db} />Database</NavLink>
    </nav>
  );
}

export default function App() {
  const [meta, setMeta] = useState(null);
  const [me, setMe] = useState(null);
  const [booting, setBooting] = useState(true);
  const [sqlInfo, setSqlInfo] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('poolup-theme') || 'auto'; } catch { return 'auto'; } });
  const [themeVersion, setThemeVersion] = useState(0);
  const [counts, setCounts] = useState({});
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    api('/meta').then(setMeta).catch((e) => setMeta({ error: e.message }));
    if (hasToken()) api('/auth/me').then(setMe).catch(() => setToken(null)).finally(() => setBooting(false));
    else setBooting(false);
    return onUnauthorized(() => { setToken(null); setMe(null); });
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme);
    try { localStorage.setItem('poolup-theme', theme); } catch { /* ignore */ }
    setThemeVersion((v) => v + 1);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setThemeVersion((v) => v + 1);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [theme]);

  // nav badges: one cross-module query (my_todo) counts everything waiting for me
  const refreshCounts = useCallback(() => {
    api('/analytics/my_todo').then((r) => {
      const c = { total: r.rows.length };
      for (const x of r.rows) {
        const k = { approve_request: 'booking', complete_ride: 'booking', add_expense: 'expenses', confirm_payment: 'confirm', pay: 'pay', rate: 'rate' }[x.kind];
        c[k] = (c[k] || 0) + 1;
      }
      setCounts(c);
    }).catch(() => setCounts({}));
  }, []);
  useEffect(() => { if (me) refreshCounts(); }, [me, location.pathname, refreshCounts]);

  const toast = useCallback((t) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((ts) => [...ts, { id, ...t }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), t.ms || 4500);
  }, []);

  const login = useCallback(async (res, { stay } = {}) => {
    setToken(res.token);
    const full = await api('/auth/me').catch(() => res.student);
    setMe(full);
    if (!stay) navigate('/home');
  }, [navigate]);
  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setToken(null); setMe(null); setCounts({}); navigate('/');
  }, [navigate]);
  const switchTo = useCallback(async (studentId) => {
    const res = await api('/auth/login', { method: 'POST', body: { login: studentId, password: meta?.demoLogin?.password || 'poolup123' } });
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    await login(res, { stay: true });
    toast({ title: `Now signed in as ${res.student.full_name}`, text: 'Pages show their rides, money and ratings.' });
  }, [login, meta, toast]);

  const acting = useMemo(() => (me ? { student_id: me.student_id, full_name: me.full_name, hostel: me.hostel } : null), [me]);
  const ctx = useMemo(() => ({
    meta, me, setMe, acting, login, logout, toast, openSql: setSqlInfo, themeVersion,
    refreshCounts, refreshPending: refreshCounts, counts, navigate,
  }), [meta, me, acting, login, logout, toast, themeVersion, refreshCounts, counts, navigate]);

  if (meta?.error) {
    return (
      <div className="content"><div className="alert error"><div className="title">Cannot reach the API</div>
        <div>{meta.error}. Start it with <span className="kbd">cd server && npm run dev</span> after <span className="kbd">npm run db:setup</span>.</div></div></div>
    );
  }
  if (!meta || booting) return <div className="empty">Loading PoolUp…</div>;

  if (!me) {
    return (
      <AppContext.Provider value={ctx}>
        <Routes><Route path="*" element={<AuthPage />} /></Routes>
        <Toasts toasts={toasts} />
      </AppContext.Provider>
    );
  }

  return (
    <AppContext.Provider value={ctx}>
      <a className="skip" href="#main">Skip to content</a>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark"><svg width="18" height="18" viewBox="0 0 32 32" aria-hidden><path d="M6 19h20l-3-8H9z" fill="#fff" /><circle cx="10" cy="22" r="3" fill="#fff" /><circle cx="22" cy="22" r="3" fill="#fff" /></svg></div>
            <div><div className="brand-name">PoolUp</div><div className="brand-sub">Campus cab-pooling · BITS Hyderabad</div></div>
          </div>
          <Nav me={me} counts={counts} />
          <div className="sidebar-foot">
            <div>DBMS course project · 5 modules, 1 database<br />PostgreSQL · Express · React</div>
            <div className="seg" role="group" aria-label="Theme">
              {['auto', 'light', 'dark'].map((t) => <button key={t} className={theme === t ? 'on' : ''} onClick={() => setTheme(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}
            </div>
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <div className="small muted topbar-tag">Share cabs to the airport, stations &amp; malls · split the fare · settle up · rate</div>
            <div className="grow" />
            <AccountSwitcher me={me} onSwitch={switchTo} onLogout={logout} />
          </header>
          <main className="content" id="main">
            {meta.dataAgeDays > 4 && (
              <div className="alert info banner">
                <div className="title">The demo data is {meta.dataAgeDays} days old</div>
                <div>It is generated relative to the moment you seed it, so recent rides, pending ratings and payments have aged out. Run <span className="kbd">npm run db:setup</span> in <span className="kbd">server/</span> before a demo.</div>
              </div>
            )}
            <Routes>
              <Route path="/" element={<Navigate to="/home" replace />} />
              <Route path="/home" element={<HomePage key={me.student_id} />} />
              <Route path="/search" element={<SearchPage key={me.student_id} />} />
              <Route path="/create" element={<CreatePage />} />
              <Route path="/rides" element={<MyRidesPage key={me.student_id} />} />
              <Route path="/expenses" element={<ExpensesPage key={me.student_id} />} />
              <Route path="/expenses/:rideId" element={<RideExpensesPage key={me.student_id} />} />
              <Route path="/money" element={<SettleUpPage key={me.student_id} />} />
              <Route path="/money/payments" element={<PaymentsPage key={me.student_id} />} />
              <Route path="/money/statement" element={<StatementPage key={me.student_id} />} />
              <Route path="/money/dashboard" element={<MoneyDashboard />} />
              <Route path="/rate" element={<RatePage key={me.student_id} />} />
              <Route path="/profile/:id" element={<ProfilePage />} />
              <Route path="/leaderboard" element={<LeaderboardPage />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/insights/rides" element={<RidesInsights />} />
              <Route path="/lab" element={<LabPage />} />
              <Route path="/sql" element={<SqlLibrary />} />
              <Route path="/database" element={<DatabasePage />} />
              <Route path="*" element={<Navigate to="/home" replace />} />
            </Routes>
          </main>
        </div>
      </div>
      <SqlDrawer info={sqlInfo} onClose={() => setSqlInfo(null)} />
      <Toasts toasts={toasts} />
    </AppContext.Provider>
  );
}

function Toasts({ toasts }) {
  return (
    <div className="toast-zone" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`alert toast ${t.kind === 'error' ? 'error' : 'success'}`}>
          {t.title && <div className="title">{t.title}</div>}
          {t.text && <div>{t.text}</div>}
        </div>
      ))}
    </div>
  );
}
