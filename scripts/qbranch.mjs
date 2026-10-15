// Entry of the native multi-call binary: `qbranch <tool> <args...>` runs a tool's CLI, `qbranch install ...` installs the
// tools into a project (the release archive ships the skills and hook definitions next to the binary).
import path from 'node:path';

const HELP = `qbranch: the Q Branch agent gadgets (headjack, middleout, moneyball, groundhog) in one binary.

  qbranch <tool> [args]              run a tool (try: qbranch moneyball, qbranch groundhog)
  qbranch install [tools|all] --platform claude|cursor|codex|gemini|copilot|windsurf [--project dir] [--uninstall]
  qbranch version`;

globalThis.__QBRANCH__ = true; // tells install.mjs it was imported, not run directly
const [cmd] = process.argv.splice(2, 1);
const tools = {
  headjack: () => import('../packages/headjack/bin/headjack.mjs'),
  middleout: () => import('../packages/middleout/bin/middleout.mjs'),
  moneyball: () => import('../packages/moneyball/bin/moneyball.mjs'),
  groundhog: () => import('../packages/groundhog/bin/groundhog.mjs'),
};

if (tools[cmd]) tools[cmd]();
else if (cmd === 'install') {
  import('./install.mjs').then(m => m.main(process.argv.slice(2), { source: path.dirname(process.execPath), runtime: 'binary', bin: process.execPath.split(path.sep).join('/') }))
    .catch((e) => { console.error(`install: ${e.message}`); process.exitCode = 1; });
} else if (cmd === 'version') console.log(process.env.QBRANCH_VERSION || '0.1.0');
else console.log(HELP);
