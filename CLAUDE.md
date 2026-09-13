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
  don't query `fact_*` directly in a report — go through `v_actual` / `v_budget` /
  `v_forecast`.
- **Nothing reaches a fact table without passing through staging.** Read → map →
  validate into `stg_row` → post. The user must be able to see what will happen first.
- **The renderer has no Node and no database access.** Everything crosses via a channel
  in `src/main/ipc.ts` and the bridge in `src/preload/index.ts`.

## Changing the schema

Add a numbered file in `src/main/db/migrations/` and register it in the `MIGRATIONS`
array in `src/main/db/index.ts`. Never edit an applied migration — existing installations
have already run it.

System queries are the exception: they live in `src/main/db/systemQueries.ts` and are
upserted on every start, so fixing one is a normal code change. Queries with
`is_system = 0` belong to the user and must never be modified or deleted by the app.

## Adding a source report

Most new report shapes need no code — a `report_definition` row plus a saved column
mapping. Only add to `src/main/ingest/targetFields.ts` when a genuinely new canonical
field is required, and add the source's caption to that field's `synonyms` so the next
file auto-maps.

## Before you push

```bash
npm run typecheck && npm test && npm run build
```

`npm test` needs no display. Its fixtures live in `tests/makeFixtures.ts` — extend them
when you add parsing behaviour, and assert the resulting numbers, not just row counts.
