const inr = new Intl.NumberFormat('en-IN');
export const fmtInt = (n) => (n === null || n === undefined ? '—' : inr.format(Math.round(n)));
export const fmtNum = (n, d = 2) => (n === null || n === undefined ? '—' : Number(n).toFixed(d));
export const fmtPct = (n, d = 1) => (n === null || n === undefined ? '—' : `${Number(n).toFixed(d)}%`);
export const fmtRupees = (n) => (n === null || n === undefined ? '—' : `₹${inr.format(Math.round(n))}`);

export function fmtCompact(n) {
  if (n === null || n === undefined) return '—';
  if (Math.abs(n) >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

const TZ = 'Asia/Kolkata';
const dt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
const d = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ });
const wdt = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
const hm = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
export const fmtDateTime = (s) => (s ? dt.format(new Date(s)) : '—');
export const fmtDate = (s) => (s ? d.format(new Date(s)) : '—');
/** "Sat, 17 Oct, 08:00" (IST) */
export const fmtWhen = (s) => (s ? wdt.format(new Date(s)) : '—');
export const fmtHM = (s) => (s ? hm.format(new Date(s)) : '—');

export function relTime(s, now = Date.now()) {
  if (!s) return '—';
  const diff = new Date(s).getTime() - now;
  const abs = Math.abs(diff);
  const units = [['day', 86400000], ['hour', 3600000], ['minute', 60000]];
  for (const [u, ms] of units) {
    if (abs >= ms || u === 'minute') {
      const v = Math.max(1, Math.round(abs / ms));
      const label = `${v} ${u}${v === 1 ? '' : 's'}`;
      return diff >= 0 ? `in ${label}` : `${label} ago`;
    }
  }
  return '';
}

export const initials = (name = '') => name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Money with paise only when needed: ₹500, ₹136.67, ₹1,04,250.50; negatives as −₹
export function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '—';
  const v = Number(n);
  const a = Math.abs(v);
  const frac = Math.abs(a % 1) > 0.004;
  return (v < -0.004 ? '−' : '') + '₹' + a.toLocaleString('en-IN', { minimumFractionDigits: frac ? 2 : 0, maximumFractionDigits: 2 });
}
export const fmtHours = (h) => {
  if (h === null || h === undefined) return '—';
  const v = Number(h);
  return v < 48 ? `${v.toFixed(v < 10 ? 1 : 0)} h` : `${(v / 24).toFixed(1)} days`;
};

/** value for <input type="datetime-local"> in the browser's local time */
export const toLocalInput = (date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
/** "BPHC Main Gate" → "Main Gate", "RGIA Airport (Shamshabad)" → "RGIA Airport" */
export const shortPlace = (name = '') => name.replace(/^BPHC /, '').replace(/ \(.*\)$/, '');
