// SQL library: every named query of every module, loaded live from db/queries/*.sql.
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useApp } from '../hooks.js';
import { Concepts, SqlCode } from '../components/Sql.jsx';
import { Empty } from '../components/ui.jsx';
import { MODULES, moduleById } from '../modules.js';

// The rubric asks for at least 5 non-trivial queries; these are the ones to walk through in the viva.
const SHOWCASE = [
  'my_todo', 'ride_lifecycle_funnel', 'reliability_vs_money', 'ledger_agreement',
  'popular_routes', 'fill_by_route', 'rider_reliability', 'who_is_owed', 'my_running_balance',
  'my_statement', 'my_settle_lines', 'tags_vs_payments', 'trust_network', 'top_routes_by_weekday', 'rater_bias',
];

export default function SqlLibrary() {
  const { me, openSql } = useApp();
  const { data } = useApi('/analytics');
  const [params, setParams] = useSearchParams();
  const view = params.get('module') || 'showcase';
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(null);
  const all = data || [];
  const list = (view === 'showcase' ? SHOWCASE.map((n) => all.find((x) => x.name === n)).filter(Boolean) : all.filter((x) => x.module === view))
    .filter((x) => !q || `${x.name} ${x.title} ${x.concepts}`.toLowerCase().includes(q.toLowerCase()));

  async function run(x) {
    setBusy(x.name);
    try {
      // per-ride / per-payment / per-student queries need an id: use the logged-in student's own
      const extra = {};
      if (x.params.some((p) => p.name === 'ride_id')) {
        const lines = await api('/analytics/my_settle_lines');
        extra.ride_id = lines.rows[0]?.ride_id ?? (await api('/analytics/my_payment_history')).rows[0]?.ride_id ?? 1;
      }
      if (x.params.some((p) => p.name === 'payment_id')) {
        const h = await api('/analytics/my_payment_history');
        extra.payment_id = h.rows[0]?.payment_id ?? 1;
      }
      if (x.params.some((p) => p.name === 'student_id')) extra.student_id = me.student_id;
      openSql(await api(`/analytics/${x.name}`, { query: extra }));
    } catch (e) {
      openSql({ name: x.name, module: x.module, title: `${x.title} (error: ${e.message})`, concepts: x.concepts, sql: x.sql, params: [] });
    } finally { setBusy(null); }
  }

  const mod = moduleById[view];
  return (
    <>
      <div className="page-head">
        <div>
          <h1>SQL library</h1>
          <p>All {all.length || '…'} named queries the app runs, loaded live from <span className="mono">{mod ? mod.file : 'db/queries/*.sql'}</span>. Edit a file and refresh: the API hot-reloads it, and the SQL shown is byte-for-byte what executes. <strong>Run</strong> opens the result with timing, bind parameters and an EXPLAIN ANALYZE button.</p>
        </div>
        <input type="search" placeholder="Filter by name or concept…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter queries" style={{ minWidth: 240 }} />
      </div>
      <div className="seg" role="group" aria-label="Module" style={{ marginBottom: 18 }}>
        <button className={view === 'showcase' ? 'on' : ''} onClick={() => setParams({})}>★ Viva showcase ({SHOWCASE.length})</button>
        {MODULES.map((m) => (
          <button key={m.id} className={view === m.id ? 'on' : ''} onClick={() => setParams({ module: m.id })}>
            {m.id === 'integration' ? 'Cross-module' : `${m.member.replace('Member ', 'M')} · ${m.short}`} ({all.filter((x) => x.module === m.id).length})
          </button>
        ))}
      </div>
      {!data && <Empty>Loading…</Empty>}
      <div className="stack" style={{ gap: 16 }}>
        {list.map((x, i) => (
          <section key={x.name} className="card">
            <div className="card-head">
              <div className="titles">
                <div className="row wrap" style={{ marginBottom: 4 }}>
                  {view === 'showcase' && <span className="badge blue">Q{i + 1}</span>}
                  <span className="badge">{moduleById[x.module]?.member}</span>
                  <span className="badge mono">{x.name}</span>
                  {x.params.map((p) => <span key={p.name} className="badge mono">{p.name}:{p.type}{p.default !== undefined ? `=${p.default || "''"}` : ''}</span>)}
                </div>
                <h2>{x.title}</h2>
                <div style={{ marginTop: 6 }}><Concepts text={x.concepts} /></div>
              </div>
              <button className="btn sm primary" onClick={() => run(x)} disabled={busy === x.name}>{busy === x.name ? 'Running…' : 'Run'}</button>
            </div>
            <SqlCode sql={x.sql} />
          </section>
        ))}
      </div>
    </>
  );
}
