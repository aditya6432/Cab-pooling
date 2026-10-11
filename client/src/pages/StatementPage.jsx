import { useMemo } from 'react';
import { useApi, useApp } from '../hooks.js';
import { Card, DataTable, Empty } from '../components/ui.jsx';
import { TrendLine } from '../components/charts.jsx';
import { fmtDate, fmtDateTime, fmtMoney } from '../format.js';

export default function StatementPage() {
  const { acting } = useApp();
  const st = useApi('/payments/statement', {}, [acting.student_id]);
  const rows = st.data?.rows || [];
  const series = useMemo(() => [...rows].reverse().map((r) => ({ ...r, balance: Number(r.balance), label: fmtDate(r.at) })), [rows]);
  const last = rows[0];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Statement</h1>
          <p>A bank-style statement built from five event sources (fares you paid, your shares, payments sent, payments received, reversals) stitched with <span className="mono">UNION ALL</span>. The running balance is a window function, <span className="mono">SUM(delta) OVER (ORDER BY seq)</span>. It always ends at your true net position.</p>
        </div>
      </div>
      <div className="grid g-12">
        <Card className="span-4 hero" loading={st.loading}>
          <div className="label">Balance now</div>
          <div className={`value ${Number(last?.balance) > 0 ? 'pos' : Number(last?.balance) < 0 ? 'neg' : ''}`}>{fmtMoney(last?.balance ?? 0)}</div>
          <div className="foot">{Number(last?.balance) >= 0 ? 'Positive: the pool owes you.' : 'Negative: you owe the pool.'} {rows.length} entries.</div>
        </Card>
        <Card className="span-8" title="Running balance" sub="Above the line: others owe you · below: you owe" result={st.data} loading={st.loading}>
          {series.length > 1
            ? <TrendLine data={series} x="label" y="balance" height={220} zeroLine curve="stepAfter" yWidth={58}
                yFormat={(v) => fmtMoney(Math.round(v))}
                tipRows={(r) => [['balance', fmtMoney(r.balance)], [r.description, `${r.delta > 0 ? '+' : ''}${fmtMoney(r.delta)}`]]} />
            : <Empty>Not enough history yet.</Empty>}
        </Card>
      </div>
      <Card title="Entries" sub="Newest first · balance = what the pool owes you. Money you receive lowers it (they owe you less); money you send raises it (you owe less)." style={{ marginTop: 16 }} result={st.data}>
        <DataTable rows={rows} empty="No money activity yet" columns={[
          { key: 'at', label: 'When', render: (r) => <span className="nowrap">{fmtDateTime(r.at)}</span> },
          { key: 'description', label: 'Description' },
          { key: 'ride_id', label: 'Ride', render: (r) => <span className="muted">#{r.ride_id}</span> },
          { key: 'delta', label: 'Amount', num: true, render: (r) => <span className={Number(r.delta) > 0 ? 'pos' : 'neg'}>{Number(r.delta) > 0 ? '+' : ''}{fmtMoney(r.delta)}</span> },
          { key: 'balance', label: 'Balance', num: true, render: (r) => <strong>{fmtMoney(r.balance)}</strong> },
        ]} />
      </Card>
    </>
  );
}
