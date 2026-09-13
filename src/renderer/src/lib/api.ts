import type { IpcResult } from '@shared/types';

// Shape exposed by the preload bridge.
type Bridge = {
  app: { info(): Promise<IpcResult<{ version: string; dbPath: string; userData: string }>> };
  db: { open(): Promise<IpcResult<{ changed: boolean; dbPath: string }>>; backup(): Promise<IpcResult<string | null>> };
  projects: { list(): Promise<IpcResult<any[]>>; create(p: unknown): Promise<IpcResult<{ project_key: number }>> };
  reports: { list(): Promise<IpcResult<any[]>> };
  freshness: { list(): Promise<IpcResult<any[]>> };
  batches: { list(limit?: number): Promise<IpcResult<any[]>>; issues(id: number, limit?: number): Promise<IpcResult<any[]>> };
  files: { pick(): Promise<IpcResult<string | null>>; preview(p: string): Promise<IpcResult<any>> };
  mapping: {
    targets(m: string): Promise<IpcResult<any[]>>;
    suggest(m: string, cols: string[]): Promise<IpcResult<Record<string, string>>>;
    load(id: number): Promise<IpcResult<any[]>>;
    save(id: number, mapping: unknown[]): Promise<IpcResult<void>>;
  };
  imports: {
    stage(req: unknown): Promise<IpcResult<any>>;
    post(id: number): Promise<IpcResult<any>>;
    remove(id: number): Promise<IpcResult<void>>;
  };
  queries: {
    list(): Promise<IpcResult<any[]>>;
    run(code: string, params: Record<string, unknown>): Promise<IpcResult<any>>;
    runSql(sql: string, params: Record<string, unknown>): Promise<IpcResult<any>>;
    save(q: unknown): Promise<IpcResult<{ query_id: number }>>;
    remove(id: number): Promise<IpcResult<number>>;
  };
  exportResult(result: unknown, meta: unknown): Promise<IpcResult<string | null>>;
  showItem(p: string): Promise<IpcResult<void>>;
};

declare global {
  interface Window { api: Bridge }
}

export const api = window.api;

/** Unwrap an IpcResult, throwing the main-process error message as-is. */
export async function call<T>(p: Promise<IpcResult<T>>): Promise<T> {
  const res = await p;
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
