// Automatic pagination for any common API style. Small models forget to page, start at the wrong page, or stop early;
// doing it here removes the whole failure class. Given the first result, find the item array, read the "there is more"
// signal, and build the next request from the TOOL'S OWN parameter names (the response says next_cursor, the tool may
// call it starting_after). Styles covered, in the order they are tried:
//   1. an explicit "no more" flag ends it (has_more: false, isLast: true, last_page: true, done: true, ...)
//   2. a continuation token (next_cursor, nextPageToken, endCursor, next_token, continuation, scroll_id, after,
//      marker, LastEvaluatedKey, a string offset as Airtable does ...), top level or nested in meta / paging /
//      pagination / response_metadata / pageInfo / links
//   3. a next-page URL (next, links.next, _links.next.href, @odata.nextLink, nextRecordsUrl, a Link header): followed
//      directly for http nodes, its query parameters mapped onto the tool's parameters for tool nodes
//   4. Stripe style: has_more plus a starting_after parameter -> the last item's id
//   5. page numbers (next_page, page + has_more, page < total_pages / last_page, last_page: false, a full page)
//   6. offsets (offset/start/startAt/skip + total, isLast: false, or a full page of `limit`)
// Never silent: a run that stops because of the page cap, or because there is more but no parameter to ask for it,
// says so (truncated / moreAvailable), and loops (the same request twice, the same page twice) stop.

const NO_MORE = [['has_more', false], ['hasMore', false], ['has_next', false], ['hasNext', false], ['hasNextPage', false], ['more', false],
  ['isLast', true], ['is_last', true], ['last_page', true], ['isLastPage', true], ['done', true], ['complete', true]];
const MORE = ['has_more', 'hasMore', 'has_next', 'hasNext', 'hasNextPage', 'more', 'more_results', 'moreResults'];

// response token key -> the parameter names that usually take it, best first (any parameter in TOKEN_PARAMS is a fallback)
const TOKENS = {
  next_cursor: ['cursor', 'next_cursor', 'start_cursor', 'after'], nextCursor: ['cursor', 'nextCursor', 'startCursor', 'after'],
  next_page_token: ['page_token', 'pageToken'], nextPageToken: ['pageToken', 'page_token'],
  endCursor: ['after', 'cursor'], end_cursor: ['after', 'cursor'],
  next_token: ['next_token', 'token'], nextToken: ['nextToken', 'NextToken', 'token'], NextToken: ['NextToken', 'nextToken'],
  continuation: ['continuation', 'continuationToken'], continuationToken: ['continuationToken', 'continuation'], continuation_token: ['continuation_token', 'continuation'],
  scroll_id: ['scroll_id'], _scroll_id: ['scroll_id'], after: ['after', 'cursor'],
  next_marker: ['marker'], NextMarker: ['Marker', 'marker'], LastEvaluatedKey: ['ExclusiveStartKey'],
  cursor: ['cursor'], next: ['next', 'cursor'], offset: ['offset'], // `next`/`offset`: tokens only when they are not URLs / numbers
};
const TOKEN_PARAMS = ['cursor', 'page_token', 'pageToken', 'after', 'starting_after', 'start_cursor', 'startCursor', 'next_cursor', 'next_token',
  'nextToken', 'continuation', 'continuationToken', 'scroll_id', 'marker', 'ExclusiveStartKey', 'token'];
const URL_KEYS = ['next', 'nextLink', '@odata.nextLink', 'next_url', 'nextUrl', 'nextRecordsUrl', 'next_page_url', 'next_page'];
const PAGE_PARAMS = ['page', 'pageNumber', 'page_number', 'pageNo', 'page_no', 'pageIndex', 'page_index', 'p'];
const CUR_PAGE = ['page', 'current_page', 'currentPage', 'pageNumber', 'page_number', 'pageNo', 'pageIndex', 'page_index'];
const TOTAL_PAGES = ['total_pages', 'totalPages', 'pages', 'page_count', 'pageCount', 'num_pages', 'numPages'];
const OFFSET_PARAMS = ['offset', 'start', 'startAt', 'start_at', 'skip', 'from', 'startIndex', 'start_index'];
const TOTALS = ['total', 'total_count', 'totalCount', 'totalResults', 'total_results', 'totalSize', 'total_size', 'count', 'found'];
const SIZES = ['limit', 'per_page', 'perPage', 'page_size', 'pageSize', 'maxResults', 'max_results', 'size', 'count', 'top', '$top', 'first', 'rows'];
const META = ['meta', 'pagination', 'paging', 'page_info', 'pageInfo', 'response_metadata', 'links', '_links', 'metadata', 'cursor', 'next'];
const CONTAINERS = ['data', 'items', 'results', 'records', 'value', 'entries', 'list', 'objects', 'rows', 'hits', 'edges', 'nodes', 'elements', 'resources'];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isUrl = (v) => typeof v === 'string' && /^(https?:\/\/|\/|\?)/.test(v);

