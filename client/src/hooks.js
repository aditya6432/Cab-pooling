import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

export const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

/**
 * Fetch an API path. Keeps the previous data while refetching (no skeleton
 * flash), exposes reload(). `deps` re-trigger the fetch.
 */
export function useApi(path, opts = {}, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: Boolean(path) });
  const seq = useRef(0);
  const key = JSON.stringify([path, opts.query]);
  const load = useCallback(async () => {
    if (!path) return;
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await api(path, opts);
      if (id === seq.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (id === seq.current) setState((s) => ({ data: s.data, error, loading: false }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => { load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, ...deps]);
  return { ...state, reload: load };
}

/** Run a named query: GET /api/analytics/:name ("me" parameters are bound by the server) */
export const useQuery = (name, params = {}, deps = []) => useApi(name ? `/analytics/${name}` : null, { query: params }, deps);
