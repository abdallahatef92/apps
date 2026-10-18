# Flow redesign: Input → Coding → Reports, with a cut-off date

The interface is organised around the three steps a cost controller actually does, in order:

1. **Input**: upload SAP/Excel reports, check what is loaded (Upload data, Data register).
2. **Coding**: classify the loaded cost (Work packages, Cost types).
3. **Reports**: read actual cost to the cut-off (Actual cost, Cost report, Subcontractors, Materials).

The scope for now is mainly **actuals**. Budget/forecast stay where they are; nothing new is built for them.

## Cut-off date (decided)

- One cut-off per project, stored in the database (`project_cutoff`), set from the top bar.
- A posted actual line **counts when its SAP posting date ≤ cut-off**. A line without a posting
  date falls back to its period's end date (`dim_period.end_date`). No cut-off set (NULL) = everything counts.
- Applied **inside `v_posting`** (so `v_actual`, `v_revenue` and every report/KPI/coding list that
  reads them respect it automatically). Lines after the cut-off stay in `fact_actual`, untouched.
- `v_posting_all` is the same view without the cut-off, for status queries that need to count
  what is being held back. Reports never read it.
- Not cut off (yet): `v_service_line`, `v_order_line`, `v_accrual`, budget/forecast. Known gap: in
  `UNIFIED_COST_REGISTER`/`PKG_SUMMARY`, a PO whose service-line detail is loaded is reported from
  that detail regardless of the cut-off.

## Contracts shared between tasks

### IPC / preload (`window.api.cutoff`)

```ts
api.cutoff.get(projectKey: number): Promise<Result<{
  cutoff_date: string | null;        // ISO 'YYYY-MM-DD'
  latest_posting_date: string | null; // newest posting date among posted actual lines (uncut)
  lines_after_cutoff: number;         // posted actual lines held back by the cut-off
  amount_after_cutoff: number;        // their cost amount (COST lines only)
}>>
api.cutoff.set(projectKey: number, cutoffDate: string | null): Promise<Result<{ ok: true }>>
```
Numbers come from a stored query (`CUTOFF_STATUS`), not TypeScript arithmetic.

### Stored query `FLOW_STATUS` (param `project_key`), one row

| column | meaning |
|---|---|
| `cutoff_date` | the project's cut-off or NULL |
| `latest_data_date` | newest `data_date` of a POSTED actual batch for the project |
| `stale_sources` / `total_sources` | from the same freshness logic the Dashboard already uses |
| `actual_to_cutoff` | `SUM(amount)` from `v_actual` |
| `actual_cutoff_month` | actual in the cut-off's own period (or the latest period when no cut-off) |
| `coded_amount` / `unallocated_amount` / `coded_pct` | work-package coding of actual cost, same rules as `PKG_SUMMARY` |
| `budget` | current budget total (as `KPI_PROJECT`) |

### Page ids (`App.tsx` `PageId`)

`dashboard` (label **Home**), `upload`, `register`, `packages`, `costtypes` (new), `reports`
(label **Actual cost**), `costreport`, `subcontractor`, `material`, then Advanced (`analysis`,
`pivot`, `queries`, `schema`, `lineage`) and `settings`. Pages that link to another step take an
`onNavigate(page: PageId-subset)` prop; `App.tsx` passes `setPage`.

## Screens

- **Sidebar**: Home on top; groups headed `1 · Input`, `2 · Coding`, `3 · Reports`; Advanced
  (collapsible, as today) and Settings below.
- **Top bar**: page title/subtitle, project picker, and a **cut-off control**: an accent-bordered
  pill "Cut-off 31 Mar 2026" with a calendar icon; click opens a native date input; a small "×"
  clears it (all data). Under the pill, faint: "latest posting 31 Mar 2026 · N lines after
  cut-off" when N > 0. Changing it calls `api.cutoff.set`, then `touch()` so every page re-queries.
- **Home** (`Dashboard.tsx`): three step cards in a row (Input / Coding / Reports) with a status
  line, one figure, and a link button to that step; then the KPI row (Budget, Actual to cut-off,
  Actual in cut-off month, % of budget spent); then the existing S-curve, cost-by-type and
  heatmap charts; data-freshness table last.
- **Cost types** (new page, Coding step): the cost-type allocation table and cost-type manager
  moved out of Settings unchanged.
- **Upload**: after a successful post, a "Next: code the cost →" button to Work packages.
