// End-to-end tests in a throwaway project and a throwaway personal space. Lexical mode (HEADJACK_EMBED=0) and no
// registry, so they are fast and offline.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseSkill } from '../src/library.mjs';

const BIN = path.resolve(import.meta.dirname, '../bin/headjack.mjs');
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'headjack-proj-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'headjack-home-'));
const env = { ...process.env, HEADJACK_EMBED: '0', HEADJACK_HOME: home, CLAUDE_PROJECT_DIR: proj };
const hj = (...args) => execFileSync('node', [BIN, ...args], { cwd: proj, env, encoding: 'utf8' });
const hook = (prompt) => execFileSync('node', [BIN, 'hook'], { cwd: proj, env, input: JSON.stringify({ prompt }), encoding: 'utf8' });
const stats = () => JSON.parse(fs.readFileSync(path.join(proj, '.headjack-stats.json'), 'utf8'));

const skill = (dir, name, description, body = 'Do the thing.') => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
};

before(() => {
  fs.mkdirSync(path.join(proj, '.git'));
  fs.writeFileSync(path.join(proj, 'headjack.config.json'), JSON.stringify({ external: false }));
  const lib = path.join(proj, '.headjack/library');
  skill(path.join(lib, 'json-canvas'), 'json-canvas', 'Create and edit Obsidian JSON Canvas files (.canvas) with nodes, edges and groups.', 'Use 16-character hex ids.');
  skill(path.join(lib, 'decision-council'), 'decision-council', 'Decision council: weigh a strategic choice from several perspectives.');
  skill(path.join(home, 'library/ads-audit'), 'ads-audit', 'Audit a Google Ads account: match types, negatives, conversion tracking.');
  skill(path.join(proj, '.claude/skills/legacy-skill'), 'legacy-skill', 'A skill that is preloaded today.');
  skill(path.join(proj, '.claude/skills/find-skill'), 'find-skill', 'Root skill: must never be adopted.');
  skill(path.join(proj, 'team-skills/deploy-runbook'), 'deploy-runbook', 'Deploy the service to Railway with the release checklist.');
});

test('parseSkill reads folded YAML descriptions', () => {
  const s = parseSkill('---\nname: x\ndescription: >\n  first line\n  second line\n---\nbody');
  assert.equal(s.description, 'first line second line');
});

test('init indexes both spaces and points at preloaded skills', () => {
  const out = hj('init');
  assert.match(out, /indexed: 3 skills/);
  assert.match(out, /headjack adopt/);
});

test('find searches shared and personal spaces', () => {
  assert.match(hj('find', 'make an obsidian canvas file').split('\n')[0], /shared\/json-canvas/);
  assert.match(hj('find', 'audit my google ads account').split('\n')[0], /personal\/ads-audit/);
  assert.equal(stats().totals.searches, 2);
});

test('get loads the skill body and counts the load', () => {
  assert.match(hj('get', 'json-canvas'), /16-character hex ids/);
  assert.equal(stats().skills['shared/json-canvas'].loaded, 1);
});

test('hook suggests a skill named in the request; a later load counts as a conversion', () => {
  const out = JSON.parse(hook('Run a decision council on whether to rewrite the backend.'));
  assert.match(out.hookSpecificOutput.additionalContext, /shared\/decision-council/);
  hj('get', 'shared/decision-council');
  assert.equal(stats().totals.suggested_then_loaded, 1);
});

test('hook injects nothing for a trivial prompt (zero tokens)', () => {
  assert.equal(hook('What is 17 * 23? Just the number.'), '');
});

test('a request the library cannot serve is recorded as a gap', () => {
  hook('Write a terraform module for a private S3 bucket behind CloudFront.');
  assert.ok(stats().gaps.some(g => /terraform/.test(g.q)));
});

test('adopt moves preloaded skills into the shared space, never the root skills', () => {
  assert.match(hj('adopt', '--dry-run'), /would move 1 skills/);
  hj('adopt');
  assert.ok(fs.existsSync(path.join(proj, '.headjack/library/legacy-skill/SKILL.md')));
  assert.ok(fs.existsSync(path.join(proj, '.claude/skills/find-skill/SKILL.md')));
});

test('adopt --from <dir> --to personal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headjack-from-'));
  skill(path.join(dir, 'my-style'), 'my-style', 'My personal writing style.');
  hj('adopt', '--from', dir, '--to', 'personal');
  assert.ok(fs.existsSync(path.join(home, 'library/my-style/SKILL.md')));
});

test('new scaffolds a skill; move promotes personal -> shared', () => {
  hj('new', 'release-notes', '--personal');
  assert.ok(fs.existsSync(path.join(home, 'library/release-notes/SKILL.md')));
  hj('move', 'personal/ads-audit', '--to', 'shared');
  assert.ok(fs.existsSync(path.join(proj, '.headjack/library/ads-audit/SKILL.md')));
  assert.match(hj('list'), /shared\/ads-audit/);
});

test('source add indexes a folder in place without moving it', () => {
  hj('source', 'add', path.join(proj, 'team-skills'));
  assert.ok(fs.existsSync(path.join(proj, 'team-skills/deploy-runbook/SKILL.md')));
  assert.match(hj('find', 'deploy to railway').split('\n')[0], /team-skills\/deploy-runbook/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(proj, 'headjack.config.json'), 'utf8')).sources, ['team-skills']);
  hj('source', 'remove', path.join(proj, 'team-skills'));
  assert.doesNotMatch(hj('list'), /deploy-runbook/);
});

test('stats summary reports conversion and gaps', () => {
  const out = hj('stats');
  assert.match(out, /conversion/);
  assert.match(out, /library gaps/);
});
