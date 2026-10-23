// Every common pagination style, against a simulated API: 23 items, 5 per page. Each case must return all 23, in order,
// in the first page's shape, using the TOOL'S parameter names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate, findItems } from '../src/paginate.mjs';

const ALL = Array.from({ length: 23 }, (_, i) => ({ id: `i${i}`, n: i }));
const SIZE = 5;
const slice = (from) => ALL.slice(from, from + SIZE);
const enc = (n) => Buffer.from(String(n)).toString('base64'); // opaque cursor
const dec = (c) => Number(Buffer.from(String(c), 'base64').toString());

async function run(api, { params, args = {}, http = false, linkOf } = {}) {
  const calls = [];
  const call = async (a) => { calls.push(a); return api(a); };
  const first = await call(args);
  const out = await paginate(first, { args, params, call, http, linkOf });
  return { ...out, calls };
}
const ids = (arr) => arr.map(x => x.id ?? x.node?.id);
const allIds = ALL.map(x => x.id);

const STYLES = {
  'top-level next_cursor -> cursor (MCP / generic)': {
    params: ['cursor', 'query'],
    api: ({ cursor }) => { const f = cursor ? dec(cursor) : 0; return { items: slice(f), next_cursor: f + SIZE < 23 ? enc(f + SIZE) : null }; },
    get: (r) => r.items,
  },
  'Slack: response_metadata.next_cursor -> cursor': {
    params: ['channel', 'cursor', 'limit'],
    api: ({ cursor }) => { const f = cursor ? dec(cursor) : 0; return { ok: true, messages: slice(f), response_metadata: { next_cursor: f + SIZE < 23 ? enc(f + SIZE) : '' } }; },
    get: (r) => r.messages,
  },
  'Notion: has_more + next_cursor -> start_cursor': {
    params: ['database_id', 'start_cursor', 'page_size'],
    api: ({ start_cursor }) => { const f = start_cursor ? dec(start_cursor) : 0; const more = f + SIZE < 23; return { object: 'list', results: slice(f), has_more: more, next_cursor: more ? enc(f + SIZE) : null }; },
    get: (r) => r.results,
  },
  'HubSpot: paging.next.after -> after': {
    params: ['after', 'limit', 'properties'],
    api: ({ after }) => { const f = after ? dec(after) : 0; return { results: slice(f), ...(f + SIZE < 23 ? { paging: { next: { after: enc(f + SIZE), link: 'x' } } } : {}) }; },
    get: (r) => r.results,
  },
  'Google: nextPageToken -> pageToken': {
    params: ['pageToken', 'pageSize', 'q'],
    api: ({ pageToken }) => { const f = pageToken ? dec(pageToken) : 0; return { files: slice(f), ...(f + SIZE < 23 ? { nextPageToken: enc(f + SIZE) } : {}) }; },
    get: (r) => r.files,
  },
  'Stripe: has_more + starting_after = last id': {
    params: ['limit', 'starting_after', 'ending_before'],
    api: ({ starting_after }) => { const f = starting_after ? ALL.findIndex(x => x.id === starting_after) + 1 : 0; return { object: 'list', data: slice(f), has_more: f + SIZE < 23, url: '/v1/charges' }; },
    get: (r) => r.data,
  },
  'GraphQL relay: data.x.edges + pageInfo{hasNextPage,endCursor} -> after': {
    params: ['first', 'after', 'query'],
    api: ({ after }) => { const f = after ? dec(after) : 0; const more = f + SIZE < 23; return { data: { search: { edges: slice(f).map(node => ({ node })), pageInfo: { hasNextPage: more, endCursor: more ? enc(f + SIZE) : null } } } }; },
    get: (r) => r.data.search.edges,
  },
  'AWS: NextToken -> NextToken': {
    params: ['NextToken', 'MaxResults'],
    api: ({ NextToken }) => { const f = NextToken ? dec(NextToken) : 0; return { Items: slice(f), ...(f + SIZE < 23 ? { NextToken: enc(f + SIZE) } : {}) }; },
    get: (r) => r.Items,
  },
  'DynamoDB: LastEvaluatedKey -> ExclusiveStartKey (object token)': {
    params: ['TableName', 'ExclusiveStartKey', 'Limit'],
    api: ({ ExclusiveStartKey }) => { const f = ExclusiveStartKey ? ALL.findIndex(x => x.id === ExclusiveStartKey.id) + 1 : 0; const p = slice(f); return { Items: p, Count: p.length, ...(f + SIZE < 23 ? { LastEvaluatedKey: { id: p.at(-1).id } } : {}) }; },
    get: (r) => r.Items,
  },
  'Airtable: offset is an opaque string token -> offset': {
    params: ['baseId', 'offset', 'pageSize'],
    api: ({ offset }) => { const f = offset ? dec(offset) : 0; return { records: slice(f), ...(f + SIZE < 23 ? { offset: enc(f + SIZE) } : {}) }; },
    get: (r) => r.records,
  },
  'page + total_pages, 1-based -> page': {
    params: ['page', 'per_page'],
    api: ({ page = 1 }) => ({ results: slice((page - 1) * SIZE), page, total_pages: 5 }),
    get: (r) => r.results,
  },
  'Laravel: current_page + last_page (number) -> page': {
    params: ['page'],
    api: ({ page = 1 }) => ({ data: slice((page - 1) * SIZE), current_page: page, last_page: 5, per_page: 5, total: 23 }),
    get: (r) => r.data,
  },
  'page + has_more, 0-based (the original fixture style) -> page': {
    params: ['page', 'stage'],
    api: ({ page = 0 }) => ({ deals: slice(page * SIZE), page, has_more: (page + 1) * SIZE < 23 }),
    get: (r) => r.deals,
  },
  'ticketing style: last_page: false, no page in the response, 0-based -> page': {
    params: ['page', 'list_ids'],
    api: ({ page = 0 }) => ({ tasks: slice(page * SIZE), last_page: (page + 1) * SIZE >= 23 }),
    get: (r) => r.tasks,
  },
  'next_page number -> page': {
    params: ['page'],
    api: ({ page = 1 }) => ({ items: slice((page - 1) * SIZE), next_page: page * SIZE < 23 ? page + 1 : null }),
    get: (r) => r.items,
  },
  'offset + limit + total -> offset': {
    params: ['offset', 'limit'],
    api: ({ offset = 0 }) => ({ items: slice(offset), offset, limit: SIZE, total: 23 }),
    get: (r) => r.items,
  },
  'Jira: startAt + maxResults + total + isLast -> startAt': {
    params: ['jql', 'startAt', 'maxResults'],
    api: ({ startAt = 0 }) => ({ issues: slice(startAt), startAt, maxResults: SIZE, total: 23, isLast: startAt + SIZE >= 23 }),
    get: (r) => r.issues,
  },
  'offset, no total: stop on a short page -> offset': {
    params: ['offset', 'limit'], args: { limit: SIZE },
    api: ({ offset = 0 }) => ({ rows: slice(offset), offset }),
    get: (r) => r.rows,
  },
  'next URL in the body (Zendesk/DRF style) mapped to tool params -> cursor': {
    params: ['cursor', 'per_page'],
    api: ({ cursor }) => { const f = cursor ? dec(cursor) : 0; return { results: slice(f), next: f + SIZE < 23 ? `https://api.example.com/v2/items?cursor=${enc(f + SIZE)}&per_page=5` : null }; },
    get: (r) => r.results,
  },
  'Microsoft Graph: @odata.nextLink with $skiptoken -> $skiptoken': {
    params: ['$skiptoken', '$top', '$filter'],
    api: (a) => { const f = a.$skiptoken ? dec(a.$skiptoken) : 0; return { value: slice(f), ...(f + SIZE < 23 ? { '@odata.nextLink': `https://graph.example.com/v1.0/users?$skiptoken=${enc(f + SIZE)}` } : {}) }; },
    get: (r) => r.value,
  },
  'JSON:API: links.next -> page[number]': {
    params: ['page[number]', 'page[size]'],
    api: (a) => { const p = a['page[number]'] ?? 1; return { data: slice((p - 1) * SIZE), links: { next: p * SIZE < 23 ? `/articles?page[number]=${p + 1}&page[size]=5` : null } }; },
    get: (r) => r.data,
  },
  'raw array + page + per_page (GitHub style without headers): stop on a short page': {
    params: ['page', 'per_page'], args: { per_page: SIZE, page: 1 },
    api: ({ page = 1 }) => slice((page - 1) * SIZE),
    get: (r) => r,
  },
};

