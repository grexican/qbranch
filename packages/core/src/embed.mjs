// Local sentence embeddings (MiniLM, 384-d) shared by tools that cluster or search text. Optional: if the model can't
// load (or <TOOL>_EMBED=0 / UB_EMBED=0), embed() returns null and callers fall back to lexical methods.
import os from 'node:os';
import path from 'node:path';

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const CACHE = path.join(os.homedir(), '.utility-belt', 'models');
let embedder;

export async function embed(texts, { disabled = process.env.UB_EMBED === '0' } = {}) {
  if (disabled || embedder === false || !texts.length) return null;
  try {
    if (!embedder) {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = CACHE;
      embedder = await pipeline('feature-extraction', MODEL);
    }
    const out = await embedder(texts, { pooling: 'mean', normalize: true });
    const dim = out.dims[1];
    return texts.map((_, i) => out.data.slice(i * dim, (i + 1) * dim));
  } catch { embedder = false; return null; }
}

export const cosine = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };
export const toBlob = (v) => (v ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : null);
export const fromBlob = (b) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
