-- =============================================================================
-- Identity for a posting line.
--
-- Replacing a whole batch cannot express how these reports are actually used: an
-- extract is often split by month, and re-running one with a different posting
-- period produces a file that overlaps the previous one without replacing it.
-- Wholesale replacement either loses the months it did not cover, or duplicates
-- the ones it did.
--
-- A line already has an identity in SAP, so use it. A CO line item is keyed by
-- document number + posting row + fiscal year (BELNR + BUZEI + GJAHR), and a
-- subcontractor service line by PO + invoice + item + line. Storing that as
-- line_uid, unique per project, makes re-import an upsert: the same line lands
-- once however many times it arrives, and overlapping extracts merge instead of
-- accumulating.
--
-- line_uid is nullable, and SQLite treats NULLs in a unique index as distinct,
-- so a source with no usable key still imports — it simply gets no protection,
-- which the import screen says out loud.
-- =============================================================================

DROP VIEW IF EXISTS v_revenue;
DROP VIEW IF EXISTS v_actual;
DROP VIEW IF EXISTS v_posting;

ALTER TABLE fact_actual ADD COLUMN line_uid TEXT;
ALTER TABLE fact_actual ADD COLUMN fiscal_year TEXT;
CREATE UNIQUE INDEX ux_actual_line_uid ON fact_actual(line_uid);

ALTER TABLE fact_service_line ADD COLUMN line_uid TEXT;
CREATE UNIQUE INDEX ux_service_line_uid ON fact_service_line(line_uid);

CREATE VIEW v_posting AS
SELECT
  f.actual_id, f.import_batch_id, f.line_uid, b.data_date, b.report_definition_id,
  p.project_key, p.project_code, p.project_name,
  w.wbs_key, w.wbs_code, w.wbs_name, w.wbs_path, w.wbs_level,
  w.discipline, w.package, w.control_account,
  ce.cost_element_key, ce.cost_element_code, ce.cost_element_name,
  ce.cost_type, COALESCE(ce.posting_nature,'COST') AS posting_nature,
  v.vendor_key, v.vendor_code, v.vendor_name,
  cur.iso_code AS currency_code,
  f.period_key, f.fiscal_year, d.year_no, d.month_no,
  f.document_no, f.document_line, f.document_type, f.reference_no, f.po_no, f.description,
  f.quantity, f.uom, f.amount
FROM fact_actual f
JOIN import_batch b   ON b.import_batch_id = f.import_batch_id
JOIN dim_project p    ON p.project_key = f.project_key
LEFT JOIN dim_wbs w   ON w.wbs_key = f.wbs_key
LEFT JOIN dim_cost_element ce ON ce.cost_element_key = f.cost_element_key
LEFT JOIN dim_vendor v ON v.vendor_key = f.vendor_key
LEFT JOIN dim_currency cur ON cur.currency_key = f.currency_key
LEFT JOIN dim_period d ON d.period_key = f.period_key
WHERE b.status = 'POSTED';

CREATE VIEW v_actual AS
SELECT * FROM v_posting WHERE posting_nature = 'COST';

CREATE VIEW v_revenue AS
SELECT
  actual_id, import_batch_id, data_date, project_key, project_code, project_name,
  wbs_key, wbs_code, wbs_name, wbs_path,
  cost_element_key, cost_element_code, cost_element_name,
  period_key, year_no, month_no, document_no, document_type, description,
  -amount AS amount
FROM v_posting WHERE posting_nature = 'REVENUE';
