import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import QRCode from 'qrcode';
import { api } from '../api.js';
import { useApi, useApp } from '../hooks.js';
import { Avatar, Card, DataTable, DbError, Empty, Modal } from '../components/ui.jsx';
import { useNow } from '../components/charts.jsx';
import { fmtDate, fmtMoney, relTime } from '../format.js';

const newKey = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => ((c === 'x' ? Math.random() * 16 : (Math.random() * 4) + 8) | 0).toString(16)));

/** Record a payment: UPI (QR + UTR) or cash. Idempotent via a per-dialog key. */
function PayDialog({ line, onClose, onPaid }) {
  const { toast, acting } = useApp();
  const [method, setMethod] = useState(line.payee_vpa ? 'upi' : 'cash');
  const [amount, setAmount] = useState(String(line.amount));
  const [utr, setUtr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const clientRef = useRef(newKey());        // same key for every retry from this dialog
  const canvas = useRef(null);
  const upiLink = line.payee_vpa
    ? `upi://pay?pa=${encodeURIComponent(line.payee_vpa)}&pn=${encodeURIComponent(line.to_name)}&am=${Number(amount || 0).toFixed(2)}&cu=INR&tn=${encodeURIComponent(`PoolUp ride #${line.ride_id}`)}`
    : null;

  useEffect(() => {
    if (method === 'upi' && upiLink && canvas.current) {
      QRCode.toCanvas(canvas.current, upiLink, { width: 156, margin: 1, color: { dark: '#0b0b0b', light: '#ffffff' } }).catch(() => {});
    }
  }, [method, upiLink]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await api('/payments', {
        method: 'POST',
        body: { clientRef: clientRef.current, rideId: line.ride_id, payeeId: line.to_id, amount, method, utr: method === 'upi' ? utr : null, note },
      });
      toast({ kind: 'success', title: res.replayed ? 'Already recorded (same request)' : `Recorded ${fmtMoney(res.payment.amount)} to ${line.to_name}`,
        body: res.replayed ? 'The idempotency key returned the existing payment, so nothing was paid twice.' : `Waiting for ${line.to_name.split(' ')[0]} to confirm it arrived.` });
      onPaid();
      onClose();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  return (
    <Modal title={`Pay ${line.to_name}`} onClose={onClose}>
      <form className="stack" style={{ gap: 14 }} onSubmit={submit}>
        <div className="small secondary">Ride #{line.ride_id} · {line.route} · completed {fmtDate(line.completed_at)}</div>
        <label className="field">Amount (₹), you still owe {fmtMoney(line.amount)} to {line.to_name.split(' ')[0]} on this ride
          <input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <div className="seg" role="group" aria-label="Payment method">
          <button type="button" className={method === 'upi' ? 'on' : ''} onClick={() => setMethod('upi')}>UPI</button>
          <button type="button" className={method === 'cash' ? 'on' : ''} onClick={() => setMethod('cash')}>Cash</button>
        </div>
        {method === 'upi' && (upiLink ? (
          <div className="qr-box">
            <canvas ref={canvas} aria-label="UPI QR code" />
            <div className="stack small">
              <div><span className="muted">Pay to</span><div className="mono">{line.payee_vpa}</div></div>
              <div className="muted">Scan with any UPI app, or <a href={upiLink}>open your UPI app</a>. Then paste the 12-digit UTR from your bank's receipt below.</div>
            </div>
          </div>
        ) : <div className="alert info small">{line.to_name} has no UPI ID saved. Ask them for it, or pay cash.</div>)}
        {method === 'upi' && (
          <label className="field">UTR / UPI reference (12 digits)
            <input type="text" inputMode="numeric" maxLength={12} placeholder="e.g. 412345678901" value={utr} onChange={(e) => setUtr(e.target.value.replace(/\D/g, ''))} />
          </label>
        )}
        {method === 'cash' && <div className="alert info small">Hand over the cash, then record it here. {line.to_name.split(' ')[0]} confirms when they have it.</div>}
        <label className="field">Note (optional)<input type="text" maxLength={140} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        {error && <DbError error={error} title="Payment refused by the database" />}
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <span className="small muted mono" title="Idempotency key: retrying this form can never record two payments">key {clientRef.current.slice(0, 8)}…</span>
          <button className="btn primary" disabled={busy}>{busy ? 'Recording…' : `Record ${method === 'upi' ? 'UPI' : 'cash'} payment`}</button>
        </div>
        <div className="small muted">Paying as {acting.full_name}. The payment stays <strong>pending</strong> until the payee confirms it.</div>
      </form>
    </Modal>
  );
}

function RideDetail({ rideId }) {
  const { data } = useApi(`/payments/rides/${rideId}`);
  const { openSql } = useApp();
  if (!data) return <div className="small muted">Loading…</div>;
  return (
    <div className="stack" style={{ gap: 10, padding: '6px 0 4px' }}>
      <div className="row"><span className="small muted">Every member's position (v_ride_balance)</span><span className="spacer" />
        <button className="icon-btn" onClick={() => openSql(data.positions)}>SQL</button></div>
      <DataTable rows={data.positions.rows} columns={[
        { key: 'full_name', label: 'Member' },
        { key: 'paid', label: 'Paid', num: true, render: (r) => fmtMoney(r.paid) },
        { key: 'share', label: 'Share', num: true, render: (r) => fmtMoney(r.share) },
        { key: 'sent', label: 'Sent', num: true, render: (r) => fmtMoney(r.sent) },
        { key: 'received', label: 'Received', num: true, render: (r) => fmtMoney(r.received) },
        { key: 'net', label: 'Balance', num: true, render: (r) => <strong className={Number(r.net) > 0 ? 'pos' : Number(r.net) < 0 ? 'neg' : ''}>{fmtMoney(r.net)}</strong> },
        { key: 'open', label: 'After pending', num: true, render: (r) => fmtMoney(r.open) },
      ]} />
      <div className="row"><span className="small muted">Fewest transfers to settle (fn_settlement_plan)</span><span className="spacer" />
        <button className="icon-btn" onClick={() => openSql(data.plan)}>SQL</button></div>
      {data.plan.rows.length === 0 ? <div className="small muted">Nothing left to settle.</div>
        : data.plan.rows.map((p, i) => <div key={i} className="small">{p.from_name} → {p.to_name}: <strong>{fmtMoney(p.amount)}</strong></div>)}
    </div>
  );
}

function UpiIds({ upi, reload }) {
  const { toast } = useApp();
  const [vpa, setVpa] = useState('');
  const [error, setError] = useState(null);
  async function add(e) {
    e.preventDefault(); setError(null);
    try { await api('/payments/methods', { method: 'POST', body: { vpa, label: 'Added in app' } }); setVpa(''); toast({ kind: 'success', title: 'UPI ID added' }); reload(); }
    catch (err) { setError(err); }
  }
  async function act(fn) { setError(null); try { await fn(); reload(); } catch (err) { setError(err); } }
  return (
    <Card title="Your UPI IDs" sub="Co-riders see your default one when they pay you" result={upi}>
      {upi.rows.length === 0 && <div className="small muted">No UPI ID yet: people can only pay you cash.</div>}
      {upi.rows.map((m) => (
        <div key={m.method_id} className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
          <span className="mono">{m.vpa}</span>
          {m.is_default ? <span className="badge good">✓ Default</span> : <button className="btn sm" onClick={() => act(() => api(`/payments/methods/${m.method_id}/default`, { method: 'POST' }))}>Make default</button>}
          <span className="spacer" />
          <button className="btn sm ghost danger" onClick={() => act(() => api(`/payments/methods/${m.method_id}`, { method: 'DELETE' }))}>Remove</button>
        </div>
      ))}
      <form className="row" style={{ marginTop: 10 }} onSubmit={add}>
        <input type="text" placeholder="name@bank" value={vpa} onChange={(e) => setVpa(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
        <button className="btn" disabled={!vpa.trim()}>Add</button>
      </form>
      {error && <div style={{ marginTop: 10 }}><DbError error={error} /></div>}
    </Card>
  );
}

export default function SettleUpPage() {
  const { acting, toast, refreshPending, openSql } = useApp();
  const ov = useApi('/payments/overview', {}, [acting.student_id]);
  const [paying, setPaying] = useState(null);
  const [open, setOpen] = useState({});
  const [lineError, setLineError] = useState({});
  const now = useNow();
  const reload = () => { ov.reload(); refreshPending(); };

  const lines = ov.data?.lines.rows || [];
  const toPay = lines.filter((l) => l.direction === 'pay');
  const toCollect = lines.filter((l) => l.direction === 'collect');
  const m = ov.data?.money;
  const rides = useMemo(() => [...new Set(lines.map((l) => l.ride_id))], [lines]);

  async function remind(l) {
    const key = `${l.ride_id}:${l.from_id}`;
    setLineError((e) => ({ ...e, [key]: null }));
    try {
      const r = await api('/payments/reminders', { method: 'POST', body: { rideId: l.ride_id, debtorId: l.from_id } });
      toast({ kind: 'success', title: `Reminded ${l.from_name.split(' ')[0]}`, body: `For ${fmtMoney(r.amount_due)} (snapshot taken by the trigger)` });
      ov.reload();
    } catch (err) { setLineError((e) => ({ ...e, [key]: err })); }
  }
  async function netOff(n) {
    try {
      const r = await api('/payments/net-off', { method: 'POST', body: { otherId: n.student_id } });
      toast({ kind: 'success', title: `Netted off ${fmtMoney(r.netted)} with ${n.full_name.split(' ')[0]}`, body: `${r.pairs.length} mirrored pair(s), checked at COMMIT by a deferred constraint trigger` });
      reload();
    } catch (err) { toast({ kind: 'error', title: 'Net-off refused', body: err.message }); }
  }

  if (ov.error) return <div className="alert error">{ov.error.message}</div>;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settle up</h1>
          <p>Each ride is its own little ledger. Balances are computed live from expenses and confirmed payments, and the plan below is the <strong>fewest transfers</strong> that settle each ride (worked out by a stored function).</p>
        </div>
        <button className="icon-btn" onClick={() => ov.data && openSql(ov.data.lines)}>SQL</button>
      </div>

      <div className="grid g-12">
        <Card className="span-8" title="Your money" sub="Across every ride you've been on: confirmed payments only, unless stated" loading={ov.loading} result={ov.data?.moneyQuery}>
          <div className="stats">
            <div className="stat"><div className="label">You owe</div><div className="value neg">{fmtMoney(m?.owes)}</div><div className="hint">across {m?.rides_owing ?? 0} ride{m?.rides_owing === 1 ? '' : 's'}</div></div>
            <div className="stat"><div className="label">You're owed</div><div className="value pos">{fmtMoney(m?.owed)}</div><div className="hint">across {m?.rides_owed ?? 0} ride{m?.rides_owed === 1 ? '' : 's'}</div></div>
            <div className="stat"><div className="label">Net position</div><div className="value">{fmtMoney(m?.net)}</div><div className="hint">{Number(m?.net) >= 0 ? 'the pool owes you overall' : 'you owe the pool overall'}</div></div>
            <div className="stat"><div className="label">Awaiting your confirmation</div><div className="value">{m?.awaiting_my_confirmation ?? 0}</div><div className="hint"><Link to="/money/payments">{fmtMoney(m?.pending_in)} incoming →</Link></div></div>
            <div className="stat"><div className="label">Your payments in flight</div><div className="value">{m?.awaiting_their_confirmation ?? 0}</div><div className="hint">{fmtMoney(m?.pending_out)} awaiting the other person</div></div>
            <div className="stat"><div className="label">Reminders received</div><div className="value">{m?.reminders_received_7d ?? 0}</div><div className="hint">in the last 7 days</div></div>
          </div>
        </Card>
        <div className="span-4"><UpiIds upi={ov.data?.upi || { rows: [] }} reload={ov.reload} /></div>
      </div>

      {ov.data?.netoffs.rows.length > 0 && (
        <Card title="Net off instead of paying" sub="You owe each other on different rides: cancel the overlap with zero money moving" result={ov.data.netoffs} style={{ marginTop: 16 }}>
          {ov.data.netoffs.rows.map((n) => (
            <div key={n.student_id} className="money-line">
              <Avatar name={n.full_name} />
              <div><strong>{n.full_name}</strong><div className="small muted">You owe {fmtMoney(n.i_owe)} · they owe you {fmtMoney(n.they_owe)} · {n.rides} rides</div></div>
              <div className="money-amt">{fmtMoney(n.nettable)}</div>
              <button className="btn primary" onClick={() => netOff(n)}>Net off</button>
            </div>
          ))}
        </Card>
      )}

      <div className="grid g-2" style={{ marginTop: 16 }}>
        <Card title={`To pay · ${toPay.length}`} sub="Your part of each ride's settlement plan" loading={ov.loading}>
          {toPay.length === 0 ? <Empty icon="✓">You don't owe anyone.</Empty> : toPay.map((l) => (
            <div key={`${l.ride_id}:${l.to_id}`} className="money-line">
              <Avatar name={l.to_name} />
              <div style={{ minWidth: 0 }}>
                <div><strong>{l.to_name}</strong></div>
                <div className="small muted">Ride #{l.ride_id} · {l.route} · {l.age_days} day{l.age_days === 1 ? '' : 's'} ago</div>
                {l.last_reminded_at && <div className="small" style={{ color: 'var(--critical-ink)' }}>Reminded you {relTime(l.last_reminded_at, now)}</div>}
              </div>
              <div className="money-amt neg">{fmtMoney(l.amount)}</div>
              <button className="btn primary" onClick={() => setPaying(l)}>Pay</button>
            </div>
          ))}
        </Card>
        <Card title={`To collect · ${toCollect.length}`} sub="Co-riders who still owe you" loading={ov.loading}>
          {toCollect.length === 0 ? <Empty icon="✓">Nobody owes you.</Empty> : toCollect.map((l) => {
            const key = `${l.ride_id}:${l.from_id}`;
            const recent = l.last_reminded_at && now - new Date(l.last_reminded_at) < 24 * 3600e3;
            return (
              <div key={key}>
                <div className="money-line">
                  <Avatar name={l.from_name} />
                  <div style={{ minWidth: 0 }}>
                    <div><strong>{l.from_name}</strong></div>
                    <div className="small muted">Ride #{l.ride_id} · {l.route} · {l.age_days} day{l.age_days === 1 ? '' : 's'} ago</div>
                    {l.last_reminded_at && <div className="small muted">Last reminded {relTime(l.last_reminded_at, now)}</div>}
                  </div>
                  <div className="money-amt pos">{fmtMoney(l.amount)}</div>
                  <button className="btn" onClick={() => remind(l)} title={recent ? 'You reminded them in the last 24 h: the database will refuse (EXCLUDE constraint)' : ''}>
                    Remind{recent ? ' again' : ''}
                  </button>
                </div>
                {lineError[key] && <div style={{ marginBottom: 10 }}><DbError error={lineError[key]} title="Reminder refused by the database" /></div>}
              </div>
            );
          })}
        </Card>
      </div>

      {rides.length > 0 && (
        <Card title="Rides with open balances" sub="Expand a ride to see every member's position and the full plan" style={{ marginTop: 16 }}>
          {rides.map((id) => {
            const l = lines.find((x) => x.ride_id === id);
            return (
              <div key={id} style={{ borderBottom: '1px solid var(--border)', padding: '8px 0' }}>
                <button className="btn ghost" style={{ width: '100%', justifyContent: 'flex-start', whiteSpace: 'normal', textAlign: 'left', flexWrap: 'wrap' }} onClick={() => setOpen((o) => ({ ...o, [id]: !o[id] }))} aria-expanded={!!open[id]}>
                  <span>{open[id] ? '▾' : '▸'}</span><strong>Ride #{id}</strong><span className="muted">{l.route} · {fmtDate(l.completed_at)}</span>
                </button>
                {open[id] && <RideDetail rideId={id} />}
              </div>
            );
          })}
        </Card>
      )}

      {paying && <PayDialog line={paying} onClose={() => setPaying(null)} onPaid={reload} />}
    </>
  );
}
