# Native report pages (supersedes docs/port/workbook-view.md)

User decision (2026-10-11): the Subcontractor and Material pages must **reflect the workbook's reports**,
sheet by sheet, but **as a native app** — SQL for the numbers, React tables and charts, the app's own
theme and components, interactive (filter, sort, group, drill down) — **not** a pixel copy of Excel.
Tabs sit **at the top**. The ⤓ Excel report export is unchanged.

So the Excel-clone path is removed: `WorkbookView.tsx` (+ `.wb*` styles), `sc:workbookView` /
`material:workbookView`, `workbookView.ts`, `formulaEngine.ts`, the `Wb*` types, the `ssf` dependency
(unless the export uses it), their e2e checks and the CLAUDE.md "Workbook view" section.
`buildSubcontractWorkbook` / `buildMaterialWorkbook` stay (the export uses them).

## Page shape (both pages)

1. Header strip: `<KpiStrip>` from `SC_REPORT_KPI` / `MAT_KPI` (Previous, This month, To date, Pending,
   counts) + a one-line hint "This month = <Mon YYYY> — the cut-off month" + "⤓ Excel report".
2. **Filter bar** (one row, above the tabs, applies to every tab): free-text search, and the report's
   main dimensions as selects — SC: Type of works, Subcontractor, DIV (work package), Month;
   Material: Family, Division, Package, Month. Values come from small stored queries. Every tab query
   takes the same optional params (`:tow`, `:vendor`, `:pkg`, `:month`, `:q` / `:family`, `:division`,
   `:pkg`, `:month`, `:q`) written as `(:p IS NULL OR col = :p)`, so filtering is SQL, not array code.
   A "Clear" button; the active filters show as removable chips.
3. **`<SheetTabs>` at the top**, one tab per workbook sheet that carries a report (below). Content is
   fetched per tab when first opened and re-fetched when filters, project or `dataVersion` change.
4. Inside a tab: the sheet's sections as cards. Tables are `<DataTable>` (sort, search, group-by,
   column picker, subtotals, sticky first column, `signColumns`, `flagColumn`), with the sheet's own
   grouping as the default group-by where the workbook groups (e.g. Service Summary by Type of works).
   Month-by-column sheets use long-format SQL rows + the existing `Pivot` component (rows × months,
   totals), not hand-built tables. Charts only where they add something (Summary cost per month as a
   stacked column; Invoices register as the existing Heatmap). Colours via tokens only.
5. **Drill-down**: clicking a row in a summary table (a service, a PO line, a subcontractor, a
   material) opens a detail panel below the table with the underlying lines (the Data tab's query
   filtered to that key) — the thing a static workbook cannot do.

## Tabs ↔ workbook sheets

Read each sheet's real columns/sections from the reference files before building:
SC — `C:\Users\abdallah.atef\Desktop\ELAN_SC_Report_2026-08.xlsx` (real data) and the app's own export;
Material — `C:\Users\ABDALL~1.ATE\AppData\Local\Temp\claude\C--Users-abdallah-atef-apps\d1fd1d5b-5eea-4759-9dbb-715b6c371a31\scratchpad\mat_sample.xlsx`.
Mirror the sheet's columns and figures (same rules as the export — the e2e ties totals to the KPI
query); leave out Excel-only mechanics (drop-downs, hidden helper sheets, "type here" cells).

| SC tab | From sheet | Content |
|---|---|---|
| Summary | Summary | cost per month (chart + table), cost by DIV, by Type of works, SAP-total → report reconciliation |
| Coding | Coding | coding status per service (DIV/PKG/MNL/Cost element, status, qty/rate/to date), coded meter, "Code in Work packages →" |
| Services | Service Summary | per service: previous / this month / to date (qty, rate, amount), pending, rate analysis; grouped by Type of works |
| Services by month | Service per Month | service × month (Pivot) qty/amount toggle |
| PO register | PO Register | per PO line: contract qty, certified to date, % used, rates, status flags |
| PO by month | PO per Month | PO line × month (Pivot) |
| Subcontractors | Subcontractor Summary | per subcontractor: certificates, previous / this month / to date, pending, main Type of works |
| Invoices register | Invoices Register | subcontractor × month heatmap, amount / certificates toggle |
| Checks | Checks | checks list, click → rows |
| Changes | Changes | changes since last load |
| Lines | Data | every certificate line (v_service_line), all filters, bucket / pending reason |

| Material tab | From sheet | Content |
|---|---|---|
| Summary | Summary | cost per month by issue type (chart + table), cost by family / division / package |
| Coding | Coding | coding status per material, coded meter by family › division, "Code in Work packages →" |
| Materials | Material Summary | per material: previous / this month / to date (qty, rate, amount), pending, rate vs PO price; grouped by family › division |
| Materials by month | Material per Month | material × month (Pivot) |
| PO register | PO Register | ME2N lines: ordered / delivered / open, prices, status |
| Stores transfers | Stores Transfers | STO lines |
| Checks | Checks | MAT_CHECKS, click → rows |
| Lines | Data | every counted issue line (v_material_issue), all filters |

The workbook's Notes become the existing collapsible "How the figures are calculated" card at the
bottom of the page. Lists/_Codes/_Meta/_Cal/_Ref are not tabs.
Material pages for a project without MB51 keep the CJI3 fallback as today.
