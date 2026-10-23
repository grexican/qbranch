// Which "server.tool" refs a plan names (for stats, errors and nudge conversion). Never throws.
export function planTools(plan) {
  const out = new Set();
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (typeof n.tool === 'string') out.add(n.tool);
    if (n.each) walk(n.each);
  };
  try { walk(typeof plan === 'string' ? JSON.parse(plan) : plan); } catch { /* not a plan */ }
  return [...out];
}
