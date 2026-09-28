# Material Cost Report

A standalone, offline HTML tool. It is the materials companion to the Subcontract Cost Report.
Each month you load three SAP exports, plus last month's report:

| Export | What it answers | Key |
|---|---|---|
| **ME2N** | What was ordered, from whom, at what price, and what is still open. It also gives each material its **material group** | PO + item |
| **MB51** | What physically moved, and where it went | material doc + year + item |
| **CJI3** | What the project paid. Only goods issues are counted (document type **WA**) | CO doc + posting row + year |

From these the page builds the Excel report: Dashboard, **Material Monthly**, Package Monthly, Materials, Price, Material Coding, Changes, Checks and Load history, plus the source sheets. Package codes are live lookups from *Material Coding*, and Material Monthly, Package Monthly and the Dashboard are live formulas. If you change a package code in Excel, the dashboard updates. Figures that never depend on coding (Material Quarterly amounts, the Materials sheet's cost) are written as values, each checked live against *Cost Detail*, so a long project stays fast in Excel.

## How the numbers are made

- **Cost is CJI3 WA only.** SAP subtotal rows (blank document number) are skipped. The detail is tied to the grand total printed in the file, and lines with other document types are listed in Checks rather than counted.
- **Every cost line is tied to one MB51 movement.** The match uses the reference document number, reference fiscal year and the *second* "Posting Row" column. That column is the material document item; the first one is the CO posting row.
  - On the DIST extracts, all 5,254 lines match.
  - Material, value, WBS and quantity agree on every one of them.
- **Movements are classified** (see `CLASSES` / `MVT` in `engine.js`, and the *Movement Rules* sheet):
  - 101/102/122 → received from vendor. If the text says transit, or the PO is a stock transport order (the ME2N supplier is a plant / storage location), they count as received from stores instead. Account-assigned and asset receipts are not stock.
  - Z52 → owner supplied.
  - 221/222 → issued to project.
  - Z21/Z22 → issued to subcontractors (recoverable).
  - 261/262 → issued to orders, which is outside project cost.
  - 551 → scrap.
  - 351/352 and 601/602 → transferred out.
  - 541/542 → subcontractor stock.
  - 309/311/7xx → adjustments.
  - Anything else → Other, and it is flagged.
- **Stock balance** is the signed sum of the stock classes. It is only as complete as the MB51 date range.
- **Price:**
  - PO unit price = net price ÷ price unit, from purchase lines that are not deleted.
  - Issue price = CJI3 cost ÷ quantity issued to the project and to subcontractors.
- **Coding** is one Package / MNL / Cost element per material, using the same catalogue as the subcontract report.
  - The material group suggests a package: M03… → DIV 03, M0302… → DIV 0302, M26… → DIV 26, SM/SP/CS/OS… → INDIRECT.
  - Suggestions count only once you accept them.
  - Codes are kept in the browser and written into the report's *Material Coding* sheet. Loading that report next month brings them back, together with load history and a *Changes* comparison.

## Report period and cut date

The rule has two parts:
- **The cut date is a posting date.** Lines posted on or before it are in the report, each in its posting month. Lines posted after it are **Pending** and counted in the next report.
- **Created on never moves a line.** It only highlights two kinds of line, on *Cost Detail* (Status column) and in the period box:
  - **Entered after cut date:** posted on or before the cut date, but entered in SAP after it. For example, 67 August lines were entered on 1 Sep.
  - **Added to a reported month:** posted in a month the last report already showed, but not among that report's lines, because it was entered later or backdated. The month changes by that amount. The check *Months already reported* confirms every change is explained by such lines, and turns red if a line the last report had is missing.

**In the tool.** After the files load, the period box shows the report month and the cut date, which defaults to the month end and can be changed. It then shows three numbers: in the report (with the highlighted part), and Pending.

**Why the whole Material Monthly block is re-pasted.** Months can change when lines are added to them. Re-pasting the whole block each month keeps the cost report right.

## Monthly exports: only what was entered since the last report

The report carries every CJI3 line and MB51 movement it has seen, in two hidden sheets (`_CJI3`, `_MB51`) that use SAP's own column names. So after the first report, SAP only has to export what was **entered** since. That includes back-dated lines of any age, because the filter is on the entry date, not the posting date.

| Export | Selection screen | Filter in the result list, before exporting |
|---|---|---|
| **CJI3**, first report | posting date from project start, to empty | none |
| **CJI3**, every month after | posting date from project start, to empty | **Created on ≥ the date printed on last month's Dashboard** |
| **MB51**, first report | posting date from project start, to empty | none |
| **MB51**, every month after | posting date from project start, to empty | **Entry Date ≥ the same date** |
| **ME2N** | no date filter | none |

**The filter date.** It is printed on the Dashboard ("NEXT MONTH'S EXPORT …"). It is **7 days before the newest Created on date in that report**, which is the day its export was taken.

**How the tool proves an export complete.** That week of overlap needs no typed number:
- Every carried line entered between the export's first entry date and the last report's newest line must be in the new export. All present means the selection is the same and nothing entered since was skipped.
- If any are missing, the selection differs. The build is blocked and the lines are listed in Checks.
- If the export has no overlap at all (the filter started after the last report's newest line), the build is blocked and the tool gives the date to filter from.
- An unfiltered, full export always passes.

**Merging.** Carried and new lines are merged on SAP's line key: CO document + posting row + year, and material document + item + year for MB51. A line in both counts once, and the export's version wins.

**Tested on DIST.** September built from a Created-on-filtered export (788 CJI3 lines instead of 5,316) plus the August report equals September from the full export, every row and every month. A test line posted 10-Mar and entered 20-Sep is counted in March and highlighted as *Added to a reported month*.

## Material Monthly

This is the main sheet, and the block you copy into your cost report each month with Paste Special → Values. It is one flat table: one header row, no merged cells, and no header or blank rows between the data.

**Column layout, shared with Service Monthly from Rev08:**

`Identity (11)` → `Opening (3)` → `month 1 … n (Qty / Rate / Amount)` → `Total (4)` → `Pending (3, not in Total)` → hidden reference

- The identity columns are Row ID (hidden), CSI, MNL, Cost element, Material, Description, Material group, Last vendor code, Last vendor name, Line type and Unit.
- Opening sits in columns L–N, so the first month is always in column O.
- Each month's Qty and Rate fold under the **+** above its Amount.

**Rows** are one per material × line type:
- Project (221/222)
- To subcontractors (Z21/Z22, recoverable)
- Scrap (551)

Rows are sorted CSI → group → material → line type on every build. Each keeps a permanent Row ID (hidden `_Rows` sheet).

**Formulas.**
- CSI, MNL and Cost element are live lookups from *Material Coding*. Re-coding changes the row where it stands; nothing needs regrouping.
- Qty and Amount are SUMIFS on *Cost Detail* by Row ID and **Report bucket**.
- The TOTAL row (follows the filter) and a tie-out check against CJI3 cost posted up to the cut date sit above the header.

**Material Quarterly** has the same rows and identity columns as Material Monthly, with one Qty / Rate / Amount block per **calendar quarter** (Q1 = Jan–Mar), then Total and Pending. A 3-year project has 12 quarter blocks (36 columns) instead of 36 month blocks (108 columns). The current quarter holds the months reported so far. Qty and Amount are written as values, because a row's amount never changes when it is re-coded; CSI / MNL / Cost element stay live. Row 2 re-adds every quarter (and Pending) live from Cost Detail's *Report quarter* column and shows ✔ or the difference, and the Dashboard checks that the total equals the cost. This keeps a 5-year report light: the ~25,000 SUMIFS it used to need were a quarter of Excel's recalculation work.

**Package Monthly** sums Material Monthly by CSI and month, so it is right whatever the row order.

**Monthly activity** (bottom of the Dashboard, linked from D4) counts each month's transactions as a reference for the project's size: CJI3 lines and material cost by posting month, MB51 movements and materials moved, lines *entered* each month (Created on / Entry Date – the size of that month's filtered export), and WA lines entered in a later month than they were posted. The report month and the months after it (Pending) are marked; the average covers the months up to the report month.

## Build and test

```bash
cd tools/material-report
npm install
npm test                  # fixture tests (assert the numbers)
MCR_REAL=/path/to/exports npm test   # also reconcile real ME2N / MB51 / CJI3 files
npm run build             # → dist/Material_Cost_Report_Rev02.html (≈1.9 MB, works offline)
```

`engine.js` is pure logic and runs in Node and in the page. `app.js` is the page. `style.css` is the Rev07 stylesheet plus a few additions. `build.mjs` inlines SheetJS, ExcelJS, Chart.js and JSZip from `node_modules` into one file.
