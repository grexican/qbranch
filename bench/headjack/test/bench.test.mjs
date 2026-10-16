// Offline tests for the benchmark machinery: no model calls, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TESTBED } from '../src/paths.mjs';
import { rendered } from '../testbed/authoring/write.mjs';
import { TARGETS } from '../testbed/authoring/targets.mjs';
import { DECOYS } from '../testbed/authoring/decoys.mjs';
import { checkCanaries, usedTargets, loadedSkills, scoreRun } from '../src/score.mjs';
import { keyTerms, tierPrompt, stem } from '../src/overlap.mjs';
import { wilson, overlaps } from '../src/stats.mjs';
import { synthSkill, shuffle, SYNTH_CAPACITY } from '../src/synth.mjs';
import { fetchFiller, usableSkill } from '../src/filler.mjs';
import { composeLibrary } from '../src/library.mjs';
import { parseListing, analyzeListing } from '../src/listing.mjs';
import { hypotheses } from '../src/summary.mjs';
import { ancestorMemoryFiles } from '../src/agents/claude.mjs';
import { parseFrontmatter } from '../../../packages/core/src/frontmatter.mjs';

const cans = JSON.parse(fs.readFileSync(path.join(TESTBED, 'canaries.json'), 'utf8'));

test('rendered target and decoy files are up to date with the authoring sources', () => {
  for (const [rel, text] of Object.entries(rendered())) assert.equal(fs.readFileSync(path.join(TESTBED, rel), 'utf8'), text, `${rel} is stale: run testbed/authoring/write.mjs`);
});

