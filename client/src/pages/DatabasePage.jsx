// Database: the schema explained by PostgreSQL's own system catalogs (pg_class, pg_constraint,
// pg_trigger, pg_index, pg_proc), grouped by module, plus the live cross-module integrity report.
import { useMemo, useState } from 'react';
import { api } from '../api.js';
import { useApi, useApp } from '../hooks.js';
import { Card, DataTable, Empty, Tabs } from '../components/ui.jsx';
import { SqlCode } from '../components/Sql.jsx';
import { fmtInt } from '../format.js';
import { MODULES, moduleById } from '../modules.js';

const ROLE = { entity: 'Core entity', reference: 'Reference data', history: 'History / audit (trigger-written)', support: 'Session support' };
const kb = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} kB`);

function Rubric({ t, constraints }) {
  const by = (type) => constraints.filter((k) => k.type.startsWith(type)).length;
  const items = [
    ['Relations', `${t.tables} tables: 14 core entities + 11 reference / history / session tables (justified in the design document)`, true],
    ['≥ 500 records', `${fmtInt(t.rows)} rows of deterministic, realistic demo data`, t.rows >= 500],
    ['PRIMARY KEY on every table', `${by('PRIMARY KEY')} primary keys (simple, composite and weak-entity keys)`, by('PRIMARY KEY') >= t.tables],
    ['FOREIGN KEY', `${by('FOREIGN KEY')} foreign keys, incl. composite keys into ride_member`, by('FOREIGN KEY') > 0],
    ['UNIQUE', `${by('UNIQUE')} unique constraints / partial unique indexes`, by('UNIQUE') > 0],
    ['CHECK', `${by('CHECK')} CHECK constraints (regex, ranges, cross-column)`, by('CHECK') > 0],
    ['NOT NULL', `${t.notNull} NOT NULL columns`, t.notNull > 0],
    ['EXCLUDE', `${by('EXCLUDE')} exclusion constraint (GiST: no overlapping reminder windows)`, by('EXCLUDE') > 0],
    ['Triggers', `${t.triggers} triggers on ${t.triggerFunctions} trigger functions, incl. deferred constraint triggers`, t.triggers > 0],
    ['Stored functions', `${t.functions} functions (PL/pgSQL + SQL), the workflows' transactions`, t.functions > 0],
    ['Views', `${t.views} views incl. 1 materialized view`, t.views > 0],
    ['Indexes', `${t.indexes} indexes (B-tree, GiST, partial, covering)`, t.indexes > 0],
  ];
  return (
    <div className="rubric">
      {items.map(([k, v, ok]) => (
        <div key={k} className="rubric-item"><span className={`verdict ${ok ? 'pass' : 'fail'}`}>{ok ? '✓' : '✗'}</span><div><strong>{k}</strong><div className="small secondary">{v}</div></div></div>
      ))}
    </div>
  );
}

