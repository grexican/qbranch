#!/usr/bin/env node
// Build the native multi-call binary for the current OS/arch with Node's single-executable support, plus the release
// folder it ships in: build/belt-<os>-<arch>/{belt[.exe], packages/<tool>/{skills,hooks,.mcp.json,.claude-plugin}}.
// CI runs this on windows, macos and ubuntu runners (SEA cannot cross-compile). Needs Node >= 25.5 (--build-sea).
// The binary has no local embeddings (native modules); headjack falls back to keyword search there.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { TOOLS } from './platforms.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const os = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform] || process.platform;
const name = `belt-${os}-${process.arch}`;
const out = path.join(ROOT, 'build', name);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const main = path.join(ROOT, 'build', 'belt.mjs');
await esbuild.build({
  entryPoints: [path.join(ROOT, 'scripts', 'belt.mjs')], bundle: true, platform: 'node', format: 'esm', target: 'node22',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(process.execPath);" },
  outfile: main, external: ['@huggingface/transformers'], logLevel: 'error', legalComments: 'none',
});
const exe = path.join(out, process.platform === 'win32' ? 'belt.exe' : 'belt');
const cfgFile = path.join(ROOT, 'build', 'sea-config.json');
fs.writeFileSync(cfgFile, JSON.stringify({ main, output: exe, mainFormat: 'module', disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }));
execFileSync(process.execPath, ['--build-sea', cfgFile], { stdio: 'inherit' });
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', exe], { stdio: 'inherit' }); // ad-hoc sign: required on Apple silicon

for (const t of TOOLS) {
  const pkg = path.join(ROOT, 'packages', t);
  for (const rel of ['skills', 'hooks', '.mcp.json', '.claude-plugin']) {
    if (fs.existsSync(path.join(pkg, rel))) fs.cpSync(path.join(pkg, rel), path.join(out, 'packages', t, rel), { recursive: true });
  }
}
console.log(`built ${path.relative(ROOT, exe)} (${(fs.statSync(exe).size / 1e6).toFixed(0)} MB)`);
