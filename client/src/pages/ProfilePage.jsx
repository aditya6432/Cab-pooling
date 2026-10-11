import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi, useApp } from '../hooks.js';
import { Avatar, Card, DataTable, Empty, HBars, Meter, Route, Stars } from '../components/ui.jsx';
import { TrustNetwork } from '../components/charts.jsx';
import AccountCard from '../components/AccountCard.jsx';
import { fmtDate, fmtNum, fmtPct, fmtWhen } from '../format.js';

function Formula({ s }) {
  const n = s.ratings_received, m = s.prior_mean, C = s.prior_weight;
  const sum = s.raw_avg !== null ? Math.round(s.raw_avg * n) : 0;
  const ratingPart = 0.8 * (s.bayes_score - 1) / 4;
  const relPart = 0.2 * (1 - (s.no_show_rate ?? 0));
  return (
    <div className="stack small" style={{ gap: 10 }}>
      <div>
        <div className="muted">① Bayesian average: shrinks small samples towards the campus mean</div>
        <div className="mono" style={{ marginTop: 4 }}>
          (C·m + Σscores) ÷ (C + n) = ({C}·{fmtNum(m, 3)} + {sum}) ÷ ({C} + {n}) = <strong>{fmtNum(s.bayes_score, 3)}</strong>
        </div>
        <div className="muted" style={{ marginTop: 2 }}>raw average {s.raw_avg ?? '—'} from {n} rating{n === 1 ? '' : 's'}; m = campus mean, C = {C} "virtual" ratings</div>
      </div>
      <div>
        <div className="muted">② Trust score = 80% rating + 20% reliability</div>
        <div className="mono" style={{ marginTop: 4 }}>
          100 × [0.8·({fmtNum(s.bayes_score, 3)} − 1)/4 + 0.2·(1 − {fmtNum(s.no_show_rate ?? 0, 3)})]
          = 100 × [{fmtNum(ratingPart, 3)} + {fmtNum(relPart, 3)}] = <strong>{s.trust_score}</strong>
        </div>
      </div>
      <div className="muted">Computed in SQL by <span className="mono">fn_bayesian_score()</span> and <span className="mono">fn_trust_score()</span> inside the view <span className="mono">v_student_reputation</span>.</div>
    </div>
  );
}

