import type { CostTypeAssignment, CostTypeCombination, CostTypeDef, ElementPackageAssignment, ExportDiagramRequest, IpcResult, LineageResult, MaterialImportResult, MaterialPackageAssignment, MaterialPackageCombination, OtherPackageCombination, PivotSource, SchemaDescription, ServicePackageAssignment, ServicePackageCombination, WorkPackageDef } from '@shared/types';

// Shape exposed by the preload bridge.
type Bridge = {
  app: { info(): Promise<IpcResult<{ version: string; dbPath: string; userData: string }>> };
  db: { open(): Promise<IpcResult<{ changed: boolean; dbPath: string }>>; backup(): Promise<IpcResult<string | null>> };
  projects: { list(): Promise<IpcResult<any[]>>; create(p: unknown): Promise<IpcResult<{ project_key: number }>> };
  reports: { list(): Promise<IpcResult<any[]>> };
  costTypes: {
    combinations(): Promise<IpcResult<CostTypeCombination[]>>;
    assign(items: CostTypeAssignment[]): Promise<IpcResult<{ assigned: number; cleared: number }>>;
    exportMapping(): Promise<IpcResult<string | null>>;
    types(): Promise<IpcResult<CostTypeDef[]>>;
    typeCreate(input: { label: string; icon: string; color: string }): Promise<IpcResult<CostTypeDef[]>>;
    typeUpdate(input: { code: string; label: string; icon: string; color: string }): Promise<IpcResult<CostTypeDef[]>>;
    typeDelete(code: string): Promise<IpcResult<CostTypeDef[]>>;
  };
  workPackages: {
    types(): Promise<IpcResult<WorkPackageDef[]>>;
    typeCreate(input: { code: string; label: string; group_label: string; icon: string; color: string }): Promise<IpcResult<WorkPackageDef[]>>;
    typeUpdate(input: { code: string; label: string; group_label: string; icon: string; color: string }): Promise<IpcResult<WorkPackageDef[]>>;
    typeDelete(code: string): Promise<IpcResult<WorkPackageDef[]>>;
    materialCombinations(projectKey: number): Promise<IpcResult<MaterialPackageCombination[]>>;
    otherCombinations(projectKey: number): Promise<IpcResult<OtherPackageCombination[]>>;
    assignElement(projectKey: number, items: ElementPackageAssignment[]): Promise<IpcResult<{ assigned: number; cleared: number }>>;
    assignMaterial(projectKey: number, items: MaterialPackageAssignment[]): Promise<IpcResult<{ assigned: number; cleared: number }>>;
    exportMaterialMapping(projectKey: number): Promise<IpcResult<string | null>>;
    importMaterialMapping(projectKey: number, filePath: string): Promise<IpcResult<MaterialImportResult>>;
    serviceCombinations(projectKey: number): Promise<IpcResult<ServicePackageCombination[]>>;
    assignService(projectKey: number, items: ServicePackageAssignment[]): Promise<IpcResult<{ assigned: number; cleared: number }>>;
  };
  settings: {
    list(): Promise<IpcResult<{ key: string; value: string }[]>>;
    set(key: string, value: string): Promise<IpcResult<void>>;
    reclassify(): Promise<IpcResult<{ costElements: number; updated: number }>>;
  };
  freshness: { list(): Promise<IpcResult<any[]>> };
  batches: { list(limit?: number): Promise<IpcResult<any[]>>; issues(id: number, limit?: number): Promise<IpcResult<any[]>> };
  files: { pick(title?: string): Promise<IpcResult<string | null>>; preview(p: string): Promise<IpcResult<any>> };
  mapping: {
    targets(m: string): Promise<IpcResult<any[]>>;
    suggest(m: string, cols: string[]): Promise<IpcResult<Record<string, string>>>;
    load(id: number): Promise<IpcResult<any[]>>;
    save(id: number, mapping: unknown[]): Promise<IpcResult<void>>;
  };
  imports: {
    stage(req: unknown): Promise<IpcResult<any>>;
    post(id: number, allowDuplicate?: boolean): Promise<IpcResult<any>>;
    remove(id: number): Promise<IpcResult<void>>;
    preview(id: number, limit?: number): Promise<IpcResult<Record<string, unknown>[]>>;
  };
  queries: {
    list(): Promise<IpcResult<any[]>>;
    run(code: string, params: Record<string, unknown>): Promise<IpcResult<any>>;
    runSql(sql: string, params: Record<string, unknown>): Promise<IpcResult<any>>;
    save(q: unknown): Promise<IpcResult<{ query_id: number }>>;
    remove(id: number): Promise<IpcResult<number>>;
  };
  pivot: {
    meta(): Promise<IpcResult<PivotSource[]>>;
    build(req: unknown): Promise<IpcResult<string>>;
  };
  schema: {
    describe(): Promise<IpcResult<SchemaDescription>>;
  };
  lineage: {
    forReport(reportDefinitionId: number): Promise<IpcResult<LineageResult>>;
  };
  exportDiagram(req: ExportDiagramRequest): Promise<IpcResult<string | null>>;
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
