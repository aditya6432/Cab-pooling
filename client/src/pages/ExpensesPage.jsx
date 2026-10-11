// Member 3: expenses overview. Balances with each person (v_pairwise_balance) and the rides
// you can record fares for. Payments recorded in Member 4's module flow into these numbers
// through v_settlement_flow.
import { Link } from 'react-router-dom';
import { useApi } from '../hooks.js';
import { Avatar, Card, DataTable, Empty, ModuleTag, RideStatus, Route } from '../components/ui.jsx';
import { fmtMoney, fmtWhen } from '../format.js';

export const Money = ({ n, signed }) => {
  const v = Number(n);
  const cls = v > 0.004 ? 'pos' : v < -0.004 ? 'neg' : 'muted';
  return <span className={cls}>{signed && v > 0.004 ? '+' : ''}{fmtMoney(v)}</span>;
};

export default function ExpensesPage() {
  const sum = useApi('/expenses/summary');
  const rides = useApi('/expenses/rides');
  const s = sum.data;
  const noFare = (rides.data || []).filter((r) => r.expenses === 0 && r.riders > 1).length;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Expenses <ModuleTag>Member 3</ModuleTag></h1>
          <p>Split cab fares like Splitwise. Record what you paid on a ride and PostgreSQL computes everyone's share to the paisa (largest-remainder rounding), checks that the shares add up at COMMIT, and keeps an audit trail.</p>
        </div>
        <Link className="btn primary" to="/money">Settle up →</Link>
      </div>
      {sum.error && <div className="alert error">{sum.error.message}</div>}
      <div className="grid g-12">
        <Card className="span-4 hero">
          <div className="label">Net balance with everyone</div>
          <div className={`value ${s && s.net > 0 ? 'pos' : s && s.net < 0 ? 'neg' : ''}`}>{s ? fmtMoney(s.net) : '…'}</div>
          <div className="foot">{s ? <>Owed to you {fmtMoney(s.owedToMe)} · you owe {fmtMoney(s.iOwe)}. Confirmed payments and net-offs (Member 4) are already counted.</> : ''}</div>
        </Card>
        <Card className="span-8" title="Balances with friends" sub="v_pairwise_balance: every share is a debt edge, every confirmed payment an opposite edge, netted per pair">
          {!s ? <Empty>Loading…</Empty> : s.people.length === 0 ? <Empty icon="✓">You are all settled up.</Empty> : (
            <div className="people-list">
              {s.people.slice(0, 12).map((p) => (
                <div key={p.other_id} className="row people-row">
                  <Avatar name={p.other_name} />
                  <div style={{ flex: 1, minWidth: 0 }}><Link to={`/profile/${p.other_id}`}><strong>{p.other_name}</strong></Link><div className="small muted mono">{p.other_id}</div></div>
                  <div className="nowrap">{p.owes_me ? <>owes you <Money n={p.amount} /></> : <>you owe <Money n={-p.amount} /></>}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="section-title"><h2>Your rides</h2><span>{noFare ? `${noFare} shared ride${noFare > 1 ? 's have' : ' has'} no fare recorded yet` : 'Departed and completed rides you travelled on'}</span></div>
      <Card>
        <DataTable rows={rides.data || []} empty="No departed or completed rides yet" columns={[
          { key: 'route', label: 'Ride', render: (r) => <Route from={r.origin} to={r.destination} /> },
          { key: 'when', label: 'When', render: (r) => <span className="nowrap">{fmtWhen(r.depart_start)}</span> },
          { key: 'status', label: 'Status', render: (r) => <RideStatus status={r.status} /> },
          { key: 'riders', label: 'Riders', num: true },
          { key: 'total', label: 'Recorded', num: true, render: (r) => (r.expenses ? fmtMoney(r.total) : <span className="muted">—</span>) },
          { key: 'my_net', label: 'Your position', num: true, render: (r) => (r.expenses ? <Money n={r.my_net} signed /> : <span className="muted">—</span>) },
          { key: 'go', label: '', render: (r) => <Link to={`/expenses/${r.ride_id}`}>{r.expenses ? 'Open' : 'Add the fare'} →</Link> },
        ]} />
      </Card>
    </>
  );
}
