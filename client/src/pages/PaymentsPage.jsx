import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useApp } from '../hooks.js';
import { Avatar, Card, DbError, Empty, StatusBadge } from '../components/ui.jsx';
import { useNow } from '../components/charts.jsx';
import { fmtDateTime, fmtMoney, relTime } from '../format.js';

function Timeline({ id }) {
  const { data } = useApi(`/payments/${id}/timeline`);
  if (!data) return <div className="small muted">Loading…</div>;
  return (
    <div className="timeline">
      {data.rows.map((e) => (
        <div key={e.event_id}>
          <strong>{e.from_status ? `${e.from_status} → ${e.to_status}` : `recorded as ${e.to_status}`}</strong>
          <span className="muted"> · {e.actor} ({e.actor_role}) · {fmtDateTime(e.changed_at)}</span>
          {e.reason && <div className="secondary">“{e.reason}”</div>}
        </div>
      ))}
    </div>
  );
}

/** One payment with the actions the current user may take. */
function PaymentRow({ p, mode, onDone }) {
  const { toast, refreshPending } = useApp();
  const [reasonFor, setReasonFor] = useState(null);       // 'reject' | 'reverse'
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showTl, setShowTl] = useState(false);
  const now = useNow();
  const incoming = mode === 'incoming' || p.direction === 'in';
  const other = incoming ? p.payer_name : p.payee_name;

  async function act(action, body = {}) {
    setBusy(true); setError(null);
    try {
      const r = await api(`/payments/${p.payment_id}/${action}`, { method: 'POST', body });
      toast({ kind: 'success', title: `Payment #${p.payment_id} ${r.status}`, body: 'Allowed by the payment_transition table; the history trigger logged it' });
      setReasonFor(null); setReason('');
      refreshPending(); onDone();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  return (
    <div style={{ padding: '11px 0', borderBottom: '1px solid var(--border)' }}>
      <div className="money-line" style={{ borderBottom: 0, padding: 0 }}>
        <Avatar name={other} />
        <div style={{ minWidth: 0 }}>
          <div className="row wrap"><strong>{incoming ? `${other} → you` : `You → ${other}`}</strong><StatusBadge status={p.status} method={p.method} /></div>
          <div className="small muted">
            #{p.payment_id} · ride #{p.ride_id} · {p.method.toUpperCase()}{p.utr ? ` · UTR ${p.utr}` : ''} · {fmtDateTime(p.created_at)}
          </div>
          {p.status === 'pending' && p.expires_at && <div className="small muted">Expires {relTime(p.expires_at, now)} if nobody responds</div>}
          {p.status_reason && <div className="small secondary">“{p.status_reason}”</div>}
          {p.note && <div className="small muted">Note: {p.note}</div>}
        </div>
        <div className={`money-amt ${incoming ? 'pos' : ''}`}>{fmtMoney(p.amount)}</div>
        <div className="row wrap" style={{ justifyContent: 'flex-end' }}>
          {mode === 'incoming' && <>
            <button className="btn primary sm" disabled={busy} onClick={() => act('confirm')}>Confirm received</button>
            <button className="btn sm" disabled={busy} onClick={() => setReasonFor(reasonFor === 'reject' ? null : 'reject')}>Reject</button>
            <button className="btn sm ghost" disabled={busy} onClick={() => act('cancel')} title="Not your move: watch the state machine refuse it">Try cancel</button>
          </>}
          {mode === 'outgoing' && <>
            <button className="btn sm" disabled={busy} onClick={() => act('cancel')}>Cancel</button>
            <button className="btn sm ghost" disabled={busy} onClick={() => act('confirm')} title="Only the payee may confirm: watch the trigger refuse it">Try confirm</button>
          </>}
          {mode === 'history' && p.can_reverse && (
            <button className="btn sm" onClick={() => setReasonFor(reasonFor === 'reverse' ? null : 'reverse')} title={`Allowed until ${fmtDateTime(p.reversible_until)}`}>Reverse</button>
          )}
          <button className="btn sm ghost" onClick={() => setShowTl((v) => !v)}>{showTl ? 'Hide' : 'History'}</button>
        </div>
      </div>
      {reasonFor && (
        <form className="row" style={{ margin: '8px 0 0 48px' }} onSubmit={(e) => { e.preventDefault(); act(reasonFor, { reason }); }}>
          <input type="text" autoFocus placeholder={reasonFor === 'reject' ? 'Why? e.g. UTR not found in my statement' : 'Why? e.g. Bank reversed the credit'}
            value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
          <button className="btn sm danger" disabled={busy}>{reasonFor === 'reject' ? 'Reject payment' : 'Reverse confirmation'}</button>
        </form>
      )}
      {error && <div style={{ margin: '8px 0 0 48px' }}><DbError error={error} /></div>}
      {showTl && <div style={{ margin: '6px 0 0 48px' }}><Timeline id={p.payment_id} /></div>}
    </div>
  );
}

export default function PaymentsPage() {
  const { acting, meta } = useApp();
  const inbox = useApi('/payments/inbox', {}, [acting.student_id]);
  const [filter, setFilter] = useState('all');
  if (inbox.error) return <div className="alert error">{inbox.error.message}</div>;
  const d = inbox.data;
  const history = (d?.history.rows || []).filter((p) => filter === 'all' || p.direction === filter);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Payments</h1>
          <p>Every payment moves through a state machine stored <em>as data</em> in <span className="mono">payment_transition</span>: only the payee confirms, rejects or reverses (within {meta.windows.reversalHours} h); only the payer cancels; the system expires anything left pending for {meta.windows.paymentExpiryDays} days. Try the "Try …" buttons to watch the database refuse a move.</p>
        </div>
      </div>
      <div className="stack" style={{ gap: 16 }}>
        <Card title={`Needs your confirmation · ${d?.incoming.rows.length ?? '…'}`} sub="Did the money actually arrive?" result={d?.incoming} loading={inbox.loading}>
          {d && d.incoming.rows.length === 0 && <Empty icon="✓">Nothing waiting for you.</Empty>}
          {d?.incoming.rows.map((p) => <PaymentRow key={p.payment_id} p={p} mode="incoming" onDone={inbox.reload} />)}
        </Card>
        <Card title={`Sent, awaiting the other person · ${d?.outgoing.rows.length ?? '…'}`} result={d?.outgoing} loading={inbox.loading}>
          {d && d.outgoing.rows.length === 0 && <Empty>No payments in flight. Pay someone from <Link to="/money">Settle up</Link>.</Empty>}
          {d?.outgoing.rows.map((p) => <PaymentRow key={p.payment_id} p={p} mode="outgoing" onDone={inbox.reload} />)}
        </Card>
        <Card title="History" sub="Newest first · expand History for the trigger-written status timeline" result={d?.history} loading={inbox.loading}
          actions={<div className="seg">{[['all', 'All'], ['in', 'Received'], ['out', 'Sent']].map(([v, l]) => <button key={v} className={filter === v ? 'on' : ''} onClick={() => setFilter(v)}>{l}</button>)}</div>}>
          {history.length === 0 ? <Empty>No payments yet.</Empty>
            : history.map((p) => <PaymentRow key={p.payment_id} p={p} mode="history" onDone={inbox.reload} />)}
        </Card>
      </div>
    </>
  );
}
