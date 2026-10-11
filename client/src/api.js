// Thin fetch wrapper. Sends the login token (Member 1's session) and turns API
// errors, which carry the PostgreSQL constraint / rule info, into ApiError objects.
let token = null;
try { token = localStorage.getItem('poolup-token'); } catch { /* storage unavailable */ }
const listeners = new Set();

export const setToken = (t) => {
  token = t;
  try { if (t) localStorage.setItem('poolup-token', t); else localStorage.removeItem('poolup-token'); } catch { /* ignore */ }
};
export const hasToken = () => Boolean(token);
/** called when the server says the session is gone (401), so the app can show the login page */
export const onUnauthorized = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `HTTP ${status}`);
    this.status = status;
    this.info = body?.error || {};
  }
}

export async function api(path, { method = 'GET', body, query } = {}) {
  const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')) : '';
  const res = await fetch(`/api${path}${qs}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token && !path.startsWith('/auth/login')) listeners.forEach((fn) => fn());
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