export default function ProfilePage() {
  const { id } = useParams();
  const { acting, openSql } = useApp();
  const profile = useApi(`/students/${id}/profile`);
  const pub = useApi(`/students/${id}`);              // Member 1 + 2: ride and booking record
  const [depth, setDepth] = useState(3);
  const network = useApi(`/students/${id}/network`, { query: { depth } });
  const [hot, setHot] = useState(null);

  if (profile.error) return <div className="alert error">{profile.error.message}</div>;
  const p = profile.data;
  if (!p) return <Empty>Loading profile…</Empty>;
  const s = p.summary;
  const isMe = acting.student_id === s.student_id;
  const sqlInfo = (name) => ({ name, ...p.queries[name] });
  const hist = p.histogram;
  const nodes = network.data?.rows || [];
  const byHop = [1, 2, 3, 4].map((h) => nodes.filter((n) => n.hops === h).length);

  return (
    <>
      <div className="grid g-12">
        <Card className="span-8">
          <div className="row" style={{ gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <Avatar name={s.full_name} size="lg" />
            <div style={{ flex: 1, minWidth: 220 }}>
              <div className="row wrap"><h1>{s.full_name}</h1>{isMe && <span className="badge blue">You</span>}</div>
              <div className="secondary mono small">{s.student_id} · {s.hostel} Bhawan</div>
              <div className="row wrap" style={{ marginTop: 10, gap: 18 }}>
                <div><div className="small muted">Raw average</div><div className="row"><strong style={{ fontSize: 18 }}>{s.raw_avg ?? '—'}</strong><Stars value={s.raw_avg || 0} /></div></div>
                <div><div className="small muted">Ratings received</div><strong style={{ fontSize: 18 }}>{s.ratings_received}</strong></div>
                <div><div className="small muted">Rides completed</div><strong style={{ fontSize: 18 }}>{s.rides_completed}</strong></div>
                <div><div className="small muted">No-shows</div><strong style={{ fontSize: 18 }}>{s.no_shows}</strong> <span className="small muted">({fmtPct(100 * (s.no_show_rate ?? 0), 0)})</span></div>
                <div><div className="small muted">Ratings given</div><strong style={{ fontSize: 18 }}>{s.ratings_given}</strong> <span className="small muted">avg {s.avg_given ?? '—'}★</span></div>
              </div>
            </div>
            <button className="icon-btn" onClick={() => openSql(sqlInfo('profile_summary'))}>SQL</button>
          </div>
        </Card>
        <Card className="span-4 hero">
          <div className="label">Trust score</div>
          <div className="value">{s.trust_score}<span style={{ fontSize: 22, color: 'var(--text-muted)', fontWeight: 500 }}> / 100</span></div>
          <Meter value={s.trust_score} tall />
          <div className="foot">Rank #{s.trust_rank} of {s.campus_size} · better than {s.percentile}% of campus (live view, updates instantly)</div>
        </Card>
      </div>

      <div className="grid g-12" style={{ marginTop: 16 }}>
        <Card className={isMe ? 'span-7' : 'span-12'} title="Rides and bookings" sub="Member 1's v_student_ride_stats and Member 2's v_student_booking_stats">
          {pub.data ? (
            <>
              <div className="stats">
                <div className="stat"><div className="label">Rides offered</div><div className="value">{pub.data.rides_created}</div></div>
                <div className="stat"><div className="label">Seats held (all time)</div><div className="value">{pub.data.rides_joined}</div></div>
                <div className="stat"><div className="label">Booking reliability</div><div className="value">{pub.data.booking?.reliability_pct ?? '—'}{pub.data.booking?.reliability_pct != null && '%'}</div>
                  <div className="hint">{pub.data.booking?.bookings ?? 0} bookings · {pub.data.booking?.self_cancelled ?? 0} cancelled · {pub.data.booking?.no_shows ?? 0} no-shows</div></div>
              </div>
              <div className="small muted" style={{ margin: '14px 0 6px' }}>Upcoming rides {isMe ? 'you are' : 'they are'} offering</div>
              {pub.data.upcoming.length === 0 ? <div className="small muted">None right now.</div> : pub.data.upcoming.map((r) => (
                <div key={r.ride_id} className="row wrap" style={{ padding: '6px 0', borderTop: '1px solid var(--border)' }}>
                  <Route from={r.origin} to={r.destination} /><span className="small muted">{fmtWhen(r.depart_start)}</span>
                  <span className="spacer" /><span className="badge">{r.seats_left} seat{r.seats_left === 1 ? '' : 's'} left</span>
                  {!isMe && <Link className="btn sm" to={`/search?ride=${r.ride_id}`}>Book</Link>}
                </div>
              ))}
            </>
          ) : <Empty>Loading…</Empty>}
        </Card>
        {isMe && <AccountCard className="span-5" />}
      </div>

      <div className="grid g-12" style={{ marginTop: 16 }}>
        <Card className="span-7" title="How this score is computed" sub="Real numbers for this student, nothing hard-coded">
          <Formula s={s} />
        </Card>
        <Card className="span-5" title="Stars received" result={sqlInfo('profile_histogram')}
          table={() => <DataTable rows={hist} columns={[{ key: 'score', label: 'Stars', num: true }, { key: 'ratings', label: 'Ratings', num: true }]} />}>
          <HBars rows={hist} labelWidth={36} label={(r) => `${r.score}★`} value={(r) => r.ratings} format={(v) => v} />
          <div className="row wrap" style={{ marginTop: 14 }}>
            {p.tags.length ? p.tags.map((t) => (
              <span key={t.label} className={`chip static on ${t.sentiment === 'positive' ? 'pos' : 'neg'}`}>
                <span className="dot" style={{ background: t.sentiment === 'positive' ? 'var(--pos)' : 'var(--neg)' }} />{t.label} <strong>{t.times}</strong>
              </span>)) : <span className="small muted">No tags yet</span>}
          </div>
        </Card>
      </div>

      <div className="section-title"><h2>Trust network</h2><span>WITH RECURSIVE: who is trusted by people {isMe ? 'you trust' : `${s.full_name.split(' ')[0]} trusts`}</span></div>
      <Card result={network.data} loading={network.loading}
        title={`${nodes.length} students reachable within ${depth} hop${depth > 1 ? 's' : ''}`}
        sub="Edge A → B when A's average rating of B is ≥ 4.5. Cycles are blocked with a path array; the shortest path is kept (DISTINCT ON)."
        actions={<div className="seg" role="group" aria-label="Depth">{[1, 2, 3].map((d) => <button key={d} className={depth === d ? 'on' : ''} onClick={() => setDepth(d)}>{d} hop{d > 1 ? 's' : ''}</button>)}</div>}>
        {nodes.length === 0 ? <Empty>No strong-trust edges yet: rate co-riders 5★ to grow the network.</Empty> : (
          <div className="net-wrap">
            <TrustNetwork me={{ id: s.student_id, name: s.full_name }} nodes={nodes} hot={hot} setHot={setHot} />
            <div>
              <div className="row wrap small" style={{ marginBottom: 8 }}>
                {byHop.slice(0, 3).map((c, i) => <span key={i} className="badge">{i + 1} hop{i ? 's' : ''}: {c}</span>)}
              </div>
              <div className="net-list">
                {nodes.map((n) => (
                  <div key={n.student_id} className={`net-item ${hot === n.student_id ? 'hot' : ''}`} onMouseEnter={() => setHot(n.student_id)} onMouseLeave={() => setHot(null)}>
                    <div className="row"><Link to={`/profile/${n.student_id}`}><strong>{n.full_name}</strong></Link><span className="spacer" /><span className="badge">{n.hops} hop{n.hops > 1 ? 's' : ''}</span></div>
                    <div className="muted">{n.path_names.join(' → ')}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </Card>

      <div className="grid g-12" style={{ marginTop: 16 }}>
        <Card className="span-7" title="Recent reviews" result={sqlInfo('profile_reviews')}>
          {p.reviews.length === 0 ? <Empty>No reviews yet</Empty> : p.reviews.map((r, i) => (
            <div key={i} style={{ padding: '10px 0', borderBottom: i < p.reviews.length - 1 ? '1px solid var(--border)' : 0 }}>
              <div className="row wrap"><Stars value={r.score} /><strong>{r.rater_name}</strong><span className="small muted">· {r.route} · {fmtDate(r.created_at)}</span></div>
              {r.comment && <div className="secondary" style={{ marginTop: 3 }}>“{r.comment}”</div>}
              {r.tags.length > 0 && <div className="small muted" style={{ marginTop: 3 }}>{r.tags.join(' · ')}</div>}
            </div>
          ))}
        </Card>
        <Card className="span-5" title="Ride buddies" sub="Most frequent co-riders" result={sqlInfo('profile_buddies')}>
          <DataTable rows={p.buddies} empty="No completed rides yet" columns={[
            { key: 'full_name', label: 'Co-rider', render: (r) => <Link to={`/profile/${r.student_id}`}>{r.full_name}</Link> },
            { key: 'hostel', label: 'Hostel' },
            { key: 'shared_rides', label: 'Rides', num: true },
            { key: 'last_ride', label: 'Last', render: (r) => <span className="nowrap small">{fmtDate(r.last_ride)}</span> }]} />
        </Card>
      </div>
    </>
  );
}
