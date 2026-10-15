// Minimal YAML frontmatter reader/writer for SKILL.md and command files (no YAML dependency).
export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {}; const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!kv) continue;
    let [, k, v] = kv;
    if (/^[|>][-+]?$/.test(v.trim())) { // block scalar
      const buf = [];
      while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1])) buf.push(lines[++i].trim());
      v = buf.join(' ').trim();
    }
    meta[k] = v.replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: m[2] };
}

const q = (v) => (/^[\w .,/()-]*$/.test(v) && !/^\s|\s$/.test(v) ? v : JSON.stringify(v));
export function renderFrontmatter(meta, body) {
  const head = Object.entries(meta).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}: ${q(String(v))}`).join('\n');
  return `---\n${head}\n---\n\n${body.replace(/^\s+/, '')}`;
}
