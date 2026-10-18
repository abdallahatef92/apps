-- =============================================================================
-- The live S/4HANA pull (migration 028) was removed from the app: the system's
-- journal entry API is not activated and the user chose CJI3 files only.
-- 028 already ran on existing databases, so it stays in the migration list and
-- this one takes its report definition out again. column_mapping and
-- build_step_report rows go with it (ON DELETE CASCADE). A definition that
-- somehow carries a batch is left in place rather than orphaning the batch.
-- =============================================================================

DELETE FROM report_definition
WHERE code = 'S4_JOURNAL_ITEMS'
  AND NOT EXISTS (SELECT 1 FROM import_batch b WHERE b.report_definition_id = report_definition.report_definition_id);
