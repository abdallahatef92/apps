import { contextBridge, ipcRenderer } from 'electron';
import type { ExportDiagramRequest, IpcResult, LineageResult, SchemaDescription } from '../shared/types';

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
  costTypes: {
    combinations: () => invoke<any[]>('costTypes:combinations'),
    assign: (items: unknown[]) => invoke<{ assigned: number; cleared: number }>('costTypes:assign', items),
    exportMapping: () => invoke<string | null>('costTypes:exportMapping'),
    types: () => invoke<any[]>('costTypes:types'),
    typeCreate: (input: unknown) => invoke<any[]>('costTypes:typeCreate', input),
    typeUpdate: (input: unknown) => invoke<any[]>('costTypes:typeUpdate', input),
    typeDelete: (code: string) => invoke<any[]>('costTypes:typeDelete', code),
  },
  workPackages: {
    types: () => invoke<any[]>('workPackages:types'),
    typeCreate: (input: unknown) => invoke<any[]>('workPackages:typeCreate', input),
    typeUpdate: (input: unknown) => invoke<any[]>('workPackages:typeUpdate', input),
    typeDelete: (code: string) => invoke<any[]>('workPackages:typeDelete', code),
    materialCombinations: (projectKey: number) => invoke<any[]>('workPackages:materialCombinations', projectKey),
    otherCombinations: (projectKey: number) => invoke<any[]>('workPackages:otherCombinations', projectKey),
    assignElement: (projectKey: number, items: unknown[]) => invoke<{ assigned: number; cleared: number }>('workPackages:assignElement', projectKey, items),
    assignMaterial: (projectKey: number, items: unknown[]) => invoke<{ assigned: number; cleared: number }>('workPackages:assignMaterial', projectKey, items),
    exportMaterialMapping: (projectKey: number) => invoke<string | null>('workPackages:exportMaterialMapping', projectKey),
    importMaterialMapping: (projectKey: number, filePath: string) => invoke<any>('workPackages:importMaterialMapping', projectKey, filePath),
    serviceCombinations: (projectKey: number) => invoke<any[]>('workPackages:serviceCombinations', projectKey),
    assignService: (projectKey: number, items: unknown[]) => invoke<{ assigned: number; cleared: number }>('workPackages:assignService', projectKey, items),
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
    pick: (title?: string) => invoke<string | null>('file:pick', title),
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
    post: (batchId: number, allowDuplicate = false) =>
      invoke<any>('import:post', batchId, allowDuplicate),
    remove: (batchId: number) => invoke<void>('import:delete', batchId),
    preview: (batchId: number, limit?: number) =>
      invoke<Record<string, unknown>[]>('import:preview', batchId, limit),
  },
  queries: {
    list: () => invoke<any[]>('query:list'),
    run: (code: string, params: Record<string, unknown>) => invoke<any>('query:run', code, params),
    runSql: (sql: string, params: Record<string, unknown>) => invoke<any>('query:runSql', sql, params),
    save: (q: unknown) => invoke<{ query_id: number }>('query:save', q),
    remove: (queryId: number) => invoke<number>('query:delete', queryId),
  },
  pivot: {
    meta: () => invoke<any[]>('pivot:meta'),
    build: (req: unknown) => invoke<string>('pivot:build', req),
  },
  schema: {
    describe: () => invoke<SchemaDescription>('schema:describe'),
  },
  lineage: {
    forReport: (reportDefinitionId: number) => invoke<LineageResult>('lineage:forReport', reportDefinitionId),
  },
  exportDiagram: (req: ExportDiagramRequest) => invoke<string | null>('export:diagram', req),
  exportResult: (result: unknown, meta: unknown) => invoke<string | null>('export:result', result, meta),
  showItem: (filePath: string) => invoke<void>('shell:showItem', filePath),
  sc: {
    exportReport: (projectKey: number) => invoke<string | null>('sc:exportReport', projectKey),
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
