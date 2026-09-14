// Stands in for the `electron` module when the main-process code is exercised
// outside a real Electron window (see tests/pipeline.e2e.ts).
import { tmpdir } from 'node:os';
export const app = {
  getPath: (_name: string) => tmpdir(),
  getVersion: () => '0.0.0-test',
  isPackaged: false,
};
export const ipcMain = { handle: () => undefined };
export const dialog = {};
export const shell = {};
export const BrowserWindow = { getAllWindows: () => [] };
