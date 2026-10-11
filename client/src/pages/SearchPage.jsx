// Member 1: ride search (fn_search_rides matches rides that pass through your stops, in order).
// Member 2: book from the results, and join the waitlist of full rides on the same route.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useApp } from '../hooks.js';
import { Avatar, Card, Empty, LocationSelect, ModuleTag, Route, Seats } from '../components/ui.jsx';
import { SqlCode } from '../components/Sql.jsx';
import { fmtHM, fmtMoney, fmtWhen, toLocalInput } from '../format.js';
import BookDialog from './BookDialog.jsx';

export default function SearchPage() {
  const { meta } = useApp();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState({ origin: '', dest: '', from: toLocalInput(new Date()), to: '', seats: 1, cab: '' });
  const [applied, setApplied] = useState(q);
  const [showSql, setShowSql] = useState(false);
  const [booking, setBooking] = useState(params.get('ride') ? Number(params.get('ride')) : null);
  const [v, setV] = useState(0);
  const [full, setFull] = useState([]);
  const [shown, setShown] = useState(24);
  const iso = (x) => (x ? new Date(x).toISOString() : '');
  const res = useApi('/rides/search', { query: { ...applied, from: iso(applied.from), to: iso(applied.to) } }, [v]);
  useEffect(() => { api('/bookings/full', { query: { origin: applied.origin, dest: applied.dest } }).then(setFull).catch(() => setFull([])); }, [applied, v]);
  const set = (k) => (x) => setQ({ ...q, [k]: x?.target ? x.target.value : x });
  const maxSeats = (cab) => meta.cabTypes.find((c) => c.cab_type === cab)?.max_seats ?? 4;
  const rows = res.data?.rows || [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Find a ride <ModuleTag>Member 1 search · Member 2 booking</ModuleTag></h1>
          <p>Rides that <em>pass through</em> your pickup and drop-off count too: a ride Main Gate → Ameerpet → Airport matches a search for Main Gate → Ameerpet. The match is one stored function, <span className="mono">fn_search_rides</span>.</p>
        </div>
      </div>
      <Card>
        <form className="filters" onSubmit={(e) => { e.preventDefault(); setApplied(q); setShown(24); }}>
          <LocationSelect label="From" value={q.origin} onChange={set('origin')} allowAny exclude={q.dest} />
          <LocationSelect label="To" value={q.dest} onChange={set('dest')} allowAny exclude={q.origin} />
          <label className="field">Leaving after<input type="datetime-local" value={q.from} onChange={set('from')} /></label>
          <label className="field">Leaving before<input type="datetime-local" value={q.to} onChange={set('to')} /></label>
          <label className="field">Seats<select value={q.seats} onChange={set('seats')}>{[1, 2, 3, 4].map((n) => <option key={n}>{n}</option>)}</select></label>
          <label className="field">Cab<select value={q.cab} onChange={set('cab')}><option value="">Any</option>{meta.cabTypes.map((c) => <option key={c.cab_type} value={c.cab_type}>{c.cab_type} ({c.max_seats} seats)</option>)}</select></label>
          <div className="filters-go"><button className="btn primary">Search</button></div>
        </form>
      </Card>

      <div className="row wrap" style={{ margin: '14px 0 10px' }}>
        <span className="small muted">{res.loading ? 'Searching…' : `${rows.length} ride${rows.length === 1 ? '' : 's'} found${res.data ? ` in ${res.data.ms} ms` : ''}`}</span>
        <span className="spacer" />
        <button className="btn sm" onClick={() => setShowSql((x) => !x)}>{showSql ? 'Hide' : 'Show'} SQL</button>
      </div>
      {showSql && (
        <Card style={{ marginBottom: 14 }} title="How the search works" sub="db/20_m1_users_rides_logic.sql">
          <SqlCode sql={`${res.data?.sql ?? ''}\n\n-- fn_search_rides builds each ride's path  origin(0) → stop1..3 → destination(99)\n-- as a UNION ALL, then self-joins it: a ride matches when your pickup comes\n-- BEFORE your drop-off along that path (b.seq > a.seq). Seats left come from\n-- Member 2's confirmed bookings; fares from fn_estimate_fare.`} />
        </Card>
      )}
      {res.error && <div className="alert error">{res.error.message}</div>}

      <div className="ride-grid">
        {rows.slice(0, shown).map((r) => (
          <article className="card ride-tile" key={r.ride_id}>
            <div className="row wrap"><Route from={r.origin_name} to={r.dest_name} stops={r.stops} /><span className="spacer" />
              {r.exact_route ? <span className="badge good">Exact route</span> : <span className="badge blue">Passes your stops</span>}</div>
            <div className="ride-when">{fmtWhen(r.depart_start)} – {fmtHM(r.depart_end)}</div>
            <div className="row"><Avatar name={r.creator_name} /><div><div>{r.creator_name}</div><div className="small muted">{r.creator_hostel}</div></div></div>
            <div className="row wrap">
              <div><span className="ride-fare">{fmtMoney(r.fare_per_head)}</span><span className="small muted"> / head if you join</span>
                <div className="small muted">{r.cab_type} · {fmtMoney(r.fare_total)} total · {r.distance_km} km</div></div>
              <span className="spacer" />
              <div style={{ textAlign: 'right' }}><Seats left={r.seats_left} max={maxSeats(r.cab_type)} /><div className="small muted">{r.seats_left} left</div></div>
            </div>
            {r.note && <div className="small secondary" style={{ fontStyle: 'italic' }}>“{r.note}”</div>}
            <button className="btn primary" style={{ justifyContent: 'center' }} onClick={() => setBooking(r.ride_id)}>Join this ride</button>
          </article>
        ))}
      </div>
      {rows.length > shown && <div style={{ textAlign: 'center', marginTop: 14 }}><button className="btn" onClick={() => setShown((n) => n + 24)}>Show more ({rows.length - shown} left)</button></div>}
      {res.data && rows.length === 0 && !res.loading && <Empty>No rides match. Widen the time window, or offer one yourself.</Empty>}

      {full.length > 0 && (<>
        <div className="section-title"><h2>Full rides on this route</h2><span>Join the waitlist: you are promoted automatically, first come first served, when seats free up</span></div>
        <div className="ride-grid">{full.slice(0, 9).map((r) => (
          <article className="card ride-tile" key={r.ride_id}>
            <div className="row wrap"><Route from={r.origin} to={r.destination} stops={r.stops} /><span className="spacer" /><span className="badge warn">■ Full</span></div>
            <div className="ride-when">{fmtWhen(r.depart_start)}</div>
            <div className="small muted">{r.cab_type} · hosted by {r.creator_name} · {r.waitlist_size} waiting</div>
            {r.my_position ? <span className="badge blue">You are #{r.my_position} in line</span>
              : <button className="btn" style={{ justifyContent: 'center' }} onClick={() => setBooking(r.ride_id)}>Join the waitlist</button>}
          </article>))}
        </div>
      </>)}
      {booking && <BookDialog rideId={booking} seats={Number(applied.seats) || 1} pickup={applied.origin} dropoff={applied.dest}
        onClose={() => { setBooking(null); if (params.get('ride')) setParams({}); }} onDone={() => setV((x) => x + 1)} />}
    </>
  );
}