test('40 targets in 8 shards of 5, one pair per shard; names and descriptions pass the skill spec', () => {
  assert.equal(TARGETS.length, 40);
  for (let s = 1; s <= 8; s++) {
    const xs = TARGETS.filter(t => t.shard === s);
    assert.equal(xs.length, 5, `shard ${s}`);
    const pairs = xs.filter(t => t.pair);
    assert.equal(pairs.length, 2); assert.equal(pairs[0].pair, pairs[1].pair);
  }
  for (const s of [...TARGETS, ...DECOYS]) {
    assert.match(s.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(s.description.length <= 1024 && /Use (when|before)/.test(s.description), s.name);
    const { meta } = parseFrontmatter(fs.readFileSync(path.join(TESTBED, s.canaries ? 'targets' : 'decoys', s.name, 'SKILL.md'), 'utf8'));
    assert.equal(meta.name, s.name); assert.equal(meta.description, s.description);
  }
  assert.equal(new Set([...TARGETS, ...DECOYS].map(s => s.name)).size, TARGETS.length + DECOYS.length);
});

test('each target body satisfies its own canaries (the rules state the markers)', () => {
  for (const t of TARGETS) assert.ok(checkCanaries(cans[t.name], t.body).used, `${t.name}: ${checkCanaries(cans[t.name], t.body).hits}`);
});

test('canaries are specific: no description, decoy or synthetic skill triggers a target', () => {
  for (const t of TARGETS) assert.deepEqual(usedTargets(cans, t.description), [], t.name);
  for (const d of DECOYS) assert.deepEqual(usedTargets(cans, d.body + d.description), [], d.name);
  for (let i = 0; i < 300; i++) { const s = synthSkill('t', i); assert.deepEqual(usedTargets(cans, s.body + s.description), []); }
  // and a target's body triggers only itself (or its pair partner, never an unrelated skill)
  for (const t of TARGETS) for (const u of usedTargets(cans, t.body)) assert.ok(u === t.name || (cans[u].pair && cans[u].pair === t.pair), `${t.name} body triggers ${u}`);
});

test('checkCanaries respects minHits', () => {
  const spec = { minHits: 2, rules: [{ id: 'a', re: 'alpha' }, { id: 'b', re: '^beta$', flags: 'm' }, { id: 'c', re: 'gamma' }] };
  assert.equal(checkCanaries(spec, 'alpha').used, false);
  assert.deepEqual(checkCanaries(spec, 'x alpha\nbeta\n'), { used: true, hits: ['a', 'b'] });
});

test('overlap: stemming, generic words and the tier rule', () => {
  assert.equal(stem('exports'), stem('exporting'));
  assert.ok(!keyTerms('Use when writing a new file for our team').size);
  const d = { 'csv-export-dialect': 'The CSV dialect for every data export.', 'sql-house-style': 'SQL formatting for queries.' };
  assert.equal(tierPrompt('Please use the csv-export-dialect skill', ['csv-export-dialect'], d).tier, 'named');
  assert.equal(tierPrompt('Please use the csv export dialect skill', ['csv-export-dialect'], d).tier, 'named');
  assert.equal(tierPrompt('Dump the orders into a spreadsheet file', ['csv-export-dialect'], d).tier, 'semantic');
  assert.equal(tierPrompt('Export the orders', ['csv-export-dialect'], d).tier, 'lexical');
  const n = tierPrompt('What does a query planner do?', [], d);
  assert.equal(n.tier, 'negative'); assert.equal(n.maxAny, 1);
});

test('wilson intervals', () => {
  const w = wilson(8, 10);
  assert.ok(Math.abs(w.lo - 0.4902) < 1e-3 && Math.abs(w.hi - 0.9433) < 1e-3);
  assert.equal(wilson(0, 0).rate, null);
  assert.equal(wilson(0, 20).lo, 0);
  assert.ok(overlaps(wilson(5, 10), wilson(6, 10)) && !overlaps(wilson(1, 50), wilson(49, 50)));
});

test('loadedSkills sees Skill calls, headjack get and SKILL.md reads, only for library skills', () => {
  const lib = new Set(['sql-house-style', 'adr-revisit', 'runbook-steps', 'find-skill']);
  const ev = [
    { t: 'tool', name: 'Skill', input: { skill: 'sql-house-style' } },
    { t: 'tool', name: 'Skill', input: { skill: 'find-skill' } },
    { t: 'tool', name: 'Bash', input: { command: 'headjack find adr && headjack get library/adr-revisit' } },
    { t: 'tool', name: 'Read', input: { file_path: 'C:\\x\\.claude\\skills\\runbook-steps\\SKILL.md' } },
    { t: 'tool', name: 'Skill', input: { skill: 'dataviz' } },
    { t: 'tool', name: 'Skill', input: { skill: 'adr-revisit' }, id: 'x1' },
    { t: 'result', id: 'x1', isError: true, text: 'Unknown skill: adr-revisit' },
  ];
  assert.deepEqual(loadedSkills(ev.slice(-2), lib), [], 'a failed Skill call loads nothing');
  assert.deepEqual(loadedSkills(ev, lib).sort(), ['adr-revisit', 'runbook-steps', 'sql-house-style']);
  const s = scoreRun({ prompt: { answers: [] }, events: ev, outputText: '', library: lib, canaries: cans });
  assert.equal(s.falseLoad, true); assert.equal(s.useHit, null);
  const u = scoreRun({ prompt: { answers: ['commit-message-trailers', 'sql-house-style'] }, events: [], outputText: 'Risk: low\nRollback: revert it\n', library: lib, canaries: cans });
  assert.equal(u.useHit, true); assert.equal(u.loadHit, false);
});

test('synthetic filler is deterministic, unique and plausible', () => {
  assert.deepEqual(synthSkill('a', 7), synthSkill('a', 7));
  const names = new Set(Array.from({ length: 2000 }, (_, i) => synthSkill('a', i).name));
  assert.equal(names.size, 2000);
  assert.ok(SYNTH_CAPACITY > 20000);
  assert.ok(usableSkill(`---\nname: ${synthSkill('a', 1).name}\ndescription: ${synthSkill('a', 1).description}\n---\n`));
  assert.deepEqual(shuffle([1, 2, 3, 4, 5], 's'), shuffle([1, 2, 3, 4, 5], 's'));
});

test('filler fetch: verifies hashes, caches, and fails on a mismatch (offline)', async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'hjb-fill-'));
  const body = Buffer.from('---\nname: demo-skill\ndescription: Does a demo thing. Use when demoing.\n---\n\nbody\n');
  const sha = createHash('sha256').update(body).digest('hex');
  const manifest = { repos: [{ repo: 'o/r', commit: 'abcdef1234567890', license: 'MIT', skills: [{ name: 'demo-skill', path: 'skills/demo/SKILL.md', sha256: sha }] }] };
  let calls = 0;
  const get = async (url) => { calls++; assert.equal(url, 'http://x/o/r/abcdef1234567890/skills/demo/SKILL.md'); return body; };
  const a = await fetchFiller({ manifest, cache, base: 'http://x', get });
  assert.equal(a[0].description, 'Does a demo thing. Use when demoing.');
  await fetchFiller({ manifest, cache, base: 'http://x', get });
  assert.equal(calls, 1, 'second fetch is served from the cache');
  manifest.repos[0].skills[0].sha256 = '0'.repeat(64);
  await assert.rejects(fetchFiller({ manifest, cache, base: 'http://x', get }), /hash mismatch/);
  fs.rmSync(cache, { recursive: true, force: true });
});

