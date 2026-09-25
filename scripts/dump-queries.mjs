/**
 * Emit the system query library as JSON. Transpiles systemQueries.ts with
 * esbuild (no imports, so a single-file transform is enough) and evaluates it,
 * so queries assembled from shared SQL fragments come out fully expanded.
 */
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

const src = readFileSync('src/main/db/systemQueries.ts', 'utf8');
const { code } = transformSync(src, { loader: 'ts', format: 'esm' });
const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const out = mod.SYSTEM_QUERIES.map((q) => ({ code: q.code, sql: q.sql }));
process.stdout.write(JSON.stringify(out));
