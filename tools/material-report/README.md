# Material Cost Report

A standalone, offline HTML tool. It is the materials companion to the Subcontract Cost Report.
Each month you load three SAP exports, plus last month's report:

| Export | What it answers | Key |
|---|---|---|
| **ME2N** | What was ordered, from whom, at what price, and what is still open. It also gives each material its **material group** | PO + item |
| **MB51** | What physically moved, and where it went | material doc + year + item |
| **CJI3** | What the project paid. Only goods issues are counted (document type **WA**) | CO doc + posting row + year |

From these the page builds the Excel report: Dashboard, **Material Monthly**, Package Monthly, Materials, Price, Material Coding, Changes, Checks and Load history, plus the source sheets. The summary sheets are live formulas over *Cost Detail* and *Material Coding*. If you change a package code in Excel, the dashboard updates.

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

## Report period and cut-off

After the three files load, the page asks for the **report month** and a **cut-off date and time**. Build stays disabled until both are set.

**Which timestamp counts.** The cut-off is compared with the moment SAP *entered* each line: CJI3 "Created on" + "Time of Entry", or MB51 "Entry Date" + "Time of Entry". SAP stamps these when the document is saved, and they cannot be backdated the way a posting date can.
- A cost line takes the stamp of its MB51 movement. The two are one save, at most a second apart, so quantity and cost always fall on the same side of the cut-off.
- On the DIST extract, 781 lines (14.6M) were entered in a later month than they were posted. This is why the posting date alone isn't enough.

**How a line is placed.**
- A line belongs to the first report whose cut-off it was entered before and whose report month has reached its posting month.
- Within that report it goes to its posting month if that month was still open. If an earlier report had already closed that month, it goes to the report month and is flagged as a **late posting**.
- A line entered after the current cut-off, or posted after the report month, is **Pending**. It is shown but not counted, and belongs to the next report.

**Closed months stay closed.** Each report stores its report month and cut-off in *Load history*. Next month's report reads them back, so every month already reported comes out exactly as it was, and a Checks item proves it. Re-building a month that was already reported replaces that report and leaves earlier months alone.

**Opening roll-up.** *Roll into Opening* sums all months before a chosen month into the Opening block, so the sheet does not grow forever.

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
- The TOTAL row (follows the filter) and a tie-out check against CJI3 cost to the cut-off sit above the header.

**Package Monthly** sums Material Monthly by CSI and month, so it is right whatever the row order.

## Build and test

```bash
cd tools/material-report
npm install
npm test                  # fixture tests (assert the numbers)
MCR_REAL=/path/to/exports npm test   # also reconcile real ME2N / MB51 / CJI3 files
npm run build             # → dist/Material_Cost_Report_Rev02.html (≈1.9 MB, works offline)
```

`engine.js` is pure logic and runs in Node and in the page. `app.js` is the page. `style.css` is the Rev07 stylesheet plus a few additions. `build.mjs` inlines SheetJS, ExcelJS, Chart.js and JSZip from `node_modules` into one file.
