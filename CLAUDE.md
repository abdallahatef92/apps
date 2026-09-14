# Working on this repository

Cost Intelligence — an Electron + React + SQLite desktop app for project cost control.
Read `README.md` first for the data model and the reasoning behind it.

## Non-negotiables

- **Aggregation belongs in SQL.** Sums, joins, grouping, variance and running totals are
  written as statements in `query_library`, not as TypeScript over an array. The UI
  renders result sets. If a page needs a new number, add or edit a query.
- **Every fact row carries an `import_batch_id`**, and every batch carries a `data_date`.
  A code path that writes a fact without a batch is a bug.
- **Reporting views read `POSTED` batches only.** That is what makes superseding work;
  don't query `fact_*` directly in a report — go through `v_actual` / `v_revenue` /
  `v_posting` / `v_budget` / `v_forecast` / `v_service_line`.
- **Cost and revenue are not the same number.** A CJI3 export carries income on
  4xxxxxxx accounts as negative amounts. `v_actual` is cost only; `v_revenue` is income
  as a positive; `v_posting` is both. Never write a "total actuals" query against
  `v_posting` — it silently nets billing off spend.
- **Service lines are never actual cost.** `fact_service_line` is the sub-ledger behind
  a purchase order whose money is already in `fact_actual`. Reconcile the two, never
  add them.
- **Detail Substitution is the general pattern, not a subcontractor special case.**
  `fact_service_line` carries nothing subcontractor-specific (po_no, vendor, description,
  quantities, amount) — a second PO-based detail report (equipment rental, materials
  reconciliation, whatever the next category is) loads into the same SERVICE module and
  joins into `UNIFIED_COST_REGISTER` with no new SQL, as long as it shares the PO key.
  `v_service_line.report_name` is what keeps two such sources distinguishable once both
  are loaded — never drop it when touching that view. A detail source with a different
  join key (not PO number) or a genuinely different shape needs its own fact table, on
  the same footing as `fact_service_line` — see "Adding a source report" below.
- **Cost type is resolved in the view, never baked into the dimension.** The mapping
  lives in `cost_type_rule` (ordered, matching cost element and/or document type by
  `GLOB`, first match wins) and `v_posting` applies it per posting row — because
  `document_type` is on the fact, not on `dim_cost_element`, and because a rule change
  must correct cost already loaded. `dim_cost_element.cost_type` holds only what a source
  file explicitly stated, which still outranks a rule; never write an inferred value
  there, and never re-introduce account ranges in `importer.ts`. Adding a seventh cost
  type is a migration — the six are a CHECK constraint on two tables.
- **Source reports interleave subtotal rows.** Anything that reads a spreadsheet must
  respect `report_definition.detail_key_fields`; rows with those fields blank are
  SKIPPED, and only rows with `stg_row.status = 'VALID'` may post.
