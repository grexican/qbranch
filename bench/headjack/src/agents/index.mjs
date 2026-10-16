// Agent adapters. An adapter is { run(opts) -> result, meta() -> { agent, cli, version } }.
//
// run({ prompt, dir, model, settings, env, timeoutMs, budgetUsd, authFromHome, extraArgs }) must:
//   - run the agent headless once in `dir` (a throwaway sandbox), isolated from the user's own agent config;
//   - apply `settings.hooks` (Claude Code hook shape: the headjack arm's UserPromptSubmit hook) in the agent's own format;
//   - return { ok, killed, error, finalText, events, costUsd, durationMs, numTurns, tokens: { input, cacheRead, cacheWrite, output } }
//     where `events` are @qbranch/core transcript events ({ t: 'tool', name, input } ...), so src/score.mjs can see
//     skill loads. Tool names must be mapped to Claude Code's (Skill, Bash, Read) or scoring will not see loads.
//
// Only Claude Code is implemented and verified. To add one, map its skill install path (native arm), its prompt-time
// hook (headjack arm; see scripts/platforms.mjs for each platform's event names), its headless command, and its
// transcript reader (packages/core/src/transcripts.mjs already reads Codex, Gemini CLI and Cursor transcripts).
import * as claude from './claude.mjs';

export const AGENTS = { claude };
export function agent(name) {
  const a = AGENTS[name];
  if (!a) throw new Error(`no adapter for agent '${name}' (implemented: ${Object.keys(AGENTS).join(', ')}). See src/agents/index.mjs for the adapter contract.`);
  return a;
}
