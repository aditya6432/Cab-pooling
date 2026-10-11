import { useState } from 'react';
import { useApp } from '../hooks.js';
import { initials, shortPlace } from '../format.js';

/**
 * Card: title + optional SQL drawer button + optional table-view twin.
 *   result     : the API result object of a named query ({name, sql, …})
 *   table      : () => JSX table rendering the same data (accessibility twin)
 */
export function Card({ title, sub, result, loading, table, actions, children, className = '', style }) {
  const { openSql } = useApp();
  const [showTable, setShowTable] = useState(false);
  return (
    <section className={`card ${loading ? 'loading' : ''} ${className}`} style={style}>
      {(title || result || table || actions) && (
        <div className="card-head">
          <div className="titles">
            {title && <h2>{title}</h2>}
            {sub && <div className="sub">{sub}</div>}
          </div>
          <div className="card-actions">
            {actions}
            {table && (
              <button className={`icon-btn ${showTable ? 'on' : ''}`} onClick={() => setShowTable((v) => !v)} aria-pressed={showTable}>
                {showTable ? 'Chart' : 'Table'}
              </button>
            )}
            {result && <button className="icon-btn" onClick={() => openSql(result)} title="Show the SQL behind this card">SQL</button>}
          </div>
        </div>
      )}
      <div className="card-body">{showTable && table ? <div className="table-wrap">{table()}</div> : children}</div>
    </section>
  );
}

export function Avatar({ name, size }) {
  return <div className={`avatar ${size === 'lg' ? 'lg' : ''}`} aria-hidden>{initials(name)}</div>;
}

const STAR = 'M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4L2.8 9.5l6.4-.8z';
export function Stars({ value = 0, size = 14, onChange, label = 'Rating' }) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  if (!onChange) {
    return (
      <span className="stars" role="img" aria-label={`${value} out of 5 stars`}>
        {[1, 2, 3, 4, 5].map((i) => (
          <svg key={i} width={size} height={size} viewBox="0 0 24 24"><path d={STAR} style={{ fill: i <= Math.round(value) ? 'var(--warning)' : 'var(--surface-3)' }} /></svg>
        ))}
      </span>
    );
  }
  return (
    <span className="stars" role="radiogroup" aria-label={label} onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((i) => (
        <button key={i} type="button" role="radio" aria-checked={value === i} aria-label={`${i} star${i > 1 ? 's' : ''}`}
          onMouseEnter={() => setHover(i)} onClick={() => onChange(i)}>
          <svg width={size} height={size} viewBox="0 0 24 24"><path d={STAR} style={{ fill: i <= shown ? 'var(--warning)' : 'var(--surface-3)' }} /></svg>
        </button>
      ))}
    </span>
  );
}

export function Meter({ value, max = 100, tall }) {
  const pct = Math.max(0, Math.min(100, (100 * (value ?? 0)) / max));
  return <div className={`meter ${tall ? 'tall' : ''}`} role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}><span style={{ width: `${pct}%` }} /></div>;
}

/** Shows a database rejection exactly: rule id, mechanism, constraint, SQLSTATE, and what PostgreSQL said. */
export function DbError({ error, title }) {
  if (!error) return null;
  const info = error.info || error;
  const human = info.explanation || info.message || error.message;
  return (
    <div className="alert error" role="alert">
      <div className="title">
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="12" r="10" style={{ fill: 'var(--critical)' }} /><path d="M8 8l8 8M16 8l-8 8" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" /></svg>
        {title || (info.sqlstate ? 'Rejected by the database' : 'Could not do that')}
      </div>
      <div style={{ marginTop: 4 }}>{human}</div>
      {info.dbMessage && info.dbMessage !== human && <div className="small secondary mono" style={{ marginTop: 4 }}>{info.dbMessage}</div>}
      {(info.rule || info.mechanism || info.constraint || info.sqlstate) && (
        <div className="meta">
          {info.rule && <span className="badge bad">{info.rule}</span>}
          {info.mechanism && <span className="badge">{info.mechanism}</span>}
          {info.constraint && <span className="badge mono">{info.constraint}</span>}
          {info.sqlstate && <span className="badge mono">SQLSTATE {info.sqlstate}</span>}
          {info.rolledBack && <span className="badge bad">transaction rolled back</span>}
        </div>
      )}
    </div>
  );
}

export function Empty({ icon = '∅', children }) {
  return <div className="empty"><div className="big">{icon}</div>{children}</div>;
}

