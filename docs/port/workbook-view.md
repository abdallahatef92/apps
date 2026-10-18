> **Superseded** by `docs/port/native-report.md` (2026-10-11): the Excel-clone view was removed.

# Workbook view: the Subcontractor and Material pages render the Excel report itself

User decision (2026-10-10): both pages are **redesigned as the Excel workbook** — the same sheets, in
the same order, built by the **same engine** as the ⤓ Excel export (`subcontractReport.ts` +
`subcontractWorkbookV26.ts`, `materialReport.ts` + `materialWorkbook.ts`). The figures therefore match
the exported file by construction. This is a deliberate, documented exception to "aggregation belongs
in SQL" for these two pages: the engine is a port of the tools' own writers, already the export's
source of truth.

## Pipeline (main process)

1. `buildSubcontractWorkbook(projectKey)` / `buildMaterialWorkbook(projectKey)` return the ExcelJS
   `Workbook` *before* `writeBuffer()` (refactor the adapters so export and view share it; export =
   that workbook → `writeBuffer()` → `fixSheetPrOrder()`).
2. **Formula evaluation:** many formula cells carry a cached `result`, but ~30–50% do not (INDEX/MATCH
   lookups into Coding, SUBTOTAL/SUMIFS totals, COUNTIFS…). Evaluate every formula cell whose result
   is missing with a formula engine (licence must be MIT/Apache/BSD — the app is UNLICENSED/internal;
   do not take GPL code), resolving defined names (`CutDate`, `RepKey`, `D_*`), cross-sheet refs,
   whole-column refs, and the functions the writers use: SUMIFS, COUNTIFS, COUNTIF, SUBTOTAL(9/…),
   INDEX, MATCH, IF, IFERROR, AND, OR, NOT, ISNUMBER, N, ABS, ROUND, MIN, MAX, TEXT, INT, MOD, ROW,
   COUNTA, DATE pieces as used. A cell that cannot be evaluated keeps an empty value and is counted.
3. **Serialise** to the view model below. Number/date formatting uses the cell's `numFmt` with an
   SSF-compatible formatter (e.g. the MIT `ssf` package) so the text matches what Excel shows.
4. IPC: `sc:workbookView(projectKey)` and `material:workbookView(projectKey)` → `Result<WorkbookView>`;
   preload bridge `api.sc.workbookView`, `api.material.workbookView`. Rebuild on every call (the page
   calls it on `[projectKey, dataVersion]`, and a cut-off change bumps `dataVersion`).

## View model (shared contract — `src/shared/types.ts`)

```ts
export interface WbStyle {            // only what is set; renderer maps to inline CSS
  bg?: string; fg?: string;           // '#RRGGBB'
  bold?: boolean; italic?: boolean; size?: number; underline?: boolean;
  align?: 'left' | 'center' | 'right'; valign?: 'top' | 'middle' | 'bottom'; wrap?: boolean; indent?: number;
  border?: { t?: string; r?: string; b?: string; l?: string };   // CSS border shorthand e.g. '1px solid #BFBFBF'
}
export interface WbCell { c: number; t: string; v?: number | string | boolean | null; s?: number; f?: 1 }
//  c = 1-based column; t = display text (already number-formatted); v = raw value; s = index into styles; f = formula cell
export interface WbRow { r: number; h?: number; hidden?: 1; lvl?: number; cells: WbCell[] }
export interface WbCol { c: number; w?: number; hidden?: 1; lvl?: number }   // w in Excel character units
export interface WbSheet {
  name: string; hidden?: 1; tab?: string;            // tab colour '#RRGGBB'
  cols: WbCol[]; rows: WbRow[];                      // rows sparse, ascending
  merges: string[];                                  // 'A1:C1'
  frozen?: { cols: number; rows: number };
  maxCol: number; maxRow: number;
  summaryBelow?: boolean; summaryRight?: boolean;    // outline: where the group's summary row/col sits
  unevaluated?: number;                              // formula cells left empty
  showGrid?: 0 | 1;                                  // 0 when the sheet turns gridlines off (views[0].showGridLines)
}
export interface WorkbookView { title: string; fileName: string; sheets: WbSheet[]; styles: WbStyle[]; generatedAt: string }
```
Hidden sheets (`_Codes`, `_Meta`, `_Cal`, `_Ref`) are included with `hidden: 1`; the renderer does
not show them as tabs. Theme colours / tints in ExcelJS styles are resolved to hex in main.

What main fills in (`src/main/services/workbookView.ts`, evaluator `formulaEngine.ts`):
- `v` is left out when it is text equal to `t`; a date's `v` is its Excel serial number; a formula
  cell left unevaluated has `v: null` and `t: ''`.
- A number format's section colour (`[Red]` on negatives) is folded into the cell's style as `fg`.
- Alignment is only set when the cell sets it; Excel's General alignment (numbers right, text left)
  is the renderer's default.
- An empty cell is sent only when it has a fill or a border. `showGrid` is sent only as `0`.
- Conditional formats and data validation are not carried.
- Every formula is evaluated (as Excel does on open, `fullCalcOnLoad`); a formula the evaluator
  cannot handle falls back to the writer's cached result, else it is left empty and counted. The
  writers' cached results are rounded and in a few places blank (PO Register / PO per Month code
  look-ups), so they are not shown as-is (`recalc: 'missing'` keeps them).

## Renderer

- `src/renderer/src/components/WorkbookView.tsx`: one sheet at a time on a white "paper" surface
  (the report's own colours — the one place literal workbook colours appear, since they are data
  from the report, not app chrome), a column-letter header and row-number gutter like Excel, cell
  sizes from widths/heights (Excel char width ≈ 7px, row height pt × 4/3), merges via colSpan/rowSpan,
  frozen rows/cols via `position: sticky`, outline groups collapsible with ± buttons in a left/top
  gutter (levels from `lvl`, summary position from `summaryBelow/Right`), hidden rows/cols skipped,
  text clipped per cell like Excel (wrap only when `wrap`). Bottom tab strip like Excel with tab
  colours; scrolling inside the grid only (page does not scroll sideways). Large sheets (Data ~1,000+
  rows × 40+ cols) must stay responsive: render rows virtualised or windowed.
- Pages `SubcontractorAnalysis.tsx` and `MaterialAnalysis.tsx` become: slim toolbar (title, report
  month / cut-off, "⤓ Excel report", unevaluated-cell warning if any) + `<WorkbookView>`. The old
  KPI/card/chart/tab content is removed (queries stay in the library for Analysis/other uses).
  Material page with no MB51 keeps a banner and the CJI3 fallback content as today.
