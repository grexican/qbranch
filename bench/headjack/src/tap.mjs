// A local pass-through proxy for the Anthropic API that records request bodies. The cutoff probe points the agent's
// ANTHROPIC_BASE_URL at it to read the exact skill listing the model receives (which skills appear, with or without
// their descriptions). It forwards every request unchanged, streams responses back unchanged, and keeps only bodies
// in memory; headers (which carry credentials) are forwarded and never stored.
import http from 'node:http';
import https from 'node:https';

export function startTap({ upstream = 'https://api.anthropic.com' } = {}) {
  const bodies = [];
  const up = new URL(upstream);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (/\/v1\/messages/.test(req.url) && !/count_tokens/.test(req.url)) { try { bodies.push(JSON.parse(body.toString('utf8'))); } catch { /* not JSON */ } }
      const headers = { ...req.headers, host: up.host };
      delete headers['content-length'];
      headers['content-length'] = String(body.length);
      const fwd = https.request({ hostname: up.hostname, port: up.port || 443, path: req.url, method: req.method, headers }, (r) => {
        res.writeHead(r.statusCode || 502, r.headers);
        r.pipe(res);
      });
      fwd.on('error', (e) => { res.writeHead(502); res.end(String(e.message)); });
      fwd.end(body);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, bodies, close: () => new Promise(r => server.close(r)),
  })));
}

/** All text the model was given in a request: system blocks + message text (tool results included). */
export function requestText(body) {
  const parts = [];
  const add = (c) => { if (typeof c === 'string') parts.push(c); else if (Array.isArray(c)) for (const b of c) { if (b.text) parts.push(b.text); if (b.content) add(b.content); } };
  add(body.system);
  for (const m of body.messages || []) add(m.content);
  for (const t of body.tools || []) parts.push(`${t.name}: ${t.description || ''}`);
  return parts.join('\n');
}
