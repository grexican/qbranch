// Word overlap between a prompt and skill descriptions, and the tier rule. Pre-declared here, applied mechanically:
//   negative  the answer set is empty
//   named     the prompt contains an acceptable skill's name (hyphens or spaces)
//   lexical   the prompt shares at least one key term with an acceptable skill's description
//   semantic  it shares none
// Key terms: lowercase alphanumeric words of 3+ letters, minus stopwords and the generic words below (words every
// skill description uses about itself), lightly stemmed so "exports"/"exporting"/"export" match.
const STOP = new Set(('a an the and or but if then else of to in on at by for with from into onto over under about as is are was were be been being ' +
  'it its this that these those there here their them they we our ours us you your yours i me my he she his her who whom which what ' +
  'when where why how all any each every some such no not only own same so than too very can could should would will shall may might ' +
  'must do does did done have has had having just also more most other another again once both few many much one two three via per ' +
  'up down out off before after while during between through against until without within upon let get got').split(' '));
export const GENERIC = new Set(('use used using uses when how our here team teams codebase repo repos repository project projects ' +
  'write writing written writes create creating created make making new every each include includes including way ' +
  'format formats formatted shape style styles rule rules convention conventions house required require requires ' +
  'need needs want wants help please thing things like something someone anyone everyone kind sort ' +
  'what which whose good better best right wrong sure quick quickly simple short long small big ' +
  'file files document documents text page pages work works working thank thanks hey hi ok okay').split(' '));

export function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ied')) w = w.slice(0, -3) + 'y';
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
  else if (w.length > 4 && /(ses|xes|ches|shes)$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

export function keyTerms(text) {
  const out = new Set();
  for (const w of String(text).toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []) {
    if (STOP.has(w) || GENERIC.has(w)) continue;
    const s = stem(w);
    if (!GENERIC.has(s)) out.add(s);
  }
  return out;
}

export const shared = (a, b) => [...a].filter(x => b.has(x));

const norm = (s) => ` ${String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
export const namesSkill = (prompt, name) => norm(prompt).includes(norm(name));

/**
 * Overlap of one prompt with every target ({ name: description }), and its tier.
 * Returns { tier, overlap: { max, terms, perSkill }, maxAny }.
 */
export function tierPrompt(text, answers, descriptions) {
  const p = keyTerms(text);
  const per = {};
  for (const [n, d] of Object.entries(descriptions)) per[n] = shared(p, keyTerms(d));
  const acc = answers.map(n => per[n] || []);
  const max = acc.length ? Math.max(...acc.map(a => a.length)) : 0;
  const maxAny = Math.max(0, ...Object.values(per).map(a => a.length));
  let tier;
  if (!answers.length) tier = 'negative';
  else if (answers.some(n => namesSkill(text, n))) tier = 'named';
  else if (max >= 1) tier = 'lexical';
  else tier = 'semantic';
  return { tier, overlap: { max, terms: [...new Set(acc.flat())] }, maxAny };
}
