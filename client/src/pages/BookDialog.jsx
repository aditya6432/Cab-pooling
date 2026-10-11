// Member 2: the booking dialog. Asks the API what would happen (preview), then books,
// sends a request (approval rides) or joins the waitlist. PostgreSQL enforces every rule.
import { useState } from 'react';
import { api } from '../api.js';
import { useApi, useApp } from '../hooks.js';
import { DbError, Modal, Route, Seats } from '../components/ui.jsx';
import { fmtMoney, fmtWhen } from '../format.js';

export default function BookDialog({ rideId, seats: seats0 = 1, pickup: p0 = '', dropoff: d0 = '', onClose, onDone }) {
  const { toast, refreshCounts } = useApp();
  const [seats, setSeats] = useState(seats0);
  const [pickup, setPickup] = useState('');
  const [dropoff, setDropoff] = useState('');
  const [message, setMessage] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const { data: pv, loading, error } = useApi(`/bookings/preview/${rideId}`, { query: { seats } });
  const onPath = (id) => pv?.path.some((p) => String(p.location_id) === String(id));
  // default to the places the person searched for, when they are on this ride's route
  const pick = pickup !== '' ? pickup : onPath(p0) && String(p0) !== String(pv?.path[0]?.location_id) ? String(p0) : '';
  const drop = dropoff !== '' ? dropoff : onPath(d0) && String(d0) !== String(pv?.path.at(-1)?.location_id) ? String(d0) : '';

  async function submit() {
    setErr(null); setBusy(true);
    try {
      const r = await api('/bookings', { method: 'POST', body: { rideId, seats, pickup: pick || null, dropoff: drop || null, message, waitlist: pv.can === 'waitlist' } });
      toast({
        title: { confirmed: 'Seat booked', requested: 'Request sent', waitlisted: 'You are on the waitlist' }[r.outcome],
        text: { confirmed: `${seats} seat(s) on ride #${rideId}. Seats left: ${r.ride.seats_left}.`, requested: 'The creator will approve or reject it.', waitlisted: 'You are promoted automatically when seats free up.' }[r.outcome],
      });
      refreshCounts?.(); onDone?.(r); onClose();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  }
  const label = { book: 'Book seat', request: 'Send request', waitlist: 'Join the waitlist' }[pv?.can];
  const r = pv?.ride;
  return (
    <Modal title={pv?.can === 'waitlist' ? 'Join the waitlist' : 'Book a seat'} onClose={onClose}>
      {loading && !pv && <div className="muted">Checking the ride…</div>}
      {error && <DbError error={error} />}
      {r && <>
        <div>
          <Route from={r.origin} to={r.destination} stops={r.stops} />
          <div className="small secondary" style={{ marginTop: 2 }}>{fmtWhen(r.depart_start)} · {r.cab_type} · hosted by {r.creator_name}</div>
        </div>
        <div className="row wrap"><Seats left={r.seats_left} max={r.max_seats} /><span className="small muted">{r.seats_left} of {r.max_seats} seats left{r.waitlist_size ? ` · ${r.waitlist_size} waiting` : ''}</span>
          <span className="spacer" /><span className={`badge ${r.join_mode === 'approval' ? 'warn' : 'good'}`}>{r.join_mode === 'approval' ? 'Creator approves riders' : 'Instant booking'}</span></div>
        {pv.reason ? <div className="alert info">{pv.reason}</div> : <>
          <div className="grid g-3" style={{ gap: 10 }}>
            <label className="field">Seats<select value={seats} onChange={(e) => setSeats(Number(e.target.value))}>{[1, 2, 3, 4].map((n) => <option key={n}>{n}</option>)}</select></label>
            <label className="field">Board at<select value={pick} onChange={(e) => setPickup(e.target.value)}>
              <option value="">{pv.path[0].name} (start)</option>
              {pv.path.slice(1, -1).map((p) => <option key={p.location_id} value={p.location_id}>{p.name}</option>)}</select></label>
            <label className="field">Get off at<select value={drop} onChange={(e) => setDropoff(e.target.value)}>
              <option value="">{pv.path.at(-1).name} (end)</option>
              {pv.path.slice(1, -1).map((p) => <option key={p.location_id} value={p.location_id}>{p.name}</option>)}</select></label>
          </div>
          {pv.can === 'request' && <label className="field">Message to the creator<input type="text" value={message} maxLength={120} onChange={(e) => setMessage(e.target.value)} placeholder="optional" /></label>}
          {pv.overlap && <div className="alert error small">Heads up: you already hold a seat on {pv.overlap.origin} → {pv.overlap.destination} at this time. The database will refuse this booking (rule B8, trigger with a row lock).</div>}
          <div className="small secondary">Fare estimate {fmtMoney(r.fare_total)} in total, about <strong>{fmtMoney(pv.fare_per_head_if_join)}</strong> per head once you join. The real fare is split later under Expenses.{pv.can === 'waitlist' && ' Waitlisted riders are promoted automatically, first come first served.'}</div>
          <DbError error={err} />
          <button className="btn primary" style={{ justifyContent: 'center' }} disabled={busy || loading} onClick={submit}>{busy ? 'Working…' : label}</button>
        </>}
      </>}
    </Modal>
  );
}
