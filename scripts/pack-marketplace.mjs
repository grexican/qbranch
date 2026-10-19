#!/usr/bin/env node
// Build the marketplace upload ZIPs. SKILL.md must sit at the ZIP root with forward-slash entry names: Windows
// PowerShell's Compress-Archive writes backslash paths, which marketplace uploaders cannot read.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal ZIP writer (deflate), so packing needs no dependency. entries: [{ name, body }] */
function zip(entries) {
  const chunks = [], central = [];
  let offset = 0;
  const dos = (d) => [((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xffff,
    (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff];
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  for (const e of entries) {
    const name = Buffer.from(e.name.split(path.sep).join('/'));
    const raw = Buffer.from(e.body);
    const def = zlib.deflateRawSync(raw);
    const [t, d] = dos(new Date());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(t, 10); local.writeUInt16LE(d, 12); local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(def.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, def);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(t, 12); cen.writeUInt16LE(d, 14); cen.writeUInt32LE(crc32(raw), 16);
    cen.writeUInt32LE(def.length, 20); cen.writeUInt32LE(raw.length, 24); cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + def.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cenBuf, end]);
}

for (const dir of fs.readdirSync(path.join(ROOT, 'marketplace'), { withFileTypes: true }).filter(d => d.isDirectory())) {
  for (const skill of fs.readdirSync(path.join(ROOT, 'marketplace', dir.name), { withFileTypes: true }).filter(d => d.isDirectory())) {
    const src = path.join(ROOT, 'marketplace', dir.name, skill.name);
    const entries = fs.readdirSync(src).map(f => ({ name: f, body: fs.readFileSync(path.join(src, f)) }));
    if (!entries.some(e => e.name === 'SKILL.md')) throw new Error(`${src}: no SKILL.md at the root`);
    const out = path.join(ROOT, 'marketplace', dir.name, `${skill.name}.zip`);
    fs.writeFileSync(out, zip(entries));
    console.log(`${path.relative(ROOT, out)}  (${entries.map(e => e.name).join(', ')})`);
  }
}
