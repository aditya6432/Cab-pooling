import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApp, useQuery } from '../hooks.js';
import { Card, DataTable, Meter } from '../components/ui.jsx';
import { fmtDateTime, fmtNum, fmtPct, relTime } from '../format.js';

export default function LeaderboardPage() {
  const { meta, toast, acting } = useApp();
  const [hostel, setHostel] = useState(0);
  const [minRatings, setMinRatings] = useState(5);
  const [refreshing, setRefreshing] = useState(false);
  const board = useQuery('leaderboard', { hostel_id: hostel, min_ratings: minRatings });
  const stale = useQuery('mv_staleness');
  const rows = board.data?.rows || [];
  const st = stale.data?.rows?.[0];

  async function refresh() {
    setRefreshing(true);
    try {
      const r = await api('/analytics/refresh', { method: 'POST' });
      toast({ kind: 'success', title: 'Materialized view refreshed', body: `REFRESH MATERIALIZED VIEW CONCURRENTLY took ${r.ms} ms; readers were never blocked` });
      board.reload(); stale.reload();
    } finally { setRefreshing(false); }
  }

  // The most striking "Bayesian vs raw" example in the current view
  const example = [...rows].filter((r) => r.raw_avg_rank < r.rank).sort((a, b) => (b.rank - b.raw_avg_rank) - (a.rank - a.raw_avg_rank))[0];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Trust leaderboard</h1>
          <p>Ranked by trust score (Bayesian rating + reliability). Served from the <span className="mono">mv_student_reputation</span> materialized view, which is fast to read but only as fresh as its last refresh.</p>
        </div>
      </div>

      <div className="filter-row">
        <label className="row small"><span className="label">Hostel</span>
          <select value={hostel} onChange={(e) => setHostel(Number(e.target.value))}>
            <option value={0}>All hostels</option>
            {meta.hostels.map((h) => <option key={h.hostel_id} value={h.hostel_id}>{h.name}</option>)}
          </select>
        </label>
        <span className="label">Minimum ratings</span>
        <div className="seg" role="group" aria-label="Minimum ratings">
          {[1, 3, 5, 10].map((n) => <button key={n} className={minRatings === n ? 'on' : ''} onClick={() => setMinRatings(n)}>{n}+</button>)}
        </div>
        <span className="spacer" />
        <span className="small muted">
          Snapshot taken {st ? relTime(st.refreshed_at) : '…'}
          {st?.changes_since_refresh > 0 && <> · <strong style={{ color: 'var(--critical-ink)' }}>{st.changes_since_refresh} rating change{st.changes_since_refresh > 1 ? 's' : ''} not reflected yet</strong></>}
        </span>
        <button className="btn primary" onClick={refresh} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh materialized view'}</button>
      </div>

      <div className="grid g-12">
        <Card className="span-8" title={`${rows.length} students`} sub="DENSE_RANK() by trust score · raw-average rank shown for comparison" result={board.data} loading={board.loading}>
          <DataTable rows={rows} empty="No students match these filters" columns={[
            { key: 'rank', label: '#', num: true, render: (r) => <strong>{r.rank}</strong> },
            { key: 'full_name', label: 'Student', render: (r) => (
              <span><Link to={`/profile/${r.student_id}`}>{r.full_name}</Link>{r.student_id === acting.student_id && <span className="badge blue" style={{ marginLeft: 6 }}>You</span>}
                <div className="small muted">{r.hostel}</div></span>) },
            { key: 'ratings_received', label: 'Ratings', num: true },
            { key: 'raw_avg', label: 'Raw avg (rank)', num: true, render: (r) => <span>{fmtNum(r.raw_avg)} <span className="muted">({r.raw_avg_rank})</span></span> },
            { key: 'bayes_score', label: 'Bayesian', num: true, render: (r) => fmtNum(r.bayes_score, 3) },
            { key: 'no_show_rate', label: 'No-show', num: true, render: (r) => fmtPct(100 * (r.no_show_rate ?? 0), 0) },
            { key: 'trust_score', label: 'Trust', render: (r) => (
              <div className="row" style={{ minWidth: 140 }}><div style={{ flex: 1 }}><Meter value={r.trust_score} /></div>
                <strong style={{ width: 26, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.trust_score}</strong></div>) },
          ]} />
        </Card>
        <div className="span-4 stack" style={{ gap: 16 }}>
          <Card title="Why not just sort by average?">
            <p className="secondary small">Someone with a single 5★ rating has a perfect 5.00 average, but we know almost nothing about them. The Bayesian average adds <strong>C = 5 virtual ratings at the campus mean</strong>, so a score only climbs as real evidence piles up.</p>
            {example && (
              <div className="alert info small" style={{ marginTop: 10 }}>
                <strong>{example.full_name}</strong> has the #{example.raw_avg_rank} raw average ({fmtNum(example.raw_avg)} from {example.ratings_received} ratings) but ranks <strong>#{example.rank}</strong> on trust: fewer ratings and/or no-shows pull them down.
              </div>
            )}
          </Card>
          <Card title="View vs materialized view" result={stale.data}>
            <div className="small secondary stack">
              <div><strong>Profile page</strong> reads <span className="mono">v_student_reputation</span>, a plain view recomputed on every read, so it is always fresh.</div>
              <div><strong>This page</strong> reads <span className="mono">mv_student_reputation</span>, a stored snapshot. Ranking 160 students on every page view would be wasted work when ratings change rarely.</div>
              <div><span className="mono">REFRESH … CONCURRENTLY</span> needs the UNIQUE index on <span className="mono">student_id</span> and lets reads continue during the refresh.</div>
              <div className="muted">Last refresh: {st ? fmtDateTime(st.refreshed_at) : '…'}</div>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
