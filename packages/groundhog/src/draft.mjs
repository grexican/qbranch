// Draft a runbook from a mined sequence or repeat: an Agent Skill (SKILL.md) under .groundhog/drafts/<name>/.
// Drafts are never installed automatically; review, then adopt into a skill library (e.g. `headjack add <dir>`).
// A runbook that stays stable for a few weeks is the cue to promote it to a script.
import fs from 'node:fs';
import path from 'node:path';
import { renderFrontmatter } from '@qbranch/core';
import { upsert } from './stats.mjs';

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'runbook';

export function draftRunbook(cfg, item, name) {
  const steps = item.steps || [item.shape];
  const examples = item.examples || [item.example];
  const n = slug(name || steps.map(s => s.split(' ').slice(0, 2).join(' ')).join(' then '));
  const dir = path.join(cfg.dataDir, 'drafts', n);
  fs.mkdirSync(dir, { recursive: true });
  const body = [
    `# ${n}`,
    '',
    `Mined by groundhog: this sequence ran by hand in ${item.sessions} sessions. Fill in the why and the parameters, then`,
    'adopt it into your skill library. When the steps stop changing, promote it to a script and point this runbook at it.',
    '',
    '## Steps',
    '',
    ...steps.map((s, i) => `${i + 1}. \`${s}\`\n   - seen as: \`${(examples[i] || '').split('\n')[0].slice(0, 200)}\``),
    '',
    '## Gotchas',
    '',
    '- (add the failure modes you hit here; `groundhog report` lists recurring error -> fix pairs)',
    '',
  ].join('\n');
  const meta = { name: n, description: `Runbook: ${steps.join(' -> ').slice(0, 300)}. Use when doing this procedure by hand. (groundhog draft: review before use)` };
  fs.writeFileSync(path.join(dir, 'SKILL.md'), renderFrontmatter(meta, body));
  upsert(cfg, (s) => { s.totals.drafts++; });
  return dir;
}
