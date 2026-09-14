/** Emit the system query library as JSON without needing a TS build step. */
import { readFileSync } from 'node:fs';

const src = readFileSync('src/main/db/systemQueries.ts', 'utf8');
const out = [];
const blocks = src.split(/\n  \{\n/).slice(1);
for (const b of blocks) {
  const code = /code: '([^']+)'/.exec(b)?.[1];
  const sql = /sql: `([\s\S]*?)`,?\n  \}/.exec(b)?.[1];
  if (code && sql) out.push({ code, sql });
}
process.stdout.write(JSON.stringify(out));