/** Horizontal div-bars: single series, value at the tip. */
export function HBars({ rows, label, value, format = (v) => v, color = 'var(--series-1)', labelWidth, max, tip }) {
  const m = max ?? Math.max(1, ...rows.map(value));
  return (
    <div className="hbars" style={labelWidth ? { '--label-w': `${labelWidth}px` } : undefined}>
      {rows.map((r, i) => (
        <div className="hbar" key={i} title={tip ? tip(r) : undefined}>
          <div className="lbl" title={label(r)}>{label(r)}</div>
          <div className="track"><div className="fill" style={{ width: `${(100 * value(r)) / m}%`, background: typeof color === 'function' ? color(r) : color }} /></div>
          <div className="val">{format(value(r))}</div>
        </div>
      ))}
    </div>
  );
}

export function DataTable({ columns, rows, empty = 'No rows' }) {
  if (!rows?.length) return <Empty>{empty}</Empty>;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr>{columns.map((c) => <th key={c.key} className={c.num ? 'num' : ''}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{columns.map((c) => <td key={c.key} className={c.num ? 'num' : ''}>{c.render ? c.render(r) : r[c.key] ?? '—'}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATUS = {
  pending:   { cls: 'warn',  icon: '◷', label: 'Pending' },
  confirmed: { cls: 'good',  icon: '✓', label: 'Confirmed' },
  rejected:  { cls: 'bad',   icon: '✕', label: 'Rejected' },
  cancelled: { cls: '',      icon: '↺', label: 'Cancelled' },
  expired:   { cls: '',      icon: '⌛', label: 'Expired' },
  reversed:  { cls: 'bad',   icon: '⤺', label: 'Reversed' },
};
/** Payment status: icon + text label, never colour alone. */
export function StatusBadge({ status, method }) {
  const s = STATUS[status] || { cls: '', icon: '', label: status };
  if (method === 'offset') return <span className="badge blue">⇄ Net-off</span>;
  return <span className={`badge ${s.cls}`}><span aria-hidden>{s.icon}</span>{s.label}</span>;
}

const RIDE_STATUS = {
  open: { cls: 'good', icon: '●', label: 'Open' },
  full: { cls: 'warn', icon: '■', label: 'Full' },
  departed: { cls: 'blue', icon: '➜', label: 'Departed' },
  completed: { cls: '', icon: '✓', label: 'Completed' },
  cancelled: { cls: 'bad', icon: '✕', label: 'Cancelled' },
  confirmed: { cls: 'good', icon: '✓', label: 'Seat confirmed' },
  no_show: { cls: 'bad', icon: '∅', label: 'No-show' },
};
/** Ride / booking status: icon + text, never colour alone. */
export function RideStatus({ status }) {
  const s = RIDE_STATUS[status] || { cls: '', icon: '', label: status };
  return <span className={`badge ${s.cls}`}><span aria-hidden>{s.icon}</span>{s.label}</span>;
}

/** Seat map: filled squares are taken seats. */
export function Seats({ left, max }) {
  return (
    <span className="seats" role="img" aria-label={`${left} of ${max} seats left`}>
      {Array.from({ length: max }, (_, i) => <i key={i} className={i < max - left ? 'taken' : ''} />)}
    </span>
  );
}

/** "Main Gate → RGIA Airport" (+ "via …" for intermediate stops) */
export function Route({ from, to, stops = [] }) {
  return (
    <span className="route">
      <strong>{shortPlace(from)}</strong>
      <span className="muted" aria-hidden> → </span><span className="sr-only"> to </span>
      <strong>{shortPlace(to)}</strong>
      {stops?.length > 0 && <span className="small muted"> via {stops.map(shortPlace).join(', ')}</span>}
    </span>
  );
}

/** Location dropdown grouped by type (campus, airport, railway, bus, mall, hub). */
export function LocationSelect({ value, onChange, label, allowAny, exclude, required }) {
  const { meta } = useApp();
  const groups = {};
  meta.locations.forEach((l) => { (groups[l.loc_type] ||= []).push(l); });
  return (
    <label className="field">{label}
      <select value={value} onChange={(e) => onChange(e.target.value)} required={required ?? !allowAny}>
        <option value="">{allowAny ? 'Anywhere' : 'Select…'}</option>
        {Object.entries(groups).map(([t, ls]) => (
          <optgroup key={t} label={t}>
            {ls.filter((l) => String(l.location_id) !== String(exclude)).map((l) => <option key={l.location_id} value={l.location_id}>{l.name}</option>)}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

export function Tabs({ tabs, value, onChange, label = 'Sections' }) {
  return (
    <div className="seg tabs" role="tablist" aria-label={label}>
      {tabs.map(([k, l, n]) => (
        <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>
          {l}{n ? <span className="count">{n}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, width = 520 }) {
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ width: `min(${width}px, calc(100vw - 32px))` }}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="modal-head"><h2>{title}</h2><button className="btn ghost" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="modal-body">{children}</div>
      </div>
    </>
  );
}

/** Small "who built this" tag shown in page headers. */
export function ModuleTag({ children }) {
  return <span className="module-tag">{children}</span>;
}
