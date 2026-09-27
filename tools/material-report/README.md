# Material Cost Report

A standalone, offline HTML tool. It is the materials companion to the Subcontract Cost Report.
Each month you load three SAP exports, plus last month's report:

| Export | What it answers | Key |
|---|---|---|
| **ME2N** | What was ordered, from whom, at what price, and what is still open. It also gives each material its **material group** | PO + item |
| **MB51** | What physically moved, and where it went | material doc + year + item |
| **CJI3** | What the project paid. Only goods issues are counted (document type **WA**) | CO doc + posting row + year |

From these the page builds the Excel report: Dashboard, **Material Monthly**, Materials, Price, Material Coding, Changes, Checks and Load history, plus the source sheets. The summary sheets are live formulas over *Cost Detail* and *Material Coding*. If you change a package code in Excel, the dashboard updates.

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

## Material Monthly

This is the material counterpart of the subcontract report's *Service Monthly* sheet.

- **Rows:** one per material × line type:
  - **Project** (221/222)
  - **To subcontractors** (Z21/Z22, recoverable)
  - **Scrap** (551)
- **Grouping:** rows sit under a header per work package, in catalogue order with UNALLOCATED last. Inside a package they are sorted by material group, then material.
- **Columns:**
  - Package, MNL and Cost element, looked up live from *Material Coding*.
  - A Total block: weighted PO price, Qty, average rate, Amount.
  - Then Qty / Rate / Amount for each month. Every one of these is a SUMIFS on *Cost Detail* by Row ID, so the sheet always agrees with the detail.
- **Row IDs:** each row keeps a permanent Row ID from load to load, stored in the hidden `_Rows` sheet.
- **TOTAL row:** on top, using SUBTOTAL, so it follows the filter.
- **Re-coding:** a material re-coded in Excel turns yellow, and cell B1 counts such rows. The next build moves them under their new package.
- **Cross-check:** the Dashboard carries "Material Monthly total", which must equal the cost.

## Build and test

```bash
cd tools/material-report
npm install
npm test                  # fixture tests (assert the numbers)
MCR_REAL=/path/to/exports npm test   # also reconcile real ME2N / MB51 / CJI3 files
npm run build             # → dist/Material_Cost_Report_Rev01.html (≈1.9 MB, works offline)
```

`engine.js` is pure logic and runs in Node and in the page. `app.js` is the page. `style.css` is the Rev07 stylesheet plus a few additions. `build.mjs` inlines SheetJS, ExcelJS and Chart.js from `node_modules` into one file.
