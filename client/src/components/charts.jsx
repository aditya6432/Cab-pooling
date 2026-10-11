import { useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, Dot } from 'recharts';
import { useApp } from '../hooks.js';
import { DAYS, fmtInt } from '../format.js';

/** Read the current theme's CSS tokens (recomputed when the theme changes). */
export function useTokens() {
  const { themeVersion } = useApp();
  return useMemo(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    return {
      series1: v('--series-1'), grid: v('--grid'), axis: v('--axis-muted'), baseline: v('--baseline'),
      surface: v('--surface-1'), text2: v('--text-secondary'),
      seq: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => v(`--seq-${i}`)),
    };
  }, [themeVersion]);
}

function ChartTip({ active, payload, label, rows }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="recharts-tip">
      <div className="muted small" style={{ marginBottom: 2 }}>{label}</div>
      {rows(payload[0].payload).map(([k, v, color]) => (
        <div key={k}>{color && <span className="k" style={{ background: color }} />}<strong>{v}</strong> <span className="secondary">{k}</span></div>
      ))}
    </div>
  );
}

/** Single-series column chart (one colour, 24px max bars, 4px rounded data-end). */
export function ColumnChart({ data, x, y, height = 220, tipRows, yFormat = fmtInt, labelLast = true }) {
  const t = useTokens();
  const last = data.length - 1;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 18, right: 8, left: 0, bottom: 0 }} barCategoryGap="22%">
        <CartesianGrid vertical={false} stroke={t.grid} />
        <XAxis dataKey={x} tick={{ fill: t.axis, fontSize: 11.5 }} tickLine={false} axisLine={{ stroke: t.baseline }} />
        <YAxis tick={{ fill: t.axis, fontSize: 11.5 }} tickLine={false} axisLine={false} width={44} tickFormatter={yFormat} allowDecimals={false} />
        <Tooltip cursor={{ fill: t.grid, opacity: 0.5 }} content={<ChartTip rows={tipRows} />} />
        <Bar dataKey={y} fill={t.series1} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false}
          label={labelLast ? ({ x: bx, y: by, width, index, value }) => index === last
            ? <text x={bx + width / 2} y={by - 6} textAnchor="middle" fontSize={11.5} fill={t.text2}>{yFormat(value)}</text> : null : undefined} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Single-series line with crosshair tooltip and an end label. */
export function TrendLine({ data, x, y, height = 160, domain = ['auto', 'auto'], ticks, tipRows, yFormat = (v) => v, zeroLine = false, curve = 'monotone', xTickFormat, yWidth = 44 }) {
  const t = useTokens();
  const lastIdx = data.length - 1;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 16, right: 46, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke={t.grid} />
        <XAxis dataKey={x} tick={{ fill: t.axis, fontSize: 11.5 }} tickLine={false} axisLine={{ stroke: t.baseline }} tickFormatter={xTickFormat} minTickGap={24} />
        <YAxis domain={domain} ticks={ticks} tick={{ fill: t.axis, fontSize: 11.5 }} tickLine={false} axisLine={false} width={yWidth} tickFormatter={yFormat} />
        {zeroLine && <ReferenceLine y={0} stroke={t.baseline} strokeWidth={1} />}
        <Tooltip cursor={{ stroke: t.axis, strokeWidth: 1 }} content={<ChartTip rows={tipRows} />} />
        <Line type={curve} dataKey={y} stroke={t.series1} strokeWidth={2} isAnimationActive={false}
          dot={(p) => p.index === lastIdx ? <Dot key={p.index} cx={p.cx} cy={p.cy} r={4.5} fill={t.series1} stroke={t.surface} strokeWidth={2} /> : <g key={p.index} />}
          activeDot={{ r: 5, fill: t.series1, stroke: t.surface, strokeWidth: 2 }}
          label={({ x: lx, y: ly, index, value }) => index === lastIdx
            ? <text key="end" x={lx + 8} y={ly + 4} fontSize={11.5} fill={t.text2}>{yFormat(value)}</text> : null} />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Day × hour heatmap — sequential one-hue ramp, per-cell hover + focus tooltip. */
export function Heatmap({ rows }) {
  const [tip, setTip] = useState(null);
  const grid = useMemo(() => {
    const g = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const r of rows) g[r.dow - 1][r.hour] = r.rides;
    return g;
  }, [rows]);
  const max = Math.max(1, ...rows.map((r) => r.rides));
  const step = (v) => (v === 0 ? 0 : Math.min(7, 1 + Math.floor((6.999 * (v - 1)) / Math.max(1, max - 1))));
  const show = (e, d, h, v) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setTip({ x: rect.left + rect.width / 2, y: rect.top, d, h, v });
  };
  return (
    <div>
      <div className="heat" onMouseLeave={() => setTip(null)}>
        <div />
        {Array.from({ length: 24 }, (_, h) => <div key={h} className="cl">{h % 3 === 0 ? String(h).padStart(2, '0') : ''}</div>)}
        {grid.map((row, d) => (
          <FragmentRow key={d} label={DAYS[d]}>
            {row.map((v, h) => (
              <div key={h} className="cell" tabIndex={0} style={{ background: `var(--seq-${step(v)})` }}
                aria-label={`${DAYS[d]} ${h}:00, ${v} rides`}
                onMouseEnter={(e) => show(e, d, h, v)} onFocus={(e) => show(e, d, h, v)} onBlur={() => setTip(null)} />
            ))}
          </FragmentRow>
        ))}
      </div>
      <div className="row" style={{ marginTop: 10, justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div className="legend-ramp">
          <span>0</span>
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <span key={i} className="sw" style={{ background: `var(--seq-${i})` }} />)}
          <span>{max} rides</span>
        </div>
        <span className="small muted">Hour of departure (IST) · stronger colour = busier</span>
      </div>
      {tip && (
        <div className="tip" style={{ left: tip.x, top: tip.y - 8, transform: 'translate(-50%, -100%)' }}>
          <strong>{tip.v}</strong> <span className="secondary">rides</span>
          <div className="muted">{DAYS[tip.d]} · {String(tip.h).padStart(2, '0')}:00–{String((tip.h + 1) % 24).padStart(2, '0')}:00</div>
        </div>
      )}
    </div>
  );
}
function FragmentRow({ label, children }) {
  return (<><div className="rl">{label}</div>{children}</>);
}

