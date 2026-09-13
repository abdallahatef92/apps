-- =============================================================================
-- Cost Intelligence — core star schema
-- Grain notes:
--   fact_actual   : one row per SAP posting line (document line) per period
--   fact_budget   : one row per project / WBS / cost element / scenario / period
--   fact_forecast : one row per project / WBS / cost element / scenario / period
-- Every fact row carries import_batch_id, so any number can be traced back to
-- the exact file and the data date (as-of date) that produced it.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- LINEAGE / FRESHNESS
-- -----------------------------------------------------------------------------

-- Where data physically comes from (SAP, Primavera, manual workbook, ...)
CREATE TABLE source_system (
  source_system_id INTEGER PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  description      TEXT
);

-- A named, repeatable report/extract, e.g. "SAP CJI3 actual line items".
-- The saved column mapping hangs off this, so the 2nd upload is one click.
CREATE TABLE report_definition (
  report_definition_id INTEGER PRIMARY KEY,
  source_system_id     INTEGER NOT NULL REFERENCES source_system(source_system_id),
  code                 TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL,
  module               TEXT NOT NULL CHECK (module IN ('ACTUAL','BUDGET','FORECAST','COMMITMENT','MASTER')),
  description          TEXT,
  -- how often this source is expected to refresh; drives the staleness warning
  expected_frequency   TEXT CHECK (expected_frequency IN ('DAILY','WEEKLY','MONTHLY','QUARTERLY','ADHOC')),
  staleness_days       INTEGER NOT NULL DEFAULT 35,
  is_active            INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One upload = one batch. data_date is the AS-OF date of the content,
-- which is deliberately separate from imported_at (when we loaded it).
CREATE TABLE import_batch (
  import_batch_id      INTEGER PRIMARY KEY,
  report_definition_id INTEGER NOT NULL REFERENCES report_definition(report_definition_id),
  module               TEXT NOT NULL CHECK (module IN ('ACTUAL','BUDGET','FORECAST','COMMITMENT','MASTER')),
  data_date            TEXT NOT NULL,               -- ISO date: as-of date of the report content
  period_key           TEXT,                        -- 'YYYY-MM' the batch primarily covers
  project_key          INTEGER REFERENCES dim_project(project_key),
  file_name            TEXT NOT NULL,
  file_path            TEXT,
  file_hash            TEXT,                        -- sha256, used to detect a re-upload of the same file
  file_size            INTEGER,
  sheet_name           TEXT,
  status               TEXT NOT NULL DEFAULT 'STAGED'
                       CHECK (status IN ('STAGED','MAPPED','POSTED','SUPERSEDED','REJECTED')),
  row_count_file       INTEGER NOT NULL DEFAULT 0,
  row_count_posted     INTEGER NOT NULL DEFAULT 0,
  row_count_rejected   INTEGER NOT NULL DEFAULT 0,
  amount_total         REAL,                        -- control total for reconciliation
  imported_at          TEXT NOT NULL DEFAULT (datetime('now')),
  imported_by          TEXT,
  posted_at            TEXT,
  superseded_by        INTEGER REFERENCES import_batch(import_batch_id),
  notes                TEXT
);
CREATE INDEX ix_batch_report_date ON import_batch(report_definition_id, data_date DESC);
CREATE INDEX ix_batch_status ON import_batch(status);
CREATE INDEX ix_batch_hash ON import_batch(file_hash);

-- -----------------------------------------------------------------------------
-- DIMENSIONS
-- -----------------------------------------------------------------------------

CREATE TABLE dim_date (
  date_key      INTEGER PRIMARY KEY,   -- YYYYMMDD
  full_date     TEXT NOT NULL UNIQUE,  -- ISO
  day_of_month  INTEGER NOT NULL,
  month_no      INTEGER NOT NULL,
  month_name    TEXT NOT NULL,
  month_abbr    TEXT NOT NULL,
  quarter_no    INTEGER NOT NULL,
  year_no       INTEGER NOT NULL,
  period_key    TEXT NOT NULL,         -- 'YYYY-MM'
  month_end     TEXT NOT NULL,
  is_month_end  INTEGER NOT NULL
);
CREATE INDEX ix_date_period ON dim_date(period_key);

-- Monthly reporting calendar (the grain budget/forecast are held at)
CREATE TABLE dim_period (
  period_key    TEXT PRIMARY KEY,      -- 'YYYY-MM'
  year_no       INTEGER NOT NULL,
  month_no      INTEGER NOT NULL,
  quarter_no    INTEGER NOT NULL,
  label         TEXT NOT NULL,         -- 'Jan 2026'
  start_date    TEXT NOT NULL,
  end_date      TEXT NOT NULL,
  period_index  INTEGER NOT NULL,      -- monotonic, for easy ordering / offsets
  is_closed     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE dim_currency (
  currency_key  INTEGER PRIMARY KEY,
  iso_code      TEXT NOT NULL UNIQUE,
  name          TEXT,
  symbol        TEXT
);

CREATE TABLE dim_project (
  project_key      INTEGER PRIMARY KEY,
  project_code     TEXT NOT NULL UNIQUE,     -- SAP project / WBS root
  project_name     TEXT NOT NULL,
  client_name      TEXT,
  contract_no      TEXT,
  project_manager  TEXT,
  currency_key     INTEGER REFERENCES dim_currency(currency_key),
  contract_value   REAL,
  start_date       TEXT,
  finish_date      TEXT,
  status           TEXT DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ON_HOLD','CLOSED','CANCELLED')),
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cost breakdown structure. Self-referencing hierarchy + materialised path
-- so rollups are a single LIKE on wbs_path — no recursion needed in hot queries.
CREATE TABLE dim_wbs (
  wbs_key         INTEGER PRIMARY KEY,
  project_key     INTEGER NOT NULL REFERENCES dim_project(project_key),
  wbs_code        TEXT NOT NULL,
  wbs_name        TEXT NOT NULL,
  parent_wbs_key  INTEGER REFERENCES dim_wbs(wbs_key),
  wbs_level       INTEGER NOT NULL DEFAULT 1,
  wbs_path        TEXT NOT NULL,             -- '/ROOT/CIV/CIV-01/'
  control_account TEXT,
  discipline      TEXT,
  package         TEXT,
  csi_code        TEXT,
  is_leaf         INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (project_key, wbs_code)
);
CREATE INDEX ix_wbs_path ON dim_wbs(wbs_path);
CREATE INDEX ix_wbs_parent ON dim_wbs(parent_wbs_key);

-- SAP cost element / GL account, grouped into cost types for analysis
CREATE TABLE dim_cost_element (
  cost_element_key  INTEGER PRIMARY KEY,
  cost_element_code TEXT NOT NULL UNIQUE,
  cost_element_name TEXT NOT NULL,
  cost_type         TEXT CHECK (cost_type IN ('LABOR','MATERIAL','SUBCONTRACT','EQUIPMENT','INDIRECT','OTHER')),
  cost_category     TEXT,                    -- e.g. 'DIRECT' / 'INDIRECT'
  gl_account        TEXT,
  is_capex          INTEGER NOT NULL DEFAULT 0,
  sort_order        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE dim_vendor (
  vendor_key   INTEGER PRIMARY KEY,
  vendor_code  TEXT NOT NULL UNIQUE,
  vendor_name  TEXT NOT NULL,
  vendor_type  TEXT,
  country      TEXT
);

-- Budget/forecast versions. Exactly one row per (project, type) may be current.
CREATE TABLE dim_scenario (
  scenario_key   INTEGER PRIMARY KEY,
  project_key    INTEGER NOT NULL REFERENCES dim_project(project_key),
  scenario_code  TEXT NOT NULL,
  scenario_name  TEXT NOT NULL,
  scenario_type  TEXT NOT NULL CHECK (scenario_type IN ('BUDGET','FORECAST')),
  version_no     INTEGER NOT NULL DEFAULT 1,
  data_date      TEXT,                       -- as-of date of this version
  is_current     INTEGER NOT NULL DEFAULT 0,
  is_baseline    INTEGER NOT NULL DEFAULT 0, -- the approved original budget
  approved_by    TEXT,
  approved_date  TEXT,
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_key, scenario_code)
);
CREATE UNIQUE INDEX ux_scenario_current
  ON dim_scenario(project_key, scenario_type) WHERE is_current = 1;

-- -----------------------------------------------------------------------------
-- FACTS
-- -----------------------------------------------------------------------------

CREATE TABLE fact_actual (
  actual_id        INTEGER PRIMARY KEY,
  import_batch_id  INTEGER NOT NULL REFERENCES import_batch(import_batch_id) ON DELETE CASCADE,
  project_key      INTEGER NOT NULL REFERENCES dim_project(project_key),
  wbs_key          INTEGER REFERENCES dim_wbs(wbs_key),
  cost_element_key INTEGER REFERENCES dim_cost_element(cost_element_key),
  vendor_key       INTEGER REFERENCES dim_vendor(vendor_key),
  currency_key     INTEGER REFERENCES dim_currency(currency_key),
  posting_date_key INTEGER REFERENCES dim_date(date_key),
  document_date_key INTEGER REFERENCES dim_date(date_key),
  period_key       TEXT NOT NULL REFERENCES dim_period(period_key),
  document_no      TEXT,
  document_line    TEXT,
  document_type    TEXT,
  reference_no     TEXT,
  description      TEXT,
  quantity         REAL,
  uom              TEXT,
  unit_rate        REAL,
  amount           REAL NOT NULL DEFAULT 0,   -- project currency
  amount_doc       REAL,                      -- document currency
  is_accrual       INTEGER NOT NULL DEFAULT 0,
  is_reversal      INTEGER NOT NULL DEFAULT 0,
  source_row_no    INTEGER
);
CREATE INDEX ix_actual_batch ON fact_actual(import_batch_id);
CREATE INDEX ix_actual_proj_period ON fact_actual(project_key, period_key);
CREATE INDEX ix_actual_wbs ON fact_actual(wbs_key, period_key);
CREATE INDEX ix_actual_ce ON fact_actual(cost_element_key);
CREATE INDEX ix_actual_doc ON fact_actual(document_no, document_line);

CREATE TABLE fact_budget (
  budget_id        INTEGER PRIMARY KEY,
  import_batch_id  INTEGER NOT NULL REFERENCES import_batch(import_batch_id) ON DELETE CASCADE,
  scenario_key     INTEGER NOT NULL REFERENCES dim_scenario(scenario_key),
  project_key      INTEGER NOT NULL REFERENCES dim_project(project_key),
  wbs_key          INTEGER REFERENCES dim_wbs(wbs_key),
  cost_element_key INTEGER REFERENCES dim_cost_element(cost_element_key),
  currency_key     INTEGER REFERENCES dim_currency(currency_key),
  period_key       TEXT REFERENCES dim_period(period_key),  -- NULL = not time-phased
  budget_quantity  REAL,
  uom              TEXT,
  unit_rate        REAL,
  budget_amount    REAL NOT NULL DEFAULT 0,
  description      TEXT,
  source_row_no    INTEGER
);
CREATE INDEX ix_budget_batch ON fact_budget(import_batch_id);
CREATE INDEX ix_budget_scope ON fact_budget(project_key, scenario_key, period_key);
CREATE INDEX ix_budget_wbs ON fact_budget(wbs_key);

CREATE TABLE fact_forecast (
  forecast_id      INTEGER PRIMARY KEY,
  import_batch_id  INTEGER NOT NULL REFERENCES import_batch(import_batch_id) ON DELETE CASCADE,
  scenario_key     INTEGER NOT NULL REFERENCES dim_scenario(scenario_key),
  project_key      INTEGER NOT NULL REFERENCES dim_project(project_key),
  wbs_key          INTEGER REFERENCES dim_wbs(wbs_key),
  cost_element_key INTEGER REFERENCES dim_cost_element(cost_element_key),
  currency_key     INTEGER REFERENCES dim_currency(currency_key),
  period_key       TEXT REFERENCES dim_period(period_key),
  forecast_amount  REAL NOT NULL DEFAULT 0,   -- spend planned in this period (ETC by period)
  etc_amount       REAL,                      -- estimate to complete at this point
  eac_amount       REAL,                      -- estimate at completion
  committed_amount REAL,
  forecast_method  TEXT,                      -- 'MANUAL','CPI','REMAINING_BUDGET',...
  description      TEXT,
  source_row_no    INTEGER
);
CREATE INDEX ix_forecast_batch ON fact_forecast(import_batch_id);
CREATE INDEX ix_forecast_scope ON fact_forecast(project_key, scenario_key, period_key);
CREATE INDEX ix_forecast_wbs ON fact_forecast(wbs_key);

-- -----------------------------------------------------------------------------
-- STAGING + MAPPING (upload -> review -> post)
-- -----------------------------------------------------------------------------

-- Raw rows exactly as read from the file, before any interpretation.
CREATE TABLE stg_row (
  stg_row_id      INTEGER PRIMARY KEY,
  import_batch_id INTEGER NOT NULL REFERENCES import_batch(import_batch_id) ON DELETE CASCADE,
  row_no          INTEGER NOT NULL,
  raw_json        TEXT NOT NULL,              -- {"Column header": value, ...}
  status          TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','VALID','WARN','ERROR','POSTED','SKIPPED')),
  message         TEXT
);
CREATE INDEX ix_stg_batch ON stg_row(import_batch_id, row_no);

-- Saved "source profile": which file column feeds which canonical field.
CREATE TABLE column_mapping (
  column_mapping_id    INTEGER PRIMARY KEY,
  report_definition_id INTEGER NOT NULL REFERENCES report_definition(report_definition_id) ON DELETE CASCADE,
  source_column        TEXT NOT NULL,
  target_field         TEXT NOT NULL,         -- canonical field name, e.g. 'wbs_code'
  transform            TEXT,                  -- 'TRIM','UPPER','NUMBER','DATE','NEGATE',...
  default_value        TEXT,
  is_required          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (report_definition_id, target_field)
);

-- Value-level mapping: the text SAP prints vs. the dimension member we keep.
CREATE TABLE value_mapping (
  value_mapping_id INTEGER PRIMARY KEY,
  dimension        TEXT NOT NULL CHECK (dimension IN ('PROJECT','WBS','COST_ELEMENT','VENDOR','CURRENCY')),
  project_key      INTEGER REFERENCES dim_project(project_key),
  source_value     TEXT NOT NULL,
  target_key       INTEGER,
  target_code      TEXT,
  confidence       TEXT NOT NULL DEFAULT 'MANUAL' CHECK (confidence IN ('EXACT','FUZZY','MANUAL')),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (dimension, project_key, source_value)
);

-- -----------------------------------------------------------------------------
-- QUERY LIBRARY — real SQL, stored in the DB, executed read-only
-- -----------------------------------------------------------------------------

CREATE TABLE query_library (
  query_id     INTEGER PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  module       TEXT NOT NULL CHECK (module IN ('ACTUAL','BUDGET','FORECAST','CROSS','ADMIN')),
  category     TEXT,
  description  TEXT,
  sql_text     TEXT NOT NULL,
  params_json  TEXT NOT NULL DEFAULT '[]',   -- [{"name":"project_key","type":"int","label":"Project"}]
  is_system    INTEGER NOT NULL DEFAULT 0,   -- system queries are reset on upgrade
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE query_run_log (
  run_id     INTEGER PRIMARY KEY,
  query_id   INTEGER REFERENCES query_library(query_id) ON DELETE SET NULL,
  ran_at     TEXT NOT NULL DEFAULT (datetime('now')),
  params_json TEXT,
  row_count  INTEGER,
  ms         INTEGER,
  error      TEXT
);

CREATE TABLE app_setting (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- -----------------------------------------------------------------------------
-- VIEWS
-- -----------------------------------------------------------------------------

-- Data freshness: the newest posted batch per report, and whether it is stale.
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

-- Actuals with every dimension resolved and the data date attached.
CREATE VIEW v_actual AS
SELECT
  f.actual_id, f.import_batch_id, b.data_date, b.report_definition_id,
  p.project_key, p.project_code, p.project_name,
  w.wbs_key, w.wbs_code, w.wbs_name, w.wbs_path, w.discipline, w.package, w.control_account,
  ce.cost_element_key, ce.cost_element_code, ce.cost_element_name, ce.cost_type,
  v.vendor_key, v.vendor_code, v.vendor_name,
  f.period_key, d.year_no, d.month_no,
  f.document_no, f.document_type, f.description,
  f.quantity, f.uom, f.amount
FROM fact_actual f
JOIN import_batch b   ON b.import_batch_id = f.import_batch_id
JOIN dim_project p    ON p.project_key = f.project_key
LEFT JOIN dim_wbs w   ON w.wbs_key = f.wbs_key
LEFT JOIN dim_cost_element ce ON ce.cost_element_key = f.cost_element_key
LEFT JOIN dim_vendor v ON v.vendor_key = f.vendor_key
LEFT JOIN dim_period d ON d.period_key = f.period_key
WHERE b.status = 'POSTED';

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
