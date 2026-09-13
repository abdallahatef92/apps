import { contextBridge, ipcRenderer } from 'electron';
import type { IpcResult } from '../shared/types';

/**
 * The renderer never touches Node or the database directly; everything goes
 * through these channels. Each call resolves to {ok:true,data} | {ok:false,error}.
 */
const invoke = <T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> =>
  ipcRenderer.invoke(channel, ...args);

const api = {
  app: {
    info: () => invoke<{ version: string; dbPath: string; userData: string }>('app:info'),
  },
  db: {
    open: () => invoke<{ changed: boolean; dbPath: string }>('db:open'),
    backup: () => invoke<string | null>('db:backup'),
  },
  projects: {
    list: () => invoke<any[]>('projects:list'),
    create: (p: unknown) => invoke<{ project_key: number }>('projects:create', p),
  },
  reports: {
    list: () => invoke<any[]>('reports:list'),
  },
  settings: {
    list: () => invoke<{ key: string; value: string }[]>('settings:list'),
    set: (key: string, value: string) => invoke<void>('settings:set', key, value),
    reclassify: () => invoke<{ costElements: number; updated: number }>('settings:reclassify'),
  },
  freshness: {
    list: () => invoke<any[]>('freshness:list'),
  },
  batches: {
    list: (limit?: number) => invoke<any[]>('batches:list', limit),
    issues: (batchId: number, limit?: number) => invoke<any[]>('import:issues', batchId, limit),
  },
  files: {
    pick: () => invoke<string | null>('file:pick'),
    preview: (filePath: string) => invoke<any>('file:preview', filePath),
  },
  mapping: {
    targets: (module: string) => invoke<any[]>('mapping:targets', module),
    suggest: (module: string, columns: string[]) => invoke<Record<string, string>>('mapping:suggest', module, columns),
    load: (reportDefinitionId: number) => invoke<any[]>('mapping:load', reportDefinitionId),
    save: (reportDefinitionId: number, mapping: unknown[]) => invoke<void>('mapping:save', reportDefinitionId, mapping),
  },
  imports: {
    stage: (req: unknown) => invoke<any>('import:stage', req),
    post: (batchId: number) => invoke<any>('import:post', batchId),
    remove: (batchId: number) => invoke<void>('import:delete', batchId),
  },
  queries: {
    list: () => invoke<any[]>('query:list'),
    run: (code: string, params: Record<string, unknown>) => invoke<any>('query:run', code, params),
    runSql: (sql: string, params: Record<string, unknown>) => invoke<any>('query:runSql', sql, params),
    save: (q: unknown) => invoke<{ query_id: number }>('query:save', q),
    remove: (queryId: number) => invoke<number>('query:delete', queryId),
  },
  exportResult: (result: unknown, meta: unknown) => invoke<string | null>('export:result', result, meta),
  showItem: (filePath: string) => invoke<void>('shell:showItem', filePath),
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
