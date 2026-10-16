// Synthetic filler skills, generated deterministically from a seed. Used only when the public pool (filler/manifest.json)
// is too small for a library size. Every synthetic skill is plausible (a real-sounding tool, artifact and task, with a
// "Use when" clause) but generic: it never carries a house convention, so it can never satisfy a target's canaries.
// Same seed + same index = the same skill, on every machine.
import { createHash } from 'node:crypto';

/** mulberry32 seeded by a string. */
export function rng(seed) {
  let a = parseInt(createHash('sha256').update(String(seed)).digest('hex').slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
/** Seeded Fisher-Yates (returns a new array). */
export function shuffle(xs, seed) {
  const r = rng(seed), a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const TOPICS = ['kubernetes', 'graphql', 'postgres', 'kafka', 'flutter', 'rust', 'django', 'svelte', 'terraform', 'ansible',
  'spreadsheet', 'latex', 'pandas', 'spark', 'airflow', 'redis', 'nginx', 'electron', 'unity', 'godot', 'arduino', 'swift',
  'kotlin', 'elixir', 'haskell', 'scala', 'laravel', 'rails', 'webpack', 'vite', 'grpc', 'protobuf', 'helm', 'prometheus',
  'grafana', 'elasticsearch', 'mongodb', 'sqlite', 'bigquery', 'snowflake', 'dbt', 'jupyter', 'pytorch', 'tensorflow',
  'opencv', 'ffmpeg', 'blender', 'wordpress', 'shopify', 'stripe', 'oauth', 'webassembly', 'bash', 'powershell', 'cmake',
  'gradle', 'maven', 'cocoapods', 'android', 'ios', 'tauri', 'deno', 'bun', 'fastapi', 'flask', 'spring', 'dotnet',
  'unreal', 'raspberry-pi', 'mqtt', 'websocket', 'openapi', 'jsonschema', 'yaml', 'toml', 'markdown', 'mermaid', 'regex'];
const ARTIFACTS = ['config', 'migration', 'test-suite', 'release', 'dashboard', 'schema', 'pipeline', 'runbook', 'client',
  'component', 'report', 'notebook', 'plugin', 'module', 'cluster', 'query', 'workflow', 'template', 'service', 'cli'];
const ACTIONS = [['review', 'Reviews'], ['scaffold', 'Scaffolds'], ['audit', 'Audits'], ['optimize', 'Optimizes'],
  ['debug', 'Debugs'], ['document', 'Documents'], ['migrate', 'Migrates'], ['lint', 'Lints'], ['refactor', 'Refactors'],
  ['benchmark', 'Benchmarks'], ['harden', 'Hardens'], ['upgrade', 'Upgrades'], ['profile', 'Profiles'], ['package', 'Packages']];
const FACETS = ['common misconfigurations', 'version compatibility', 'performance hot spots', 'naming and layout',
  'error handling', 'security defaults', 'dependency pinning', 'logging and metrics', 'test coverage gaps',
  'backward compatibility', 'resource limits', 'caching behavior', 'concurrency issues', 'input validation',
  'documentation gaps', 'build reproducibility', 'deprecated APIs', 'accessibility checks', 'cost drivers', 'rollback steps'];
const WHEN = ['setting up a new {t} {a}', 'a {t} {a} misbehaves or fails in CI', 'preparing a {t} {a} for production',
  'someone asks for a second opinion on a {t} {a}', 'moving a {t} {a} to a newer version', 'a {t} {a} is slow or flaky',
  'onboarding a teammate to an existing {t} {a}', 'cleaning up a {t} {a} before a release'];

/** The i-th synthetic skill for a seed: { name, description, body, synthetic: true }. Names are unique per seed. */
export function synthSkill(seed, i) {
  const r = rng(`${seed}:synth:${i}`);
  // index -> a unique (topic, artifact, action) triple, then seeded wording
  const n = TOPICS.length * ARTIFACTS.length * ACTIONS.length;
  const k = (i * 7919 + 13) % n; // 7919 is prime and coprime to n, so k is a permutation of 0..n-1
  const t = TOPICS[k % TOPICS.length], a = ARTIFACTS[Math.floor(k / TOPICS.length) % ARTIFACTS.length];
  const [act, verb] = ACTIONS[Math.floor(k / (TOPICS.length * ARTIFACTS.length)) % ACTIONS.length];
  const fs = new Set(); while (fs.size < 3) fs.add(pick(r, FACETS));
  const [f1, f2, f3] = [...fs];
  const name = `${t}-${a}-${act}`;
  const when = pick(r, WHEN).replace('{t}', t).replace('{a}', a.replace(/-/g, ' '));
  const description = `${verb} ${t} ${a.replace(/-/g, ' ')}s: checks ${f1}, ${f2} and ${f3}, and proposes concrete fixes. Use when ${when}.`;
  const body = `# ${name}\n\n1. Read the ${t} ${a.replace(/-/g, ' ')} and list what it does.\n2. Check ${f1}.\n3. Check ${f2}.\n4. Check ${f3}.\n5. Propose the smallest fix for each finding, most important first.\n`;
  return { name, description, body, synthetic: true };
}
export const SYNTH_CAPACITY = TOPICS.length * ARTIFACTS.length * ACTIONS.length;
