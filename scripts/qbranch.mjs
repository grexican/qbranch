// Entry of the native multi-call binary: `qbranch <tool> <args...>` runs a tool's CLI, `qbranch install ...` installs the
// tools into a project (the release archive ships the skills and hook definitions next to the binary).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installCommand } from '../packages/core/src/binary.mjs';

const HELP = `qbranch: the Q Branch agent gadgets (headjack, middleout, moneyball, groundhog) in one binary.

  qbranch <tool> [args]              run a tool (try: qbranch moneyball, qbranch groundhog)
  qbranch stats [--json]             is each installed tool earning its keep in this project? (all stats files, one view)
  qbranch install [tools|all] --platform claude|cursor|codex|gemini|copilot|windsurf [--project dir] [--uninstall]
  qbranch update                     reinstall the latest binary (plugins update with: claude plugin update <tool>@qbranch)
  qbranch version`;

globalThis.__QBRANCH__ = true; // tells install.mjs it was imported, not run directly
const [cmd] = process.argv.splice(2, 1);
const tools = {
  headjack: () => import('../packages/headjack/bin/headjack.mjs'),
  middleout: () => import('../packages/middleout/bin/middleout.mjs'),
  moneyball: () => import('../packages/moneyball/bin/moneyball.mjs'),
  groundhog: () => import('../packages/groundhog/bin/groundhog.mjs'),
};

// every tool's config + stats modules are side-effect free (the MCP servers and CLIs are not imported here)
const statsOf = {
  headjack: () => Promise.all([import('../packages/headjack/src/config.mjs'), import('../packages/headjack/src/stats.mjs')]),
  middleout: () => Promise.all([import('../packages/middleout/src/config.mjs'), import('../packages/middleout/src/stats.mjs')]),
  moneyball: () => Promise.all([import('../packages/moneyball/src/config.mjs'), import('../packages/moneyball/src/stats.mjs')]),
  groundhog: () => Promise.all([import('../packages/groundhog/src/config.mjs'), import('../packages/groundhog/src/stats.mjs')]),
};

async function allStats(json) {
  const out = {};
  for (const [name, load] of Object.entries(statsOf)) {
    const [{ loadConfig }, { summarize }] = await load();
    const cfg = loadConfig();
    let s = null; try { s = cfg.stats && JSON.parse(fs.readFileSync(path.join(cfg.root, cfg.stats), 'utf8')); } catch { /* not installed here, or never used */ }
    out[name] = json ? s : s ? summarize(s, cfg) : `${name}: no stats in ${cfg.root} (not installed here, or not used yet)`;
  }
  console.log(json ? JSON.stringify(out, null, 2) : Object.values(out).join('\n\n'));
}

// The binary is installed apart from the plugins, so `claude plugin update` never refreshes it: re-run the installer.
// On Windows the installer renames this running qbranch.exe away (allowed while it runs) before moving the new one in.
function update() {
  const line = installCommand();
  console.log(`updating qbranch: ${line}`);
  const r = process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', line.match(/-Command "(.*)"$/)[1]], { stdio: 'inherit' })
    : spawnSync('sh', ['-c', line], { stdio: 'inherit' });
  if (r.error) { console.error(`update: ${r.error.message}`); process.exitCode = 1; } else process.exitCode = r.status ?? 1;
}

if (tools[cmd]) tools[cmd]();
else if (cmd === 'update') update();
else if (cmd === 'stats') allStats(process.argv.includes('--json')).catch((e) => { console.error(`stats: ${e.message}`); process.exitCode = 1; });
else if (cmd === 'install') {
  import('./install.mjs').then(m => m.main(process.argv.slice(2), { source: path.dirname(process.execPath), runtime: 'binary', bin: process.execPath.split(path.sep).join('/') }))
    .catch((e) => { console.error(`install: ${e.message}`); process.exitCode = 1; });
} else if (cmd === 'version') console.log(typeof __QBRANCH_VERSION__ === 'string' ? __QBRANCH_VERSION__ : 'dev'); // stamped at build time
else console.log(HELP);
