// =====================================================================
// Hidden behavioural traits of every seeded student (used by the M4 and
// M5 seeds). Derived DETERMINISTICALLY from the student id, so the same
// student is a late payer in the payments data AND gets "Payment delayed"
// tags in the ratings data. That is what makes the cross-module analytics
// (tags_vs_payments, reliability_vs_money) tell a consistent story.
// =====================================================================

export function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a string hash → 32-bit seed
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export const DEMO_ID = '2023A7PS0001H';

export function traitsFor(studentId, { noShows = 0 } = {}) {
  const r = mulberry32(hash(String(studentId).trim()));
  const gauss = (m, s) => m + s * Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  // a student who has actually skipped rides (Member 2's data) is more likely "flaky"
  const flaky = r() < 0.08 + Math.min(0.5, noShows * 0.18);
  const t = {
    flaky,
    quality: clamp(gauss(flaky ? 3.6 : 4.3, 0.4), 2.4, 4.95),            // how good a co-rider they are
    harshness: r() < 0.08 ? -0.9 : r() < 0.09 ? 0.6 : gauss(0, 0.25),   // how harshly they rate others
    diligence: 0.35 + 0.6 * r(),                                        // how often they bother to rate
    latePayer: r() < 0.12,                                              // slow to settle up
    cashOnly: r() < 0.05,                                               // no UPI ID registered
  };
  if (String(studentId).trim() === DEMO_ID) Object.assign(t, { flaky: false, quality: 4.55, harshness: 0, latePayer: false, cashOnly: false });
  return t;
}
