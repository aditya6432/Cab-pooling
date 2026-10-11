import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useApp, useQuery } from '../hooks.js';
import { Avatar, Card, DbError, Empty, Stars } from '../components/ui.jsx';
import { useNow } from '../components/charts.jsx';
import { fmtDateTime, relTime } from '../format.js';

const SCORE_WORDS = { 1: 'Poor', 2: 'Below par', 3: 'Okay', 4: 'Good', 5: 'Excellent' };

function TagPicker({ tags, value, onToggle, score }) {
  return (
    <div className="row wrap">
      {tags.map((t) => {
        const on = value.includes(t.tag_id);
        // UI guidance only: the database enforces these rules (BR13, BR14) regardless
        const blocked = !on && (value.length >= 3 || (t.sentiment === 'negative' && score === 5) || (t.sentiment === 'positive' && score === 1));
        return (
          <span key={t.tag_id} className={`chip ${t.sentiment === 'positive' ? 'pos' : 'neg'} ${on ? 'on' : ''} ${blocked ? 'disabled' : ''}`}
            role="checkbox" aria-checked={on} tabIndex={0}
            title={blocked ? (value.length >= 3 ? 'Max 3 tags (BR13)' : 'Tag contradicts the score (BR14)') : ''}
            onClick={() => !blocked && onToggle(t.tag_id)} onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && !blocked && onToggle(t.tag_id)}>
            <span className="dot" style={{ background: t.sentiment === 'positive' ? 'var(--pos)' : 'var(--neg)' }} />{t.label}
          </span>
        );
      })}
    </div>
  );
}

