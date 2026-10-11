import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { moduleById } from '../modules.js';

const KW = new Set(('select from where join left right inner outer full cross on and or not exists in is null as with recursive union all ' +
  'group by order having limit offset distinct case when then else end over partition rank dense_rank lag lead sum count avg ' +
  'min max coalesce nullif round filter insert into values update set delete returning begin commit rollback savepoint release ' +
  'asc desc nulls last first using array interval between like ilike true false explain analyze least greatest extract date_trunc ' +
  'to_char generate_series unnest ordinality percent_rank any lateral row_number ntile first_value percentile_cont within rollup format').split(' '));

/** Tiny SQL highlighter: enough to make queries readable in the drawer. */
export function SqlCode({ sql, className = 'sql' }) {
  const parts = [];
  const re = /(--[^\n]*)|('(?:[^']|'')*')|(\$\d+)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|(.)/g;
  let m; let i = 0;
  while ((m = re.exec(sql))) {
    const [t, cm, str, prm, num, word] = m;
    if (cm) parts.push(<span key={i++} className="cm">{t}</span>);
    else if (str) parts.push(<span key={i++} className="str">{t}</span>);
    else if (prm) parts.push(<span key={i++} className="prm">{t}</span>);
    else if (num) parts.push(<span key={i++} className="num">{t}</span>);
    else if (word) {
      const lw = word.toLowerCase();
      if (KW.has(lw)) parts.push(<span key={i++} className="kw">{t}</span>);
      else if (/^(fn_|v_|mv_)/.test(lw)) parts.push(<span key={i++} className="fn">{t}</span>);
      else parts.push(t);
    } else parts.push(t);
  }
  return <pre className={className}>{parts}</pre>;
}

export function Concepts({ text }) {
  if (!text) return null;
  return <div className="concepts">{text.split(',').map((c) => <span key={c} className="concept">{c.trim()}</span>)}</div>;
}

/** Side drawer showing the exact SQL behind a card, plus EXPLAIN ANALYZE. */
export function SqlDrawer({ info, onClose }) {
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => { setPlan(null); setErr(null); }, [info]);
  if (!info) return null;
  const query = Object.fromEntries((info.params || []).filter((p) => p.name !== 'me').map((p) => [p.name, p.value]));
  const mod = moduleById[info.module];

  async function explain() {
    setBusy(true); setErr(null);
    try { setPlan(await api(`/analytics/${info.name}/explain`, { query })); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={`SQL for ${info.title}`}>
        <div className="drawer-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="row wrap" style={{ marginBottom: 4 }}>
              <span className="badge mono">{info.name}</span>
              {mod && <span className="badge blue">{mod.member} · {mod.label}</span>}
              {info.ms !== undefined && <span className="badge">{info.ms} ms</span>}
              {info.rowCount !== undefined && <span className="badge">{info.rowCount} rows</span>}
            </div>
            <h2>{info.title}</h2>
          </div>
          <button className="btn ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="drawer-body">
          <div className="stack">
            <div className="small muted">DBMS concepts demonstrated</div>
            <Concepts text={info.concepts} />
          </div>
          {info.params?.length > 0 && (
            <div className="stack">
              <div className="small muted">Bind parameters (sent separately from the SQL, so SQL injection is impossible). <span className="mono">me</span> is always the logged-in student.</div>
              <div className="row wrap">
                {info.params.map((p, i) => <span key={p.name} className="badge mono">${i + 1} {p.name} = {JSON.stringify(p.value)}</span>)}
              </div>
            </div>
          )}
          <div className="stack">
            <div className="row"><span className="small muted">SQL served from <span className="mono">{mod?.file || 'db/queries/'}</span>: exactly what ran</span><span className="spacer" />
              <button className="btn sm" onClick={() => navigator.clipboard?.writeText(info.sql)}>Copy</button></div>
            <SqlCode sql={info.sql} />
          </div>
          <div className="stack">
            <div className="row">
              <span className="small muted">Query plan</span><span className="spacer" />
              <button className="btn sm primary" onClick={explain} disabled={busy}>{busy ? 'Running…' : 'Run EXPLAIN ANALYZE'}</button>
            </div>
            {err && <div className="alert error">{err}</div>}
            {plan && (
              <>
                <div className="row wrap">
                  <span className="small muted">Indexes used:</span>
                  {plan.indexesUsed.length ? plan.indexesUsed.map((ix) => <span key={ix} className="badge blue mono">{ix}</span>)
                    : <span className="small muted">none (sequential scans: the tables are small enough that the planner prefers them)</span>}
                </div>
                <pre className="plan">{plan.plan}</pre>
              </>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