/** Where the item array lives: [] (the result itself is the array), ['deals'], ['data', 'search', 'edges'], or null. */
export function findItems(r) {
  if (Array.isArray(r)) return [];
  if (!isObj(r)) return null;
  const found = [];
  const walk = (o, at, depth) => {
    for (const [k, v] of Object.entries(o)) {
      if (Array.isArray(v)) found.push([...at, k]);
      else if (isObj(v) && depth < 3 && !META.includes(k)) walk(v, [...at, k], depth + 1);
    }
  };
  walk(r, [], 0);
  if (found.length === 1) return found[0];
  const top = found.filter(p => p.length === 1);
  if (top.length === 1) return top[0];
  const named = found.filter(p => CONTAINERS.includes(p.at(-1)));
  return named.length === 1 ? named[0] : null; // ambiguous: never guess which list to merge
}

const get = (o, p) => p.reduce((v, k) => (v == null ? v : v[k]), o);
function set(o, p, val) {
  if (!p.length) return val;
  const out = Array.isArray(o) ? [...o] : { ...o };
  out[p[0]] = set(o[p[0]], p.slice(1), val);
  return out;
}

/** The fields that may carry paging signals: the top level, the item array's parent (GraphQL pageInfo), and META objects. */
function signals(r, itemsPath) {
  const out = [];
  const add = (o) => { if (isObj(o)) out.push(o); };
  add(r);
  if (itemsPath?.length > 1) add(get(r, itemsPath.slice(0, -1)));
  for (const scope of [...out]) for (const k of META) {
    add(scope[k]);
    if (isObj(scope[k])) for (const k2 of ['next', 'pageInfo']) add(scope[k][k2]); // paging.next.after, links.next
  }
  return out;
}
const pick = (scopes, keys, ok = (v) => v != null && v !== '') => {
  for (const s of scopes) for (const k of keys) if (k in s && ok(s[k])) return { key: k, value: s[k], scope: s };
  return null;
};
const has = (params, k) => !params || params.includes(k);
const firstParam = (params, cands, fallback) => (params ? cands.find(c => params.includes(c)) : fallback ?? cands[0]);

/**
 * Decide the next request. Returns { args, style } | { url, style } | { stop: 'done' | 'no-param', style? }.
 *   params: the tool's input parameter names (null when unknown: http nodes, or a tool that publishes no schema)
 */
