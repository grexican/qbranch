// The cost ladder for any vendor. A model name parses into a rung: vendor, base model, and reasoning effort.
//   claude-opus-5-5            -> opus            (Anthropic keys stay haiku | sonnet | opus | fable: the hook routes them)
//   claude-opus-5-thinking-high -> opus@high
//   grok-4.7-high              -> grok-4.7@high   (Cursor-style names: [cursor-]<model>[-thinking][-<effort>][-fast])
//   cursor-grok-4.6-high-fast  -> grok-4.6@high+fast
//   gpt-5.6-sol-medium         -> gpt-5.6-sol@medium
// Cheaper rungs come in a fixed order: lower effort on the same model first (keeps the prompt cache, smallest risk),
// then the next size down within the same vendor and version. Versions are never a ladder: an older model is not a
// cheaper tier of a newer one.
const EFFORT = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const ANTHROPIC = ['haiku', 'sonnet', 'opus', 'fable'];

export function rung(model) {
  let m = String(model || '').toLowerCase().replace(/-\d{8}$/, '').replace(/^cursor-/, '');
  let effort = null, fast = false;
  m = m.replace(/-fast$/, () => { fast = true; return ''; });
  m = m.replace(/-(?:thinking-)?(minimal|low|medium|high|xhigh|max)$/, (_, e) => { effort = e; return ''; });
  m = m.replace(/-thinking$/, () => { effort ??= 'high'; return ''; });
  let vendor = 'other', base = m;
  const size = ANTHROPIC.find(s => m.includes(s)) || (/mythos/.test(m) ? 'fable' : null);
  if (size && /^(claude|haiku|sonnet|opus|fable|mythos)/.test(m)) { vendor = 'anthropic'; base = size; }
  else if (/^(gpt|o\d|codex)/.test(m)) vendor = 'openai';
  else if (/^gemini/.test(m)) vendor = 'google';
  else if (/^grok/.test(m)) vendor = 'xai';
  else if (/^composer/.test(m)) vendor = 'cursor';
  else if (/^(default|auto)$/.test(m)) vendor = 'auto';   // the editor picked: not a choice the user can tune
  const key = base + (effort ? `@${effort}` : '') + (fast ? '+fast' : '');
  return { key, vendor, base, effort, fast };
}

/** Parse a rung key back (the inverse of rung().key). */
export function parseKey(key) {
  const m = String(key).match(/^(.+?)(?:@([a-z]+))?(\+fast)?$/) || [];
  const base = m[1] || key;
  return { key, base, effort: m[2] || null, fast: !!m[3], vendor: ANTHROPIC.includes(base) ? 'anthropic' : rung(base).vendor };
}

/** Smaller models of the same vendor and version, nearest first. */
function sizesBelow(base, vendor) {
  if (vendor === 'anthropic') return ANTHROPIC.slice(0, ANTHROPIC.indexOf(base)).reverse();
  if (vendor === 'openai') {
    if (/-pro$/.test(base)) return [base.replace(/-pro$/, ''), base.replace(/-pro$/, '-mini')];
    if (/-mini$/.test(base)) return [base.replace(/-mini$/, '-nano')];
    if (/-nano$/.test(base)) return [];
    return [`${base}-mini`, `${base}-nano`];
  }
  if (vendor === 'google') {
    if (/-pro\b/.test(base)) return [base.replace(/-pro\b/, '-flash'), base.replace(/-pro\b/, '-flash-lite')];
    if (/-flash$/.test(base)) return [`${base}-lite`];
    return [];
  }
  if (vendor === 'xai') return /-mini$/.test(base) ? [] : [`${base}-mini`];
  return [];
}

/** Cheaper rungs of a key, nearest first: effort steps down on the same model, then smaller sizes. */
export function cheaperOf(key) {
  const r = parseKey(key);
  if (r.vendor === 'auto' || r.vendor === 'other') return [];
  const out = [];
  const tail = r.fast ? '+fast' : '';
  if (r.effort) {
    const i = EFFORT.indexOf(r.effort);
    if (i > EFFORT.indexOf('medium')) out.push(r.base + tail);                 // the model's default effort
    for (const e of EFFORT.slice(0, i).reverse()) if (e !== 'minimal') out.push(`${r.base}@${e}${tail}`);
  }
  for (const s of sizesBelow(r.base, r.vendor)) out.push(s + tail);
  return [...new Set(out)].filter(k => k !== key);
}

/** Is this step an effort change on the same model (cache-friendly), or a different, smaller model? */
export const sameModel = (a, b) => parseKey(a).base === parseKey(b).base;
