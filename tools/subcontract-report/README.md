# Subcontract Cost Report tool

A single offline HTML page. The user drops this month's SAP **ZSCPRG01** (certificates) and **ZSCSRV1**
(PO service lines), optionally last month's report and the work package master, picks the **report month**,
and downloads the Excel report. Nothing is uploaded; the libraries are embedded in the page.

| File | Role |
| --- | --- |
| `engine.js` | Reads the exports, classifies lines, builds the workbook (ExcelJS) and post-processes the XML (JSZip). Pure logic – runs in the page and in Node. |
| `coding_ui.js` | Work package coding page: views, period filter, bulk coding, list editor. |
| `page.html` | Page shell and on-screen overview. |
| `build_standalone.py` | Turns `page.html` + `engine.js` + `coding_ui.js` + the libraries into the one-file tool (list editor, Save tool, light/dark switch). |

## Report rules (Rev08)

- **Report month → cut date.** The user picks a month; the cut date is its last day, computed in UTC
  (never the PC's local time, so 31-Aug stays in August east of UTC).
- **The certificate Date decides the month.** A line dated after the cut date, or not approved, is **Pending**:
  shown in its own block, never in Total (Detail → *Pending reason*).
- **Include in this report** (Detail, drop-down on after-cut lines): picking *Include* takes the line out of Pending
  into its month. Service Monthly has a block for every month in the data – after-cut months are red and fill only with
  included lines – and Service Quarterly, Package Monthly, By Supplier and the Dashboard follow live.
- **Late lines** are flagged, never moved: *Added to a reported month* / *Approved after the month was reported*
  (Detail → *Reported-month flag*), from last month's report.
- **Service Monthly** and **Service Quarterly** are flat tables (no merged cells, no header or blank rows between data):
  row 1 TOTAL (SUBTOTAL), row 2 check against Detail (✔ or the difference), row 3 year, row 4 month / quarter,
  row 5 column names. Identity (11) → Opening → Qty / Rate / Amount per period → Total → Pending → reference columns.
  Service Monthly and Service Quarterly figures are live SUMIFS on Detail; row 2 re-adds every block from Detail.
  Package / MNL / Cost element / Unit are live lookups on Service Coding on both.
- **Per-service totals** (Service Coding → Total amount) are values; Dashboard → Final control checks them against Detail.
- **Package Monthly** sums Service Monthly by current package (live); the Dashboard reads it.
- **Invoice Matrix** (2nd tab): one cell pair (invoice no. + amount) per invoice – an invoice is PO + Invoice Serial, and all
  its lines share one date and one approval – by subcontractor / PO and month. Colours are conditional formats on Detail:
  red = not approved, grey = after the cut date and not picked as Include, green = in this report. Each rule has its own
  priority and red / grey stop the green one (Excel needs both). Under each month: all invoices, in this report,
  excluded, and ✔ checks against Detail and Service Monthly; below, the list of every excluded invoice with a live status.
- **Monthly activity** (Dashboard, page 2): lines, approved cost, not approved, late lines per month, and for months
  the last report showed, *change = late lines* ✔ or the unexplained amount.

## Build and test

```bash
npm install
npm run build                      # -> dist/Subcontract_Cost_Report.html
SUBCON_PROG=<zscprog01 traz.xlsx> SUBCON_SERV=<zscsrv1 traz.xlsx> npm test
python3 tests/recalc.py <report.xlsx>        # LibreOffice recalculation: every check cell and Notes reconciliation
python3 tests/ooxml_order.py <report.xlsx>   # element order Excel requires
```

The tests assert the TRAZ numbers (SAP grand total 73,923,142.32, pending and after-cut amounts, late lines)
under two time zones and, when LibreOffice is installed, recalculate the report and require every check cell ✔. Real SAP extracts and generated reports are never committed (`*.xlsx` is ignored).