export function nextRequest(r, args, params, items, { http = false, linkNext = null } = {}) {
  const at = findItems(r);
  const scopes = signals(r, at);
  // 1. an explicit "no more" wins over everything else
  for (const [k, v] of NO_MORE) if (pick(scopes, [k], (x) => x === v)) return { stop: 'done' };
  const more = !!pick(scopes, MORE, (x) => x === true);

  // 2. continuation tokens (a numeric offset or a URL is not a token)
  // only DynamoDB's LastEvaluatedKey is an object token; any other object under a token-ish name is a container
  const tokOk = (v, k) => (k === 'LastEvaluatedKey' ? isObj(v) && Object.keys(v).length > 0
    : typeof v === 'string' && v !== '' && !isUrl(v));
  let tok = null;
  for (const s of scopes) { for (const k of Object.keys(TOKENS)) if (k in s && tokOk(s[k], k)) { tok = { key: k, value: s[k] }; break; } if (tok) break; }
  // a relay endCursor is the last page's cursor too: it only means "more" next to hasNextPage: true
  if (tok && (tok.key === 'endCursor' || tok.key === 'end_cursor') && !pick(scopes, ['hasNextPage', 'has_next_page'], x => x === true)) tok = null;
  if (tok) {
    // known names first; else the one parameter that is plainly a cursor (since_cursor, pagination_token, ...)
    const fuzzy = () => { const f = params.filter(p => /cursor|token|continuation|marker|^after$|_after$/i.test(p)); return f.length === 1 ? f[0] : undefined; };
    const param = params ? [...TOKENS[tok.key], ...TOKEN_PARAMS].find(p => params.includes(p)) ?? fuzzy() : TOKENS[tok.key][0];
    if (!param) return { stop: 'no-param', style: `token:${tok.key}` };
    return { args: { ...args, [param]: tok.value }, style: `token:${tok.key}` };
  }

  // 3. a next-page URL (body or Link header)
  const u = linkNext ? { key: 'Link', value: linkNext } : pick(scopes, URL_KEYS, isUrl) || (() => {
    const href = pick(scopes, ['next'], (v) => isObj(v) && isUrl(v.href)); return href && { key: 'next.href', value: href.value.href };
  })();
  if (u) {
    if (http) return { url: u.value, style: `url:${u.key}` };
    const q = new URL(u.value, 'http://x').searchParams;
    const mapped = Object.fromEntries([...q].filter(([k]) => has(params, k)).map(([k, v]) => [k, /^\d+$/.test(v) ? Number(v) : v]));
    if (!Object.keys(mapped).length) return { stop: 'no-param', style: `url:${u.key}` };
    return { args: { ...args, ...mapped }, style: `url:${u.key}` };
  }

  // 4. Stripe: has_more and the last item's id as starting_after
  const last = items.at(-1);
  if (more && params?.includes('starting_after') && last?.id != null) return { args: { ...args, starting_after: last.id }, style: 'starting_after' };

  // 5. page numbers
  const pageParam = firstParam(params, PAGE_PARAMS);
  const nextPage = pick(scopes, ['next_page', 'nextPage'], (v) => typeof v === 'number');
  if (nextPage && pageParam) return { args: { ...args, [pageParam]: nextPage.value }, style: 'page:next_page' };
  const curHit = pick(scopes, CUR_PAGE, (v) => typeof v === 'number');
  const cur = curHit?.value ?? (pageParam && typeof args[pageParam] === 'number' ? args[pageParam] : null);
  const tp = pick(scopes, TOTAL_PAGES, (v) => typeof v === 'number') || pick(scopes, ['last_page', 'lastPage'], (v) => typeof v === 'number');
  const lastFalse = !!pick(scopes, ['last_page', 'isLastPage', 'is_last', 'isLast'], (x) => x === false);
  if (pageParam && (curHit || pageParam in args || lastFalse || (more && !pick(scopes, OFFSET_PARAMS, v => typeof v === 'number')))) {
    const c = cur ?? 0; // unknown start: assume the first page was 0; a repeated page is caught by the duplicate check
    let go = more || lastFalse;
    if (!go && tp) go = c === 0 ? c + 1 < tp.value : c < tp.value; // 0-based vs 1-based numbering
    if (!go && !tp && !curHit && fullPage(args, items, scopes)) go = true;
    if (go) return { args: { ...args, [pageParam]: c + 1 }, style: 'page' };
    if (curHit || tp) return { stop: 'done' };
  }

  // 6. offsets
  const offParam = firstParam(params, OFFSET_PARAMS, pick(scopes, OFFSET_PARAMS, (v) => typeof v === 'number')?.key);
  const offHit = pick(scopes, OFFSET_PARAMS, (v) => typeof v === 'number');
  if (offParam && (offHit || offParam in args)) {
    const off = offHit?.value ?? args[offParam] ?? 0;
    const total = pick(scopes, TOTALS, (v) => typeof v === 'number' && v >= items.length);
    let go;
    if (total) go = off + items.length < total.value;
    else go = more || lastFalse || fullPage(args, items, scopes);
    if (go && items.length) return { args: { ...args, [offParam]: off + items.length }, style: 'offset' };
    return { stop: 'done' };
  }

  if (more) return { stop: 'no-param', style: 'has_more' };
  return { stop: 'done' };
}

/** No explicit signal: a page exactly as big as the requested (or reported) page size is assumed to have a successor. */
function fullPage(args, items, scopes) {
  const size = SIZES.map(k => args[k]).find(v => typeof v === 'number') ?? pick(scopes, SIZES.filter(k => k !== 'count'), (v) => typeof v === 'number')?.value;
  return !!size && items.length >= size;
}

/**
 * Fetch every page. call(args | {url}) -> result (for http, also { linkNext } from a Link header via opts.linkOf).
 * Returns { result (first page's shape, all items merged), pages, style, truncated, moreAvailable }.
 */
export async function paginate(first, { args = {}, params = null, call, maxPages = 50, http = false, linkOf = () => null }) {
  const at = findItems(first);
  if (at === null) return { result: first, pages: 1 };
  let items = [...get(first, at)];
  let r = first, pages = 1, style = null, truncated = false, moreAvailable = false;
  const seenArgs = new Set([JSON.stringify(args)]);
  let lastFp = JSON.stringify(items[0] ?? null), lastLen = items.length, curArgs = args;
  while (true) {
    const n = nextRequest(r, curArgs, params, get(r, at) || [], { http, linkNext: linkOf(r) });
    if (n.stop) { if (n.stop === 'no-param') { moreAvailable = true; style ??= n.style; } break; }
    style ??= n.style;
    if (pages >= maxPages) { truncated = true; break; }
    const key = JSON.stringify(n.args ?? n.url);
    if (seenArgs.has(key)) break; // the API handed back the same continuation: a loop
    seenArgs.add(key);
    const nr = await call(n.args ? n.args : { url: n.url });
    const page = get(nr, at);
    if (!Array.isArray(page) || !page.length) break;
    const fp = JSON.stringify(page[0]);
    if (fp === lastFp && page.length === lastLen) break; // the same page again (a 1-based API asked for page 1 twice)
    lastFp = fp; lastLen = page.length;
    items.push(...page); pages++; r = nr; if (n.args) curArgs = n.args;
  }
  return { result: pages > 1 ? set(first, at, items) : first, pages, style, truncated, moreAvailable };
}
