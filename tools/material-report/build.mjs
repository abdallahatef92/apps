// Builds dist/Material_Cost_Report_Rev01.html: one self-contained page (libraries, engine, page) that works offline.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), 'utf8');
const lib = (p, name) => {
  const src = read(p).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  return `<script>/* ${name} */\n${src}\n</script>`;
};
const libs = [
  lib('node_modules/xlsx/dist/xlsx.full.min.js', 'SheetJS 0.18.5 (Apache-2.0)'),
  lib('node_modules/exceljs/dist/exceljs.min.js', 'ExcelJS 4.4.0 (MIT)'),
  lib('node_modules/chart.js/dist/chart.umd.js', 'Chart.js 4.4.1 (MIT)'),
].join('\n');
// String.replace with a function, so "$&" and friends inside the minified libraries are left alone
const html = read('page.html')
  .replace('/*STYLE*/', () => read('style.css'))
  .replace('<!--LIBS-->', () => libs)
  .replace('/*ENGINE*/', () => read('engine.js').replace(/<\/script/gi, '<\\/script'))
  .replace('/*APP*/', () => read('app.js').replace(/<\/script/gi, '<\\/script'));
mkdirSync(join(here, 'dist'), { recursive: true });
const out = join(here, 'dist', 'Material_Cost_Report_Rev01.html');
writeFileSync(out, html);
console.log(`${out} ${(html.length / 1048576).toFixed(2)} MB`);
