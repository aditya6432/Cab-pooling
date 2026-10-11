// Home: everything waiting for the logged-in student, from all five modules,
// computed by ONE cross-module query (my_todo: a UNION ALL over six sources).
import { Link } from 'react-router-dom';
import { useApi, useApp, useQuery } from '../hooks.js';
import { Card, Empty, HBars, Meter, Route, RideStatus } from '../components/ui.jsx';
import { fmtMoney, fmtWhen, relTime } from '../format.js';

const KIND = {
  confirm_payment: { icon: '◷', label: 'Confirm a payment', who: 'M4' },
  approve_request: { icon: '✋', label: 'Approve a rider', who: 'M2' },
  pay: { icon: '₹', label: 'Pay what you owe', who: 'M4' },
  rate: { icon: '★', label: 'Rate a co-rider', who: 'M5' },
  add_expense: { icon: '🧾', label: 'Record the fare', who: 'M3' },
  complete_ride: { icon: '➜', label: 'Complete your ride', who: 'M2' },
};

export default function HomePage() {
  const { me } = useApp();
  const todo = useQuery('my_todo');
  const overview = useQuery('student_overview');
  const funnel = useQuery('ride_lifecycle_funnel');
  const mine = useApi('/bookings/mine');
  const hosting = useApi('/bookings/hosting');
  const o = overview.data?.rows[0];
  const items = todo.data?.rows || [];

  const upcoming = [
    ...(hosting.data || []).filter((r) => ['open', 'full', 'departed'].includes(r.ride_status)).map((r) => ({ ...r, role: 'Hosting' })),
    ...((mine.data?.bookings) || []).filter((b) => b.booking_status === 'confirmed' && ['open', 'full', 'departed'].includes(b.ride_status)).map((b) => ({ ...b, role: 'Seat booked' })),
  ].sort((a, b) => new Date(a.depart_start) - new Date(b.depart_start)).slice(0, 6);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Hi, {me.full_name.split(' ')[0]}</h1>
          <p>Your rides, money and ratings in one place. Every number here comes live from PostgreSQL; click <strong>SQL</strong> on any card to see the query.</p>
        </div>
        <div className="row wrap">
          <Link className="btn" to="/search">Find a ride</Link>
          <Link className="btn primary" to="/create">Offer a ride</Link>
        </div>
      </div>

      <div className="grid g-12">
        <Card className="span-12" result={overview.data} loading={overview.loading}
          title="You across all five modules" sub="One row of v_student_overview: a view that joins a view from every module">
          {o ? (
            <div className="stats stats-5">
              <div className="stat"><div className="label">Rides offered · joined</div><div className="value">{o.rides_created} · {o.rides_joined}</div><div className="hint">Member 1</div></div>
              <div className="stat"><div className="label">Booking reliability</div><div className="value">{o.reliability_pct ?? '—'}{o.reliability_pct != null && '%'}</div><div className="hint">Member 2 · {o.no_shows} no-show{o.no_shows === 1 ? '' : 's'}</div></div>
              <div className="stat"><div className="label">You are owed</div><div className="value pos">{fmtMoney(o.owed)}</div><div className="hint">Members 3 + 4{o.pending_in > 0 ? ` · ${fmtMoney(o.pending_in)} paid, waiting for your confirmation` : ''}</div></div>
              <div className="stat"><div className="label">You owe</div><div className={`value ${o.owes > 0 ? 'neg' : ''}`}>{fmtMoney(o.owes)}</div><div className="hint">{o.pending_out > 0 ? `${fmtMoney(o.pending_out)} sent, waiting for the payee` : 'Members 3 + 4'}</div></div>
              <div className="stat"><div className="label">Trust score</div><div className="value">{o.trust_score}<span className="muted" style={{ fontSize: 14 }}> / 100</span></div><Meter value={o.trust_score} /><div className="hint">Member 5 · {o.ratings_received} ratings</div></div>
            </div>
          ) : <Empty>Loading…</Empty>}
        </Card>

        <Card className="span-7" result={todo.data} loading={todo.loading}
          title={`To do · ${items.length}`} sub="my_todo: booking requests, rides to complete, fares to record, payments to confirm and make, co-riders to rate">
          {items.length === 0 && !todo.loading ? <Empty icon="✓">Nothing waiting for you.</Empty> : (
            <div className="todo">
              {items.map((t, i) => {
                const k = KIND[t.kind] || { icon: '•', label: t.kind };
                return (
                  <Link key={i} to={t.link} className="todo-item">
                    <span className="todo-icon" aria-hidden>{k.icon}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="row wrap" style={{ gap: 6 }}><strong>{k.label}</strong><span className="badge">{k.who}</span>{t.ride_id && <span className="small muted">ride #{t.ride_id}</span>}</span>
                      <span className="small secondary" style={{ display: 'block' }}>{t.text}</span>
                    </span>
                    {t.amount != null && <span className="money-amt">{fmtMoney(t.amount)}</span>}
                    <span className="small muted nowrap">{relTime(t.at)}</span>
                  </Link>
                );
              })}
            </div>
          )}
        </Card>

        <Card className="span-5" title="Your upcoming trips" sub="Seats you hold and rides you host (Member 2)" loading={mine.loading || hosting.loading}>
          {upcoming.length === 0 ? <Empty>No upcoming trips. <Link to="/search">Find a ride</Link>.</Empty> : upcoming.map((r) => (
            <div key={`${r.role}-${r.ride_id}`} className="trip">
              <div className="row wrap"><Route from={r.origin} to={r.destination} stops={r.stops} /><span className="spacer" /><RideStatus status={r.ride_status} /></div>
              <div className="row wrap small secondary" style={{ marginTop: 2 }}>
                <span>{fmtWhen(r.depart_start)}</span><span>·</span><span>{r.cab_type}</span><span>·</span>
                <span className="badge">{r.role}</span>
                {r.role === 'Hosting' && r.requests?.length > 0 && <span className="badge warn">{r.requests.length} request{r.requests.length > 1 ? 's' : ''}</span>}
                <span className="spacer" /><span>{fmtMoney(r.fare_per_head_now)} / head now</span>
              </div>
            </div>
          ))}
          <div style={{ marginTop: 10 }}><Link to="/rides">Manage my rides →</Link></div>
        </Card>

        <Card className="span-12" result={funnel.data} loading={funnel.loading}
          title="How a ride flows through PoolUp" sub="ride_lifecycle_funnel: each stage is owned by a different module and checked with EXISTS against its tables">
          {funnel.data && (
            <HBars rows={funnel.data.rows} labelWidth={210} label={(r) => r.stage} value={(r) => r.rides}
              format={(v) => v} tip={(r) => `${r.pct_of_completed}% of completed rides`} />
          )}
        </Card>
      </div>
    </>
  );
}
