-- =============================================================================
-- Project build workspace (Project_Build_Workspace_Plan.md, rev. 4, "A").
--
-- A project is built through a list of build steps (P6-style). Steps, their
-- dependencies, the report definitions that load them and the inputs every
-- report page needs are DATA, not code, like module_type and dim_cost_type.
-- Status is computed by the BUILD_STATUS stored query over v_project_batch and
-- the project cut-off; nothing here is a fact.
--
--   build_step              one row per step (code, group, kind, action)
--   build_step_report       which report_definition rows load an upload step
--   build_step_dependency   step -> step it waits for; any_of = 1 marks a set
--                           of alternatives (the step waits for none of them)
--   report_input            which steps each report page needs (required) or
--                           is better with (improves)
--   v_project_batch         (import_batch_id, project_key) where facts landed
-- =============================================================================

CREATE TABLE build_step (
  code           TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  group_label    TEXT NOT NULL,
  sort_order     INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('project','upload','coding')),
  is_optional    INTEGER NOT NULL DEFAULT 0,   -- no report requires it
  is_conditional INTEGER NOT NULL DEFAULT 0,   -- only needed when the project has the case (B05)
  is_planned     INTEGER NOT NULL DEFAULT 0,   -- source does not exist yet (B15)
  module         TEXT,                         -- module_type code, or the module still to be built
  action_label   TEXT,
  action_target  TEXT CHECK (action_target IS NULL
                   OR action_target IN ('upload','packages','costtypes','settings'))
);

CREATE TABLE build_step_report (
  step_code            TEXT NOT NULL REFERENCES build_step(code) ON DELETE CASCADE,
  report_definition_id INTEGER NOT NULL REFERENCES report_definition(report_definition_id) ON DELETE CASCADE,
  PRIMARY KEY (step_code, report_definition_id)
);

CREATE TABLE build_step_dependency (
  step_code       TEXT NOT NULL REFERENCES build_step(code) ON DELETE CASCADE,
  depends_on_code TEXT NOT NULL REFERENCES build_step(code) ON DELETE CASCADE,
  any_of          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (step_code, depends_on_code)
);

CREATE TABLE report_input (
  report_page TEXT NOT NULL,                   -- the renderer's PageId
  step_code   TEXT NOT NULL REFERENCES build_step(code) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('required','improves')),
  PRIMARY KEY (report_page, step_code)
);

-- JSON array of the captions that identify a report; recognition (delivery 2)
-- scores a file against it. NULL where the layout is not known yet.
ALTER TABLE report_definition ADD COLUMN signature_columns TEXT;

UPDATE report_definition SET signature_columns = '["Cost Element","Val/COArea Crcy","Document Number"]'
  WHERE code IN ('SAP_CJI3','SAP_ACTUAL_LINE');
UPDATE report_definition SET signature_columns = '["Pur. Doc.","SC Work Current Cost"]'
  WHERE code = 'SAP_SC_REPORT';
UPDATE report_definition SET signature_columns = '["Purchase Order","PO Service Code"]'
  WHERE code = 'SAP_ZSCSRV1';
UPDATE report_definition SET signature_columns = '["Order","Order Type","Activity Type","Category"]'
  WHERE code = 'SAP_ORDER_DETAIL';
UPDATE report_definition SET signature_columns = '["Level","Description","Basic fin."]'
  WHERE code = 'SAP_WBS_TREE';
UPDATE report_definition SET signature_columns = '["Material","Movement Type","Material Document"]'
  WHERE code = 'SAP_MB51';
UPDATE report_definition SET signature_columns = '["Purchasing Document","Item","Material"]'
  WHERE code = 'SAP_ME2N';
-- MB52 (confirm the captions on a real export); the MM60 layout stays accepted
-- by the same definition.
UPDATE report_definition SET signature_columns = '["Material","Storage Location","Unrestricted"]'
  WHERE code = 'SAP_MM60';

-- -----------------------------------------------------------------------------
-- The steps
-- -----------------------------------------------------------------------------
INSERT INTO build_step
  (code, name, group_label, sort_order, kind, is_optional, is_conditional, is_planned, module, action_label, action_target) VALUES
  ('B01', 'Project details',                 'CJI3 · general review',            10, 'project', 0, 0, 0, NULL,         'Open project settings',   'settings'),
  ('B04', 'Actual cost',                     'CJI3 · general review',            20, 'upload',  0, 0, 0, 'ACTUAL',     'Load CJI3',               'upload'),
  ('B11', 'Cost types',                      'CJI3 · general review',            30, 'coding',  0, 0, 0, NULL,         'Review cost types',       'costtypes'),
  ('B07', 'Subcontract certificates',        'Subcontractor cost',               40, 'upload',  0, 0, 0, 'SERVICE',    'Load ZSCPROG01',          'upload'),
  ('B08', 'PO service lines',                'Subcontractor cost',               41, 'upload',  0, 0, 0, 'PO_SERVICE', 'Load ZSCSRV1',            'upload'),
  ('B15', 'Subcontractor deductions',        'Subcontractor cost',               42, 'upload',  1, 0, 1, NULL,         'Not available yet',       NULL),
  ('B18', 'Service MNL (labour / equipment services)', 'Subcontractor cost',     43, 'coding',  1, 0, 0, NULL,         'Review service MNL',      'packages'),
  ('B06', 'Material issues',                 'Material cost',                    50, 'upload',  0, 0, 0, 'MATISSUE',   'Load MB51',               'upload'),
  ('B09', 'Material POs',                    'Material cost',                    51, 'upload',  0, 0, 0, 'MATPO',      'Load ME2N',               'upload'),
  ('B10', 'Material stock',                  'Material cost',                    52, 'upload',  0, 0, 0, 'MATLIST',    'Load MB52',               'upload'),
  ('B05', 'Internal order detail',           'Equipment · Fleet · House rent',   60, 'upload',  1, 1, 0, 'ORDER',      'Load ZINTC1',             'upload'),
  ('B16', 'Labour allocation form',          'Labor · Asset depreciation',       70, 'upload',  1, 0, 0, 'LABOUR',     'Load labour form',        'upload'),
  ('B17', 'Asset movement sheet',            'Labor · Asset depreciation',       71, 'upload',  1, 0, 0, 'ASSET',      'Load asset sheet',        'upload'),
  ('B02', 'WBS structure',                   'Structure',                        80, 'upload',  1, 0, 0, 'MASTER',     'Load WBS tree',           'upload'),
  ('B03', 'Budget',                          'Structure',                        81, 'upload',  1, 0, 0, 'BUDGET',     'Load budget',             'upload'),
  ('B12', 'Work packages',                   'Coding',                           90, 'coding',  0, 0, 0, NULL,         'Code work packages',      'packages');

