-- =============================================================================
-- What the real SAP extracts taught us.
--
-- 1. A CJI3 export is not only cost. Income cost elements (4xxxxxxx) are posted
--    to the same project as negative amounts, so "sum the file" is revenue-netted
--    cost, not actual cost. Postings are now classified and the reporting views
--    separate the two.
-- 2. A subcontractor report is a sub-ledger of postings already in CJI3 — the
--    service lines behind each PO. It gets its own fact table, never fact_actual,
--    because adding it to actuals double-counts.
-- 3. New modules should not need a schema migration, so the module CHECK
--    constraints become a lookup table.
--
-- This migration rebuilds report_definition and import_batch, so it manages its
-- own transaction (see MIGRATIONS in src/main/db/index.ts).
-- =============================================================================

PRAGMA foreign_keys = OFF;

BEGIN;

-- Views must go before the table rebuilds: ALTER TABLE ... RENAME re-parses every
-- view, and a view referencing a table that is mid-rebuild cannot be parsed.
DROP VIEW IF EXISTS v_actual;
DROP VIEW IF EXISTS v_budget;
DROP VIEW IF EXISTS v_forecast;
DROP VIEW IF EXISTS v_data_freshness;

-- ---------------------------------------------------------------------------
-- Modules as data rather than a CHECK constraint
-- ---------------------------------------------------------------------------
CREATE TABLE module_type (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

INSERT INTO module_type (code, name, description, sort_order) VALUES
  ('ACTUAL','Actuals','Posted actual cost from SAP',1),
  ('BUDGET','Budget','Approved budget by WBS and cost element',2),
  ('FORECAST','Forecast','ETC / EAC by WBS and period',3),
  ('COMMITMENT','Commitments','Purchase orders not yet actualised',4),
  ('SERVICE','Service lines','Subcontractor service-line detail beneath a PO',5),
  ('MASTER','Master data','WBS structure and other dimension loads',6);

-- ---------------------------------------------------------------------------
-- report_definition — module becomes a foreign key
-- ---------------------------------------------------------------------------
CREATE TABLE report_definition_new (
  report_definition_id INTEGER PRIMARY KEY,
  source_system_id     INTEGER NOT NULL REFERENCES source_system(source_system_id),
  code                 TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL,
  module               TEXT NOT NULL REFERENCES module_type(code),
  description          TEXT,
  expected_frequency   TEXT CHECK (expected_frequency IN ('DAILY','WEEKLY','MONTHLY','QUARTERLY','ADHOC')),
  staleness_days       INTEGER NOT NULL DEFAULT 35,
  -- JSON array of canonical fields that must be non-empty for a row to be real
  -- data. SAP exports interleave subtotal rows, which leave these blank.
  detail_key_fields    TEXT NOT NULL DEFAULT '[]',
  is_active            INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO report_definition_new
  (report_definition_id, source_system_id, code, name, module, description,
   expected_frequency, staleness_days, is_active, created_at)
  SELECT report_definition_id, source_system_id, code, name, module, description,
         expected_frequency, staleness_days, is_active, created_at
  FROM report_definition;
DROP TABLE report_definition;
ALTER TABLE report_definition_new RENAME TO report_definition;

-- ---------------------------------------------------------------------------
-- import_batch — same, plus a count of rows deliberately skipped (subtotals)
-- ---------------------------------------------------------------------------
CREATE TABLE import_batch_new (
  import_batch_id      INTEGER PRIMARY KEY,
  report_definition_id INTEGER NOT NULL REFERENCES report_definition(report_definition_id),
  module               TEXT NOT NULL REFERENCES module_type(code),
  data_date            TEXT NOT NULL,
  period_key           TEXT,
  project_key          INTEGER REFERENCES dim_project(project_key),
  file_name            TEXT NOT NULL,
  file_path            TEXT,
  file_hash            TEXT,
  file_size            INTEGER,
  sheet_name           TEXT,
  status               TEXT NOT NULL DEFAULT 'STAGED'
                       CHECK (status IN ('STAGED','MAPPED','POSTED','SUPERSEDED','REJECTED')),
  row_count_file       INTEGER NOT NULL DEFAULT 0,
  row_count_posted     INTEGER NOT NULL DEFAULT 0,
  row_count_rejected   INTEGER NOT NULL DEFAULT 0,
  row_count_skipped    INTEGER NOT NULL DEFAULT 0,
  amount_total         REAL,
  imported_at          TEXT NOT NULL DEFAULT (datetime('now')),
  imported_by          TEXT,
  posted_at            TEXT,
  superseded_by        INTEGER REFERENCES import_batch(import_batch_id),
  notes                TEXT
);
INSERT INTO import_batch_new
  (import_batch_id, report_definition_id, module, data_date, period_key, project_key,
   file_name, file_path, file_hash, file_size, sheet_name, status, row_count_file,
   row_count_posted, row_count_rejected, amount_total, imported_at, imported_by,
   posted_at, superseded_by, notes)
  SELECT import_batch_id, report_definition_id, module, data_date, period_key, project_key,
         file_name, file_path, file_hash, file_size, sheet_name, status, row_count_file,
         row_count_posted, row_count_rejected, amount_total, imported_at, imported_by,
         posted_at, superseded_by, notes
  FROM import_batch;
DROP TABLE import_batch;
ALTER TABLE import_batch_new RENAME TO import_batch;

CREATE INDEX ix_batch_report_date ON import_batch(report_definition_id, data_date DESC);
CREATE INDEX ix_batch_status ON import_batch(status);
CREATE INDEX ix_batch_hash ON import_batch(file_hash);

INSERT INTO app_setting (key, value) VALUES
  ('revenue_account_pattern','^4')
  ON CONFLICT(key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Cost element classification
--
-- posting_nature says whether a cost element is cost or revenue; the reporting
-- views key off it so income can never silently net down actual cost.
-- ---------------------------------------------------------------------------
ALTER TABLE dim_cost_element ADD COLUMN posting_nature TEXT NOT NULL DEFAULT 'COST';
UPDATE dim_cost_element SET posting_nature =
  CASE WHEN substr(cost_element_code,1,1) = '4' THEN 'REVENUE' ELSE 'COST' END;

-- The purchasing document is what ties an actual posting to the subcontractor
-- service lines behind it.
ALTER TABLE fact_actual ADD COLUMN po_no TEXT;
CREATE INDEX ix_actual_po ON fact_actual(po_no);

-- ---------------------------------------------------------------------------
-- WBS master attributes carried by a project structure export
-- ---------------------------------------------------------------------------
ALTER TABLE dim_wbs ADD COLUMN planned_start  TEXT;
ALTER TABLE dim_wbs ADD COLUMN planned_finish TEXT;
ALTER TABLE dim_wbs ADD COLUMN actual_start   TEXT;
ALTER TABLE dim_wbs ADD COLUMN actual_finish  TEXT;

-- ---------------------------------------------------------------------------
-- Subcontractor service lines: the detail beneath a PO posting in fact_actual.
-- Deliberately NOT part of fact_actual — these amounts are already in CJI3.
-- ---------------------------------------------------------------------------
CREATE TABLE fact_service_line (
  service_line_id   INTEGER PRIMARY KEY,
  import_batch_id   INTEGER NOT NULL REFERENCES import_batch(import_batch_id) ON DELETE CASCADE,
  project_key       INTEGER NOT NULL REFERENCES dim_project(project_key),
  wbs_key           INTEGER REFERENCES dim_wbs(wbs_key),
  cost_element_key  INTEGER REFERENCES dim_cost_element(cost_element_key),
  vendor_key        INTEGER REFERENCES dim_vendor(vendor_key),
  currency_key      INTEGER REFERENCES dim_currency(currency_key),
  period_key        TEXT REFERENCES dim_period(period_key),
  po_no             TEXT,                -- purchasing document; joins to fact_actual
  invoice_no        TEXT,                -- SAP invoice / IPC document number
  entry_sheet_no    TEXT,
  invoice_serial    TEXT,
  invoice_date_key  INTEGER REFERENCES dim_date(date_key),
  item_no           TEXT,
  line_no           TEXT,
  service_code      TEXT,
  service_text      TEXT,
  category          TEXT,                -- e.g. "DIV03 - CONCRETE", "Equipment Rent"
  contract_type     TEXT,
  uom               TEXT,
  unit_rate         REAL,
  quantity_total    REAL,
  quantity_previous REAL,
  quantity_current  REAL,
  progress_pct      REAL,
  amount_net        REAL NOT NULL DEFAULT 0,   -- work done this certificate, excl. VAT
  amount_vat        REAL,
  amount_gross      REAL,
  source_row_no     INTEGER
);
CREATE INDEX ix_sl_batch ON fact_service_line(import_batch_id);
CREATE INDEX ix_sl_po ON fact_service_line(po_no);
CREATE INDEX ix_sl_scope ON fact_service_line(project_key, period_key);
CREATE INDEX ix_sl_wbs ON fact_service_line(wbs_key);
CREATE INDEX ix_sl_vendor ON fact_service_line(vendor_key);

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------
-- Every posted line, cost and revenue alike.
CREATE VIEW v_posting AS
SELECT
  f.actual_id, f.import_batch_id, b.data_date, b.report_definition_id,
  p.project_key, p.project_code, p.project_name,
  w.wbs_key, w.wbs_code, w.wbs_name, w.wbs_path, w.wbs_level,
  w.discipline, w.package, w.control_account,
  ce.cost_element_key, ce.cost_element_code, ce.cost_element_name,
  ce.cost_type, COALESCE(ce.posting_nature,'COST') AS posting_nature,
  v.vendor_key, v.vendor_code, v.vendor_name,
  cur.iso_code AS currency_code,
  f.period_key, d.year_no, d.month_no,
  f.document_no, f.document_type, f.reference_no, f.po_no, f.description,
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

-- Actual COST. Income cost elements are excluded, so a revenue posting can never
-- quietly reduce the cost position.
CREATE VIEW v_actual AS
SELECT * FROM v_posting WHERE posting_nature = 'COST';

-- Revenue, sign-flipped to read positive.
CREATE VIEW v_revenue AS
SELECT
  actual_id, import_batch_id, data_date, project_key, project_code, project_name,
  wbs_key, wbs_code, wbs_name, wbs_path,
  cost_element_key, cost_element_code, cost_element_name,
  period_key, year_no, month_no, document_no, document_type, description,
  -amount AS amount
FROM v_posting WHERE posting_nature = 'REVENUE';

CREATE VIEW v_budget AS
SELECT
  f.budget_id, f.import_batch_id, b.data_date,
  s.scenario_key, s.scenario_code, s.scenario_name, s.version_no, s.is_current, s.is_baseline,
  p.project_key, p.project_code, p.project_name,
  w.wbs_key, w.wbs_code, w.wbs_name, w.wbs_path, w.discipline, w.package,
  ce.cost_element_key, ce.cost_element_code, ce.cost_element_name, ce.cost_type,
  f.period_key, f.budget_quantity, f.uom, f.unit_rate, f.budget_amount
FROM fact_budget f
JOIN import_batch b ON b.import_batch_id = f.import_batch_id
JOIN dim_scenario s ON s.scenario_key = f.scenario_key
JOIN dim_project p  ON p.project_key = f.project_key
LEFT JOIN dim_wbs w ON w.wbs_key = f.wbs_key
LEFT JOIN dim_cost_element ce ON ce.cost_element_key = f.cost_element_key
WHERE b.status = 'POSTED';

CREATE VIEW v_forecast AS
SELECT
  f.forecast_id, f.import_batch_id, b.data_date,
  s.scenario_key, s.scenario_code, s.scenario_name, s.version_no, s.is_current,
  p.project_key, p.project_code, p.project_name,
  w.wbs_key, w.wbs_code, w.wbs_name, w.wbs_path, w.discipline, w.package,
  ce.cost_element_key, ce.cost_element_code, ce.cost_element_name, ce.cost_type,
  f.period_key, f.forecast_amount, f.etc_amount, f.eac_amount, f.committed_amount, f.forecast_method
FROM fact_forecast f
JOIN import_batch b ON b.import_batch_id = f.import_batch_id
JOIN dim_scenario s ON s.scenario_key = f.scenario_key
JOIN dim_project p  ON p.project_key = f.project_key
LEFT JOIN dim_wbs w ON w.wbs_key = f.wbs_key
LEFT JOIN dim_cost_element ce ON ce.cost_element_key = f.cost_element_key
WHERE b.status = 'POSTED';

CREATE VIEW v_service_line AS
SELECT
  f.service_line_id, f.import_batch_id, b.data_date,
  p.project_key, p.project_code, p.project_name,
  w.wbs_key, w.wbs_code, w.wbs_name, w.wbs_path,
  ce.cost_element_key, ce.cost_element_code, ce.cost_element_name, ce.cost_type,
  v.vendor_key, v.vendor_code, v.vendor_name,
  f.period_key, f.po_no, f.invoice_no, f.entry_sheet_no, f.invoice_serial,
  f.item_no, f.line_no, f.service_code, f.service_text, f.category, f.contract_type,
  f.uom, f.unit_rate, f.quantity_total, f.quantity_previous, f.quantity_current,
  f.progress_pct, f.amount_net, f.amount_vat, f.amount_gross
FROM fact_service_line f
JOIN import_batch b ON b.import_batch_id = f.import_batch_id
JOIN dim_project p  ON p.project_key = f.project_key
LEFT JOIN dim_wbs w ON w.wbs_key = f.wbs_key
LEFT JOIN dim_cost_element ce ON ce.cost_element_key = f.cost_element_key
LEFT JOIN dim_vendor v ON v.vendor_key = f.vendor_key
WHERE b.status = 'POSTED';

CREATE VIEW v_data_freshness AS
SELECT
  rd.report_definition_id,
  rd.code            AS report_code,
  rd.name            AS report_name,
  rd.module,
  ss.code            AS source_system,
  rd.expected_frequency,
  rd.staleness_days,
  b.import_batch_id  AS latest_batch_id,
  b.data_date        AS latest_data_date,
  b.period_key       AS latest_period,
  b.imported_at      AS latest_imported_at,
  b.row_count_posted AS latest_rows,
  CAST(julianday('now') - julianday(b.data_date) AS INTEGER) AS age_days,
  CASE
    WHEN b.import_batch_id IS NULL THEN 'NO_DATA'
    WHEN julianday('now') - julianday(b.data_date) > rd.staleness_days THEN 'STALE'
    ELSE 'CURRENT'
  END AS freshness_status
FROM report_definition rd
JOIN source_system ss ON ss.source_system_id = rd.source_system_id
LEFT JOIN import_batch b
  ON b.import_batch_id = (
       SELECT b2.import_batch_id FROM import_batch b2
       WHERE b2.report_definition_id = rd.report_definition_id
         AND b2.status = 'POSTED'
       ORDER BY b2.data_date DESC, b2.import_batch_id DESC
       LIMIT 1)
WHERE rd.is_active = 1;

-- ---------------------------------------------------------------------------
-- query_library.module is a grouping in the UI, not an import module, so it
-- should not be pinned by a CHECK constraint that a new report kind can break.
-- ---------------------------------------------------------------------------
CREATE TABLE query_library_new (
  query_id     INTEGER PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  module       TEXT NOT NULL,
  category     TEXT,
  description  TEXT,
  sql_text     TEXT NOT NULL,
  params_json  TEXT NOT NULL DEFAULT '[]',
  is_system    INTEGER NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO query_library_new SELECT * FROM query_library;
DROP TABLE query_library;
ALTER TABLE query_library_new RENAME TO query_library;

-- ---------------------------------------------------------------------------
-- Source reports seen in the real extracts
-- ---------------------------------------------------------------------------
INSERT INTO report_definition
  (report_definition_id, source_system_id, code, name, module, description,
   expected_frequency, staleness_days, detail_key_fields) VALUES
  (6,1,'SAP_CJI3','SAP CJI3 actual line items','ACTUAL',
   'Full actual postings by WBS and cost element. Contains subtotal rows and income postings; both are handled on import.',
   'MONTHLY',35,'["document_no"]'),
  (7,1,'SAP_SC_REPORT','Subcontractor service-line report','SERVICE',
   'Service-line detail behind each subcontract PO already posted in CJI3. Reconciles to actuals; never added to them.',
   'MONTHLY',35,'["po_no"]'),
  (8,1,'SAP_WBS_TREE','SAP project structure (WBS tree)','MASTER',
   'Full WBS hierarchy with levels and dates. Builds the cost breakdown structure.',
   'ADHOC',400,'["wbs_code"]');

COMMIT;

PRAGMA foreign_keys = ON;
