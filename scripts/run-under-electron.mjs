/**
 * Run a bundled script with Electron's Node runtime.
 *
 * The app's better-sqlite3 is compiled against Electron's ABI (electron-builder
 * install-app-deps does that on postinstall), so plain `node` cannot load it.
 * Usage: node scripts/run-under-electron.mjs out/test/pipeline.cjs
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron');
const [, , script, ...rest] = process.argv;

if (!script) {
  console.error('usage: node scripts/run-under-electron.mjs <script.cjs> [args…]');
  process.exit(2);
}

const child = spawn(electron, [script, ...rest], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
child.on('exit', (code) => process.exit(code ?? 1));