-- Which report definitions load a step. Looked up by code so a database that
-- never had one (e.g. no budget template) simply gets no link.
INSERT INTO build_step_report (step_code, report_definition_id)
SELECT m.step_code, rd.report_definition_id
FROM (SELECT 'B02' AS step_code, 'SAP_WBS_TREE' AS code UNION ALL SELECT 'B02', 'WBS_MASTER'
      UNION ALL SELECT 'B03', 'BUDGET_BASELINE'
      UNION ALL SELECT 'B04', 'SAP_CJI3' UNION ALL SELECT 'B04', 'SAP_ACTUAL_LINE'
      UNION ALL SELECT 'B05', 'SAP_ORDER_DETAIL'
      UNION ALL SELECT 'B06', 'SAP_MB51'
      UNION ALL SELECT 'B07', 'SAP_SC_REPORT'
      UNION ALL SELECT 'B08', 'SAP_ZSCSRV1'
      UNION ALL SELECT 'B09', 'SAP_ME2N'
      UNION ALL SELECT 'B10', 'SAP_MM60') m
JOIN report_definition rd ON rd.code = m.code;

INSERT INTO build_step_dependency (step_code, depends_on_code, any_of) VALUES
  ('B02', 'B01', 0), ('B03', 'B01', 0), ('B04', 'B01', 0),
  ('B06', 'B01', 0), ('B07', 'B01', 0), ('B08', 'B01', 0),
  ('B09', 'B01', 0), ('B10', 'B01', 0), ('B16', 'B01', 0), ('B17', 'B01', 0),
  ('B05', 'B04', 0), ('B11', 'B04', 0),
  ('B15', 'B07', 0), ('B18', 'B07', 0),
  -- work packages code whatever is loaded: any one of the three is enough
  ('B12', 'B04', 1), ('B12', 'B06', 1), ('B12', 'B07', 1);

INSERT INTO report_input (report_page, step_code, role) VALUES
  ('dashboard',     'B04', 'required'), ('dashboard',     'B11', 'required'),
  ('dashboard',     'B05', 'improves'), ('dashboard',     'B02', 'improves'), ('dashboard',     'B03', 'improves'),
  ('reports',       'B04', 'required'), ('reports',       'B11', 'required'),
  ('reports',       'B05', 'improves'),   -- Actual cost needs no budget or WBS (user: both optional)
  ('costreport',    'B04', 'required'), ('costreport',    'B11', 'required'),
  ('costreport',    'B05', 'improves'), ('costreport',    'B02', 'improves'), ('costreport',    'B03', 'improves'),
  ('subcontractor', 'B07', 'required'), ('subcontractor', 'B08', 'required'),
  ('subcontractor', 'B15', 'improves'), ('subcontractor', 'B18', 'improves'),
  ('material',      'B06', 'required'), ('material',      'B09', 'required'), ('material',      'B10', 'required');

-- -----------------------------------------------------------------------------
-- Where a batch's facts landed. Status follows the facts, never
-- import_batch.project_key (a wizard hint - CLAUDE.md "Batch superseding is the
-- fallback only"). Two modules write no fact with a project:
--   MASTER   writes dim_wbs for the batch's project, which postWbsMaster
--            requires, so the batch's own project_key is the truth.
--   MATLIST  updates dim_material (plant-wide), so a list counts for every
--            project that has MB51 issues, and for the project it was loaded for.
-- v_data_freshness is not project-scoped, so it is not reused.
-- -----------------------------------------------------------------------------
CREATE VIEW v_project_batch AS
SELECT DISTINCT import_batch_id, project_key FROM (
  SELECT import_batch_id, project_key FROM fact_actual
  UNION ALL SELECT import_batch_id, project_key FROM fact_budget
  UNION ALL SELECT import_batch_id, project_key FROM fact_forecast
  UNION ALL SELECT import_batch_id, project_key FROM fact_service_line
  UNION ALL SELECT import_batch_id, project_key FROM fact_order_line
  UNION ALL SELECT import_batch_id, project_key FROM fact_accrual
  UNION ALL SELECT import_batch_id, project_key FROM fact_po_service_line
  UNION ALL SELECT import_batch_id, project_key FROM fact_material_issue
  UNION ALL SELECT import_batch_id, project_key FROM fact_po_material_line
  UNION ALL SELECT import_batch_id, project_key FROM import_batch
    WHERE module = 'MASTER' AND project_key IS NOT NULL
  UNION ALL SELECT import_batch_id, project_key FROM import_batch
    WHERE module = 'MATLIST' AND project_key IS NOT NULL
  UNION ALL SELECT b.import_batch_id, m.project_key
    FROM import_batch b
    JOIN (SELECT DISTINCT project_key FROM fact_material_issue) m
    WHERE b.module = 'MATLIST'
);
