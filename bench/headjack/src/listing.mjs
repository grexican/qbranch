// Reading the skill listing the model actually received (captured by src/tap.mjs) and finding the description cutoff.
//
// Claude Code lists skills as lines "- name: description" or, once its description budget is spent, "- name" alone.
// v2 definition: the description cutoff is where a skill positioned late in the alphabetical listing no longer has its
// description; past-cutoff skills are those positioned at or after the first user skill listed without one.

/** Parse the listing lines out of a request's text: Map name -> description|null, in listing order. */
export function parseListing(text) {
  const out = new Map();
  const start = text.lastIndexOf('The following skills are available');
  if (start < 0) return out;
  const block = text.slice(start, text.indexOf('</system-reminder>', start) >>> 0 || undefined);
  for (const line of block.split('\n')) {
    const m = line.match(/^- ([a-z0-9][a-z0-9:-]*)(?:: (.*))?$/);
    if (m) out.set(m[1], m[2] ?? null);
  }
  return out;
}

/**
 * For a library (names in it, target names), what the listing shows: which skills kept a description, where the first
 * drop is, and each target's position and past-cutoff status.
 */
export function analyzeListing(listing, libraryNames, targetNames) {
  const lib = new Set(libraryNames);
  const order = [...listing.keys()].filter(n => lib.has(n));
  const firstDrop = order.findIndex(n => listing.get(n) == null);
  const described = order.filter(n => listing.get(n) != null).length;
  const targets = {};
  for (const t of targetNames) {
    const pos = order.indexOf(t);
    targets[t] = { position: pos, listed: pos >= 0, described: pos >= 0 && listing.get(t) != null, pastCutoff: pos >= 0 && firstDrop >= 0 && pos >= firstDrop };
  }
  return { size: order.length, listedOfLibrary: order.length, described, firstDrop: firstDrop < 0 ? null : firstDrop, lastDescribed: order.length ? listing.get(order[order.length - 1]) != null : null, targets };
}
