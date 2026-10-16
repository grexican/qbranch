// Maintainer step (done once, output committed): blind prompt generation.
//   npm run bench:headjack:generate -- [--model sonnet] [--concurrency 8] [--auth-from-home]
// Step 1: a model reads a skill and writes a situation card (the person's goal and concrete details, none of the
//         skill's vocabulary). Step 2: a fresh call that never sees the skill turns the card into the message the
//         person would type. Tiers are then assigned from measured word overlap (src/overlap.mjs), not from intent.
// Output: testbed/prompts/cards.json, testbed/prompts/prompts.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TESTBED } from './paths.mjs';
import { run } from './agents/claude.mjs';
import { keyTerms, tierPrompt } from './overlap.mjs';
import { usedTargets } from './score.mjs';
import { canaries as loadCanaries } from './library.mjs';
import { parseFrontmatter } from '../../../packages/core/src/frontmatter.mjs';

const OUT = path.join(TESTBED, 'prompts');
export const SEED = 'hjbench-v1';
const PER = { natural: 6, named: 1, negative: 2, multi: 4 };

export function jobs(cans) {
  const out = [];
  const names = Object.keys(cans).sort();
  for (const n of names) {
    for (let k = 0; k < PER.natural; k++) out.push({ id: `natural:${n}:${k}`, kind: 'natural', skills: [n] });
    for (let k = 0; k < PER.named; k++) out.push({ id: `named:${n}:${k}`, kind: 'named', skills: [n] });
    for (let k = 0; k < PER.negative; k++) out.push({ id: `negative:${n}:${k}`, kind: 'negative', skills: [n] });
  }
  const pairs = [...new Set(names.map(n => cans[n].pair).filter(Boolean))].sort();
  for (const p of pairs) {
    const two = names.filter(n => cans[n].pair === p);
    for (let k = 0; k < PER.multi; k++) out.push({ id: `multi:${p}:${k}`, kind: 'multi', skills: two });
  }
  return out;
}

/** Stable dev/test split: ~25% dev. */
export const splitOf = (id, seed = SEED) => (parseInt(createHash('sha256').update(`${seed}:${id}`).digest('hex').slice(0, 8), 16) % 100 < 25 ? 'dev' : 'test');

const ANGLES = ['', 'Pick a different, specific situation than the most obvious one.', 'Make the person someone outside software (a manager, a researcher, a founder) if it fits.',
  'Make it a situation from a hobby, a nonprofit or a school, if the skill can apply there.', 'Pick a situation where the person is in a hurry and only has a rough idea.', 'Pick a situation in an unusual industry (farming, shipping, theater, a lab).'];
function cardPrompt(job, skills, k) {
  const banned = [...new Set(skills.flatMap(s => [...keyTerms(`${s.name.replace(/-/g, ' ')} ${s.description}`)]))].sort();
  const what = job.kind === 'negative'
    ? 'the request sounds close to this skill\'s area, but the skill must NOT apply: for example a conceptual question, a debugging question, an opinion, or a different kind of artifact, so that none of the skill\'s rules would show up in a good answer'
    : job.kind === 'multi' ? 'BOTH skills below legitimately apply to the same request' : 'this skill clearly applies';
  return `You are helping build a benchmark for AI coding assistants. Below ${skills.length > 1 ? 'are two skills' : 'is a skill'} (house instructions an assistant can load).
Write a SITUATION CARD: a realistic moment where a person asks an AI coding assistant for help, where ${what}.

Rules:
- Describe who the person is, their goal, and the concrete details they have (names, numbers, the content of the change, the data columns...). 2-4 sentences.
- The assistant works in an EMPTY folder, so the card must contain any content the task needs.
- Do NOT describe the skill's rules, formats or markers, and do NOT use any of these words (or forms of them): ${banned.join(', ')}.
- ${ANGLES[k % ANGLES.length] || 'Be specific.'}

${skills.map(s => `=== SKILL ${s.name} ===\n${s.text}`).join('\n\n')}

Reply with JSON only: {"card": "..."}`;
}

function promptPrompt(job, card, attempt) {
  const named = job.kind === 'named' ? `\n- The person has a skill called "${job.skills[0]}" and asks the assistant to use it, by that exact name.` : '';
  const extra = attempt === 0 ? '' : attempt === 1 ? '\n- Say it the way a non-specialist would, in your own everyday words (avoid the technical terms a specialist would use).'
    : '\n- Describe what they want to end up with and why, in everyday words. Avoid naming the technology, file type or document type unless the task cannot be understood without it.';
  return `Here is a situation card about a person who is about to ask an AI coding assistant for help.

CARD: ${card}

Write the exact message this person types. Rules:
- Write as the person: natural, direct, 1-4 sentences (a pasted snippet or list of details may follow).
- The assistant has an empty project folder: include the concrete details from the card so it can do the task right away.
- Use plain everyday words.${extra}
- Do not mention skills, style guides, templates or conventions.${named}

Reply with JSON only: {"prompt": "..."}`;
}

