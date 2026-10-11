import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '../hooks.js';
import { Card, DataTable, HBars, Meter, Stars, Empty } from '../components/ui.jsx';
import { ColumnChart, TrendLine, Heatmap } from '../components/charts.jsx';
import { fmtInt, fmtNum, fmtPct, fmtRupees, fmtDateTime, DAYS } from '../format.js';

const short = (route) => route.replace(/BPHC /g, '').replace(' (Shamshabad)', '').replace(' (Nampally)', '');

const DEST_TYPES = [['all', 'All trips'], ['airport', 'Airport'], ['railway', 'Railway'], ['bus', 'Bus'], ['mall', 'Malls'], ['hub', 'City hubs']];

export default function Dashboard() {
  const kpi = useQuery('kpi_overview');
  const trend = useQuery('monthly_trend');
  const [destType, setDestType] = useState('all');
  const heat = useQuery('demand_heatmap', { dest_type: destType });
  const topRoutes = useQuery('top_routes_by_weekday');
  const routes = useQuery('route_economics');
  const cabs = useQuery('occupancy_by_cab');
  const dist = useQuery('rating_distribution');
  const tags = useQuery('tag_frequency');
  const bias = useQuery('rater_bias');
  const hostels = useQuery('hostel_league');
  const noShows = useQuery('no_show_watchlist');
  const buddies = useQuery('ride_buddies');
  const audit = useQuery('audit_recent', { limit: 8 });

  const k = kpi.data?.rows?.[0];
  const months = trend.data?.rows || [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Campus pooling dashboard</h1>
          <p>Every number on this page is computed live by PostgreSQL. Click <span className="kbd">SQL</span> on any card to see the exact query, its DBMS concepts and its <span className="kbd">EXPLAIN ANALYZE</span> plan.</p>
        </div>
      </div>

      {/* ---------------- headline ---------------- */}
      <div className="grid g-12">
        <Card className="hero span-4" loading={kpi.loading}>
          <div className="label">Money saved by pooling</div>
          <div className="value">{fmtRupees(k?.rupees_saved)}</div>
          <div className="foot">compared with every rider booking a solo cab · {fmtInt(k?.cab_trips_avoided)} cab trips avoided</div>
        </Card>
        <Card className="span-8" title="At a glance" sub="Completed rides only, unless stated" result={kpi.data} loading={kpi.loading}>
          <div className="stats">
            <div className="stat"><div className="label">Rides completed</div><div className="value">{fmtInt(k?.rides_completed)}</div><div className="hint">of {fmtInt(k?.rides_total)} created · {fmtInt(k?.rides_upcoming)} upcoming</div></div>
            <div className="stat"><div className="label">Active riders</div><div className="value">{fmtInt(k?.active_riders)}</div><div className="hint">{fmtInt(k?.seats_travelled)} seat-trips travelled</div></div>
            <div className="stat"><div className="label">Average cab occupancy</div><div className="value">{fmtPct(k?.avg_occupancy_pct)}</div><div className="hint">seats filled ÷ cab capacity</div></div>
            <div className="stat"><div className="label">Average rating</div><div className="value row">{fmtNum(k?.avg_rating)} <Stars value={k?.avg_rating || 0} size={15} /></div><div className="hint">{fmtInt(k?.ratings_total)} ratings</div></div>
            <div className="stat"><div className="label">Rating coverage</div><div className="value">{fmtPct(k?.rating_coverage_pct)}</div><div className="hint">co-rider pairs that got rated</div></div>
            <div className="stat"><div className="label">CO₂ avoided (est.)</div><div className="value">{fmtInt(k?.co2_kg_saved)} kg</div><div className="hint">avoided km × 0.15 kg/km</div></div>
          </div>
        </Card>
      </div>

      {/* ---------------- trends ---------------- */}
      <div className="section-title"><h2>Trends</h2><span>Semester rhythm: end-sem exits in May, summer lull, August return</span></div>
      <div className="grid g-12">
        <Card className="span-7" title="Completed rides per month" sub="Current month is month-to-date" result={trend.data} loading={trend.loading}
          table={() => <DataTable rows={months} columns={[
            { key: 'label', label: 'Month' }, { key: 'rides', label: 'Rides', num: true }, { key: 'riders', label: 'Riders', num: true },
            { key: 'cumulative_rides', label: 'Cumulative', num: true }, { key: 'mom_change_pct', label: 'MoM %', num: true, render: (r) => r.mom_change_pct === null ? '—' : `${r.mom_change_pct > 0 ? '+' : ''}${r.mom_change_pct}%` },
            { key: 'saved', label: '₹ saved', num: true, render: (r) => fmtRupees(r.saved) }]} />}>
          {months.length ? (
            <ColumnChart data={months} x="label" y="rides" tipRows={(r) => [
              ['rides', fmtInt(r.rides)], ['riders', fmtInt(r.riders)], ['running total', fmtInt(r.cumulative_rides)],
              ['vs previous month', r.mom_change_pct === null ? '—' : `${r.mom_change_pct > 0 ? '+' : ''}${r.mom_change_pct}%`],
              ['saved', fmtRupees(r.saved)]]} />
          ) : <Empty>No data</Empty>}
        </Card>
        <Card className="span-5" title="Average rating per month" sub="Separate chart on its own scale: never a dual axis" result={trend.data} loading={trend.loading}
          table={() => <DataTable rows={months} columns={[{ key: 'label', label: 'Month' }, { key: 'avg_rating', label: 'Avg ★', num: true }, { key: 'ratings', label: 'Ratings', num: true }]} />}>
          {months.length ? (
            <TrendLine data={months.filter((m) => m.avg_rating !== null)} x="label" y="avg_rating" domain={[3.5, 5]} ticks={[3.5, 4, 4.5, 5]} height={220}
              yFormat={(v) => Number(v).toFixed(1)} tipRows={(r) => [['average rating', fmtNum(r.avg_rating)], ['ratings submitted', fmtInt(r.ratings)]]} />
          ) : <Empty>No data</Empty>}
        </Card>
      </div>

      {/* ---------------- demand ---------------- */}
      <div className="section-title"><h2>When do people travel?</h2><span>The filter below scopes this section</span></div>
      <div className="filter-row">
        <span className="label">Trips involving</span>
        <div className="seg" role="group" aria-label="Destination type">
          {DEST_TYPES.map(([v, l]) => <button key={v} className={destType === v ? 'on' : ''} onClick={() => setDestType(v)}>{l}</button>)}
        </div>
      </div>
      <Card title="Departure heatmap: day of week × hour (IST)" sub="Airport runs cluster before dawn; railway trips on Friday & Sunday evenings"
        result={heat.data} loading={heat.loading}
        table={() => <DataTable rows={heat.data?.rows || []} columns={[{ key: 'dow', label: 'Day', render: (r) => DAYS[r.dow - 1] }, { key: 'hour', label: 'Hour', num: true }, { key: 'rides', label: 'Rides', num: true }]} />}>
        {heat.data ? <Heatmap rows={heat.data.rows} /> : <Empty>Loading…</Empty>}
      </Card>

      {/* ---------------- routes ---------------- */}
      <div className="section-title"><h2>Routes & cabs</h2></div>
      <div className="grid g-12">
        <Card className="span-7" title="Busiest routes" sub="Rides per route; saving = 1 − (1 ÷ riders), averaged" result={routes.data} loading={routes.loading}
          table={() => <DataTable rows={routes.data?.rows || []} columns={[
            { key: 'route', label: 'Route' }, { key: 'rides', label: 'Rides', num: true }, { key: 'avg_riders', label: 'Avg riders', num: true },
            { key: 'avg_cab_fare', label: 'Cab fare', num: true, render: (r) => fmtRupees(r.avg_cab_fare) },
            { key: 'avg_fare_per_rider', label: 'Per rider', num: true, render: (r) => fmtRupees(r.avg_fare_per_rider) },
            { key: 'avg_saving_pct', label: 'Saving', num: true, render: (r) => fmtPct(r.avg_saving_pct, 0) }]} />}>
          <HBars rows={routes.data?.rows || []} labelWidth={230} label={(r) => short(r.route)} value={(r) => r.rides}
            format={(v) => `${v} rides`} tip={(r) => `${r.route}\n${r.rides} rides · avg ${r.avg_riders} riders · ${fmtRupees(r.avg_fare_per_rider)}/rider (${r.avg_saving_pct}% saved)`} />
        </Card>
        <Card className="span-5" title="How full do cabs get?" sub="Average occupancy by cab type" result={cabs.data} loading={cabs.loading}
          table={() => <DataTable rows={cabs.data?.rows || []} columns={[
            { key: 'cab_type', label: 'Cab' }, { key: 'max_seats', label: 'Seats', num: true }, { key: 'rides', label: 'Rides', num: true },
            { key: 'avg_seats_filled', label: 'Avg filled', num: true }, { key: 'occupancy_pct', label: 'Occupancy', num: true, render: (r) => fmtPct(r.occupancy_pct) },
            { key: 'full_pct', label: '% full', num: true, render: (r) => fmtPct(r.full_pct) }, { key: 'avg_fare_per_rider', label: '₹/rider', num: true }]} />}>
          <HBars rows={cabs.data?.rows || []} labelWidth={110} max={100} label={(r) => `${r.cab_type} · ${r.max_seats} seats`}
            value={(r) => r.occupancy_pct} format={(v) => fmtPct(v, 0)} tip={(r) => `${r.rides} rides · ${r.full_pct}% left completely full · ${fmtRupees(r.avg_fare_per_rider)} per rider`} />
          <p className="small muted" style={{ marginTop: 12 }}>Autos fill up most often; SUVs carry the most people per trip but often leave seats empty.</p>
        </Card>
        <Card className="span-12" title="Top 3 routes for each weekday" sub="RANK() OVER (PARTITION BY weekday): ties share a rank" result={topRoutes.data} loading={topRoutes.loading}
          table={() => <DataTable rows={topRoutes.data?.rows || []} columns={[{ key: 'day', label: 'Day' }, { key: 'rnk', label: 'Rank', num: true }, { key: 'route', label: 'Route' }, { key: 'rides', label: 'Rides', num: true }, { key: 'avg_riders', label: 'Avg riders', num: true }]} />}>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(128px, 1fr))', gap: 10 }}>
            {DAYS.map((d, i) => {
              const rows = (topRoutes.data?.rows || []).filter((r) => r.dow === i + 1);
              return (
                <div key={d} style={{ background: 'var(--surface-2)', borderRadius: 10, padding: '10px 12px' }}>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>{d}</div>
                  {rows.length ? rows.map((r, j) => (
                    <div key={j} className="small" style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                      <span className="muted" style={{ width: 14 }}>{r.rnk}</span>
                      <span style={{ flex: 1 }}>{short(r.route)}</span>
                      <span className="secondary nowrap">{r.rides}</span>
                    </div>)) : <div className="small muted">—</div>}
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      {/* ---------------- ratings ---------------- */}
      <div className="section-title"><h2>Ratings</h2><span>What the rating module is learning about riders</span></div>
      <div className="grid g-12">
        <Card className="span-4" title="Rating distribution" sub="All ratings, 1★ to 5★" result={dist.data} loading={dist.loading}
          table={() => <DataTable rows={dist.data?.rows || []} columns={[{ key: 'score', label: 'Stars', num: true }, { key: 'ratings', label: 'Ratings', num: true }, { key: 'pct', label: 'Share', num: true, render: (r) => fmtPct(r.pct) }]} />}>
          <ColumnChart data={(dist.data?.rows || []).map((r) => ({ ...r, label: `${r.score}★` }))} x="label" y="ratings" height={200} labelLast={false}
            tipRows={(r) => [['ratings', fmtInt(r.ratings)], ['of all ratings', fmtPct(r.pct)]]} />
        </Card>
        <Card className="span-4" title="Praise vs complaints" sub="Tag usage · blue = praise, red = complaint" result={tags.data} loading={tags.loading}
          table={() => <DataTable rows={tags.data?.rows || []} columns={[{ key: 'label', label: 'Tag' }, { key: 'sentiment', label: 'Sentiment' }, { key: 'uses', label: 'Uses', num: true }, { key: 'avg_score_when_used', label: 'Avg ★ when used', num: true }]} />}>
          <HBars rows={tags.data?.rows || []} labelWidth={168} label={(r) => `${r.sentiment === 'positive' ? '＋' : '−'} ${r.label}`} value={(r) => r.uses}
            color={(r) => (r.sentiment === 'positive' ? 'var(--pos)' : 'var(--neg)')} format={fmtInt}
            tip={(r) => `${r.label} (${r.sentiment}) · used ${r.uses}× · avg score when used ${r.avg_score_when_used ?? '—'}`} />
        </Card>
        <Card className="span-4" title="Harsh critics & generous raters" sub="How each rater scores people vs how everyone else scores the same people" result={bias.data} loading={bias.loading}>
          <DataTable rows={bias.data?.rows || []} columns={[
            { key: 'full_name', label: 'Rater', render: (r) => <Link to={`/profile/${r.rater_id}`}>{r.full_name}</Link> },
            { key: 'bias', label: 'Bias', num: true, render: (r) => `${r.bias > 0 ? '+' : ''}${fmtNum(r.bias)}★` },
            { key: 'label', label: '', render: (r) => <span className={`badge ${r.label === 'Harsh critic' ? 'bad' : r.label === 'Generous' ? 'blue' : ''}`}>{r.label}</span> }]} />
        </Card>
      </div>

      {/* ---------------- people ---------------- */}
      <div className="section-title"><h2>Hostels & people</h2></div>
      <div className="grid g-12">
        <Card className="span-7" title="Hostel league" sub="Average trust score of students with 3+ ratings" result={hostels.data} loading={hostels.loading}>
          <DataTable rows={hostels.data?.rows || []} columns={[
            { key: 'hostel', label: 'Hostel' },
            { key: 'participation_pct', label: 'Participation', num: true, render: (r) => `${r.active_riders}/${r.students}` },
            { key: 'seat_trips', label: 'Seat-trips', num: true },
            { key: 'avg_rating', label: 'Avg ★', num: true, render: (r) => fmtNum(r.avg_rating) },
            { key: 'no_show_pct', label: 'No-show', num: true, render: (r) => fmtPct(r.no_show_pct) },
            { key: 'avg_trust', label: 'Avg trust', render: (r) => <div className="row" style={{ minWidth: 150 }}><div style={{ flex: 1 }}><Meter value={r.avg_trust} /></div><span className="nowrap" style={{ fontVariantNumeric: 'tabular-nums', width: 34, textAlign: 'right' }}>{fmtNum(r.avg_trust, 1)}</span></div> }]} />
        </Card>
        <Card className="span-5" title="Reliability watchlist" sub="No-show rate above their OWN hostel's average (correlated subquery)" result={noShows.data} loading={noShows.loading}>
          <DataTable rows={noShows.data?.rows || []} empty="Nobody is above their hostel's average" columns={[
            { key: 'full_name', label: 'Student', render: (r) => <Link to={`/profile/${r.student_id}`}>{r.full_name}</Link> },
            { key: 'hostel', label: 'Hostel' },
            { key: 'no_shows', label: 'No-shows', num: true, render: (r) => `${r.no_shows}/${r.no_shows + r.rides_completed}` },
            { key: 'no_show_rate', label: 'Rate vs hostel', num: true, render: (r) => <span><strong>{fmtPct(100 * r.no_show_rate, 0)}</strong> <span className="muted">vs {fmtPct(100 * r.hostel_rate, 0)}</span></span> }]} />
        </Card>
        <Card className="span-6" title="Ride buddies" sub="Pairs who pooled together 3+ times (self-join on ride_member)" result={buddies.data} loading={buddies.loading}>
          <DataTable rows={buddies.data?.rows || []} columns={[
            { key: 'pair', label: 'Pair', render: (r) => <span><Link to={`/profile/${r.a_id}`}>{r.a_name}</Link> <span className="muted">&</span> <Link to={`/profile/${r.b_id}`}>{r.b_name}</Link></span> },
            { key: 'shared_rides', label: 'Rides', num: true },
            { key: 'mutual', label: 'Rate each other', num: true, render: (r) => `${r.a_rates_b ?? '—'} / ${r.b_rates_a ?? '—'}` }]} />
        </Card>
        <Card className="span-6" title="Audit trail" sub="Written only by the rating_audit trigger: the app never inserts here" result={audit.data} loading={audit.loading}>
          <DataTable rows={audit.data?.rows || []} columns={[
            { key: 'changed_at', label: 'When', render: (r) => <span className="nowrap">{fmtDateTime(r.changed_at)}</span> },
            { key: 'action', label: 'Action', render: (r) => <span className={`badge ${r.action === 'Withdrawn' ? 'bad' : r.action === 'Edited' ? 'blue' : ''}`}>{r.action}</span> },
            { key: 'who', label: 'Rater → ratee', render: (r) => <span className="small">{r.rater} → {r.ratee}</span> },
            { key: 'score', label: 'Score', num: true, render: (r) => r.old_score && r.new_score ? `${r.old_score}→${r.new_score}` : (r.new_score ?? r.old_score) }]} />
        </Card>
      </div>
    </>
  );
}