/** Radial trust-network graph: rings = hops from the centre student. */
export function TrustNetwork({ me, nodes, hot, setHot }) {
  const t = useTokens();
  const size = 460, c = size / 2;
  const radii = [0, 78, 148, 212];
  const layout = useMemo(() => {
    const pos = new Map([[me.id, { x: c, y: c, angle: 0, hops: 0 }]]);
    const byHop = [1, 2, 3, 4].map((h) => nodes.filter((n) => n.hops === h));
    byHop.forEach((ring, k) => {
      const hop = k + 1;
      const sorted = [...ring].sort((a, b) => {
        const pa = pos.get(a.path_ids[a.path_ids.length - 2])?.angle ?? 0;
        const pb = pos.get(b.path_ids[b.path_ids.length - 2])?.angle ?? 0;
        return pa - pb || a.full_name.localeCompare(b.full_name);
      });
      sorted.forEach((n, i) => {
        const angle = -Math.PI / 2 + (2 * Math.PI * (i + 0.5)) / Math.max(1, sorted.length);
        const r = radii[Math.min(hop, 3)];
        pos.set(n.student_id, { x: c + r * Math.cos(angle), y: c + r * Math.sin(angle), angle, hops: hop });
      });
    });
    return pos;
  }, [me.id, nodes, c]);
  const hotPath = new Set(hot ? nodes.find((n) => n.student_id === hot)?.path_ids ?? [] : []);
  const fillFor = (h) => (h === 1 ? t.seq[6] : h === 2 ? t.seq[4] : t.seq[3]);

  return (
    <svg className="net-svg" viewBox={`0 0 ${size} ${size}`} width="100%" style={{ maxHeight: 460 }} role="img"
      aria-label={`Trust network of ${me.name}: ${nodes.length} students reachable`}>
      {[1, 2, 3].map((h) => <circle key={h} cx={c} cy={c} r={radii[h]} fill="none" stroke={t.grid} strokeWidth={1} />)}
      {nodes.map((n) => {
        const a = layout.get(n.path_ids[n.path_ids.length - 2]); const b = layout.get(n.student_id);
        if (!a || !b) return null;
        const on = hotPath.has(n.student_id) && hotPath.has(n.path_ids[n.path_ids.length - 2]);
        return <line key={`e-${n.student_id}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={on ? t.series1 : t.baseline} strokeWidth={on ? 2 : 1} opacity={hot && !on ? 0.35 : 0.9} />;
      })}
      {nodes.map((n) => {
        const p = layout.get(n.student_id);
        const on = hotPath.has(n.student_id);
        return (
          <g key={n.student_id} onMouseEnter={() => setHot(n.student_id)} onMouseLeave={() => setHot(null)} style={{ cursor: 'pointer' }}>
            <circle cx={p.x} cy={p.y} r={12} fill="transparent" />
            <circle cx={p.x} cy={p.y} r={n.hops === 1 ? 6.5 : 5} fill={fillFor(n.hops)} stroke={on ? t.series1 : t.surface} strokeWidth={2} opacity={hot && !on ? 0.4 : 1} />
            {(n.hops === 1 || on) && (
              <text x={p.x} y={p.y - 10} textAnchor="middle" style={{ fontWeight: on ? 600 : 400 }}>{n.full_name.split(' ')[0]}</text>
            )}
          </g>
        );
      })}
      <circle cx={c} cy={c} r={16} fill={t.series1} stroke={t.surface} strokeWidth={3} />
      <text x={c} y={c + 4} textAnchor="middle" style={{ fill: '#fff', fontWeight: 700, fontSize: 11 }}>YOU</text>
      {[1, 2, 3].map((h) => <text key={`l${h}`} x={c + 4} y={c - radii[h] + 13} style={{ fill: t.axis, fontSize: 10 }}>{h} hop{h > 1 ? 's' : ''}</text>)}
    </svg>
  );
}

/** Small re-render hook for relative timers (e.g. "closes in 3 hours"). */
export function useNow(intervalMs = 30000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(id); }, [intervalMs]);
  return now;
}