async function ask(text, { model, authFromHome, key }) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hjbench-gen-')));
  try {
    for (let t = 0; t < 3; t++) {
      const r = await run({ prompt: text, dir, model, authFromHome, extraArgs: ['--tools', ''], timeoutMs: 180_000, budgetUsd: 0.5 });
      const m = r.finalText.match(/\{[\s\S]*\}/);
      if (m) { try { const v = JSON.parse(m[0]); if (v[key]) return { value: String(v[key]).trim(), costUsd: r.costUsd }; } catch { /* retry */ } }
    }
    throw new Error('no JSON from generator');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export async function generate({ model = 'sonnet', concurrency = 8, authFromHome = false, log = console.log } = {}) {
  const cans = loadCanaries();
  const skill = (n) => { const text = fs.readFileSync(path.join(TESTBED, 'targets', n, 'SKILL.md'), 'utf8'); return { name: n, text, description: parseFrontmatter(text).meta.description }; };
  const descriptions = Object.fromEntries(Object.keys(cans).map(n => [n, skill(n).description]));
  const all = process.env.HJ_GEN_ONLY ? jobs(cans).filter(j => new RegExp(process.env.HJ_GEN_ONLY).test(j.id)) : jobs(cans);
  fs.mkdirSync(OUT, { recursive: true });
  const cardsFile = path.join(OUT, 'cards.json');
  const cards = fs.existsSync(cardsFile) ? JSON.parse(fs.readFileSync(cardsFile, 'utf8')) : {};
  let i = 0, cost = 0;
  const save = () => fs.writeFileSync(cardsFile, JSON.stringify(cards, null, 1) + '\n');
  const worker = async () => {
    while (i < all.length) {
      const job = all[i++];
      if (cards[job.id]?.prompt) continue;
      const k = Number(job.id.split(':').pop());
      try {
        const c = cards[job.id]?.card ? { value: cards[job.id].card, costUsd: 0 } : await ask(cardPrompt(job, job.skills.map(skill), k), { model, authFromHome, key: 'card' });
        const answers = job.kind === 'negative' ? [] : job.skills;
        const attempts = [];
        for (let a = 0; a < (job.kind === 'natural' || job.kind === 'multi' ? 5 : 1); a++) {
          const p = await ask(promptPrompt(job, c.value, a), { model, authFromHome, key: 'prompt' });
          cost += p.costUsd;
          const t = tierPrompt(p.value, answers, descriptions);
          const leak = usedTargets(cans, p.value);
          attempts.push({ prompt: p.value, tier: t.tier, leak });
          // natural requests get up to two more phrasings when they came out lexical; the tier stays the measured one
          if (leak.length || !(job.kind === 'natural' || job.kind === 'multi') || t.tier === 'semantic') break;
        }
        const pick = attempts.find(x => !x.leak.length && x.tier === 'semantic') || attempts.find(x => !x.leak.length) || null;
        cost += c.costUsd;
        cards[job.id] = { kind: job.kind, skills: job.skills, card: c.value, prompt: pick?.prompt || null, attempts: attempts.length, discarded: pick ? null : 'prompt satisfied a canary' };
        save();
        log(`${Object.values(cards).filter(x => x.prompt).length}/${all.length} ${job.id} -> ${pick ? tierPrompt(pick.prompt, answers, descriptions).tier : 'DISCARDED'}`);
      } catch (e) { log(`fail ${job.id}: ${e.message}`); }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  log(`generation cost (reported by the CLI): $${cost.toFixed(2)}`);
  return assemble({ cards, descriptions, model });
}

/** Turn cards into the prompt set: tiers from overlap, answer sets, splits. Pure; re-runnable offline. */
export function assemble({ cards, descriptions, model }) {
  const cans = loadCanaries();
  const prompts = Object.entries(cards).filter(([, c]) => c.prompt).map(([id, c]) => {
    const answers = c.kind === 'negative' ? [] : c.skills;
    const t = tierPrompt(c.prompt, answers, descriptions);
    return { id, text: c.prompt, answers, near: c.skills, shard: cans[c.skills[0]].shard, kind: c.kind, tier: t.tier,
      overlap: t.overlap.max, overlapTerms: t.overlap.terms, overlapAnyTarget: t.maxAny, multi: answers.length > 1, split: splitOf(id) };
  }).sort((a, b) => a.id.localeCompare(b.id));
  // Tier quotas from the pre-registration, applied per split by a seeded draw (tiers themselves stay as measured):
  // semantic is the largest tier, named is at most 20%. Excluded prompts stay in the file, flagged, and are never run.
  const h = (id) => createHash('sha256').update(`${SEED}:quota:${id}`).digest('hex');
  for (const split of ['dev', 'test']) {
    const ps = prompts.filter(p => p.split === split);
    const of = (tier) => ps.filter(p => p.tier === tier && !p.excluded).sort((a, b) => h(a.id).localeCompare(h(b.id)));
    const sem = of('semantic').length;
    for (const p of of('lexical').slice(Math.max(0, sem - 1))) p.excluded = 'tier quota: semantic must be the largest tier';
    const total = ps.filter(p => !p.excluded).length;
    for (const p of of('named').slice(Math.floor(0.2 * total))) p.excluded = 'tier quota: named at most 20%';
  }
  const counts = {};
  for (const p of prompts.filter(x => !x.excluded)) { const k = `${p.split}:${p.tier}`; counts[k] = (counts[k] || 0) + 1; }
  const doc = { seed: SEED, generator: { agent: 'claude', model, steps: ['situation card (sees the skill)', 'prompt (fresh call, never sees the skill)'] }, counts, prompts };
  fs.writeFileSync(path.join(OUT, 'prompts.json'), JSON.stringify(doc, null, 1) + '\n');
  return doc;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const a = process.argv.slice(2);
  const opt = (f, d) => { const i = a.indexOf(f); return i < 0 ? d : a[i + 1]; };
  const doc = await generate({ model: opt('--model', 'sonnet'), concurrency: Math.min(8, +opt('--concurrency', 8)), authFromHome: a.includes('--auth-from-home') });
  console.log(doc.counts);
}
