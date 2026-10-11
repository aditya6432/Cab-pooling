// Member 1: edit your own account. Every rule (name length, phone format, unique phone,
// known hostel) is checked by PostgreSQL; this form only shows which rule said no.
import { useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../hooks.js';
import { Card, DbError } from './ui.jsx';

export default function AccountCard({ className = '' }) {
  const { me, setMe, meta, toast } = useApp();
  const [f, setF] = useState({ fullName: me.full_name, phone: String(me.phone || '').trim(), hostelId: me.hostel_id });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  async function save(e) {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      await api('/auth/me', { method: 'PUT', body: { ...f, hostelId: Number(f.hostelId) } });
      setMe(await api('/auth/me'));
      toast({ title: 'Account saved', text: 'Validated by the student table\'s constraints and normalised by a trigger.' });
    } catch (x) { setErr(x); } finally { setBusy(false); }
  }
  return (
    <Card className={className} title="Account" sub={`${me.student_id} · ${me.email} (BITS ID and e-mail cannot change)`}>
      <form className="stack" onSubmit={save} style={{ gap: 10 }}>
        <label className="field">Full name<input type="text" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></label>
        <div className="grid g-2" style={{ gap: 10 }}>
          <label className="field">Phone<input type="text" inputMode="numeric" maxLength={10} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
          <label className="field">Hostel<select value={f.hostelId} onChange={(e) => setF({ ...f, hostelId: e.target.value })}>
            {meta.hostels.map((h) => <option key={h.hostel_id} value={h.hostel_id}>{h.name}</option>)}</select></label>
        </div>
        <DbError error={err} />
        <div><button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button></div>
      </form>
    </Card>
  );
}