- **A posting line owns its identity.** `NATURAL_KEY` in `importer.ts` names the fields
  that identify a row (for a CO line item: document number + posting row + fiscal year,
  which is SAP's BELNR + BUZEI + GJAHR). It is stored as `line_uid`, unique per project,
  and posting upserts on it, so extracts that overlap — a report split by month, or
  re-run over a wider period — merge instead of accumulating. Never dedupe by file, by
  period, or by batch when the rows carry a key.
- **Never trust a key that repeats.** If `line_uid` collides inside one file, the key
  does not identify a line and using it would silently drop real rows. `postBatch` falls
  back to plain inserts plus batch superseding, and the import screen says so.
- **Batch superseding is the fallback only.** It runs when a source has no usable line
  identity. It is scoped by the projects the facts actually landed on, never by
  `import_batch.project_key` — that is a wizard hint and differs between two uploads of
  the same file.
- **Nothing reaches a fact table without passing through staging.** Read → map →
  validate into `stg_row` → post. The user must be able to see what will happen first.
- **The renderer has no Node and no database access.** Everything crosses via a channel
  in `src/main/ipc.ts` and the bridge in `src/preload/index.ts`.

## Charts

Chart colours come from the validated palette in `styles.css`: eight categorical
slots assigned in fixed order and never cycled, one sequential blue ramp for
magnitude, a blue↔red diverging pair with a neutral midpoint for signed variance,
and a reserved status set that must never double as a series. Before changing any
of them, re-run the dataviz validator against `--surface #121822`.

Never use a dual axis, never colour by rank (a filter must not repaint the
survivors), and never let a null read as zero — an element with no budget is
neutral on a diverging scale, not an overrun the size of its spend.

How an analysis is drawn lives in `query_library.viz_json` beside its SQL, so a
report is one object and a user-written query can describe its own chart. Headline
KPIs come from a separate stored query named by `viz.headline` — never from summing
the result table in the UI.

## Changing the schema

Add a numbered file in `src/main/db/migrations/` and register it in the `MIGRATIONS`
array in `src/main/db/index.ts`. Never edit an applied migration — existing installations
have already run it.

System queries are the exception: they live in `src/main/db/systemQueries.ts` and are
upserted on every start, so fixing one is a normal code change. Queries with
`is_system = 0` belong to the user and must never be modified or deleted by the app.

## Adding a Detail Substitution source

Before writing anything, check whether the new report is PO-based with the usual
shape (a purchase order, a vendor, a description, an amount) — if so it is not a new
report *kind*, it is another instance of `SERVICE`: map it via a new `report_definition`
row and a column mapping, same as any upload, and it joins into
`UNIFIED_COST_REGISTER` automatically. Confirm with `DETAIL_SOURCES` that it shows up
as its own row.

Only build a new fact table when the join key genuinely is not a PO number, or the
shape has no sensible mapping onto `fact_service_line`'s columns. In that case: a new
fact table alongside `fact_service_line`, a view exposing `report_name` the same way,
and a second CTE in `UNIFIED_COST_REGISTER` keyed on the new field — the "PO with
detail" exclusion in `direct_cost` needs to check the new key too, or a posting could
be excluded from actuals without anything replacing it.

An internal order settling into a WBS is one such non-PO case: CJI3 names the
receiver directly on the posting via `partner_object_type` ("Order") and
`partner_object` (the order number) — captured on `fact_actual` / exposed on
`v_actual` since migration 008, and queryable today via `ORDER_SETTLEMENTS`. That
migration only captures the identity; it does not exclude these postings from
`v_actual`, because there is no order-level detail report loaded yet to substitute
in for them. When one is loaded, key its new CTE on `partner_object` (not `po_no`)
and extend the `direct_cost` exclusion in `UNIFIED_COST_REGISTER` to also drop a
row when `partner_object_type = 'Order'` and its `partner_object` has detail —
mirroring the PO exclusion exactly, just on a different column.

## Adding a source report

Most new report shapes need no code — a `report_definition` row (including its
`detail_key_fields`) plus a saved column mapping. Only add to
`src/main/ingest/targetFields.ts` when a genuinely new canonical field is required, and
add the source's caption to that field's `synonyms` so the next file auto-maps.

Synonym order is significant: the first synonym that matches a column wins, which is how
`wbs_code` prefers "WBS Element" over the vaguer "Object". Avoid short generic synonyms
("type", "name") — they get claimed by unrelated SAP columns and quietly mis-map a whole
file.

Modules are rows in `module_type`, not a CHECK constraint, so a new module needs a seed
row and a branch in `postBatch` — no table rebuild.

## Before you push

```bash
npm run typecheck && npm test && npm run build
```

`npm test` needs no display. Its fixtures live in `tests/makeFixtures.ts` — extend them
when you add parsing behaviour, and assert the resulting numbers, not just row counts.
The SAP-shaped fixtures reproduce the real traps (subtotal rows, income postings, the
Title/Description swap, the PO sub-ledger); keep them that way.

`npm run load:real -- <db> <cji3> <subcontractor> <wbs-tree>` loads genuine extracts and
prints the reconciliation. The files are not in the repo, so this is a manual check.
