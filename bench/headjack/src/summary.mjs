// SUMMARY.md: every pre-registered hypothesis (v1 H1-H5 and v2 H2b) with its verdict and 95% Wilson intervals.
// Runs that did not finish (API error, timeout, harness error) are excluded from rates and counted separately.
//
// Verdict rules, applied mechanically:
//   - pass / fail by the pre-registered criterion, on point estimates and (where the criterion says so) intervals;
//   - the A/A rule (v1: "a difference counts only if it exceeds the native vs native-again difference"): a claimed
//     difference (H1, H2, H2b) passes only if it also exceeds the A/A gap; a non-inferiority failure (H3, H4, H5) whose
//     shortfall is within the A/A gap is reported as inconclusive;
//   - inconclusive when an arm has no finished runs in the cell.
import { wilson, overlaps, pct, fmt } from './stats.mjs';

const rate = (runs, f) => { const xs = runs.map(f).filter(v => v != null); return wilson(xs.filter(Boolean).length, xs.length); };
const sel = (runs, q) => runs.filter(r => r.ok && Object.entries(q).every(([k, v]) => (typeof v === 'function' ? v(r[k], r) : Array.isArray(v) ? v.includes(r[k]) : r[k] === v)));
const NATURAL = ['lexical', 'semantic'];
const useRate = (rs) => rate(rs, r => r.useHit);
const loadRate = (rs) => rate(rs, r => r.loadHit);
const falseLoad = (rs) => rate(rs, r => r.falseLoad);
const followRate = (rs) => rate(rs.filter(r => r.loadHit), r => r.useHit);
const aa = (runs, q, metric) => { const a = metric(sel(runs, { ...q, arm: 'native' })), b = metric(sel(runs, { ...q, arm: 'native-again' })); return a.n && b.n ? Math.abs(a.rate - b.rate) : null; };

export function hypotheses(runs) {
  const H = [];
  const row = (id, version, claim, q, metric, judge) => {
    const hj = metric(sel(runs, { ...q, arm: 'headjack' })), nat = metric(sel(runs, { ...q, arm: 'native' }));
    const gap = aa(runs, q, metric);
    let verdict, why;
    if (!hj.n || !nat.n) { verdict = 'inconclusive'; why = 'an arm has no finished runs in this cell'; }
    else ({ verdict, why } = judge(hj, nat, gap));
    H.push({ id, version, claim, headjack: hj, native: nat, aaGap: gap, verdict, why });
  };
  const diff = (hj, nat) => hj.rate - nat.rate;
  row('H1', 'v1', 'At 100+ skills, semantic prompts: headjack - native >= 15 points, intervals do not overlap', { size: s => s >= 100, tier: 'semantic' }, useRate, (hj, nat, gap) => {
    const d = diff(hj, nat);
    if (d < 0.15) return { verdict: 'fail', why: `difference ${pct(d)} < 15 points` };
    if (overlaps(hj, nat)) return { verdict: 'fail', why: `difference ${pct(d)} but the intervals overlap` };
    if (gap != null && d <= gap) return { verdict: 'fail', why: `difference ${pct(d)} does not exceed the A/A gap ${pct(gap)}` };
    return { verdict: 'pass', why: `difference ${pct(d)}` };
  });
  row('H2', 'v1', 'Named-request reach (run at every size, per v2): native <= 20%, headjack >= 80%', { tier: 'named', size: s => s > 0 }, useRate, (hj, nat, gap) => {
    if (nat.rate > 0.2) return { verdict: 'fail', why: `native reaches named skills: ${pct(nat.rate)} > 20%` };
    if (hj.rate < 0.8) return { verdict: 'fail', why: `headjack ${pct(hj.rate)} < 80%` };
    if (gap != null && hj.rate - nat.rate <= gap) return { verdict: 'fail', why: 'difference within the A/A gap' };
    return { verdict: 'pass', why: '' };
  });
  row('H2b', 'v2', 'Past the description cutoff, natural prompts: native <= 30%, headjack >= 70%', { tier: NATURAL, pastCutoff: true }, useRate, (hj, nat, gap) => {
    if (nat.rate > 0.3) return { verdict: 'fail', why: `native ${pct(nat.rate)} > 30%` };
    if (hj.rate < 0.7) return { verdict: 'fail', why: `headjack ${pct(hj.rate)} < 70%` };
    if (gap != null && hj.rate - nat.rate <= gap) return { verdict: 'fail', why: 'difference within the A/A gap' };
    return { verdict: 'pass', why: '' };
  });
  const nonInf = (margin, worse) => (hj, nat, gap) => {
    const short = worse(hj, nat);
    if (short <= margin) return { verdict: 'pass', why: `shortfall ${pct(Math.max(0, short))} <= ${pct(margin)}` };
    if (gap != null && short - margin <= gap) return { verdict: 'inconclusive', why: `shortfall ${pct(short)} but within the A/A gap ${pct(gap)}` };
    return { verdict: 'fail', why: `shortfall ${pct(short)} > ${pct(margin)}` };
  };
  row('H3', 'v1', 'At 5-25 skills, use rate: headjack >= native - 5 points', { size: [5, 25], tier: t => t !== 'negative' }, useRate, nonInf(0.05, (h, n) => n.rate - h.rate));
  row('H4', 'v1', 'False-load rate on negatives: headjack <= native + 5 points', { tier: 'negative', size: s => s > 0 }, falseLoad, nonInf(0.05, (h, n) => h.rate - n.rate));
  row('H5', 'v1', 'Given an acceptable skill was loaded, canary rate: headjack >= native - 5 points', { tier: t => t !== 'negative', size: s => s > 0 }, followRate, nonInf(0.05, (h, n) => n.rate - h.rate));
  return H;
}

