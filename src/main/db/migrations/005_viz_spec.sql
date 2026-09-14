-- =============================================================================
-- How an analysis should be drawn, stored beside the SQL that produces it.
--
-- Keeping the visualisation with the query means a report is one object: change
-- the grouping and the chart follows, and a user-written query can describe its
-- own chart without any code change. The renderer only reads the spec — it never
-- decides what to aggregate.
--
-- `headline_code` points at another stored query supplying the KPI row, so the
-- headline numbers are SQL like everything else rather than sums taken in the UI.
-- =============================================================================

ALTER TABLE query_library ADD COLUMN viz_json TEXT NOT NULL DEFAULT '{}';
