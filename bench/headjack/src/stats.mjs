// Rates with 95% Wilson score intervals.
export function wilson(k, n, z = 1.959964) {
  if (!n) return { k, n, rate: null, lo: null, hi: null };
  const p = k / n, z2 = z * z, den = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / den, h = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / den;
  return { k, n, rate: p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}
export const overlaps = (a, b) => a.n && b.n && !(a.hi < b.lo || b.hi < a.lo);
export const pct = (x) => (x == null ? 'n/a' : `${(100 * x).toFixed(1)}%`);
export const fmt = (w) => (w.n ? `${pct(w.rate)} [${pct(w.lo)}, ${pct(w.hi)}] (${w.k}/${w.n})` : 'n/a (0 runs)');
