// Integrity Lab: try to break every module's rules and watch PostgreSQL refuse.
// 81 scenarios across the five modules; each runs inside BEGIN … ROLLBACK.
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { Card, Empty } from '../components/ui.jsx';
import { MODULES, moduleById } from '../modules.js';

const GROUP_NOTES = {
  'Control': 'Proves the happy path works, so the rejections are meaningful.',
  'Declarative constraints': 'Single-row rules: CHECK, PRIMARY KEY, UNIQUE, FOREIGN KEY. No procedural code.',
  'Trigger rules': 'Rules that need other rows, other tables or the clock: PL/pgSQL triggers.',
  'Transactions': 'Atomicity: a multi-statement unit either fully commits or leaves no trace.',
  'Transactions & concurrency': 'Idempotency, atomic multi-row changes, and two real sessions racing for the same money.',
  'State machine': 'Status changes allowed only along the documented arrows.',
  'Workflow': 'A complete valid operation: succeeds, then rolls back.',
  'Happy paths': 'Complete valid operations: they succeed, then roll back.',
};
const LAB_MODULES = MODULES.filter((m) => m.id !== 'integration');

function StepView({ s }) {
  return (
    <div className="step">
      <pre>{s.sql}</pre>
      {s.note ? <div className="res"><span className="muted">{s.note}</span></div>
        : s.ok ? (
          <div className="res ok">
            <span className="verdict pass">✓ OK</span>
            <span className="secondary mono small" style={{ wordBreak: 'break-word' }}>{s.rows?.length ? JSON.stringify(s.rows[0]) : `${s.rowCount ?? 0} row(s)`}</span>
          </div>
        ) : (
          <div className="res err">
            <span className="verdict fail">✗ ERROR</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div>{s.error.message}</div>
              {s.error.dbMessage && s.error.dbMessage !== s.error.message && <div className="small secondary mono" style={{ marginTop: 2 }}>{s.error.dbMessage}</div>}
              <div className="row wrap" style={{ marginTop: 4 }}>
                {s.error.rule && <span className="badge bad">{s.error.rule}</span>}
                <span className="badge">{s.error.mechanism}</span>
                {s.error.constraint && <span className="badge mono">{s.error.constraint}</span>}
                <span className="badge mono">SQLSTATE {s.error.sqlstate}</span>
              </div>
            </div>
          </div>
        )}
    </div>
  );
}

function Scenario({ sc, result, running, onRun, showModule }) {
  const expected = sc.expect === 'accept' ? 'should be accepted'
    : sc.expectConstraint ? `should fail on ${sc.expectConstraint}` : sc.expectState ? `should fail with SQLSTATE ${sc.expectState}` : 'should be rejected';
  return (
    <Card className="scenario">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row wrap" style={{ marginBottom: 4 }}>
            {showModule && <span className="badge blue">{moduleById[sc.module]?.member}</span>}
            {sc.rule && <span className={`badge ${sc.expect === 'accept' ? 'good' : 'bad'}`}>{sc.rule}</span>}
            <span className="badge">{expected}</span>
            {sc.commits && <span className="badge blue" title="Needs two real sessions, so it COMMITs and then cleans up through the state machine">2 sessions · commits</span>}
            {result && <span className={`verdict ${result.passed ? 'pass' : 'fail'}`}>{result.passed ? '✓ behaved as expected' : '✗ unexpected'}</span>}
          </div>
          <h3>{sc.title}</h3>
          <p className="small secondary" style={{ marginTop: 4 }}>{sc.story}</p>
        </div>
        <button className="btn sm" onClick={onRun} disabled={running}>{running ? 'Running…' : result ? 'Run again' : 'Run'}</button>
      </div>
      {result?.error && result.passed && result.error.explanation && (
        <div className="small" style={{ fontWeight: 500 }}>Database says: <span className="secondary">{result.error.explanation}</span></div>
      )}
      {result && <div className="steps">{result.steps.map((s, i) => <StepView key={i} s={s} />)}</div>}
      {result?.message && <div className="alert error small">{result.message}</div>}
    </Card>
  );
}

export default function LabPage() {
  const [params, setParams] = useSearchParams();
  const module = params.get('module') || 'all';
  const setModule = (m) => setParams(m === 'all' ? {} : { module: m });
  const { data: all } = useApi('/lab/scenarios');
  const scenarios = (all || []).filter((s) => module === 'all' || s.module === module);
  const [results, setResults] = useState({});
  const [running, setRunning] = useState({});
  const [batch, setBatch] = useState(null);

  async function run(id) {
    setRunning((r) => ({ ...r, [id]: true }));
    try {
      const res = await api(`/lab/scenarios/${id}/run`, { method: 'POST' });
      setResults((r) => ({ ...r, [id]: res }));
    } catch (e) {
      setResults((r) => ({ ...r, [id]: { passed: false, steps: [], message: e.message } }));
    } finally { setRunning((r) => ({ ...r, [id]: false })); }
  }
  async function runAll() {
    setBatch({ done: 0, total: scenarios.length });
    for (const [i, s] of scenarios.entries()) { await run(s.id); setBatch({ done: i + 1, total: scenarios.length }); }
    setBatch(null);
  }

  const groups = [...new Set(scenarios.map((s) => (module === 'all' ? `${moduleById[s.module]?.member}: ${moduleById[s.module]?.label}` : s.group)))];
  const groupOf = (s) => (module === 'all' ? `${moduleById[s.module]?.member}: ${moduleById[s.module]?.label}` : s.group);
  const done = scenarios.map((s) => results[s.id]).filter(Boolean);
  const passed = done.filter((r) => r.passed).length;
  const count = (id) => (all || []).filter((s) => s.module === id).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Integrity Lab</h1>
          <p>Try to break the rules and watch <strong>PostgreSQL itself</strong> refuse. Every statement below is real SQL fired at the database, usually a raw INSERT or UPDATE that bypasses the API. Each scenario runs inside <span className="mono">BEGIN … ROLLBACK</span>, so nothing is ever changed (the one exception is Member 4's two-session race, which must commit and then cleans up after itself).</p>
        </div>
        <div className="stack" style={{ alignItems: 'flex-end' }}>
          <div className="row">
            {done.length > 0 && <span className={`badge ${passed === done.length ? 'good' : 'bad'}`}>{passed}/{done.length} as expected</span>}
            <button className="btn primary" onClick={runAll} disabled={Boolean(batch) || !scenarios.length}>
              {batch ? `Running ${batch.done}/${batch.total}…` : `Run all ${scenarios.length || ''} scenarios`}</button>
          </div>
        </div>
      </div>
      <div className="seg" role="group" aria-label="Module" style={{ marginBottom: 18 }}>
        <button className={module === 'all' ? 'on' : ''} onClick={() => setModule('all')}>All modules ({(all || []).length})</button>
        {LAB_MODULES.map((m) => <button key={m.id} className={module === m.id ? 'on' : ''} onClick={() => setModule(m.id)}>{m.member.replace('Member ', 'M')} · {m.short} ({count(m.id)})</button>)}
      </div>
      {!all && <Empty>Loading scenarios…</Empty>}
      {groups.map((g) => (
        <div key={g}>
          <div className="section-title"><h2>{g}</h2><span>{GROUP_NOTES[g] || ''}</span></div>
          <div className="grid g-2">
            {scenarios.filter((s) => groupOf(s) === g).map((sc) => (
              <Scenario key={sc.id} sc={sc} result={results[sc.id]} running={running[sc.id]} onRun={() => run(sc.id)} showModule={module === 'all'} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
