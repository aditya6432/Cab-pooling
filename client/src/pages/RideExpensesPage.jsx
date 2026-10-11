// Member 3: one ride's expenses. The live preview and the stored shares come from the SAME
// database function (fn_expense_shares), so what you see is exactly what is saved.
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useApp } from '../hooks.js';
import { Card, DataTable, DbError, Empty, ModuleTag, RideStatus, Route } from '../components/ui.jsx';
import { fmtDateTime, fmtMoney, fmtWhen } from '../format.js';
import { Money } from './ExpensesPage.jsx';

const SPLITS = [['equal', 'Equally'], ['seats', 'By seats'], ['exact', 'Exact ₹'], ['percent', 'Percent %']];

export default function RideExpensesPage() {
  const { rideId } = useParams();
  const { toast, refreshCounts } = useApp();
  const [v, setV] = useState(0);
  const { data, error, loading } = useApi(`/expenses/ride/${rideId}`, {}, [v]);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('Cab fare');
  const [split, setSplit] = useState('equal');
  const [on, setOn] = useState({});          // student_id -> included?
  const [vals, setVals] = useState({});      // student_id -> exact amount / percent
  const [preview, setPreview] = useState(null);
  const [previewErr, setPreviewErr] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const members = data?.members || [];
  useEffect(() => { setOn(Object.fromEntries(members.map((m) => [m.student_id, true]))); setVals({}); }, [data?.ride?.ride_id]); // eslint-disable-line
  const chosen = useMemo(() => members.filter((m) => on[m.student_id]), [members, on]);
  const needsValues = split === 'exact' || split === 'percent';
  const valuesReady = !needsValues || chosen.every((m) => vals[m.student_id] !== undefined && vals[m.student_id] !== '');

  useEffect(() => {
    setPreview(null); setPreviewErr(null);
    if (!(Number(amount) > 0) || !chosen.length || !valuesReady || !data?.ride?.can_add) return undefined;
    const t = setTimeout(() => {
      api('/expenses/preview', { query: { rideId, amount, split, people: chosen.map((m) => m.student_id).join(','),
        values: needsValues ? chosen.map((m) => vals[m.student_id]).join(',') : '' } })
        .then(setPreview).catch(setPreviewErr);
    }, 250);
    return () => clearTimeout(t);
  }, [amount, split, on, vals, rideId, data?.ride?.can_add]); // eslint-disable-line

  async function submit(e) {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      await api('/expenses', { method: 'POST', body: { rideId: Number(rideId), amount, note, split,
        people: chosen.map((m) => m.student_id), values: needsValues ? chosen.map((m) => Number(vals[m.student_id])) : [] } });
      toast({ title: 'Expense added', text: `${fmtMoney(Number(amount))} split ${chosen.length} way${chosen.length === 1 ? '' : 's'}. Settle up is ready.` });
      setAmount(''); setVals({}); setV((x) => x + 1); refreshCounts?.();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  }
  async function remove(id) {
    setErr(null);
    try { await api(`/expenses/${id}`, { method: 'DELETE' }); toast({ title: 'Expense deleted', text: 'The audit trigger recorded who deleted it.' }); setV((x) => x + 1); }
    catch (x) { setErr(x); }
  }

  if (error) return <><div className="page-head"><h1>Ride expenses</h1></div><DbError error={error} title="Cannot open this ride" /><Link to="/expenses">← All expenses</Link></>;
  if (!data) return <Empty>{loading ? 'Loading…' : ''}</Empty>;
  const { ride, me } = data;
  const shareOf = (id) => preview?.shares.find((s) => s.student_id === id)?.share_amount;
  const iOwe = data.transfers.some((t) => t.from_id === me);

  return (
    <>
      <Link className="small" to="/expenses">← All expenses</Link>
      <div className="page-head" style={{ marginTop: 6 }}>
        <div>
          <h1><Route from={ride.origin} to={ride.destination} /> <ModuleTag>Member 3</ModuleTag></h1>
          <p>{fmtWhen(ride.depart_start)} · {ride.cab_type} · {ride.distance_km} km · suggested fare ≈ {fmtMoney(ride.fare_hint)} · <RideStatus status={ride.status} /></p>
        </div>
        {data.transfers.length > 0 && <Link className={`btn ${iOwe ? 'primary' : ''}`} to="/money">{iOwe ? 'Pay what you owe →' : 'Go to Settle up →'}</Link>}
      </div>
      <DbError error={err} />

      <div className="grid g-12">
        {ride.can_add ? (
          <Card className="span-7" title="Add an expense" sub={`You (${me}) are the payer. Choose who shares it.`}>
            <form className="stack" style={{ gap: 12 }} onSubmit={submit}>
              <div className="grid g-2" style={{ gap: 10 }}>
                <label className="field">Amount paid (₹)<input type="number" min="0.01" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={String(Math.round(ride.fare_hint))} /></label>
                <label className="field">What was it for?<input type="text" maxLength={60} required value={note} onChange={(e) => setNote(e.target.value)} /></label>
              </div>
              <div className="seg" role="group" aria-label="Split type">
                {SPLITS.map(([k, label]) => <button type="button" key={k} className={split === k ? 'on' : ''} onClick={() => { setSplit(k); setVals({}); }}>{label}</button>)}
              </div>
              <div className="split-list">
                {members.map((m) => (
                  <div key={m.student_id} className={`split-row ${on[m.student_id] ? '' : 'off'}`}>
                    <input type="checkbox" aria-label={`Include ${m.full_name}`} checked={!!on[m.student_id]} onChange={(e) => setOn({ ...on, [m.student_id]: e.target.checked })} />
                    <div style={{ minWidth: 0 }}><strong>{m.full_name}</strong>{m.student_id === me && <span className="badge blue" style={{ marginLeft: 6 }}>you</span>}<div className="small muted">{m.seats_taken} seat{m.seats_taken > 1 ? 's' : ''}</div></div>
                    {needsValues && on[m.student_id]
                      ? <input type="number" step="0.01" min="0" aria-label={`${split === 'exact' ? 'Amount' : 'Percent'} for ${m.full_name}`} placeholder={split === 'exact' ? '₹' : '%'}
                          value={vals[m.student_id] ?? ''} onChange={(e) => setVals({ ...vals, [m.student_id]: e.target.value })} />
                      : <span />}
                    <span className="split-share">{on[m.student_id] && shareOf(m.student_id) !== undefined ? fmtMoney(shareOf(m.student_id)) : ''}</span>
                  </div>
                ))}
              </div>
              {previewErr && <DbError error={previewErr} title="The database would refuse this split" />}
              {preview && <div className="small muted">Preview from <span className="mono">fn_expense_shares</span>: total {fmtMoney(preview.total)}. Shares always add up to the exact amount.</div>}
              <div><button className="btn primary" disabled={busy || !preview}>{busy ? 'Saving…' : 'Add expense'}</button></div>
            </form>
          </Card>
        ) : <Card className="span-7"><div className="muted">Expenses can be added once this ride has departed (trigger rule E6).</div></Card>}

        <Card className="span-5" title="Who owes what" sub="v_ride_ledger: paid − share + sent − received">
          {data.ledger.length === 0 ? <Empty>No expenses yet.</Empty> : (
            <DataTable rows={data.ledger} columns={[
              { key: 'full_name', label: 'Person', render: (l) => <span>{l.full_name}{l.student_id === me && <span className="badge blue" style={{ marginLeft: 6 }}>you</span>}</span> },
              { key: 'paid', label: 'Paid', num: true, render: (l) => fmtMoney(l.paid) },
              { key: 'owed', label: 'Share', num: true, render: (l) => fmtMoney(l.owed) },
              { key: 'settled', label: 'Settled', num: true, render: (l) => fmtMoney(l.settled_out - l.settled_in) },
              { key: 'net', label: 'Balance', num: true, render: (l) => <Money n={l.net} signed /> },
            ]} />
          )}
          {data.transfers.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="small"><strong>Fewest payments to settle</strong> <span className="muted">(fn_simplify_debts, greedy)</span></div>
              {data.transfers.map((t, i) => (
                <div key={i} className="row wrap transfer"><strong>{t.from_name}</strong><span className="muted">pays →</span><strong>{t.to_name}</strong><span className="spacer" /><span className="money-amt">{fmtMoney(t.amount)}</span></div>
              ))}
              <div className="small muted" style={{ marginTop: 6 }}>Paying, confirming and netting off happen in <Link to="/money">Settle up</Link> (Member 4); confirmed payments flow back here through v_settlement_flow.</div>
            </div>
          )}
          {data.ledger.length > 0 && data.transfers.length === 0 && <div className="alert success small" style={{ marginTop: 10 }}>✓ Everyone is settled up on this ride.</div>}
        </Card>
      </div>

      <div className="grid g-12" style={{ marginTop: 16 }}>
        <Card className="span-7" title="Expenses on this ride" sub={ride.has_settlements ? 'Money has moved on this ride, so its expenses are locked (trigger rule E18)' : 'Only the payer can delete an expense'}>
          {data.expenses.length === 0 ? <Empty>Nothing recorded yet.</Empty> : data.expenses.map((e) => (
            <div key={e.expense_id} className="expense-row">
              <div className="row wrap">
                <strong>{e.note}</strong><span className="money-amt">{fmtMoney(e.amount)}</span><span className="badge">{e.split_type}</span>
                <span className="spacer" />
                {e.paid_by === me && <button className="btn sm ghost danger" onClick={() => remove(e.expense_id)}>Delete</button>}
              </div>
              <div className="small muted">Paid by {e.paid_by_name} · {fmtDateTime(e.created_at)}</div>
              <div className="row wrap" style={{ marginTop: 4, gap: 4 }}>{e.shares.map((s) => <span className="badge" key={s.student_id}>{s.full_name.split(' ')[0]} {fmtMoney(s.share_amount)}</span>)}</div>
            </div>
          ))}
        </Card>
        <Card className="span-5" title="Audit trail" sub="expense_audit, written by a trigger (it survives deletes: no foreign key on purpose)">
          <DataTable rows={data.audit} empty="No history yet" columns={[
            { key: 'happened_at', label: 'When', render: (a) => <span className="nowrap small">{fmtDateTime(a.happened_at)}</span> },
            { key: 'action', label: 'Action' },
            { key: 'actor_name', label: 'By', render: (a) => a.actor_name || '—' },
            { key: 'amount', label: 'Amount', num: true, render: (a) => fmtMoney(a.amount) },
          ]} />
        </Card>
      </div>
    </>
  );
}
