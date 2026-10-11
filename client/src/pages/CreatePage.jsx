// Member 1: offer a ride. fn_create_ride writes the ride, its stops and the creator's seat in one
// transaction; triggers enforce "≥ 15 min ahead", "≤ 60 days ahead", "no overlapping ride", stop rules.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../hooks.js';
import { Card, DbError, LocationSelect, ModuleTag } from '../components/ui.jsx';
import { fmtMoney, toLocalInput } from '../format.js';

export default function CreatePage() {
  const { meta, toast } = useApp();
  const nav = useNavigate();
  const t0 = new Date(Date.now() + 3 * 3600e3); t0.setMinutes(0, 0, 0);
  const [f, setF] = useState({ origin: '', dest: '', cab: 'sedan', start: toLocalInput(t0), end: toLocalInput(new Date(t0.getTime() + 3600e3)), note: '' });
  const [stops, setStops] = useState([]);
  const [est, setEst] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF({ ...f, [k]: v?.target ? v.target.value : v });

  useEffect(() => {
    if (!f.origin || !f.dest || f.origin === f.dest) { setEst(null); return; }
    api('/rides/estimate', { query: { origin: f.origin, dest: f.dest, cab: f.cab, stops: stops.filter(Boolean).join(',') } }).then(setEst).catch(() => setEst(null));
  }, [f.origin, f.dest, f.cab, stops]);

  async function submit(e) {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const r = await api('/rides', { method: 'POST', body: { ...f, start: new Date(f.start).toISOString(), end: new Date(f.end).toISOString(), stops: stops.filter(Boolean).map(Number) } });
      toast({ title: 'Ride created', text: `Ride #${r.ride_id}: ${r.origin} → ${r.destination}. You hold the first seat.` });
      nav('/rides');
    } catch (x) { setErr(x); } finally { setBusy(false); }
  }
  const cab = meta.cabTypes.find((c) => c.cab_type === f.cab);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Offer a ride <ModuleTag>Member 1</ModuleTag></h1>
          <p>Pick a route, up to three stops on the way and a departure window. The ride, its stops and your own seat are written atomically by <span className="mono">fn_create_ride</span>; the triggers refuse overlapping rides, rides in the past and impossible routes.</p>
        </div>
      </div>
      <div className="grid g-12">
        <Card className="span-7">
          <form className="stack" style={{ gap: 14 }} onSubmit={submit}>
            <div className="grid g-2" style={{ gap: 12 }}>
              <LocationSelect label="From" value={f.origin} onChange={set('origin')} exclude={f.dest} />
              <LocationSelect label="To" value={f.dest} onChange={set('dest')} exclude={f.origin} />
            </div>
            <div className="stack" style={{ gap: 8 }}>
              <div className="small muted">Stops on the way (optional, max 3): riders going to a stop can join too</div>
              {stops.map((s, i) => (
                <div className="row" key={i} style={{ alignItems: 'flex-end' }}>
                  <div style={{ flex: 1 }}><LocationSelect label={`Stop ${i + 1}`} value={s} onChange={(v) => setStops(stops.map((x, j) => (j === i ? v : x)))} /></div>
                  <button type="button" className="btn sm" onClick={() => setStops(stops.filter((_, j) => j !== i))}>Remove</button>
                </div>))}
              <div><button type="button" className="btn sm" onClick={() => setStops([...stops, ''])}>+ Add a stop</button>
                {stops.length >= 3 && <span className="small muted" style={{ marginLeft: 8 }}>A 4th stop would be refused by CHECK (stop_seq BETWEEN 1 AND 3).</span>}</div>
            </div>
            <div className="grid g-2" style={{ gap: 12 }}>
              <label className="field">Earliest departure<input type="datetime-local" value={f.start} onChange={set('start')} required /></label>
              <label className="field">Latest departure (window ≤ 3 h)<input type="datetime-local" value={f.end} onChange={set('end')} required /></label>
            </div>
            <div className="grid g-2" style={{ gap: 12 }}>
              <label className="field">Cab type<select value={f.cab} onChange={set('cab')}>{meta.cabTypes.map((c) => <option key={c.cab_type} value={c.cab_type}>{c.cab_type}: {c.max_seats} seats</option>)}</select></label>
              <label className="field">Note (optional)<input type="text" maxLength={200} value={f.note} onChange={set('note')} placeholder="Two small bags only…" /></label>
            </div>
            <DbError error={err} />
            <div><button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create ride'}</button></div>
          </form>
        </Card>
        <Card className="span-5 hero" title="Fare estimate" sub="fn_route_km (haversine × 1.3 over every leg) and fn_estimate_fare">
          {est && cab ? (
            <>
              <div className="label">Per head if the cab fills up ({cab.max_seats} seats)</div>
              <div className="value">{fmtMoney(est.fare_total / cab.max_seats)}</div>
              <div className="foot">{est.distance_km} km by road · {fmtMoney(est.fare_total)} for the whole cab · base {fmtMoney(cab.base_fare)} + {fmtMoney(cab.per_km)}/km</div>
            </>
          ) : <div className="muted">Choose where from and where to.</div>}
        </Card>
      </div>
    </>
  );
}
