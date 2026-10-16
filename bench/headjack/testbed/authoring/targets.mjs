// Source of the 40 target skills: original, written for this benchmark. `node bench/headjack/testbed/authoring/write.mjs`
// renders each into testbed/targets/<name>/SKILL.md and collects the canaries into testbed/canaries.json.
// Rules of the house: every convention is odd and specific (no model produces it by default), every canary is a
// deterministic regex, and the description says what the skill is for without revealing the markers.
//
// shard: which 5-skill group the skill belongs to (libraries are built per shard; see src/library.mjs).
// pair:  skills sharing a pair id both legitimately fit one situation (multi-answer prompts).
// minHits: how many of the canaries must match for the skill to count as used.
export const TARGETS = [
  // ---------------- shard 1 ----------------
  {
    name: 'palette-token-names', shard: 1, pair: 'design-tokens', domain: 'design',
    description: 'House rules for naming color design tokens (CSS custom properties) in our design system, including how shades are stepped and how contrast is recorded. Use when defining or renaming theme colors, CSS variables or a color palette.',
    body: `# Palette token names

Every color token follows these rules. They override any naming scheme you know.

1. Name colors after minerals, never after hues or roles: \`--hue-<mineral>-<step>\`. Minerals in use: basalt, quartz, jasper, malachite, cobalt, ochre, slate.
2. Steps go in fifties from 050 to 950, written with three digits (\`--hue-cobalt-050\`, \`--hue-cobalt-350\`).
3. Every token that is meant for text or icons carries a trailing comment with its contrast against the page background: \`/* contrast: 7.1:1 */\`.
4. Role aliases (button, link, surface) point at mineral tokens and live in a separate \`:root\` block headed \`/* roles */\`.

Example:

\`\`\`css
:root {
  --hue-basalt-900: #1d1f24; /* contrast: 15.2:1 */
  --hue-cobalt-500: #2f5fd0; /* contrast: 5.4:1 */
}
/* roles */
:root { --link: var(--hue-cobalt-500); }
\`\`\`
`,
    canaries: [
      { id: 'mineral-token', re: '--hue-(basalt|quartz|jasper|malachite|cobalt|ochre|slate)-\\d{3}\\b' },
      { id: 'contrast-comment', re: 'contrast:\\s*\\d+(\\.\\d+)?:1' },
      { id: 'roles-block', re: '/\\*\\s*roles\\s*\\*/' },
    ], minHits: 2,
  },
  {
    name: 'type-scale-ladder', shard: 1, pair: 'design-tokens', domain: 'design',
    description: 'Our typography scale: how font sizes, line heights and the base size are defined as tokens for web projects. Use when setting up fonts, text sizes, headings or a type scale in CSS.',
    body: `# Type scale ladder

1. Font sizes are rungs on a ladder: \`--type-rung-0\` is the base, \`--type-rung-1\`, \`--type-rung-2\`... go up, \`--type-rung--1\` goes down. Never name sizes sm/md/lg or h1/h2.
2. The base is 17px and the ratio is 1.2. State both in a header comment exactly like this: \`/* ladder: ratio 1.2 · base 17px */\`.
3. Every rung is paired with a leading token: \`--lead-rung-<n>\` (unitless).
4. Headings map to rungs in a separate block, never with raw pixel values.

\`\`\`css
/* ladder: ratio 1.2 · base 17px */
:root {
  --type-rung-0: 1.0625rem; --lead-rung-0: 1.55;
  --type-rung-1: 1.275rem;  --lead-rung-1: 1.4;
}
\`\`\`
`,
    canaries: [
      { id: 'rung-token', re: '--type-rung-\\d' },
      { id: 'ladder-comment', re: 'ratio 1\\.2\\s*·\\s*base 17px' },
      { id: 'lead-token', re: '--lead-rung-\\d' },
    ], minHits: 2,
  },
  {
    name: 'commit-message-trailers', shard: 1, domain: 'writing',
    description: 'How this team writes git commit messages: subject line shape, body, and the trailers every commit must carry. Use when writing, fixing or reviewing a commit message.',
    body: `# Commit message trailers

1. Subject: \`<area>: <imperative verb> <what>\`, at most 60 characters, no trailing period.
2. Body: one short paragraph on why, wrapped at 72 columns.
3. Every commit ends with exactly these two trailers, in this order, each on its own line:
   - \`Risk: low\`, \`Risk: medium\` or \`Risk: high\`
   - \`Rollback: <one line saying how to undo it>\`
4. No emoji, no ticket numbers in the subject (they go in a \`Refs:\` trailer after Rollback when there is one).

\`\`\`
billing: round invoice totals half-even

Totals were rounded half-up, which drifted from the ledger by a cent on
about 1 in 400 invoices.

Risk: low
Rollback: revert this commit; no data migration involved
\`\`\`
`,
    canaries: [
      { id: 'risk-trailer', re: '^Risk: (low|medium|high)\\s*$', flags: 'm' },
      { id: 'rollback-trailer', re: '^Rollback: \\S.+$', flags: 'm' },
    ], minHits: 2,
  },
  {
    name: 'sql-house-style', shard: 1, domain: 'code-style',
    description: 'SQL formatting and naming conventions for queries in this codebase: casing, comma placement, common table expressions and aliases. Use when writing, formatting or reviewing a SQL query.',
    body: `# SQL house style

1. Keywords in lowercase (\`select\`, \`from\`, \`where\`), identifiers in snake_case.
2. Leading commas: every column after the first starts its line with \`, \`.
3. Every common table expression is named \`cte_<what>\` and the query starts with \`with cte_...\`. Never nest subqueries in \`from\`.
4. Table aliases are the table's first three letters, never single letters.
5. End the query with a comment line \`-- grain: <one row per what>\`.

\`\`\`sql
with cte_paid as (
  select cus.id
       , sum(inv.total) as paid_total
  from customers cus
  join invoices inv on inv.customer_id = cus.id
  group by cus.id
)
select * from cte_paid
-- grain: one row per customer
\`\`\`
`,
    canaries: [
      { id: 'cte-prefix', re: '\\bwith\\s+cte_\\w+\\s+as\\b', flags: 'i' },
      { id: 'leading-comma', re: '^\\s*,\\s*[a-z_]', flags: 'm' },
      { id: 'grain-comment', re: '--\\s*grain:', flags: 'i' },
    ], minHits: 2,
  },
  {
    name: 'runbook-steps', shard: 1, domain: 'ops',
    description: 'The format for operational runbooks: how steps, expected results and fallbacks are written so anyone on call can follow them. Use when writing or rewriting a runbook, an ops procedure or step-by-step operating instructions.',
    body: `# Runbook steps

1. Title line: \`RUNBOOK · <system> · <task>\`.
2. A \`Before you start:\` list of access and preconditions.
3. Steps are numbered \`STEP 1 ▸\`, \`STEP 2 ▸\`... Each step is exactly three lines:
   - the action (a command in backticks when there is one),
   - \`Expect:\` what you should see,
   - \`If not:\` what to do instead (often "stop and page the owner").
4. End with \`Done when:\` and a single observable condition.

\`\`\`
RUNBOOK · queue workers · drain one node
Before you start: shell access to the node, the dashboard open
STEP 1 ▸ \`systemctl stop worker\`
Expect: the node's in-flight count falls to 0 within 2 minutes
If not: stop and page the queue owner
Done when: the node shows 0 jobs for 5 minutes
\`\`\`
`,
    canaries: [
      { id: 'step-marker', re: 'STEP \\d+ ▸' },
      { id: 'expect-line', re: '^\\s*(-\\s*)?Expect:', flags: 'm' },
      { id: 'if-not-line', re: '^\\s*(-\\s*)?If not:', flags: 'm' },
    ], minHits: 2,
  },
  // ---------------- shard 2 ----------------
  {
    name: 'react-hook-contracts', shard: 2, pair: 'react', domain: 'code-style',
    description: 'The contract every custom React hook in this codebase follows: what it returns, how loading and failure are reported, and the file header. Use when writing or refactoring a custom React hook, data fetching in React, or hook-based state.',
    body: `# React hook contracts

1. The first line of every hook file is \`// hook-contract: v1\`.
2. A hook returns one object \`{ status, data, problem }\`. Never return a tuple, never call the field \`error\` or \`loading\`.
3. \`status\` is exactly one of \`'idle' | 'busy' | 'done' | 'failed'\`.
4. \`problem\` is \`null\` or \`{ code: string, message: string }\`.
5. Hooks never throw; they set \`status: 'failed'\` and fill \`problem\`.

\`\`\`ts
// hook-contract: v1
export function useOrders(customerId: string) {
  const [state, set] = useState({ status: 'idle', data: null, problem: null });
  // ... set({ status: 'busy', data: null, problem: null }) while fetching
  return state;
}
\`\`\`
`,
    canaries: [
      { id: 'contract-header', re: '//\\s*hook-contract:\\s*v1' },
      { id: 'busy-status', re: '[\'"]busy[\'"]' },
      { id: 'problem-field', re: '\\bproblem\\s*[:,}]' },
    ], minHits: 2,
  },
  {
    name: 'react-component-anatomy', shard: 2, pair: 'react', domain: 'code-style',
    description: 'How a React component file is laid out in this codebase: section order, section markers and the naming of its props type. Use when creating, splitting or reviewing a React component.',
    body: `# React component anatomy

A component file has four sections, in this order, each introduced by a marker comment on its own line:

1. \`// §props\` the props type. It is named \`<Component>Knobs\` (never \`Props\`).
2. \`// §state\` hooks and derived values.
3. \`// §handlers\` event handlers, each named \`on<Thing><Event>\`.
4. \`// §render\` the returned JSX.

One component per file, a named export (no default export).

\`\`\`tsx
// §props
type OrderListKnobs = { customerId: string };
export function OrderList({ customerId }: OrderListKnobs) {
  // §state
  // §handlers
  // §render
  return <ul />;
}
\`\`\`
`,
    canaries: [
      { id: 'render-marker', re: '//\\s*§render' },
      { id: 'props-marker', re: '//\\s*§props' },
      { id: 'knobs-type', re: '\\b[A-Z]\\w*Knobs\\b' },
    ], minHits: 2,
  },
  {
    name: 'meeting-notes-ledger', shard: 2, domain: 'writing',
    description: 'The format for meeting notes in this team: how decisions, open questions and action items are recorded so they can be found later. Use when writing up, summarizing or cleaning up notes from a meeting or call.',
    body: `# Meeting notes ledger

1. First line: \`<YYYY-MM-DD> · <meeting name> · <who attended, first names>\`.
2. Sections, in this order: \`Decisions\`, \`Open questions\`, \`Actions\`. Nothing else (no summary, no discussion log).
3. Decisions are numbered \`D-1\`, \`D-2\`... Open questions are \`Q-1\`, \`Q-2\`...
4. Every action is one line: \`→ @owner by YYYY-MM-DD: <what>\`. An action without an owner or date is not written down; it becomes an open question.

\`\`\`
2026-03-02 · pricing sync · Ana, Joe, Mei
Decisions
D-1 Annual plans get two months free.
Open questions
Q-1 Do we grandfather existing monthly customers?
Actions
→ @ana by 2026-03-09: draft the pricing page copy
\`\`\`
`,
    canaries: [
      { id: 'decision-id', re: '\\bD-1\\b' },
      { id: 'action-line', re: '→\\s*@\\w+\\s+by\\s+\\d{4}-\\d{2}-\\d{2}' },
      { id: 'question-id', re: '\\bQ-1\\b' },
    ], minHits: 2,
  },
  {
    name: 'yaml-config-layout', shard: 2, domain: 'data-formats',
    description: 'How YAML configuration files are laid out here: section separators, key naming, ownership and the required header. Use when writing or restructuring a YAML config file for an app or service.',
    body: `# YAML config layout

1. The file starts with \`x-owner: <team or person>\` and \`x-reviewed: <YYYY-MM-DD>\`.
2. Top-level sections are separated by a comment line of the form \`# --- <section> ---\`.
3. Keys are kebab-case (\`max-connections\`), never snake_case or camelCase.
4. Durations are strings with units (\`"30s"\`), never bare numbers.

\`\`\`yaml
x-owner: payments-team
x-reviewed: 2026-02-11
# --- server ---
server:
  listen-port: 8080
  read-timeout: "30s"
\`\`\`
`,
    canaries: [
      { id: 'owner-key', re: '^x-owner:', flags: 'm' },
      { id: 'section-sep', re: '^#\\s*---\\s*[\\w -]+\\s*---\\s*$', flags: 'm' },
      { id: 'reviewed-key', re: '^x-reviewed:', flags: 'm' },
    ], minHits: 2,
  },
  {
    name: 'a11y-review-tags', shard: 2, domain: 'design',
    description: 'How accessibility reviews of screens and components are written up: severity tags, the keyboard walk-through and the summary line. Use when reviewing a UI, page, form or design for accessibility.',
    body: `# Accessibility review tags

1. Every finding starts with a tag: \`A11Y-H\` (blocks a task), \`A11Y-M\` (slows a task), \`A11Y-L\` (polish).
2. Each finding names the criterion it fails in plain words, then the fix.
3. Include a \`Keyboard path:\` section that walks the main task with Tab/Enter/Escape only and says where it breaks.
4. End with a summary line: \`Tally: <n> H · <n> M · <n> L\`.

\`\`\`
A11Y-H The submit button is a div; it cannot be reached by keyboard. Fix: use a button element.
Keyboard path: Tab to email → Tab to password → Tab skips submit (breaks here)
Tally: 1 H · 0 M · 0 L
\`\`\`
`,
    canaries: [
      { id: 'severity-tag', re: '\\bA11Y-[HML]\\b' },
      { id: 'keyboard-path', re: 'Keyboard path:' },
      { id: 'tally-line', re: 'Tally:\\s*\\d+\\s*H' },
    ], minHits: 2,
  },
  // ---------------- shard 3 ----------------
  {
    name: 'release-notes-voice', shard: 3, pair: 'release', domain: 'writing',
    description: 'How user-facing release notes are written: grouping, voice and the opening line. Use when announcing a new version to users, writing release notes or a "what\'s new" post.',
    body: `# Release notes voice

1. Open with one sentence that starts \`This release\` and says the single biggest change.
2. Group items under exactly three headings, in this order: \`Fresh\`, \`Fixed\`, \`Farewell\` (removed or deprecated). Omit an empty group.
3. Every item under Fresh starts with \`You can now\`.
4. No version-control jargon (no "merged", "PR", "refactor"). Speak to the user.

\`\`\`
This release makes exports ten times faster.
## Fresh
- You can now export a whole year in one click.
## Fixed
- Dates in exports no longer shift by a day in some time zones.
## Farewell
- The legacy XML export is gone; use CSV instead.
\`\`\`
`,
    canaries: [
      { id: 'fresh-heading', re: '^#*\\s*\\**Fresh\\**\\s*$', flags: 'm' },
      { id: 'farewell-heading', re: '^#*\\s*\\**Farewell\\**\\s*$', flags: 'm' },
      { id: 'you-can-now', re: 'You can now' },
    ], minHits: 2,
  },
  {
    name: 'changelog-ledger', shard: 3, pair: 'release', domain: 'docs',
    description: 'The format of the CHANGELOG file: version headers, dates, codenames and the per-line change markers. Use when adding a version to a changelog or summarizing what changed between versions.',
    body: `# Changelog ledger

1. Newest version first. Each version header is \`## [x.y.z] · YYYY-MM-DD · <codename>\`; codenames are trees (alder, birch, cedar...).
2. Each change is one line starting with a marker: \`+ \` added, \`~ \` changed, \`- \` removed, \`! \` security.
3. No sub-headings inside a version. No links.
4. A line ends with the area in parentheses: \`(exports)\`.

\`\`\`
## [2.3.0] · 2026-05-04 · cedar
+ year-long export in one click (exports)
~ CSV dates are now ISO 8601 (exports)
- legacy XML export (exports)
\`\`\`
`,
    canaries: [
      { id: 'version-header', re: '^##\\s*\\[\\d+\\.\\d+\\.\\d+\\]\\s*·\\s*\\d{4}-\\d{2}-\\d{2}\\s*·\\s*\\w+', flags: 'm' },
      { id: 'tilde-marker', re: '^~ \\S', flags: 'm' },
      { id: 'area-suffix', re: '^[+~!-] .+\\([a-z -]+\\)\\s*$', flags: 'm' },
    ], minHits: 2,
  },
  {
    name: 'python-docstring-contract', shard: 3, domain: 'code-style',
    description: 'How Python functions are documented in this codebase: the docstring sections and their order. Use when writing or documenting Python functions, methods or modules.',
    body: `# Python docstring contract

Every public function gets a docstring with these sections, in this order, and no others:

\`\`\`python
def settle(invoice, amount):
    """Apply a payment to an invoice.

    Takes: invoice (Invoice), amount (Decimal, > 0)
    Gives: the updated Invoice
    Breaks when: amount exceeds the open balance (raises OverpaymentError)
    """
\`\`\`

1. One summary line in the imperative.
2. \`Takes:\` parameters with types and constraints on one line.
3. \`Gives:\` the return value.
4. \`Breaks when:\` the conditions that raise, and what they raise.
Never use Google, NumPy or reST docstring styles.
`,
    canaries: [
      { id: 'takes', re: '^\\s*Takes:', flags: 'm' },
      { id: 'gives', re: '^\\s*Gives:', flags: 'm' },
      { id: 'breaks-when', re: '^\\s*Breaks when:', flags: 'm' },
    ], minHits: 2,
  },
  {
    name: 'compose-service-labels', shard: 3, domain: 'ops',
    description: 'Conventions for docker compose files: required service labels, healthchecks and restart policy. Use when writing or editing a docker-compose.yml or containerizing a small multi-service app.',
    body: `# Compose service labels

1. Every service carries the label \`com.house.tier\` with one of \`edge\`, \`core\`, \`data\`.
2. Every service has a healthcheck with \`interval: 17s\`, \`timeout: 4s\` and \`retries: 5\` (the odd interval keeps checks from aligning).
3. Restart policy is always \`restart: unless-stopped\`.
4. Images are pinned by tag and digest comment: \`image: postgres:16.4 # digest pinned in ops repo\`.

\`\`\`yaml
services:
  db:
    image: postgres:16.4 # digest pinned in ops repo
    labels:
      com.house.tier: data
    healthcheck:
      test: ["CMD", "pg_isready"]
      interval: 17s
      timeout: 4s
      retries: 5
    restart: unless-stopped
\`\`\`
`,
    canaries: [
      { id: 'tier-label', re: 'com\\.house\\.tier' },
      { id: 'odd-interval', re: 'interval:\\s*17s' },
      { id: 'digest-comment', re: '#\\s*digest pinned' },
    ], minHits: 2,
  },
  {
    name: 'user-story-cards', shard: 3, domain: 'planning',
    description: 'How product work is written as story cards in this team: the fields, the ids and the acceptance line. Use when turning a feature idea or request into user stories, tickets or backlog items.',
    body: `# User story cards

Do not use the "As a ..., I want ..., so that ..." template. Every story is a card with these fields, in this order:

\`\`\`
ST-101
WHO: a returning shopper on mobile
NEEDS: to reorder a past order in one tap
BECAUSE: rebuilding the cart by hand takes minutes
DONE-WHEN: a past order's "reorder" fills the cart with in-stock items and says which were skipped
SIZE: S
\`\`\`

1. Ids are \`ST-\` plus three digits, starting at 101.
2. \`DONE-WHEN:\` is one observable condition, never a list.
3. \`SIZE:\` is S, M or L. Anything bigger is split into more cards.
`,
    canaries: [
      { id: 'story-id', re: '\\bST-\\d{3}\\b' },
      { id: 'needs-field', re: '^\\s*\\**NEEDS:?\\**:?', flags: 'm' },
      { id: 'done-when', re: 'DONE-WHEN:' },
    ], minHits: 2,
  },
  // ---------------- shard 4 ----------------
  {
    name: 'test-naming-givenwhen', shard: 4, pair: 'tests', domain: 'testing',
    description: 'How unit tests are named and structured in this codebase: the test name pattern and the oracle comment. Use when writing, naming or reviewing unit tests in any language.',
    body: `# Test naming: given/when/then

1. Test names follow \`given_<state>__when_<action>__then_<outcome>\` (snake_case, double underscores between parts), in every language.
2. Each test body has a single comment line stating where the expected value comes from: \`// oracle: <source>\` (or \`# oracle:\` in Python), e.g. \`// oracle: worked by hand from the pricing table\`.
3. One behavior per test; no loops over cases inside a test (use the framework's parameterization).

\`\`\`js
test('given_empty_cart__when_total__then_zero', () => {
  // oracle: an empty cart costs nothing by definition
  expect(total([])).toBe(0);
});
\`\`\`
`,
    canaries: [
      { id: 'gwt-name', re: 'given_\\w+__when_\\w+__then_\\w+' },
      { id: 'oracle-comment', re: '(//|#)\\s*oracle:' },
    ], minHits: 2,
  },
  {
    name: 'fixture-builders', shard: 4, pair: 'tests', domain: 'testing',
    description: 'How test data is created in this codebase: builder functions, their naming and how fields are overridden. Use when writing unit or integration tests that need sample objects, fixtures or test data.',
    body: `# Fixture builders

1. Never write object literals for domain objects in tests. Build them with builder functions named \`a<Thing>()\` or \`an<Thing>()\` (\`aCart()\`, \`anOrder()\`).
2. Builders return sensible defaults and expose \`.with<Field>(value)\` methods for overrides, then \`.build()\`.
3. Builders live together at the top of the test file (or in a builders file), and that block ends with the comment \`// builders end\`.

\`\`\`js
const aCart = () => ({ items: [], withItems(items) { this.items = items; return this; }, build() { return { items: this.items }; } });
// builders end

test('...', () => {
  const cart = aCart().withItems([anItem().withPrice(5).build()]).build();
});
\`\`\`
`,
    canaries: [
      { id: 'builder-chain', re: '\\ban?[A-Z]\\w*\\(\\)\\s*\\.\\s*with[A-Z]\\w*\\(' },
      { id: 'builders-end', re: '(//|#)\\s*builders end' },
    ], minHits: 2,
  },
  {
    name: 'api-error-envelope', shard: 4, domain: 'data-formats',
    description: 'The JSON shape of every error our HTTP APIs return, and how error kinds and trace references are named. Use when designing API error responses, writing an error handler or documenting API errors.',
    body: `# API error envelope

Every error response body is exactly this shape (no top-level \`error\` or \`message\` key):

\`\`\`json
{
  "fault": {
    "kind": "quota.exceeded",
    "hint": "You have used 1000 of 1000 calls this hour. Retry after 14:00 UTC.",
    "trace_ref": "tr_8f3a2c"
  }
}
\`\`\`

1. \`kind\` is dot.case, \`<area>.<problem>\`.
2. \`hint\` is one sentence a human can act on.
3. \`trace_ref\` is \`tr_\` plus 6 hex characters.
4. The HTTP status still carries the class (4xx/5xx); the body never repeats it.
`,
    canaries: [
      { id: 'fault-key', re: '["\']?fault["\']?\\s*:' },
      { id: 'trace-ref', re: 'trace_ref["\']?\\s*:\\s*["\'`]?tr_' },
      { id: 'hint-key', re: '["\']hint["\']\\s*:' },
    ], minHits: 2,
  },
  {
    name: 'weekly-status', shard: 4, domain: 'writing',
    description: 'The weekly status update format for projects: the sections, the overall weather and how slips are reported. Use when writing a weekly update, progress report or project status summary.',
    body: `# Weekly status

1. First line: \`Weather: sunny\`, \`Weather: cloudy\` or \`Weather: stormy\` (overall health).
2. Three sections, in this order: \`Shipped\`, \`Slipped\`, \`Next\`. \`Slipped\` is never omitted; write "nothing slipped" if so.
3. Every slipped item says the new date and why, in that order: \`<item> → <new date> (<why>)\`.
4. At most five bullets per section.

\`\`\`
Weather: cloudy
## Shipped
- Import from spreadsheets
## Slipped
- SSO login → 2026-04-20 (waiting on the identity provider)
## Next
- Billing page
\`\`\`
`,
    canaries: [
      { id: 'weather', re: 'Weather:\\s*(sunny|cloudy|stormy)', flags: 'i' },
      { id: 'slipped-section', re: '^#*\\s*\\**Slipped\\**:?\\s*$', flags: 'm' },
    ], minHits: 2,
  },
  {
    name: 'survey-question-format', shard: 4, domain: 'research',
    description: 'How survey and questionnaire items are written: numbering, the response scale and its anchors. Use when drafting a survey, feedback form, questionnaire or interview screener.',
    body: `# Survey question format

1. Every rated question uses a 1–7 scale, never 1–5 or 1–10, and says so in a tag after the question: \`(Q3 · scale 1–7)\`.
2. Directly under each rated question, an anchors line: \`1 = <low end> … 7 = <high end>\`.
3. Open questions are tagged \`(Q4 · open)\` and come after all rated questions.
4. No double-barreled questions: one idea per question.

\`\`\`
How easy was it to find the export button? (Q1 · scale 1–7)
1 = very hard … 7 = very easy
What would you change first? (Q2 · open)
\`\`\`
`,
    canaries: [
      { id: 'scale-tag', re: '\\(Q\\d+\\s*·\\s*scale 1[–-]7\\)' },
      { id: 'anchors', re: '\\b1 = .+7 = ' },
      { id: 'open-tag', re: '\\(Q\\d+\\s*·\\s*open\\)' },
    ], minHits: 2,
  },
  // ---------------- shard 5 ----------------
  {
    name: 'csv-export-dialect', shard: 5, pair: 'export', domain: 'data-formats',
    description: 'The CSV dialect for every data export and spreadsheet handoff: delimiter, header naming, encoding and the dialect line. Use when exporting data to CSV, writing a CSV file or a script that produces one.',
    body: `# CSV export dialect

1. The first line of every export is the dialect line: \`#dialect: semi/utf8/lf\`.
2. The delimiter is a semicolon (\`;\`), never a comma.
3. Header names are SCREAMING_SNAKE_CASE (\`ORDER_ID;TOTAL_EUR\`). Money columns end in the currency code.
4. Decimal separator is a dot; no thousands separators; empty values are empty, never \`NULL\`.

\`\`\`
#dialect: semi/utf8/lf
ORDER_ID;CUSTOMER_NAME;TOTAL_EUR
1001;Ana Ruiz;42.50
\`\`\`
`,
    canaries: [
      { id: 'dialect-line', re: '#dialect:\\s*semi/utf8/lf' },
      { id: 'semicolon-header', re: '^"?[A-Z][A-Z0-9_]*"?;"?[A-Z][A-Z0-9_]*', flags: 'm' },
    ], minHits: 2,
  },
  {
    name: 'timestamp-format', shard: 5, pair: 'export', domain: 'data-formats',
    description: 'How dates and times are written in data files, exports, logs and reports here: the timestamp shape and the naming of time fields. Use when a file, export, schema or log includes dates or times.',
    body: `# Timestamp format

1. Every timestamp is UTC, written \`YYYY-MM-DD@HH:MM:SSZ\` with an at-sign between date and time: \`2026-10-16@14:05:09Z\`.
2. Every time field or column name ends in \`_at_utc\` (\`created_at_utc\`, or \`CREATED_AT_UTC\` where headers are upper case).
3. Dates without times are \`YYYY-MM-DD\` and their fields end in \`_on\` (\`shipped_on\`).
4. Never write local times or offsets in stored data; convert when displaying.
`,
    canaries: [
      { id: 'at-sign-stamp', re: '\\d{4}-\\d{2}-\\d{2}@\\d{2}:\\d{2}(:\\d{2})?Z' },
      { id: 'at-utc-field', re: '_at_utc\\b', flags: 'i' },
    ], minHits: 2,
  },
  {
    name: 'bash-script-preamble', shard: 5, domain: 'ops',
    description: 'The required opening of every bash script in this repo: strict mode, the script tag, the error handler and the trap. Use when writing a new shell script or fixing an existing bash script.',
    body: `# Bash script preamble

Every script starts with exactly this block (only the tag changes):

\`\`\`bash
#!/usr/bin/env bash
set -Eeuo pipefail
readonly SCRIPT_TAG="nightly-export"
die() { printf '[%s] fatal: %s\\n' "$SCRIPT_TAG" "$*" >&2; exit 1; }
trap 'die "failed at line $LINENO"' ERR
\`\`\`

1. \`SCRIPT_TAG\` is the script's file name without extension.
2. All user-facing messages go through \`die\` or \`say\` (\`say() { printf '[%s] %s\\n' "$SCRIPT_TAG" "$*"; }\`).
3. Arguments are parsed with a \`while\`/\`case\` loop, never \`getopts\`.
`,
    canaries: [
      { id: 'script-tag', re: 'readonly SCRIPT_TAG=' },
      { id: 'die-trap', re: 'trap\\s+[\'"]die\\b' },
      { id: 'die-func', re: '\\bdie\\(\\)\\s*\\{' },
    ], minHits: 2,
  },
  {
    name: 'kpi-tile-spec', shard: 5, domain: 'design',
    description: 'How metric tiles (KPI cards) on dashboards are specified: label style, the delta indicator, the comparison period and the footnote. Use when designing a dashboard, a stat card or KPI tiles, or writing their spec.',
    body: `# KPI tile spec

Each tile is specified with these lines, in this order:

\`\`\`
TILE · Active customers
Value: 12,480
Delta: ▲ 4.2% vs prior 28d
Footnote: counts customers with one paid invoice in the window
\`\`\`

1. The label line starts \`TILE · \` and uses sentence case.
2. The delta is always against the prior 28 days, written \`vs prior 28d\`, with ▲ for up and ▼ for down (no colors named in text; color follows the arrow).
3. Every tile has a \`Footnote:\` that defines the metric in one line.
`,
    canaries: [
      { id: 'tile-label', re: 'TILE · ' },
      { id: 'prior-28d', re: 'vs prior 28d' },
      { id: 'footnote', re: '^\\s*\\**Footnote:?\\**:?', flags: 'm' },
    ], minHits: 2,
  },
  {
    name: 'adr-revisit', shard: 5, domain: 'docs',
    description: 'The template for architecture decision records (ADRs): numbering, sections and the revisit date. Use when recording a technical decision, writing an ADR or documenting why an architecture choice was made.',
    body: `# ADR with a revisit date

1. Title: \`ADR-<4 digits> <decision in a few words>\` (ADR-0007 Use Postgres for the job queue).
2. Sections, in this order: \`Context\`, \`Options\`, \`Choice\`, \`Consequences\`. \`Options\` lists at least two options, each with one line for and one against.
3. The last line is \`Revisit by: YYYY-MM-DD\` and a trigger: \`Revisit by: 2027-01-31 or when the queue passes 1M jobs/day\`.
4. Status is not a section; decisions are superseded by a new ADR that names the old one.
`,
    canaries: [
      { id: 'adr-id', re: '\\bADR-\\d{4}\\b' },
      { id: 'revisit-by', re: 'Revisit by:\\s*\\d{4}-\\d{2}-\\d{2}' },
      { id: 'options-section', re: '^#*\\s*\\**Options\\**:?\\s*$', flags: 'm' },
    ], minHits: 2,
  },
  // ---------------- shard 6 ----------------
  {
    name: 'incident-timeline', shard: 6, pair: 'incident', domain: 'ops',
    description: 'How incident timelines are written: relative timestamps, the detection line and what each entry must say. Use when reconstructing what happened during an outage or incident, or writing an incident timeline.',
    body: `# Incident timeline

1. Times are relative to detection: \`T+00:00\` is the moment someone noticed, \`T-00:20\` before it, \`T+01:15\` after.
2. The first line is \`Detected by: <person, alert or customer>\` and the absolute detection time in UTC.
3. Each entry: \`T+hh:mm — <who> <did or saw what>\`. One fact per line, no interpretation.
4. The timeline ends with \`T+hh:mm — resolved\` and the total duration.

\`\`\`
Detected by: checkout error-rate alert, 2026-06-03 09:12 UTC
T-00:20 — deploy 4411 rolled out to all regions
T+00:00 — alert fired: checkout errors at 8%
T+00:31 — on-call rolled back deploy 4411
T+00:40 — resolved (duration 40 min)
\`\`\`
`,
    canaries: [
      { id: 'relative-time', re: 'T[+-]\\d{2}:\\d{2}' },
      { id: 'detected-by', re: 'Detected by:' },
    ], minHits: 2,
  },
  {
    name: 'postmortem-frame', shard: 6, pair: 'incident', domain: 'ops',
    description: 'The structure of a postmortem (incident review) document in this team: its sections and the blameless check. Use when writing a postmortem, incident review or retrospective after something broke.',
    body: `# Postmortem frame

The document has exactly these sections, in this order:

1. \`What we believed\` the assumptions that made the failure possible, as the team held them before.
2. \`What was true\` what actually happened and why those beliefs were wrong.
3. \`What we'll change\` at most five changes, each with an owner and a date.
4. The last line: \`Blameless check: no person is named as a cause\` (rewrite until it is true).

Never use the headings "Root cause", "Impact" or "Lessons learned".
`,
    canaries: [
      { id: 'believed', re: 'What we believed' },
      { id: 'was-true', re: 'What was true' },
      { id: 'blameless-check', re: 'Blameless check' },
    ], minHits: 2,
  },
  {
    name: 'structured-log-lines', shard: 6, domain: 'ops',
    description: 'The format of application log lines in our services: key order, event naming and the service field. Use when adding logging to code, writing log statements or defining a log format.',
    body: `# Structured log lines

Every log line is logfmt with keys in this order:

\`\`\`
lvl=info evt=order.paid svc=checkout order_id=1001 took_ms=42
\`\`\`

1. \`lvl\` first (debug, info, warn, fail; never "error"), then \`evt\`, then \`svc\`, then the rest.
2. \`evt\` is dot.case \`<noun>.<past-tense verb>\` (\`order.paid\`, \`cache.missed\`).
3. Durations are \`took_ms\`. No free-text message key: the event name is the message.
`,
    canaries: [
      { id: 'evt-key', re: '\\bevt=[a-z_]+\\.[a-z_]+' },
      { id: 'lvl-key', re: '\\blvl=(debug|info|warn|fail)\\b' },
      { id: 'svc-key', re: '\\bsvc=' },
    ], minHits: 2,
  },
  {
    name: 'ts-oops-errors', shard: 6, domain: 'code-style',
    description: 'How TypeScript code in this codebase handles expected failures: the result type, its helper functions and error codes. Use when writing TypeScript functions that can fail, error handling, or parsing and validation code.',
    body: `# TypeScript: oops errors

1. Expected failures are returned, never thrown. A function that can fail returns \`Fine<T> | Oops<Code>\`.
2. Build them with the helpers \`fine(value)\` and \`oops('code', 'message')\`. Codes are kebab-case string literals.
3. Callers branch on \`r.ok\`.
4. Only programmer errors (impossible states) throw.

\`\`\`ts
type Fine<T> = { ok: true; value: T };
type Oops<C extends string> = { ok: false; code: C; message: string };
const fine = <T>(value: T): Fine<T> => ({ ok: true, value });
const oops = <C extends string>(code: C, message: string): Oops<C> => ({ ok: false, code, message });

function parseAge(s: string): Fine<number> | Oops<'not-a-number' | 'out-of-range'> {
  const n = Number(s);
  if (Number.isNaN(n)) return oops('not-a-number', \`"\${s}" is not a number\`);
  return n < 0 || n > 150 ? oops('out-of-range', 'age must be 0-150') : fine(n);
}
\`\`\`
`,
    canaries: [
      { id: 'oops-call', re: '\\boops\\(\\s*[\'"`]' },
      { id: 'oops-type', re: '\\bOops<' },
      { id: 'fine-type', re: '\\bFine<' },
    ], minHits: 2,
  },
  {
    name: 'endpoint-catalog', shard: 6, domain: 'docs',
    description: 'How HTTP API endpoints are documented in our API reference: the catalog table, its columns and the per-route line format. Use when documenting a REST or HTTP API, listing its routes or writing an API reference.',
    body: `# Endpoint catalog

1. Start with a catalog table with exactly these columns: \`Route\`, \`Purpose\`, \`Auth\`, \`Idempotent?\`.
2. Then one section per route, whose first line is \`VERB /path — one-line summary\` (an em dash between path and summary).
3. Each route section lists request fields, response fields, and errors by their kind.

\`\`\`
| Route | Purpose | Auth | Idempotent? |
|---|---|---|---|
| GET /v1/orders | list orders | token | yes |

GET /v1/orders — list a customer's orders, newest first
\`\`\`
`,
    canaries: [
      { id: 'idempotent-column', re: 'Idempotent\\?' },
      { id: 'route-line', re: '(GET|POST|PUT|PATCH|DELETE) /\\S+ — ' },
    ], minHits: 2,
  },
  // ---------------- shard 7 ----------------
  {
    name: 'estimate-ranges', shard: 7, pair: 'planning', domain: 'planning',
    description: 'How effort and time estimates are given in this team: the range format, the median and the confidence label. Use when estimating how long work will take, sizing tasks or giving a delivery forecast.',
    body: `# Estimate ranges

1. Never give a single number. Every estimate is three points in working days, best / likely / worst, followed by the median: \`2d / 4d / 9d (p50 4d)\`.
2. Add a confidence label: \`confidence: lo\`, \`confidence: mid\` or \`confidence: hi\`.
3. If the worst case is more than 3x the best case, say what unknown drives it in one line starting \`Spread driver:\`.

\`\`\`
Billing page: 2d / 4d / 9d (p50 4d), confidence: mid
Spread driver: the payment provider's sandbox has been unreliable
\`\`\`
`,
    canaries: [
      { id: 'three-point', re: '\\d+(\\.\\d+)?d\\s*/\\s*\\d+(\\.\\d+)?d\\s*/\\s*\\d+(\\.\\d+)?d' },
      { id: 'p50', re: '\\(p50 \\d+(\\.\\d+)?d\\)' },
      { id: 'confidence-label', re: 'confidence:\\s*(lo|mid|hi)\\b' },
    ], minHits: 2,
  },
  {
    name: 'milestone-plan', shard: 7, pair: 'planning', domain: 'planning',
    description: 'How project plans are broken into milestones here: milestone ids, exit tests and the cut line. Use when planning a project, a roadmap for the next weeks, or breaking a large piece of work into phases.',
    body: `# Milestone plan

1. Milestones are lettered: \`MS-A\`, \`MS-B\`, \`MS-C\`... never numbered phases or sprints.
2. Each milestone has a one-line goal and an \`Exit test:\` line: an observable check that says the milestone is done.
3. The plan ends with a \`Cut line:\` listing what gets dropped, in order, if the plan runs late.
4. At most five milestones; dates are week numbers (\`wk 3\`), not calendar dates.

\`\`\`
MS-A (wk 1-2) Read path on the new database
Exit test: the orders page serves from the new database for 10% of traffic
Cut line: 1) admin export 2) audit history
\`\`\`
`,
    canaries: [
      { id: 'ms-id', re: '\\bMS-[A-E]\\b' },
      { id: 'exit-test', re: 'Exit test:' },
      { id: 'cut-line', re: 'Cut line:' },
    ], minHits: 2,
  },
  {
    name: 'pr-description-proof', shard: 7, domain: 'docs',
    description: 'The template for pull request descriptions in this repo: sections, the proof of testing and the blast radius. Use when writing or improving a pull request (PR) description or a merge request summary.',
    body: `# PR description with proof

Sections, in this order:

\`\`\`
### Why
### What
### Proof
### Blast radius
\`\`\`

1. \`Why\`: the problem in two sentences at most.
2. \`What\`: the change as a short list.
3. \`Proof\`: how you know it works: commands run and their result, screenshots, or numbers. "Tested locally" alone is not proof.
4. \`Blast radius\`: one line, \`Blast radius: <who or what breaks if this is wrong>\`.
`,
    canaries: [
      { id: 'proof-heading', re: '^#{1,4}\\s*Proof\\s*$', flags: 'm' },
      { id: 'blast-radius', re: 'Blast radius' },
    ], minHits: 2,
  },
  {
    name: 'json-schema-stamps', shard: 7, domain: 'data-formats',
    description: 'Required metadata on every JSON Schema in this codebase: ownership comment, stability marker and id format. Use when writing or editing a JSON Schema, or defining the shape of a JSON payload or config.',
    body: `# JSON Schema stamps

1. Every schema's root has \`"$comment": "owner: <team>"\`.
2. Every schema and every object property that is not obvious carries \`"x-stability": "experimental"\` or \`"x-stability": "stable"\`.
3. \`$id\` is \`urn:house:<name>:<major>\`, e.g. \`urn:house:invoice:2\`.
4. \`additionalProperties\` is always stated explicitly.

\`\`\`json
{
  "$id": "urn:house:invoice:2",
  "$comment": "owner: billing",
  "x-stability": "stable",
  "type": "object",
  "additionalProperties": false
}
\`\`\`
`,
    canaries: [
      { id: 'x-stability', re: '"x-stability"\\s*:\\s*"(experimental|stable)"' },
      { id: 'owner-comment', re: '"\\$comment"\\s*:\\s*"owner:' },
      { id: 'urn-id', re: 'urn:house:[a-z-]+:\\d+' },
    ], minHits: 2,
  },
  {
    name: 'error-message-copy', shard: 7, domain: 'writing',
    description: 'How user-facing error messages are worded in our products: the three parts of a message and the error code. Use when writing or rewriting error messages, validation messages or failure text shown to users.',
    body: `# Error message copy

Every user-facing error message has three parts, then a code:

1. What happened, in plain words, without blame ("We couldn't save your changes.").
2. Why, if known ("The file is larger than 10 MB.").
3. \`What to do:\` one concrete action ("What to do: compress the file or split it in two.").
4. The error code at the end in square brackets: \`[E-1042]\` (E- plus four digits).

Never use "Oops", "Error:", "invalid" or exclamation marks.

\`\`\`
We couldn't upload your photo. The file is larger than 10 MB. What to do: choose a smaller photo. [E-2201]
\`\`\`
`,
    canaries: [
      { id: 'error-code', re: '\\[E-\\d{4}\\]' },
      { id: 'what-to-do', re: 'What to do:' },
    ], minHits: 2,
  },
  // ---------------- shard 8 ----------------
  {
    name: 'readme-skeleton', shard: 8, pair: 'docs', domain: 'docs',
    description: 'The section skeleton for README files in our projects: section names, their order and the quickstart rule. Use when writing or restructuring a README or the front page of a project\'s documentation.',
    body: `# README skeleton

Sections, in this order, with exactly these headings:

1. \`## In one breath\` one or two sentences: what it is and who it is for.
2. \`## Try it in 60 seconds\` the shortest path to a visible result, copy-pasteable.
3. \`## How it works\` a short explanation, a diagram if it helps.
4. \`## When not to use this\` honest limits and better alternatives.
5. \`## Help\` where to ask.

No badges, no table of contents, no "Introduction" or "Overview" heading.
`,
    canaries: [
      { id: 'one-breath', re: 'In one breath' },
      { id: 'sixty-seconds', re: 'Try it in 60 seconds' },
      { id: 'when-not', re: 'When not to use this' },
    ], minHits: 2,
  },
  {
    name: 'cli-help-text', shard: 8, pair: 'docs', domain: 'docs',
    description: 'How command-line tools in our projects present their help text: the usage line, verb list, flags and the exit code footer. Use when writing --help output, a man page or usage documentation for a CLI tool.',
    body: `# CLI help text

The help text has these blocks, in this order:

\`\`\`
usage: tally <verb> [flags]

VERBS
  add       record an entry
  report    print totals

FLAGS
  -q, --quiet   print nothing on success

Exit codes: 0 ok · 1 usage · 2 runtime
\`\`\`

1. Block headings are upper case on their own line: \`VERBS\`, \`FLAGS\`.
2. Every tool ends its help with the exit code footer, exactly in that form.
3. Descriptions are lowercase, no trailing period, at most 50 characters.
`,
    canaries: [
      { id: 'exit-footer', re: 'Exit codes:\\s*0 ok' },
      { id: 'verbs-heading', re: '^\\s*VERBS\\s*$', flags: 'm' },
      { id: 'flags-heading', re: '^\\s*FLAGS\\s*$', flags: 'm' },
    ], minHits: 2,
  },
  {
    name: 'oncall-handoff', shard: 8, domain: 'ops',
    description: 'The note the outgoing on-call engineer writes at the end of a shift: what carries over, what to watch and the quiet-hours rule. Use when handing over on-call, ending a support shift or summarizing open operational issues for the next person.',
    body: `# On-call handoff

The note has these lines and sections, in this order:

1. \`Shift: <start> → <end> (<your name>)\`
2. \`Carry-over:\` open issues the next person now owns, each with its current state.
3. \`Watch list:\` things that are fine now but might not be, with the signal to watch.
4. \`Pages: <n>\` the number of pages during the shift.
5. \`Quiet-hours rule:\` what is allowed to wait until morning.
`,
    canaries: [
      { id: 'carry-over', re: '^\\s*\\**Carry-over:?\\**:?', flags: 'm' },
      { id: 'watch-list', re: '^\\s*\\**Watch list:?\\**:?', flags: 'm' },
      { id: 'quiet-hours', re: 'Quiet-hours rule' },
    ], minHits: 2,
  },
  {
    name: 'code-review-severity', shard: 8, domain: 'code-review',
    description: 'How code review comments are written in this team: severity tags, the suggestion format and the confidence footer. Use when reviewing code, a diff or a pull request and writing review comments.',
    body: `# Code review severity

1. Every comment starts with a severity tag: \`[S1]\` must fix before merge, \`[S2]\` should fix soon, \`[S3]\` take it or leave it.
2. After the tag: the file and line (\`orders.ts:42\`), the problem, then the suggested change.
3. The review ends with \`Confidence: <n>/5\` (how sure you are the change is correct overall) and \`Verdict: ship\`, \`Verdict: ship after S1s\` or \`Verdict: rework\`.

\`\`\`
[S1] orders.ts:42 the total ignores refunds. Subtract refunded line items before summing.
[S3] orders.ts:10 the name \`tmp\` hides intent; consider \`unpaidOrders\`.
Confidence: 4/5
Verdict: ship after S1s
\`\`\`
`,
    canaries: [
      { id: 'severity-tag', re: '\\[S[123]\\]' },
      { id: 'confidence-footer', re: 'Confidence:\\s*\\d/5' },
      { id: 'verdict', re: 'Verdict:\\s*(ship|rework)' },
    ], minHits: 2,
  },
  {
    name: 'risk-register', shard: 8, domain: 'planning',
    description: 'How project risks are recorded: risk ids, the likelihood-impact score and the tripwire that triggers the response. Use when listing project risks, writing a risk register or assessing what could go wrong with a plan.',
    body: `# Risk register

1. Risks are numbered \`R-1\`, \`R-2\`...
2. Each risk is scored \`L<1-5> × I<1-5> = <score>\` (likelihood times impact), e.g. \`L3 × I4 = 12\`. Sort by score, highest first.
3. Each risk has a \`Tripwire:\` an observable signal that means the risk is happening, and a \`Response:\` what we do when the tripwire fires.
4. Anything scoring 15 or more names an owner.

\`\`\`
R-1 The vendor API changes during the migration. L3 × I4 = 12
Tripwire: a failed contract test in the nightly run
Response: freeze the integration and switch to the cached feed
\`\`\`
`,
    canaries: [
      { id: 'risk-id', re: '\\bR-\\d+\\b' },
      { id: 'tripwire', re: 'Tripwire:' },
      { id: 'lxi-score', re: 'L[1-5]\\s*[×x*]\\s*I[1-5]' },
    ], minHits: 2,
  },
];
