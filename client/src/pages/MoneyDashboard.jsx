import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApp, useQuery } from '../hooks.js';
import { Card, DataTable, Empty, HBars, StatusBadge } from '../components/ui.jsx';
import { ColumnChart, TrendLine } from '../components/charts.jsx';
import { fmtCompact, fmtDate, fmtDateTime, fmtHours, fmtInt, fmtMoney, fmtPct, relTime } from '../format.js';

export default function MoneyDashboard() {
  const { toast } = useApp();
  const kpi = useQuery('money_kpis');
  const integrity = useQuery('ledger_integrity');
  const monthly = useQuery('money_monthly');
  const aging = useQuery('debt_aging');
  const speed = useQuery('settle_time_histogram');
  const funnel = useQuery('payment_funnel');
  const reasons = useQuery('rejection_reasons');
  const debtors = useQuery('top_debtors', { limit: 8 });
  const float = useQuery('creditor_float', { limit: 8 });
  const hostels = useQuery('hostel_money_league');
  const netoffs = useQuery('netoff_opportunities');
  const cohorts = useQuery('tags_vs_payments');
  const events = useQuery('recent_payment_events', { limit: 8 });
  const stale = useQuery('stale_pending');
  const [running, setRunning] = useState(false);

  const k = kpi.data?.rows?.[0];
  const L = integrity.data?.rows?.[0];
  const balanced = L && L.unbalanced_rides === 0 && Number(L.campus_sum) === 0 && L.bad_expenses === 0 && L.bad_offsets === 0
    && L.payments_without_history === 0 && L.overpaid_positions === 0;
  const months = (monthly.data?.rows || []).map((r) => ({ ...r, amount: Number(r.amount) }));
  const s = stale.data?.rows?.[0];

  async function expire() {
    setRunning(true);
    try {
      const r = await api('/payments/expire', { method: 'POST' });
      toast({ kind: 'success', title: `Expired ${r.expired} stale payment${r.expired === 1 ? '' : 's'}`, body: 'Ran fn_expire_stale_payments() as the "system" actor' });
      [kpi, stale, funnel, events].forEach((q) => q.reload());
    } finally { setRunning(false); }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Money dashboard</h1>
          <p>How the campus settles up. No balance is ever stored: every figure is derived from expenses and payments, so the books are re-checked on every load.</p>
        </div>
        <div className="row">
          <span className="small muted">{s ? `${s.stale} pending payment${s.stale === 1 ? '' : 's'} older than 7 days` : ''}</span>
          <button className="btn" onClick={expire} disabled={running || !s?.stale}>{running ? 'Running…' : 'Run expiry job'}</button>
        </div>
      </div>

      <div className="grid g-12">
        <Card className="hero span-4" loading={kpi.loading}>
          <div className="label">Settled between students</div>
          <div className="value">{fmtMoney(Math.round(k?.settled_amount ?? 0))}</div>
          <div className="foot">{fmtInt(k?.settled_count)} confirmed payments · {fmtMoney(k?.netted_amount)} cleared by net-off with no money moving</div>
        </Card>
        <Card className="span-8" title="At a glance" result={kpi.data} loading={kpi.loading}>
          <div className="stats">
            <div className="stat"><div className="label">Still owed</div><div className="value">{fmtMoney(Math.round(k?.outstanding ?? 0))}</div><div className="hint">of {fmtMoney(Math.round(k?.debt_created ?? 0))} ever owed</div></div>
            <div className="stat"><div className="label">Debt settled</div><div className="value">{fmtPct(k?.settled_pct)}</div><div className="hint">1 − outstanding ÷ created</div></div>
            <div className="stat"><div className="label">Median time to settle</div><div className="value">{fmtHours(k?.median_hours_to_settle)}</div><div className="hint">ride end → confirmation (percentile_cont)</div></div>
            <div className="stat"><div className="label">Paid by UPI</div><div className="value">{fmtPct(k?.upi_share_pct)}</div><div className="hint">of settled ₹; the rest is cash</div></div>
            <div className="stat"><div className="label">In flight</div><div className="value">{fmtInt(k?.pending_count)}</div><div className="hint">{fmtMoney(k?.pending_amount)} awaiting confirmation</div></div>
            <div className="stat"><div className="label">Rides fully settled</div><div className="value">{fmtPct(k?.rides_settled_pct)}</div><div className="hint">{fmtInt(k?.disputed_count)} payments rejected or reversed</div></div>
          </div>
        </Card>
      </div>

      <Card title="Do the books balance?" sub="Invariants checked as queries on every load. Any non-zero count would mean a bug." result={integrity.data} loading={integrity.loading} style={{ marginTop: 16 }}>
        {L && (
          <div className="row wrap" style={{ gap: 18 }}>
            <span className={`badge ${balanced ? 'good' : 'bad'}`} style={{ fontSize: 13, padding: '3px 10px' }}>{balanced ? '✓ Books balance' : '✕ Inconsistency found'}</span>
            <span className="small">{fmtInt(L.rides_with_money)} rides sum to <strong>{fmtMoney(L.campus_sum)}</strong></span>
            <span className="small">Unbalanced rides: <strong>{L.unbalanced_rides}</strong></span>
            <span className="small">Expenses whose shares ≠ amount: <strong>{L.bad_expenses}</strong></span>
            <span className="small">Broken net-off pairs: <strong>{L.bad_offsets}</strong></span>
            <span className="small">Payments without history: <strong>{L.payments_without_history}</strong></span>
            <span className="small">Overpaid positions: <strong>{L.overpaid_positions}</strong></span>
          </div>
        )}
      </Card>

      <div className="section-title"><h2>Flow of money</h2><span>Confirmed payments only; net-offs excluded</span></div>
      <div className="grid g-12">
        <Card className="span-7" title="Settled per month (₹)" sub="Current month is month-to-date" result={monthly.data} loading={monthly.loading}
          table={() => <DataTable rows={months} columns={[
            { key: 'label', label: 'Month' }, { key: 'payments', label: 'Payments', num: true },
            { key: 'amount', label: 'Settled', num: true, render: (r) => fmtMoney(r.amount) },
            { key: 'upi_amount', label: 'UPI', num: true, render: (r) => fmtMoney(r.upi_amount) },
            { key: 'cash_amount', label: 'Cash', num: true, render: (r) => fmtMoney(r.cash_amount) },
            { key: 'median_hours', label: 'Median time', num: true, render: (r) => fmtHours(r.median_hours) },
            { key: 'cumulative_amount', label: 'Cumulative', num: true, render: (r) => fmtMoney(r.cumulative_amount) }]} />}>
          {months.length ? <ColumnChart data={months} x="label" y="amount" yFormat={fmtCompact}
            tipRows={(r) => [['settled', fmtMoney(r.amount)], ['payments', fmtInt(r.payments)], ['by UPI', fmtMoney(r.upi_amount)], ['running total', fmtMoney(r.cumulative_amount)]]} /> : <Empty>No data</Empty>}
        </Card>
        <Card className="span-5" title="Median time to settle, by month" sub="Separate chart and scale: never a dual axis" result={monthly.data} loading={monthly.loading}>
          {months.length ? <TrendLine data={months.map((m) => ({ ...m, median_hours: Number(m.median_hours) }))} x="label" y="median_hours" height={220}
            yFormat={(v) => `${Math.round(v)} h`} tipRows={(r) => [['median', fmtHours(r.median_hours)], ['payments', fmtInt(r.payments)]]} /> : <Empty>No data</Empty>}
        </Card>
        <Card className="span-6" title="How old is the money still owed?" sub="Open debts by age since the ride ended" result={aging.data} loading={aging.loading}
          table={() => <DataTable rows={aging.data?.rows || []} columns={[{ key: 'label', label: 'Age' }, { key: 'debts', label: 'Debts', num: true }, { key: 'people', label: 'People', num: true }, { key: 'amount', label: 'Amount', num: true, render: (r) => fmtMoney(r.amount) }]} />}>
          <HBars rows={aging.data?.rows || []} labelWidth={110} label={(r) => r.label} value={(r) => Number(r.amount)} format={(v) => fmtMoney(Math.round(v))}
            tip={(r) => `${r.debts} debts · ${r.people} people`} />
          <p className="small muted" style={{ marginTop: 10 }}>Buckets come from an inline <span className="mono">VALUES</span> table LEFT JOINed to the debts, so empty buckets still appear.</p>
        </Card>
        <Card className="span-6" title="How long until a debt is settled?" sub="Ride end → payee confirms" result={speed.data} loading={speed.loading}
          table={() => <DataTable rows={speed.data?.rows || []} columns={[{ key: 'label', label: 'Time' }, { key: 'payments', label: 'Payments', num: true }, { key: 'pct', label: 'Share', num: true, render: (r) => fmtPct(r.pct) }]} />}>
          <ColumnChart data={speed.data?.rows || []} x="label" y="payments" height={210} labelLast={false}
            tipRows={(r) => [['payments', fmtInt(r.payments)], ['of all', fmtPct(r.pct)]]} />
        </Card>
      </div>

      <div className="section-title"><h2>Payment lifecycle</h2><span>The state machine in numbers</span></div>
      <div className="grid g-12">
        <Card className="span-5" title="What happens to recorded payments" result={funnel.data} loading={funnel.loading}>
          <DataTable rows={funnel.data?.rows || []} columns={[
            { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            { key: 'payments', label: 'Payments', num: true },
            { key: 'amount', label: 'Amount', num: true, render: (r) => fmtMoney(Math.round(r.amount)) },
            { key: 'pct', label: 'Share', num: true, render: (r) => fmtPct(r.pct) }]} />
        </Card>
        <Card className="span-7" title="Why payments get rejected or reversed" result={reasons.data} loading={reasons.loading}>
          <DataTable rows={reasons.data?.rows || []} empty="No disputes" columns={[
            { key: 'reason', label: 'Reason' }, { key: 'rejected', label: 'Rejected', num: true },
            { key: 'reversed', label: 'Reversed', num: true }, { key: 'last_seen', label: 'Last seen', render: (r) => <span className="nowrap small">{fmtDate(r.last_seen)}</span> }]} />
        </Card>
      </div>

      <div className="section-title"><h2>People</h2><span>Debtors, creditors and the ratings ↔ payments cross-check</span></div>
      <div className="grid g-12">
        <Card className="span-6" title="Who owes the most right now" sub="Oldest debt and reminders this week via correlated subqueries" result={debtors.data} loading={debtors.loading}>
          <DataTable rows={debtors.data?.rows || []} empty="Nobody owes anything" columns={[
            { key: 'full_name', label: 'Student', render: (r) => <span><Link to={`/profile/${r.student_id}`}>{r.full_name}</Link><div className="small muted">{r.hostel}</div></span> },
            { key: 'owes', label: 'Owes', num: true, render: (r) => <strong>{fmtMoney(r.owes)}</strong> },
            { key: 'rides_owing', label: 'Rides', num: true },
            { key: 'oldest_debt_at', label: 'Oldest', render: (r) => <span className="nowrap small">{relTime(r.oldest_debt_at)}</span> },
            { key: 'reminders_7d', label: 'Nudged (7d)', num: true }]} />
        </Card>
        <Card className="span-6" title="Who is bankrolling the pool" sub="Students who fronted fares and are still owed" result={float.data} loading={float.loading}>
          <DataTable rows={float.data?.rows || []} columns={[
            { key: 'full_name', label: 'Student', render: (r) => <span><Link to={`/profile/${r.student_id}`}>{r.full_name}</Link><div className="small muted">{r.hostel}</div></span> },
            { key: 'owed', label: 'Owed', num: true, render: (r) => <strong>{fmtMoney(r.owed)}</strong> },
            { key: 'rides_owed', label: 'Rides', num: true },
            { key: 'pending_in', label: 'Incoming', num: true, render: (r) => fmtMoney(r.pending_in) }]} />
        </Card>
        <Card className="span-5" title={'Do "Payment delayed" tags match reality?'} sub="Cross-module query: ratings ⨝ payments" result={cohorts.data} loading={cohorts.loading}>
          <div className="cohorts">
            {(cohorts.data?.rows || []).map((c) => (
              <div key={c.cohort} className="cohort">
                <div className="small muted">{c.cohort}</div>
                <div className="big">{fmtHours(c.median_hours_to_pay)}</div>
                <div className="small">median time to pay</div>
                <div className="small muted" style={{ marginTop: 6 }}>{fmtPct(c.paid_within_24h_pct)} paid within 24 h · {c.students} students · {c.payments} payments</div>
              </div>
            ))}
          </div>
          <p className="small muted" style={{ marginTop: 10 }}>Co-riders' tags (Member 5's data) agree with what the payment records (Member 4's data) actually show.</p>
        </Card>
        <Card className="span-7" title="Hostel settlement league" result={hostels.data} loading={hostels.loading}>
          <DataTable rows={hostels.data?.rows || []} columns={[
            { key: 'hostel', label: 'Hostel' },
            { key: 'settled_pct', label: 'Settled', num: true, render: (r) => fmtPct(r.settled_pct) },
            { key: 'outstanding', label: 'Outstanding', num: true, render: (r) => fmtMoney(Math.round(r.outstanding)) },
            { key: 'median_hours_to_pay', label: 'Median time to pay', num: true, render: (r) => fmtHours(r.median_hours_to_pay) },
            { key: 'on_time_pct', label: 'Paid ≤ 24 h', num: true, render: (r) => fmtPct(r.on_time_pct) }]} />
        </Card>
        <Card className="span-6" title="Pairs who could net off" sub="Owe each other on different rides (self-join on v_ride_balance)" result={netoffs.data} loading={netoffs.loading}>
          <DataTable rows={netoffs.data?.rows || []} empty="No mutual debts right now" columns={[
            { key: 'pair', label: 'Pair', render: (r) => <span>{r.a_name} <span className="muted">⇄</span> {r.b_name}</span> },
            { key: 'a_owes_b', label: 'A→B', num: true, render: (r) => fmtMoney(r.a_owes_b) },
            { key: 'b_owes_a', label: 'B→A', num: true, render: (r) => fmtMoney(r.b_owes_a) },
            { key: 'nettable', label: 'Nettable', num: true, render: (r) => <strong>{fmtMoney(r.nettable)}</strong> }]} />
        </Card>
        <Card className="span-6" title="Payment audit trail" sub="Written only by the payment_event trigger" result={events.data} loading={events.loading}>
          <DataTable rows={events.data?.rows || []} columns={[
            { key: 'changed_at', label: 'When', render: (r) => <span className="nowrap small">{fmtDateTime(r.changed_at)}</span> },
            { key: 'move', label: 'Move', render: (r) => <span className="small">{r.from_status ? `${r.from_status} → ` : ''}<strong>{r.to_status}</strong></span> },
            { key: 'actor', label: 'By', render: (r) => <span className="small">{r.actor} <span className="muted">({r.actor_role})</span></span> },
            { key: 'amount', label: 'Amount', num: true, render: (r) => fmtMoney(r.amount) }]} />
        </Card>
      </div>
    </>
  );
}
