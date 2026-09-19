-- =============================================================================
-- Accrual cost: cost incurred but not yet posted in SAP (a manual estimate —
-- "ADD/OMM", "Provision" in the source workflow this app is modeled on).
--
-- This is a new module and its own fact table, not a repurposing of
-- fact_actual.is_accrual (a column that already exists on fact_actual but is
-- never set, never selected by any view, and never queried — dead weight
-- from an earlier, unfinished idea, left alone here rather than wired up,
-- since fact_actual is fed by posted SAP extracts and an accrual is by
-- definition not one). Unlike budget/forecast, an accrual carries no
-- scenario — it is one running set of estimates, not multiple named
-- versions — but it still goes through staging/posting like every other
-- module, per the non-negotiable that nothing reaches a fact table without
-- passing through staging: an accrual is a manual estimate, but it is still
-- a batch with a data date, an audit trail, and the ability to supersede a
-- prior estimate.
-- =============================================================================

INSERT INTO module_type (code, name, description, sort_order) VALUES
  ('ACCRUAL', 'Accrual', 'Cost incurred but not yet posted in SAP — a manual estimate', 65);

CREATE TABLE fact_accrual (
  accrual_id       INTEGER PRIMARY KEY,
  import_batch_id  INTEGER NOT NULL REFERENCES import_batch(import_batch_id) ON DELETE CASCADE,
  project_key      INTEGER NOT NULL REFERENCES dim_project(project_key),
  wbs_key          INTEGER REFERENCES dim_wbs(wbs_key),
  cost_element_key INTEGER REFERENCES dim_cost_element(cost_element_key),
  currency_key     INTEGER REFERENCES dim_currency(currency_key),
  period_key       TEXT REFERENCES dim_period(period_key),
  accrual_type     TEXT,  -- free text, e.g. "ADD/OMM", "Provision" — not a fixed taxonomy
  amount           REAL NOT NULL DEFAULT 0,
  description      TEXT,
  source_row_no    INTEGER
);
CREATE INDEX ix_accrual_batch ON fact_accrual(import_batch_id);
CREATE INDEX ix_accrual_scope ON fact_accrual(project_key, period_key);
CREATE INDEX ix_accrual_wbs ON fact_accrual(wbs_key);

CREATE VIEW v_accrual AS
SELECT
  f.accrual_id, f.import_batch_id, b.data_date,
  p.project_key, p.project_code, p.project_name,
  w.wbs_key, w.wbs_code, w.wbs_name, w.wbs_path, w.discipline, w.package,
  ce.cost_element_key, ce.cost_element_code, ce.cost_element_name, ce.cost_type,
  COALESCE(
    (SELECT m.work_package FROM cost_element_work_package m
      WHERE m.cost_element_code = ce.cost_element_code),
    CASE WHEN ce.cost_type <> 'MATERIAL' THEN 'INDIRECT' ELSE NULL END) AS work_package,
  f.period_key, f.accrual_type, f.amount, f.description
FROM fact_accrual f
JOIN import_batch b ON b.import_batch_id = f.import_batch_id
JOIN dim_project p  ON p.project_key = f.project_key
LEFT JOIN dim_wbs w ON w.wbs_key = f.wbs_key
LEFT JOIN dim_cost_element ce ON ce.cost_element_key = f.cost_element_key
WHERE b.status = 'POSTED';

INSERT INTO report_definition
  (report_definition_id, source_system_id, code, name, module, description, expected_frequency, staleness_days) VALUES
  (10,3,'ACCRUAL_WORKBOOK','Accrual workbook','ACCRUAL',
   'Manual estimate of cost incurred but not yet posted in SAP (ADD/OMM, provisions).','MONTHLY',35);
