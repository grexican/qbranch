import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.resolve(BENCH, '..', '..');
export const TESTBED = path.join(BENCH, 'testbed');
export const CACHE_DIR = path.join(BENCH, '.cache');
export const RESULTS = path.join(BENCH, 'results');
