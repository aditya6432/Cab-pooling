// Rides & bookings insights: Member 1's ride analytics and Member 2's booking analytics.
// Every card is one named query from db/queries/m1_users_rides.sql or m2_booking.sql.
import { useQuery } from '../hooks.js';
import { Card, DataTable, Empty, HBars, ModuleTag, Route } from '../components/ui.jsx';
import { ColumnChart, TrendLine } from '../components/charts.jsx';
import { fmtCompact, fmtInt, fmtMoney, fmtPct, fmtWhen, shortPlace } from '../format.js';

const route = (r) => `${shortPlace(r.origin)} → ${shortPlace(r.destination)}`;

export default function RidesInsights() {
  const kpi = useQuery('campus_kpis');
  const monthly = useQuery('monthly_growth');
  const hours = useQuery('busiest_hours');
  const popular = useQuery('popular_routes');
  const fill = useQuery('fill_by_route');
  const status = useQuery('status_mix');
  const cabs = useQuery('cab_mix');
  const fare = useQuery('fare_by_cab');
  const hostels = useQuery('hostel_ride_league');
  const stops = useQuery('stop_hotspots');
  const lead = useQuery('booking_lead_time');
  const cancel = useQuery('cancellation_lead_time');
  const funnel = useQuery('request_funnel');
  const noShow = useQuery('no_show_by_hostel');
  const queue = useQuery('waitlist_queue');
  const util = useQuery('seat_utilisation');
  const boarding = useQuery('boarding_points');
  const pairs = useQuery('co_rider_pairs');
  const k = kpi.data?.rows[0];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Rides &amp; bookings <ModuleTag>Member 1 · Member 2</ModuleTag></h1>
          <p>How the campus travels: demand by month and hour, which routes fill their cabs, how people book, cancel and wait. Click <strong>SQL</strong> on a card for the query, its DBMS concepts and its EXPLAIN ANALYZE plan.</p>
        </div>
      </div>

      <div className="grid g-12">
        <Card className="span-4 hero" result={kpi.data} loading={kpi.loading}>
          <div className="label">Saved by sharing cabs</div>
          <div className="value">{k ? fmtMoney(k.money_saved) : '—'}</div>
          <div className="foot">versus every rider booking a solo cab, completed rides only (campus_kpis: CTE + FILTER)</div>
        </Card>
        <Card className="span-8" title="At a glance" result={kpi.data} loading={kpi.loading}>
          {k && (
            <div className="stats">
              <div className="stat"><div className="label">Students</div><div className="value">{fmtInt(k.students)}</div><div className="hint">{k.active_creators} have offered a ride</div></div>
              <div className="stat"><div className="label">Rides created</div><div className="value">{fmtInt(k.rides_total)}</div><div className="hint">{k.rides_completed} completed · {k.rides_cancelled} cancelled</div></div>
              <div className="stat"><div className="label">Upcoming</div><div className="value">{fmtInt(k.rides_upcoming)}</div><div className="hint">open or full, still to leave</div></div>
              <div className="stat"><div className="label">Average occupancy</div><div className="value">{fmtPct(k.avg_occupancy_pct)}</div><div className="hint">confirmed riders ÷ cab seats</div></div>
              <div className="stat"><div className="label">Average trip</div><div className="value">{k.avg_km} km</div><div className="hint">road distance, completed rides</div></div>
              <div className="stat"><div className="label">Rides per creator</div><div className="value">{(k.rides_total / k.active_creators).toFixed(1)}</div><div className="hint">across active creators</div></div>
            </div>
          )}
        </Card>
      </div>

      <div className="section-title"><h2>Demand</h2><span>Member 1</span></div>
      <div className="grid g-2">
        <Card title="Rides per month" sub="date_trunc + LAG(): change against the previous month. The current month is month-to-date." result={monthly.data} loading={monthly.loading}
          table={() => <DataTable rows={monthly.data?.rows} columns={[{ key: 'month', label: 'Month' }, { key: 'rides', label: 'Rides', num: true }, { key: 'change_vs_prev', label: 'Change', num: true }]} />}>
          {monthly.data && <TrendLine data={monthly.data.rows} x="month" y="rides" height={220} yFormat={fmtInt}
            tipRows={(r) => [['rides', fmtInt(r.rides)], ['vs previous month', r.change_vs_prev == null ? '—' : `${r.change_vs_prev > 0 ? '+' : ''}${r.change_vs_prev}`]]} />}
        </Card>
        <Card title="Departures by hour of day (IST)" sub="EXTRACT(HOUR FROM … AT TIME ZONE 'Asia/Kolkata')" result={hours.data} loading={hours.loading}
          table={() => <DataTable rows={hours.data?.rows} columns={[{ key: 'hour', label: 'Hour', num: true }, { key: 'rides', label: 'Rides', num: true }]} />}>
          {hours.data && <ColumnChart data={hours.data.rows.map((r) => ({ ...r, label: String(r.hour).padStart(2, '0') }))} x="label" y="rides" height={220} labelLast={false}
            tipRows={(r) => [['rides', fmtInt(r.rides)]]} />}
        </Card>
      </div>

      <div className="section-title"><h2>Routes</h2><span>Members 1 and 2</span></div>
      <div className="grid g-2">
        <Card title="Most popular routes" sub="RANK() OVER (ORDER BY count(*) DESC)" result={popular.data} loading={popular.loading}
          table={() => <DataTable rows={popular.data?.rows} columns={[{ key: 'popularity_rank', label: '#', num: true }, { key: 'r', label: 'Route', render: route }, { key: 'rides', label: 'Rides', num: true }, { key: 'avg_km', label: 'km', num: true }]} />}>
          {popular.data && <HBars rows={popular.data.rows.slice(0, 8)} labelWidth={190} label={route} value={(r) => r.rides} />}
        </Card>
        <Card title="Which routes fill their cabs best?" sub="Average seats used ÷ seats offered, ranked (Member 2)" result={fill.data} loading={fill.loading}
          table={() => <DataTable rows={fill.data?.rows} columns={[{ key: 'fill_rank', label: '#', num: true }, { key: 'r', label: 'Route', render: route }, { key: 'rides', label: 'Rides', num: true }, { key: 'avg_fill_pct', label: 'Fill', num: true, render: (r) => fmtPct(r.avg_fill_pct) }]} />}>
          {fill.data && <HBars rows={fill.data.rows.slice(0, 8)} labelWidth={190} label={route} value={(r) => r.avg_fill_pct} max={100} format={(v) => fmtPct(v, 0)} />}
        </Card>
        <Card title="Where rides stop on the way" sub="Weak entity ride_stop joined to location" result={stops.data} loading={stops.loading}>
          {stops.data && <HBars rows={stops.data.rows.slice(0, 8)} labelWidth={170} label={(r) => r.stop} value={(r) => r.rides_with_stop} />}
        </Card>
        <Card title="Boarding and leaving mid-route" sub="Pickups and drop-offs at intermediate stops: ride pooling (UNION ALL + FILTER)" result={boarding.data} loading={boarding.loading}>
          <DataTable rows={boarding.data?.rows} empty="No mid-route boardings yet" columns={[
            { key: 'stop', label: 'Stop' }, { key: 'boardings', label: 'Board here', num: true }, { key: 'alightings', label: 'Leave here', num: true }]} />
        </Card>
      </div>

      <div className="section-title"><h2>Cabs and people</h2><span>Members 1 and 2</span></div>
      <div className="grid g-3">
        <Card title="Ride status" sub="Share of all rides: window SUM() OVER ()" result={status.data} loading={status.loading}>
          {status.data && <HBars rows={status.data.rows} labelWidth={90} label={(r) => r.status} value={(r) => r.share_pct} max={100} format={(v) => fmtPct(v, 0)} />}
        </Card>
        <Card title="Cab mix" sub="Completed rides by cab type, with occupancy" result={cabs.data} loading={cabs.loading}>
          {cabs.data && <HBars rows={cabs.data.rows} labelWidth={70} label={(r) => r.cab_type} value={(r) => r.rides} tip={(r) => `${fmtPct(r.avg_occupancy_pct)} full on average`} />}
          {cabs.data && <div className="small muted" style={{ marginTop: 8 }}>{cabs.data.rows.map((r) => `${r.cab_type} ${fmtPct(r.avg_occupancy_pct, 0)} full`).join(' · ')}</div>}
        </Card>
        <Card title="Fare per head by cab" sub="fn_estimate_fare ÷ confirmed riders" result={fare.data} loading={fare.loading}>
          {fare.data && <HBars rows={fare.data.rows} labelWidth={70} label={(r) => r.cab_type} value={(r) => r.avg_fare_per_head} format={fmtMoney} />}
        </Card>
        <Card title="Hostel league: rides offered" sub="LEFT JOIN + GROUP BY" result={hostels.data} loading={hostels.loading}>
          {hostels.data && <HBars rows={hostels.data.rows} labelWidth={90} label={(r) => r.hostel} value={(r) => r.rides_created} />}
        </Card>
        <Card title="No-show rate by hostel" sub="Conditional aggregation, HAVING ≥ 20 bookings (Member 2)" result={noShow.data} loading={noShow.loading}>
          {noShow.data && <HBars rows={noShow.data.rows} labelWidth={90} label={(r) => r.hostel} value={(r) => r.no_show_pct} format={(v) => fmtPct(v)} />}
        </Card>
        <Card title="Pairs who keep sharing rides" sub="Self-join of ride_member" result={pairs.data} loading={pairs.loading}>
          <DataTable rows={pairs.data?.rows?.slice(0, 8)} columns={[{ key: 'rider_a', label: 'Rider' }, { key: 'rider_b', label: 'With' }, { key: 'shared_rides', label: 'Rides', num: true }]} />
        </Card>
      </div>

      <div className="section-title"><h2>Booking behaviour</h2><span>Member 2</span></div>
      <div className="grid g-2">
        <Card title="How early do riders cancel?" sub="CASE buckets over cancelled_at − departure" result={cancel.data} loading={cancel.loading}>
          {cancel.data && <HBars rows={cancel.data.rows} labelWidth={150} label={(r) => r.bucket.replace(/^\d\. /, '')} value={(r) => r.cancellations} tip={(r) => fmtPct(r.share_pct)} />}
        </Card>
        <Card title="Approval requests: how are they decided?" sub="CTE + FILTER, average minutes to decide" result={funnel.data} loading={funnel.loading}>
          <DataTable rows={funnel.data?.rows} columns={[{ key: 'status', label: 'Outcome' }, { key: 'requests', label: 'Requests', num: true }, { key: 'share_pct', label: 'Share', num: true, render: (r) => fmtPct(r.share_pct) }, { key: 'avg_minutes_to_decide', label: 'Minutes to decide', num: true }]} />
        </Card>
        <Card title="How far ahead do people book?" sub="percentile_cont: median and 90th percentile" result={lead.data} loading={lead.loading}>
          <DataTable rows={lead.data?.rows} columns={[{ key: 'cab_type', label: 'Cab' }, { key: 'bookings', label: 'Bookings', num: true }, { key: 'median_hours_ahead', label: 'Median h ahead', num: true }, { key: 'p90_hours_ahead', label: '90th pct h', num: true }]} />
        </Card>
        <Card title="Seat utilisation" sub="GROUP BY ROLLUP (cab, status): subtotals included" result={util.data} loading={util.loading}>
          <DataTable rows={util.data?.rows} columns={[{ key: 'cab_type', label: 'Cab', render: (r) => r.cab_type ?? <strong>All cabs</strong> }, { key: 'ride_status', label: 'Status', render: (r) => r.ride_status ?? <span className="muted">subtotal</span> }, { key: 'seats_used', label: 'Used', num: true, render: (r) => fmtCompact(r.seats_used) }, { key: 'seats_offered', label: 'Offered', num: true, render: (r) => fmtCompact(r.seats_offered) }, { key: 'utilisation_pct', label: 'Utilisation', num: true, render: (r) => fmtPct(r.utilisation_pct) }]} />
        </Card>
      </div>
      <Card title="Full rides with a queue" sub="Aggregate over v_waitlist_position, HAVING count ≥ 1" result={queue.data} loading={queue.loading} style={{ marginTop: 16 }}>
        {queue.data?.rows?.length ? <DataTable rows={queue.data.rows.slice(0, 10)} columns={[
          { key: 'r', label: 'Ride', render: (r) => <Route from={r.origin} to={r.destination} /> },
          { key: 'day', label: 'Day', render: (r) => fmtWhen(r.day).split(',').slice(0, 2).join(',') },
          { key: 'people_waiting', label: 'Waiting', num: true }, { key: 'seats_wanted', label: 'Seats wanted', num: true }, { key: 'longest_wait_h', label: 'Longest wait (h)', num: true }]} />
          : <Empty>No queues right now.</Empty>}
      </Card>
    </>
  );
}