test('library composition: targets, decoys, filler prefix, synthetic top-up; deterministic', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hjb-lib-'));
  const filler = Array.from({ length: 30 }, (_, i) => { const f = path.join(dir, `f${i}.md`); fs.writeFileSync(f, `---\nname: pub-${i}\ndescription: public ${i}\n---\n`); return { name: `pub-${i}`, description: `public ${i}`, file: f, repo: 'o/r' }; });
  const l5 = composeLibrary({ shard: 3, size: 5, seed: 's', filler });
  assert.deepEqual(l5.map(s => s.kind), Array(5).fill('target'));
  const l25 = composeLibrary({ shard: 3, size: 25, seed: 's', filler }), l50 = composeLibrary({ shard: 3, size: 50, seed: 's', filler });
  assert.equal(l25.length, 25); assert.equal(l25.filter(s => s.kind === 'decoy').length, 3);
  assert.deepEqual(l50.slice(0, 25).map(s => s.name), l25.map(s => s.name), 'smaller library is a prefix');
  assert.equal(l50.filter(s => s.kind === 'synthetic').length, 50 - 8 - 30);
  assert.deepEqual(composeLibrary({ shard: 3, size: 50, seed: 's', filler }).map(s => s.name), l50.map(s => s.name));
  assert.equal(new Set(l50.map(s => s.name)).size, 50);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listing: parse the received listing and find past-cutoff targets', () => {
  const text = 'x\n<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n- alpha-one: does a\n- beta-two: does b\n- gamma-three\n- zeta-four: short\n- dataviz: builtin\n</system-reminder>\n';
  const L = parseListing(text);
  assert.equal(L.get('gamma-three'), null); assert.equal(L.get('alpha-one'), 'does a');
  const a = analyzeListing(L, ['alpha-one', 'beta-two', 'gamma-three', 'zeta-four'], ['beta-two', 'zeta-four']);
  assert.equal(a.firstDrop, 2); assert.equal(a.described, 3);
  assert.equal(a.targets['beta-two'].pastCutoff, false);
  assert.equal(a.targets['zeta-four'].pastCutoff, true, 'positional: past the first drop even though its short description fit');
});

test('verdicts: pass, fail, and inconclusive within the A/A gap', () => {
  const mk = (arm, n, k, extra) => Array.from({ length: n }, (_, i) => ({ ok: true, arm, size: 500, tier: 'semantic', useHit: i < k, loadHit: i < k, ...extra }));
  const runs = [...mk('headjack', 50, 40), ...mk('native', 50, 10), ...mk('native-again', 50, 12)];
  const h1 = hypotheses(runs).find(h => h.id === 'H1');
  assert.equal(h1.verdict, 'pass');
  const r3 = [...mk('headjack', 40, 20, { size: 5 }), ...mk('native', 40, 24, { size: 5 }), ...mk('native-again', 40, 30, { size: 5 })];
  assert.equal(hypotheses(r3).find(h => h.id === 'H3').verdict, 'inconclusive');
  const r3b = [...mk('headjack', 40, 20, { size: 5 }), ...mk('native', 40, 30, { size: 5 }), ...mk('native-again', 40, 30, { size: 5 })];
  assert.equal(hypotheses(r3b).find(h => h.id === 'H3').verdict, 'fail');
  assert.equal(hypotheses([]).find(h => h.id === 'H4').verdict, 'inconclusive');
});

test('isolation: every ancestor CLAUDE.md (and ~/.claude/CLAUDE.md) is excluded', () => {
  const xs = ancestorMemoryFiles(path.join(os.homedir(), 'a', 'b'));
  const fwd = (p) => p.split(path.sep).join('/');
  assert.ok(xs.includes(fwd(path.join(os.homedir(), '.claude', 'CLAUDE.md'))));
  assert.ok(xs.includes(fwd(path.join(os.homedir(), 'a', 'CLAUDE.md'))));
  assert.ok(xs.includes(fwd(path.join(path.parse(os.homedir()).root, 'CLAUDE.md'))));
});
