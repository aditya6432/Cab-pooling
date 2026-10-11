// My rides: Member 2's booking views (seats, waitlist, requests, hosting tools, activity feed)
// and Member 1's ride list + cancel. Every action calls a stored function; triggers enforce the rules.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useApp } from '../hooks.js';
import { Avatar, Card, DataTable, DbError, Empty, ModuleTag, RideStatus, Route, Seats, Tabs } from '../components/ui.jsx';
import { fmtDateTime, fmtMoney, fmtWhen } from '../format.js';

const EVENT_TEXT = {
  booked: 'booked a seat', requested: 'asked to join', accepted: 'request accepted', rejected: 'request rejected', withdrawn: 'withdrew a request',
  waitlisted: 'joined the waitlist', promoted: 'was promoted from the waitlist', left_waitlist: 'left the waitlist', cancelled: 'cancelled the booking',
  late_cancel: 'cancelled late (under 2 h before departure)', removed: 'was removed by the creator', no_show: 'did not show up', ride_cancelled: 'ride was cancelled',
};
const upcoming = (r) => ['open', 'full'].includes(r.ride_status) && new Date(r.depart_end) > new Date();

function useAction(refresh) {
  const { toast, refreshCounts } = useApp();
  const [err, setErr] = useState(null);
  const run = async (path, body, ok) => {
    setErr(null);
    try { const r = await api(path, { method: 'POST', body }); if (ok) toast(ok(r)); refresh(); refreshCounts?.(); return r; }
    catch (x) { setErr(x); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  };
  return [err, run];
}

function RideHead({ r, children }) {
  return (
    <div className="row wrap" style={{ alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 200 }}>
        <Route from={r.origin} to={r.destination} stops={r.stops} />
        <div className="small secondary" style={{ marginTop: 2 }}>{fmtWhen(r.depart_start)} · {r.cab_type} · ride #{r.ride_id}</div>
      </div>
      {children}
      <RideStatus status={r.ride_status} />
    </div>
  );
}

function Seating({ v, refresh }) {
  const { data } = useApi('/bookings/mine', {}, [v]);
  const [err, run] = useAction(refresh);
  if (!data) return <Empty>Loading…</Empty>;
  const seats = data.bookings.filter((b) => b.booking_status === 'confirmed' && upcoming(b));
  const past = data.bookings.filter((b) => !(b.booking_status === 'confirmed' && upcoming(b)));
  const pending = data.requests.filter((q) => q.request_status === 'pending');
  const s = data.stats;
  return (
    <>
      <DbError error={err} />
      {s && (
        <Card style={{ marginBottom: 16 }} title="Your booking record" sub="v_student_booking_stats (rides you created are excluded)">
          <div className="stats stats-5">
            <div className="stat"><div className="label">Bookings</div><div className="value">{s.bookings}</div></div>
            <div className="stat"><div className="label">Trips taken</div><div className="value">{s.trips_taken}</div></div>
            <div className="stat"><div className="label">Cancelled</div><div className="value">{s.self_cancelled}</div></div>
            <div className="stat"><div className="label">No-shows</div><div className="value">{s.no_shows}</div></div>
            <div className="stat"><div className="label">Reliability</div><div className="value">{s.reliability_pct ?? '—'}{s.reliability_pct != null && '%'}</div></div>
          </div>
        </Card>
      )}
      <div className="section-title"><h2>Seats on upcoming rides</h2><span>Cancel and the first person on the waitlist who fits is promoted by a trigger</span></div>
      {seats.length === 0 && <Empty>No upcoming seats. <Link to="/search">Find a ride</Link>.</Empty>}
      <div className="ride-grid">{seats.map((b) => (
        <article className="card ride-tile" key={b.ride_id}>
          <RideHead r={b} />
          <div className="small">You travel <strong>{b.pickup}</strong> → <strong>{b.dropoff}</strong> · {b.my_seats} seat{b.my_seats > 1 ? 's' : ''}</div>
          <div className="row wrap"><Seats left={b.seats_left} max={b.max_seats} /><span className="small muted">hosted by {b.creator_name}</span><span className="spacer" /><span className="small">{fmtMoney(b.fare_per_head_now)} / head now</span></div>
          <button className="btn sm danger" onClick={() => run(`/bookings/ride/${b.ride_id}/cancel`, undefined, (r) => ({ title: 'Booking cancelled', text: `${r.seats_released} seat(s) released. Anyone waiting who fits was promoted automatically.` }))}>Cancel my seat</button>
        </article>))}
      </div>
      {data.waitlist.length > 0 && (<>
        <div className="section-title"><h2>Waitlist</h2><span>Position = order of joining (ROW_NUMBER() OVER the queue)</span></div>
        <div className="ride-grid">{data.waitlist.map((w) => (
          <article className="card ride-tile" key={w.ride_id}>
            <RideHead r={{ ...w, ride_status: w.ride_status }}><span className="badge blue">#{w.position} in line</span></RideHead>
            <div className="small muted">Waiting for {w.my_seats} seat{w.my_seats > 1 ? 's' : ''} · {w.waitlist_size} in the queue · promoted automatically</div>
            <button className="btn sm" onClick={() => run(`/bookings/ride/${w.ride_id}/waitlist/leave`, undefined, () => ({ title: 'Left the waitlist' }))}>Leave the waitlist</button>
          </article>))}
        </div>
      </>)}
      {pending.length > 0 && (<>
        <div className="section-title"><h2>Requests waiting for the creator</h2></div>
        <div className="ride-grid">{pending.map((q) => (
          <article className="card ride-tile" key={q.request_id}>
            <RideHead r={q}><span className="badge warn">◷ Pending</span></RideHead>
            <div className="small muted">Hosted by {q.creator_name} · sent {fmtDateTime(q.created_at)}</div>
            <button className="btn sm" onClick={() => run(`/bookings/requests/${q.request_id}/withdraw`, undefined, () => ({ title: 'Request withdrawn' }))}>Withdraw</button>
          </article>))}
        </div>
      </>)}
      <div className="section-title"><h2>Booking history</h2></div>
      <Card>
        <DataTable rows={past.slice(0, 20)} empty="Nothing yet" columns={[
          { key: 'route', label: 'Ride', render: (b) => <Route from={b.origin} to={b.destination} /> },
          { key: 'when', label: 'When', render: (b) => <span className="nowrap">{fmtWhen(b.depart_start)}</span> },
          { key: 'booking_status', label: 'My booking', render: (b) => <span>{b.booking_status.replace('_', '-')}{b.cancel_reason ? ` (${b.cancel_reason.replace('_', ' ')})` : ''}</span> },
          { key: 'ride_status', label: 'Ride', render: (b) => <RideStatus status={b.ride_status} /> },
          { key: 'money', label: '', render: (b) => (b.ride_status === 'completed' && b.booking_status === 'confirmed' ? <Link to={`/expenses/${b.ride_id}`}>Fare & split →</Link> : null) },
        ]} />
      </Card>
    </>
  );
}

function Hosting({ v, refresh }) {
  const { data } = useApi('/bookings/hosting', {}, [v]);
  const [err, run] = useAction(refresh);
  if (!data) return <Empty>Loading…</Empty>;
  if (!data.length) return <Empty>You are not hosting an active ride. <Link to="/create">Offer a ride</Link>.</Empty>;
  return (
    <>
      <DbError error={err} />
      <div className="stack" style={{ gap: 16 }}>{data.map((r) => (
        <Card key={r.ride_id}>
          <RideHead r={r} />
          <div className="row wrap" style={{ margin: '10px 0' }}>
            <Seats left={r.seats_left} max={r.max_seats} /><span className="small muted">{r.seats_left} left · {r.waitlist_size} waiting · {fmtMoney(r.fare_per_head_now)} / head now</span>
            <span className="spacer" />
            {['open', 'full'].includes(r.ride_status) && (
              <label className="small row" style={{ gap: 6 }}>Riders
                <select value={r.join_mode} onChange={(e) => run(`/bookings/ride/${r.ride_id}/policy`, { joinMode: e.target.value }, () => ({ title: 'Booking policy updated', text: e.target.value === 'approval' ? 'New riders must be approved by you.' : 'Riders now book instantly.' }))}>
                  <option value="instant">book instantly</option><option value="approval">need my approval</option></select></label>)}
          </div>
          {r.requests.length > 0 && (
            <div className="sub-block">
              <div className="small"><strong>Requests</strong></div>
              {r.requests.map((q) => (
                <div className="row wrap sub-row" key={q.request_id}>
                  <Avatar name={q.full_name} />
                  <span style={{ flex: 1, minWidth: 180 }}><strong>{q.full_name}</strong> <span className="small muted">{q.hostel} · {q.seats} seat{q.seats > 1 ? 's' : ''} · {q.pickup} → {q.dropoff}{q.message ? ` · “${q.message}”` : ''}</span></span>
                  <button className="btn sm primary" onClick={() => run(`/bookings/requests/${q.request_id}/decide`, { accept: true }, () => ({ title: 'Request accepted', text: `${q.full_name} now has a seat.` }))}>Accept</button>
                  <button className="btn sm" onClick={() => run(`/bookings/requests/${q.request_id}/decide`, { accept: false }, () => ({ title: 'Request rejected' }))}>Reject</button>
                </div>))}
            </div>)}
          <div className="sub-block">
            <div className="small"><strong>Passengers</strong></div>
            {r.members.map((m) => (
              <div className="row wrap sub-row" key={m.student_id}>
                <Avatar name={m.full_name} />
                <span style={{ flex: 1, minWidth: 180 }}>{m.full_name}{m.is_creator && <span className="badge blue" style={{ marginLeft: 6 }}>You</span>} <span className="small muted">{m.seats_taken > 1 ? `${m.seats_taken} seats · ` : ''}{m.pickup} → {m.dropoff}{m.status === 'no_show' ? ' · no-show' : ''}</span></span>
                {!m.is_creator && ['open', 'full'].includes(r.ride_status) && <button className="btn sm" onClick={() => run(`/bookings/ride/${r.ride_id}/remove`, { studentId: m.student_id.trim() }, () => ({ title: 'Rider removed', text: 'The seat is free again.' }))}>Remove</button>}
                {!m.is_creator && ['departed', 'completed'].includes(r.ride_status) && m.status === 'confirmed' && <button className="btn sm" onClick={() => run(`/bookings/ride/${r.ride_id}/no-show`, { studentId: m.student_id.trim() }, () => ({ title: 'Marked as a no-show' }))}>No-show</button>}
              </div>))}
          </div>
          {r.waitlist.length > 0 && <div className="small muted" style={{ marginTop: 8 }}>Waitlist: {r.waitlist.map((w) => `#${w.position} ${w.full_name} (${w.seats})`).join(', ')}</div>}
          <div className="row wrap" style={{ marginTop: 12 }}>
            {['open', 'full'].includes(r.ride_status) && <button className="btn sm" onClick={() => run(`/bookings/ride/${r.ride_id}/start`, undefined, () => ({ title: 'Ride started', text: 'Bookings are closed; the waitlist and open requests were cleared by a trigger.' }))}>Start ride</button>}
            {r.ride_status === 'departed' && <button className="btn sm primary" onClick={() => run(`/bookings/ride/${r.ride_id}/complete`, undefined, () => ({ title: 'Ride completed', text: 'Riders can now record the fare, settle up and rate each other.' }))}>Complete ride</button>}
            {r.ride_status === 'completed' && <Link className="btn sm primary" to={`/expenses/${r.ride_id}`}>Record the fare →</Link>}
            {['open', 'full'].includes(r.ride_status) && <button className="btn sm danger" onClick={() => run(`/rides/${r.ride_id}/cancel`, undefined, () => ({ title: 'Ride cancelled', text: 'Riders were released and the waitlist cleared by triggers; the status change was logged.' }))}>Cancel ride</button>}
          </div>
        </Card>))}
      </div>
    </>
  );
}

function AllRides({ v }) {
  const { data } = useApi('/rides/mine', {}, [v]);
  if (!data) return <Empty>Loading…</Empty>;
  return (
    <Card title="Every ride you created or joined" sub="v_ride_board (Member 1): seats are computed, never stored">
      <DataTable rows={data} empty="You have no rides yet" columns={[
        { key: 'route', label: 'Ride', render: (r) => <Route from={r.origin} to={r.destination} stops={r.stops} /> },
        { key: 'when', label: 'When', render: (r) => <span className="nowrap">{fmtWhen(r.depart_start)}</span> },
        { key: 'role', label: 'Role', render: (r) => (r.is_creator ? <span className="badge blue">Creator</span> : <span className="badge">Rider</span>) },
        { key: 'seats', label: 'Seats', render: (r) => <Seats left={r.seats_left} max={r.max_seats} /> },
        { key: 'status', label: 'Status', render: (r) => <RideStatus status={r.status} /> },
      ]} />
    </Card>
  );
}

function Activity({ v }) {
  const { data } = useApi('/bookings/events', {}, [v]);
  if (!data) return <Empty>Loading…</Empty>;
  const List = ({ rows, who }) => (
    <DataTable rows={rows.slice(0, 15)} empty="Nothing yet" columns={[
      { key: 'created_at', label: 'When', render: (e) => <span className="nowrap small muted">{fmtDateTime(e.created_at)}</span> },
      { key: 'event', label: 'What happened', render: (e) => <span>{who ? <strong>{e.full_name} </strong> : 'You '}{EVENT_TEXT[e.event]}{e.seats > 1 ? ` (${e.seats} seats)` : ''}</span> },
      { key: 'ride', label: 'Ride', render: (e) => <Route from={e.origin} to={e.destination} /> },
    ]} />);
  return (
    <div className="grid g-2">
      <Card title="What happened to my bookings" sub="booking_event: append-only, written by triggers"><List rows={data.mine} /></Card>
      <Card title="What happened on rides I host"><List rows={data.onMyRides} who /></Card>
    </div>
  );
}

export default function MyRidesPage() {
  const { counts } = useApp();
  const [tab, setTab] = useState(() => (counts.booking > 0 ? 'hosting' : 'seats'));
  const [v, setV] = useState(0);
  const refresh = () => setV((x) => x + 1);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>My rides <ModuleTag>Member 2 booking · Member 1 rides</ModuleTag></h1>
          <p>Seats you hold, rides you host and everything that happened to them. Capacity, overlap, waitlist promotion and the ride / booking state machines are all enforced inside PostgreSQL.</p>
        </div>
      </div>
      <div style={{ marginBottom: 16 }}>
        <Tabs value={tab} onChange={setTab} tabs={[['seats', 'My seats'], ['hosting', 'Hosting', counts.booking], ['all', 'All rides'], ['activity', 'Activity']]} />
      </div>
      {tab === 'seats' && <Seating v={v} refresh={refresh} />}
      {tab === 'hosting' && <Hosting v={v} refresh={refresh} />}
      {tab === 'all' && <AllRides v={v} />}
      {tab === 'activity' && <Activity v={v} />}
    </>
  );
}