function RideToRate({ ride, tags, onDone }) {
  const { toast, refreshPending } = useApp();
  const [drafts, setDrafts] = useState(() => Object.fromEntries(ride.coriders.map((c) => [c.ratee_id, { score: 0, tags: [], comment: '' }])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [failedRatee, setFailedRatee] = useState(null);
  const now = useNow();

  const set = (id, patch) => setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
  const chosen = ride.coriders.filter((c) => drafts[c.ratee_id].score > 0);

  async function submit() {
    setBusy(true); setError(null); setFailedRatee(null);
    const items = chosen.map((c) => ({ rideId: ride.ride_id, rateeId: c.ratee_id, score: drafts[c.ratee_id].score, comment: drafts[c.ratee_id].comment || null, tags: drafts[c.ratee_id].tags }));
    try {
      const res = await api('/ratings/batch', { method: 'POST', body: { items } });
      toast({ kind: 'success', title: `Saved ${res.saved} rating${res.saved > 1 ? 's' : ''} in one transaction`, body: 'Committed atomically · audit rows written by trigger' });
      refreshPending();
      onDone();
    } catch (e) {
      setError(e);
      if (e.info?.failedItem !== undefined) setFailedRatee(items[e.info.failedItem]?.rateeId);
    } finally { setBusy(false); }
  }

  return (
    <section className="card ride-card">
      <div className="ride-head">
        <div style={{ flex: 1, minWidth: 200 }}>
          <h3>{ride.route}</h3>
          <div className="small muted">Ride #{ride.ride_id} · departed {fmtDateTime(ride.depart_start)} · completed {fmtDateTime(ride.completed_at)}</div>
        </div>
        <span className={`badge ${new Date(ride.closes_at) - now < 86400000 ? 'bad' : 'blue'}`}>Rating window closes {relTime(ride.closes_at, now)}</span>
      </div>
      {ride.coriders.map((c) => {
        const d = drafts[c.ratee_id];
        const needsComment = d.score > 0 && d.score <= 2 && d.comment.trim().length < 10;
        return (
          <div key={c.ratee_id} className={`corider ${failedRatee === c.ratee_id ? 'failed' : ''}`}>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <Avatar name={c.ratee_name} />
              <div>
                <Link to={`/profile/${c.ratee_id}`}><strong>{c.ratee_name}</strong></Link>
                <div className="small muted mono">{c.ratee_id}</div>
                <div className="small muted">{c.ratee_hostel} Bhawan</div>
              </div>
            </div>
            <div className="stack">
              <div className="row wrap">
                <Stars value={d.score} size={24} onChange={(s) => set(c.ratee_id, { score: s })} label={`Rate ${c.ratee_name}`} />
                <span className="secondary">{d.score ? SCORE_WORDS[d.score] : 'Tap to rate · or leave blank to skip'}</span>
              </div>
              {d.score > 0 && (
                <>
                  <TagPicker tags={tags} value={d.tags} score={d.score}
                    onToggle={(id) => set(c.ratee_id, { tags: d.tags.includes(id) ? d.tags.filter((x) => x !== id) : [...d.tags, id] })} />
                  <textarea placeholder={d.score <= 2 ? 'Required for 1★/2★: what went wrong? (min 10 characters)' : 'Optional comment'} maxLength={280}
                    value={d.comment} onChange={(e) => set(c.ratee_id, { comment: e.target.value })} />
                  {needsComment && <div className="small" style={{ color: 'var(--critical-ink)' }}>BR5: a 1★ or 2★ rating needs a reason. Submit anyway to see the database reject it.</div>}
                </>
              )}
            </div>
          </div>
        );
      })}
      {error && <div style={{ padding: '0 18px 12px' }}><DbError error={error} title="Transaction rolled back: nothing was saved" /></div>}
      <div className="ride-foot">
        <span className="small muted">{chosen.length} of {ride.coriders.length} co-riders rated · submitted as one <span className="mono">BEGIN … COMMIT</span> transaction</span>
        <span className="spacer" />
        <button className="btn primary" disabled={!chosen.length || busy} onClick={submit}>{busy ? 'Saving…' : `Submit ${chosen.length || ''} rating${chosen.length === 1 ? '' : 's'}`}</button>
      </div>
    </section>
  );
}

function GivenRating({ r, tags, onChanged }) {
  const { toast } = useApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ score: r.score, tags: r.tag_ids || [], comment: r.comment || '' });
  const [error, setError] = useState(null);
  const [history, setHistory] = useState(null);
  const { acting } = useApp();
  const now = useNow();
  const editable = new Date(r.editable_until).getTime() > now;
  const tagLabel = Object.fromEntries(tags.map((t) => [t.tag_id, t]));

  async function save() {
    setError(null);
    try {
      await api(`/ratings/${r.ride_id}/${r.ratee_id}`, { method: 'PUT', body: draft });
      toast({ kind: 'success', title: 'Rating updated', body: 'BEFORE UPDATE trigger stamped updated_at; audit row added' });
      setEditing(false); onChanged();
    } catch (e) { setError(e); }
  }
  async function withdraw() {
    setError(null);
    try {
      await api(`/ratings/${r.ride_id}/${r.ratee_id}`, { method: 'DELETE' });
      toast({ kind: 'success', title: 'Rating withdrawn', body: 'The audit trail keeps a record of it' });
      onChanged();
    } catch (e) { setError(e); }
  }
  async function toggleHistory() {
    if (history) return setHistory(null);
    setHistory(await api(`/ratings/${r.ride_id}/${acting.student_id}/${r.ratee_id}/audit`));
  }

  return (
    <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
      <div className="row wrap" style={{ alignItems: 'flex-start' }}>
        <Avatar name={r.ratee_name} />
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="row wrap"><Link to={`/profile/${r.ratee_id}`}><strong>{r.ratee_name}</strong></Link><Stars value={r.score} />
            {r.updated_at && <span className="badge">edited</span>}</div>
          <div className="small muted">Ride #{r.ride_id} · rated {fmtDateTime(r.created_at)}</div>
          {r.comment && <div className="secondary" style={{ marginTop: 4 }}>“{r.comment}”</div>}
          {r.tag_ids?.length > 0 && <div className="row wrap" style={{ marginTop: 6 }}>{r.tag_ids.map((id) => <span key={id} className={`chip static ${tagLabel[id]?.sentiment === 'positive' ? 'pos' : 'neg'} on`}><span className="dot" style={{ background: tagLabel[id]?.sentiment === 'positive' ? 'var(--pos)' : 'var(--neg)' }} />{tagLabel[id]?.label}</span>)}</div>}
        </div>
        <div className="row wrap" style={{ justifyContent: 'flex-end' }}>
          {editable ? <span className="badge good">editable · locks {relTime(r.editable_until, now)}</span> : <span className="badge">locked (24 h passed)</span>}
          <button className="btn sm" onClick={() => setEditing((v) => !v)}>{editing ? 'Cancel' : editable ? 'Edit' : 'Try to edit'}</button>
          <button className="btn sm danger" onClick={withdraw}>{editable ? 'Withdraw' : 'Try to withdraw'}</button>
          <button className="btn sm ghost" onClick={toggleHistory}>{history ? 'Hide history' : 'History'}</button>
        </div>
      </div>
      {editing && (
        <div className="stack" style={{ margin: '10px 0 0 42px' }}>
          {!editable && <div className="alert info small">This rating is older than 24 hours. The UI lets you try, so you can watch the <strong>database trigger</strong> refuse it.</div>}
          <Stars value={draft.score} size={22} onChange={(s) => setDraft((d) => ({ ...d, score: s }))} />
          <TagPicker tags={tags} value={draft.tags} score={draft.score}
            onToggle={(id) => setDraft((d) => ({ ...d, tags: d.tags.includes(id) ? d.tags.filter((x) => x !== id) : [...d.tags, id] }))} />
          <textarea value={draft.comment} maxLength={280} onChange={(e) => setDraft((d) => ({ ...d, comment: e.target.value }))} placeholder="Comment" />
          <div><button className="btn primary sm" onClick={save}>Save changes</button></div>
        </div>
      )}
      {error && <div style={{ margin: '10px 0 0 42px' }}><DbError error={error} /></div>}
      {history && (
        <div style={{ margin: '10px 0 0 42px' }} className="small">
          {history.map((h) => (
            <div key={h.audit_id} className="row"><span className="badge mono">{h.action}</span>
              <span className="muted nowrap">{fmtDateTime(h.changed_at)}</span>
              <span>{h.action === 'I' ? `submitted ${h.new_score}★` : h.action === 'U' ? `${h.old_score}★ → ${h.new_score}★` : `withdrew ${h.old_score}★`}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function RatePage() {
  const { meta, acting } = useApp();
  const pending = useApi('/ratings/pending');
  const given = useQuery('profile_given', { student_id: acting.student_id });

  const rides = useMemo(() => {
    const map = new Map();
    for (const r of pending.data?.rows || []) {
      if (!map.has(r.ride_id)) map.set(r.ride_id, { ...r, coriders: [] });
      map.get(r.ride_id).coriders.push(r);
    }
    return [...map.values()];
  }, [pending.data]);

  const reloadAll = () => { pending.reload(); given.reload(); };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Rate your co-riders</h1>
          <p>Rides that finished in the last {meta.windows.ratingDays} days, with the people you shared them with. Each ride's ratings are saved in <strong>one transaction</strong>: if any rating breaks a rule, none are saved.</p>
        </div>
      </div>

      <div className="stack" style={{ gap: 16 }}>
        <Card title={`Waiting for your rating · ${pending.data?.rowCount ?? '…'}`} sub="fn_pending_ratings(): completed rides × confirmed co-riders, minus ones already rated (NOT EXISTS)" result={pending.data} loading={pending.loading}>
          {rides.length === 0 && !pending.loading && <Empty icon="✓">You're all caught up. Use "Signed in as" (top right) to switch to another student and rate as them.</Empty>}
        </Card>
        {rides.map((ride) => <RideToRate key={ride.ride_id} ride={ride} tags={meta.tags} onDone={reloadAll} />)}

        <Card title="Ratings you've given" sub={`Edit or withdraw within ${meta.windows.editHours} hours (enforced by trigger). Every change is audited.`} result={given.data} loading={given.loading}>
          {(given.data?.rows || []).length === 0 ? <Empty>No ratings yet</Empty>
            : given.data.rows.map((r) => <GivenRating key={`${r.ride_id}-${r.ratee_id}`} r={r} tags={meta.tags} onChanged={reloadAll} />)}
        </Card>
      </div>
    </>
  );
}