for (const [name, s] of Object.entries(STYLES)) {
  test(`pagination: ${name}`, async () => {
    const { result, pages, truncated, moreAvailable } = await run(s.api, { params: s.params, args: s.args });
    assert.deepEqual(ids(s.get(result)), allIds);
    assert.equal(pages, 5);
    assert.ok(!truncated && !moreAvailable);
  });
}

test('http nodes follow a next URL directly, and a Link header', async () => {
  const api = ({ url }) => { const f = url ? dec(new URL(url).searchParams.get('c')) : 0; return { items: slice(f), next: f + SIZE < 23 ? `https://api.example.com/x?c=${enc(f + SIZE)}` : null }; };
  const r1 = await run(api, { http: true, params: null });
  assert.deepEqual(ids(r1.result.items), allIds);
  const pages = new Map(); // a raw array whose next page is only in the Link header
  const apiL = ({ url }) => { const f = url ? Number(new URL(url).searchParams.get('from')) : 0; const arr = slice(f); pages.set(arr, f + SIZE < 23 ? `https://api.example.com/x?from=${f + SIZE}` : null); return arr; };
  const r2 = await run(apiL, { http: true, params: null, linkOf: (r) => pages.get(r) });
  assert.deepEqual(ids(r2.result), allIds);
});

test('never silent: the page cap is reported as truncated', async () => {
  const api = ({ page = 0 }) => ({ items: [{ id: `p${page}` }], page, has_more: true });
  const calls = [];
  const out = await paginate(api({}), { args: {}, params: ['page'], call: async (a) => { calls.push(a); return api(a); }, maxPages: 7 });
  assert.equal(out.pages, 7);
  assert.equal(out.truncated, true);
});

