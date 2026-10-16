// The cross-vendor cost ladder: parse any model name, then step down effort first, size second, never across versions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rung, cheaperOf, sameModel } from '../src/ladder.mjs';
import { decide } from '../src/recommend.mjs';
import { DEFAULTS } from '../src/config.mjs';

test('model names parse into vendor, base model and effort', () => {
  assert.deepEqual(['claude-opus-5-5', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5'].map(m => rung(m).key), ['opus', 'sonnet', 'haiku']);
  assert.equal(rung('claude-opus-5-thinking-high').key, 'opus@high');
  assert.deepEqual(rung('grok-4.7-high'), { key: 'grok-4.7@high', vendor: 'xai', base: 'grok-4.7', effort: 'high', fast: false });
  assert.equal(rung('cursor-grok-4.6-high-fast').key, 'grok-4.6@high+fast');
  assert.equal(rung('gpt-5.6-sol-medium').key, 'gpt-5.6-sol@medium');
  assert.equal(rung('composer-2.5-fast').key, 'composer-2.5+fast');
  assert.equal(rung('default').vendor, 'auto');
  assert.equal(rung('gemini-3-pro').vendor, 'google');
});

test('cheaper rungs: lower effort on the same model first, then a smaller size, never an older version', () => {
  assert.deepEqual(cheaperOf('grok-4.7@high'), ['grok-4.7', 'grok-4.7@medium', 'grok-4.7@low', 'grok-4.7-mini']);
  assert.deepEqual(cheaperOf('grok-4.7'), ['grok-4.7-mini']);
  assert.deepEqual(cheaperOf('opus'), ['sonnet', 'haiku']);
  assert.deepEqual(cheaperOf('opus@high'), ['opus', 'opus@medium', 'opus@low', 'sonnet', 'haiku']);
  assert.deepEqual(cheaperOf('gpt-5.2'), ['gpt-5.2-mini', 'gpt-5.2-nano']);
  assert.deepEqual(cheaperOf('gemini-3-pro'), ['gemini-3-flash', 'gemini-3-flash-lite']);
  assert.deepEqual(cheaperOf('haiku'), []);
  assert.deepEqual(cheaperOf('default'), []);
  assert.ok(!cheaperOf('grok-4.7').includes('grok-4.6'));
  assert.ok(sameModel('grok-4.7@high', 'grok-4.7') && !sameModel('opus', 'sonnet'));
});

test('a Cursor class graduates from high effort to default on outcomes alone (no tokens recorded)', () => {
  const t = (n, ok) => ({ n, ok, rate: ok / n, cost: 0, priced: 0, credit: 0, perTask: 0 });
  const g = decide({ ...DEFAULTS }, { prior: 'mechanical', tiers: { 'grok-4.7@high': t(137, 130), 'grok-4.7': t(163, 158) } });
  // 'grok-4.7' has the most runs, so it is the current rung; its ladder goes to the mini size
  assert.equal(g.from, 'grok-4.7');
  const h = decide({ ...DEFAULTS }, { prior: 'mechanical', tiers: { 'grok-4.7@high': t(160, 152), 'grok-4.7': t(40, 39) } });
  assert.equal(h.action, 'graduate');
  assert.equal(h.to, 'grok-4.7');
  assert.equal(h.step, 'lower effort, same model');
  assert.equal(h.saving, null);
  const auto = decide({ ...DEFAULTS }, { prior: 'unclear', tiers: { default: t(40, 39) } });
  assert.match(auto.why, /chosen by the editor/);
});