function table(runs, model) {
  const arms = ['none', 'native', 'native-again', 'headjack'];
  const sizes = [...new Set(runs.filter(r => r.size > 0).map(r => r.size))].sort((a, b) => a - b);
  const tiers = ['named', 'lexical', 'semantic', 'negative'];
  const lines = [`#### Use rate by size and tier (${model})`, '', `| size | tier | ${arms.join(' | ')} |`, `|---|---|${arms.map(() => '---').join('|')}|`];
  for (const size of sizes) for (const tier of tiers) {
    const m = tier === 'negative' ? falseLoad : useRate;
    lines.push(`| ${size} | ${tier}${tier === 'negative' ? ' (false-load)' : ''} | ${arms.map(a => fmt(m(sel(runs, { arm: a, tier, ...(a === 'none' ? {} : { size }) })))).join(' | ')} |`);
  }
  lines.push('', `#### Load recall, follow rate, cost (${model}, all sizes pooled, non-negative prompts)`, '', '| arm | load recall | follow rate given load | multi-answer use | mean $ / run | mean s / run | mean input+cache tokens |', '|---|---|---|---|---|---|---|');
  for (const a of arms) {
    const rs = sel(runs, { arm: a, tier: t => t !== 'negative' });
    const all = runs.filter(r => r.arm === a && r.ok);
    const mean = (f) => (all.length ? all.reduce((s, r) => s + (f(r) || 0), 0) / all.length : 0);
    lines.push(`| ${a} | ${fmt(loadRate(rs))} | ${fmt(followRate(rs))} | ${fmt(useRate(rs.filter(r => r.multi)))} | ${mean(r => r.costUsd).toFixed(3)} | ${(mean(r => r.durationMs) / 1000).toFixed(1)} | ${Math.round(mean(r => (r.tokens?.input || 0) + (r.tokens?.cacheRead || 0) + (r.tokens?.cacheWrite || 0)))} |`);
  }
  return lines.join('\n');
}

export function summarize(docs, { tag } = {}) {
  const out = [`# headjack skill benchmark: ${tag}`, ''];
  for (const d of docs) {
    const e = d.environment, runs = d.runs;
    const fin = runs.filter(r => r.ok).length;
    out.push(`## ${e.agent} ${e.version} · model ${e.model}`, '',
      `qbranch ${e.qbranchCommit.slice(0, 10)}${e.dirty ? ' (dirty)' : ''} · ${e.os} · node ${e.node} · seed ${e.seed} · ${e.date.slice(0, 10)}`,
      `split ${d.options.split} · sizes ${d.options.sizes.join(',')} · runs ${d.options.runs} · thresholds ${JSON.stringify(e.thresholds)}${e.thresholdsFrozen ? ' (frozen)' : ''}`,
      `prompts ${e.promptsSha} · canaries ${e.canariesSha} · filler manifest ${e.fillerManifestSha}`,
      `runs: ${runs.length} recorded, ${fin} finished, ${runs.length - fin} excluded (errors/timeouts)`, '');
    const comp = Object.entries(d.libraries || {}).filter(([k]) => k.startsWith('s1-')).map(([k, v]) => `${k.split('-')[1]}: ${Object.entries(v).map(([a, b]) => `${b} ${a}`).join(', ')}`);
    if (comp.length) out.push(`Library composition (shard 1; other shards alike): ${comp.join(' · ')}${Object.values(d.libraries).some(v => v.synthetic) ? ' (includes seeded synthetic filler)' : ''}`, '');
    const L = Object.entries(d.listings || {});
    if (L.length) {
      out.push('Description cutoff (listing as received, per library): ' + [...new Set(L.map(([k]) => k.split('-')[1]))].map(n => {
        const xs = L.filter(([k]) => k.endsWith(`-${n}`)).map(([, v]) => v);
        const past = xs.reduce((s, v) => s + Object.values(v.targets).filter(t => t.pastCutoff).length, 0), tot = xs.reduce((s, v) => s + Object.keys(v.targets).length, 0);
        return `${n}: ${xs.map(v => v.described).join('/')} described, past-cutoff targets ${past}/${tot}`;
      }).join(' · '), '');
    }
    out.push('| | ver | hypothesis | headjack | native | A/A gap | verdict |', '|---|---|---|---|---|---|---|');
    for (const h of hypotheses(runs)) out.push(`| ${h.id} | ${h.version} | ${h.claim} | ${fmt(h.headjack)} | ${fmt(h.native)} | ${h.aaGap == null ? 'n/a' : pct(h.aaGap)} | **${h.verdict}** ${h.why ? `(${h.why})` : ''} |`);
    out.push('', table(runs, e.model), '');
  }
  return out.join('\n') + '\n';
}