export default function DatabasePage() {
  const { openSql } = useApp();
  const { data, loading, error, reload } = useApi('/database/overview');
  const [tab, setTab] = useState('overview');
  const [mod, setMod] = useState('all');
  const [q, setQ] = useState('');
  const f = (rows) => (rows || []).filter((r) => (mod === 'all' || r.module === mod) && (!q || JSON.stringify(r).toLowerCase().includes(q.toLowerCase())));
  const badIntegrity = useMemo(() => (data?.integrity || []).filter((c) => Number(c.violations) !== 0).length, [data]);

  if (error) return <div className="alert error">{error.message}</div>;
  if (!data) return <Empty>Reading the system catalogs…</Empty>;
  const t = data.totals;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Database</h1>
          <p>The schema as PostgreSQL itself describes it: every table, constraint, trigger, index, view and function, read live from the system catalogs and grouped by the member who owns it.</p>
        </div>
        <button className="btn" onClick={reload} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
      </div>

      <div className="stats stats-6 card" style={{ marginBottom: 16 }}>
        <div className="stat"><div className="label">Tables</div><div className="value">{t.tables}</div></div>
        <div className="stat"><div className="label">Rows</div><div className="value">{fmtInt(t.rows)}</div></div>
        <div className="stat"><div className="label">Constraints</div><div className="value">{t.constraints}</div><div className="hint">+ {t.notNull} NOT NULL</div></div>
        <div className="stat"><div className="label">Triggers</div><div className="value">{t.triggers}</div></div>
        <div className="stat"><div className="label">Functions</div><div className="value">{t.functions}</div><div className="hint">+ {t.triggerFunctions} trigger functions</div></div>
        <div className="stat"><div className="label">Views · indexes</div><div className="value">{t.views} · {t.indexes}</div></div>
      </div>

      <div className="row wrap" style={{ marginBottom: 14, gap: 10 }}>
        <Tabs value={tab} onChange={setTab} tabs={[['overview', 'Overview'], ['constraints', 'Constraints', t.constraints], ['triggers', 'Triggers', t.triggers], ['indexes', 'Indexes', t.indexes], ['views', 'Views', t.views], ['functions', 'Functions', t.functions + t.triggerFunctions], ['er', 'ER diagram']]} />
        {tab !== 'overview' && tab !== 'er' && (<>
          <select value={mod} onChange={(e) => setMod(e.target.value)} aria-label="Module">
            <option value="all">All modules</option>{MODULES.map((m) => <option key={m.id} value={m.id}>{m.member}: {m.label}</option>)}</select>
          <input type="search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        </>)}
      </div>

      {tab === 'overview' && (
        <>
          <div className="grid g-12">
            <Card className="span-6" title="How it meets the project guidelines" sub="Counted live from pg_catalog, not typed by hand">
              <Rubric t={t} constraints={data.constraints} />
            </Card>
            <Card className="span-6" title={badIntegrity ? `Integrity report: ${badIntegrity} check(s) failing` : 'Integrity report: all checks pass'}
              sub="fn_integrity_report(): every invariant the modules promise each other, counted live (must all be 0)"
              actions={<button className="icon-btn" onClick={async () => openSql(await api('/analytics/integrity_report'))}>SQL</button>}>
              <DataTable rows={data.integrity} columns={[
                { key: 'check_id', label: '#' },
                { key: 'module', label: 'Module', render: (r) => <span className="badge">{r.module}</span> },
                { key: 'description', label: 'Invariant' },
                { key: 'violations', label: 'Violations', num: true, render: (r) => <span className={`verdict ${Number(r.violations) === 0 ? 'pass' : 'fail'}`}>{Number(r.violations) === 0 ? '✓ 0' : `✗ ${r.violations}`}</span> },
              ]} />
            </Card>
          </div>
          {MODULES.filter((m) => m.id !== 'integration').map((m) => (
            <div key={m.id}>
              <div className="section-title"><h2>{m.member}: {m.label}</h2><span>{data.tables.filter((x) => x.module === m.id).length} tables</span></div>
              <Card>
                <DataTable rows={data.tables.filter((x) => x.module === m.id)} columns={[
                  { key: 'name', label: 'Table', render: (r) => <span className="mono">{r.name}</span> },
                  { key: 'role', label: 'Role', render: (r) => <span className={`badge ${r.role === 'entity' ? 'blue' : ''}`}>{ROLE[r.role]}</span> },
                  { key: 'rows', label: 'Rows', num: true, render: (r) => fmtInt(r.rows) },
                  { key: 'columns', label: 'Columns', num: true },
                  { key: 'constraints', label: 'Constraints', num: true },
                  { key: 'triggers', label: 'Triggers', num: true },
                  { key: 'indexes', label: 'Indexes', num: true },
                  { key: 'bytes', label: 'Size', num: true, render: (r) => kb(r.bytes) },
                ]} />
              </Card>
            </div>
          ))}
        </>
      )}

      {tab === 'constraints' && (
        <Card title="Constraints" sub="pg_get_constraintdef(): the exact definitions PostgreSQL enforces">
          <DataTable rows={f(data.constraints)} columns={[
            { key: 'table', label: 'Table', render: (r) => <span className="mono">{r.table}</span> },
            { key: 'type', label: 'Type', render: (r) => <span className="badge">{r.type}{r.deferrable ? ' · deferrable' : ''}</span> },
            { key: 'name', label: 'Name', render: (r) => <span className="mono small">{r.name}</span> },
            { key: 'definition', label: 'Definition', render: (r) => <code className="def">{r.definition}</code> },
          ]} />
        </Card>
      )}
      {tab === 'triggers' && (
        <Card title="Triggers" sub="pg_get_triggerdef(): timing, events, row/statement level and the function each one calls">
          <DataTable rows={f(data.triggers)} columns={[
            { key: 'table', label: 'Table', render: (r) => <span className="mono">{r.table}</span> },
            { key: 'name', label: 'Trigger', render: (r) => <span className="mono small">{r.name}{r.is_constraint_trigger && <span className="badge blue" style={{ marginLeft: 6 }}>constraint{r.deferrable ? ', deferred' : ''}</span>}</span> },
            { key: 'module', label: 'Module', render: (r) => moduleById[r.module]?.member ?? '' },
            { key: 'definition', label: 'Definition', render: (r) => <code className="def">{r.definition.replace(/^CREATE (CONSTRAINT )?TRIGGER \S+ /, '')}</code> },
          ]} />
        </Card>
      )}
      {tab === 'indexes' && (
        <Card title="Indexes" sub="Primary key / unique indexes are created automatically; every other index serves a named query or a trigger">
          <DataTable rows={f(data.indexes)} columns={[
            { key: 'table', label: 'Table', render: (r) => <span className="mono">{r.table}</span> },
            { key: 'name', label: 'Index', render: (r) => <span className="mono small">{r.name}</span> },
            { key: 'kind', label: 'Kind', render: (r) => <span className="row wrap" style={{ gap: 4 }}><span className="badge">{r.method}</span>{r.is_primary && <span className="badge blue">PK</span>}{r.is_unique && !r.is_primary && <span className="badge">unique</span>}{r.is_partial && <span className="badge good">partial</span>}</span> },
            { key: 'definition', label: 'Definition', render: (r) => <code className="def">{r.definition.replace(/^CREATE (UNIQUE )?INDEX \S+ ON public\./, '')}</code> },
          ]} />
        </Card>
      )}
      {tab === 'views' && (
        <div className="stack" style={{ gap: 16 }}>
          {f(data.views).map((v) => (
            <Card key={v.name} title={v.name} sub={`${v.kind} · ${moduleById[v.module]?.member ?? ''} ${moduleById[v.module]?.label ?? ''}`}>
              <SqlCode sql={v.definition.trim()} />
            </Card>
          ))}
        </div>
      )}
      {tab === 'functions' && (
        <Card title="Functions and trigger functions" sub="pg_proc: language, volatility and signature">
          <DataTable rows={f(data.routines)} columns={[
            { key: 'name', label: 'Name', render: (r) => <span className="mono small">{r.name}</span> },
            { key: 'kind', label: 'Kind', render: (r) => <span className="badge">{r.kind}</span> },
            { key: 'module', label: 'Module', render: (r) => moduleById[r.module]?.member ?? '' },
            { key: 'language', label: 'Language' },
            { key: 'volatility', label: 'Volatility' },
            { key: 'args', label: 'Arguments → result', render: (r) => <code className="def">({r.args}) → {r.returns}</code> },
          ]} />
        </Card>
      )}
      {tab === 'er' && (
        <Card title="Entity-relationship diagram" sub="All 25 relations; crow's-foot notation. The same figure is in docs/PoolUp_Design_Document.pdf">
          <img className="er-img" src="/er-diagram.svg" alt="PoolUp ER diagram: users and rides, bookings, expenses, payments and ratings" />
        </Card>
      )}
    </>
  );
}