test('never silent: more is available but the tool has no parameter to ask for it', async () => {
  const api = () => ({ items: slice(0), next_cursor: 'abc' });
  const out = await paginate(api(), { args: {}, params: ['query'], call: async () => assert.fail('must not call') });
  assert.equal(out.moreAvailable, true);
  assert.equal(out.pages, 1);
});

test('loops stop: the same cursor twice, or the same page twice', async () => {
  let n = 0;
  const same = () => { n++; return { items: [{ id: `x${n}` }], next_cursor: 'stuck' }; };
  const a = await paginate(same(), { args: {}, params: ['cursor'], call: async (x) => same(x) });
  assert.equal(a.pages, 2); // the second response hands back the same cursor: stop
  const fixed = () => ({ items: slice(0), last_page: false }); // ignores the page parameter
  const b = await paginate(fixed(), { args: {}, params: ['page'], call: async () => fixed() });
  assert.equal(b.pages, 1);
});

test('no signal, or an ambiguous shape, is one page untouched', async () => {
  const plain = { items: slice(0), total: 5 };
  assert.equal((await paginate(plain, { params: ['offset'], call: async () => assert.fail() })).pages, 1);
  assert.equal(findItems({ a: [1], b: [2] }), null);
  const two = { a: [1], b: [2], next_cursor: 'x' };
  assert.equal((await paginate(two, { params: ['cursor'], call: async () => assert.fail() })).result, two);
});
