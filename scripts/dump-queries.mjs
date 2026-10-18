/**
 * Emit the system query library as JSON. Bundles systemQueries.ts (and the
 * query modules it spreads in, e.g. materialQueries.ts) with esbuild and
 * evaluates it, so queries assembled from shared SQL fragments come out fully
 * expanded.
 */
import { buildSync } from 'esbuild';

const { outputFiles } = buildSync({
  entryPoints: ['src/main/db/systemQueries.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const code = outputFiles[0].text;
const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const out = mod.SYSTEM_QUERIES.map((q) => ({ code: q.code, sql: q.sql }));
process.stdout.write(JSON.stringify(out));
