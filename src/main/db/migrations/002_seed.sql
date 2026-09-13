-- Reference data. The query library is seeded from src/main/db/systemQueries.ts
-- so that fixing a system query ships with the app instead of needing a migration.

INSERT INTO dim_currency (currency_key, iso_code, name, symbol) VALUES
  (1,'USD','US Dollar','$'),
  (2,'EUR','Euro','EUR'),
  (3,'GBP','Pound Sterling','GBP'),
  (4,'SAR','Saudi Riyal','SAR'),
  (5,'AED','UAE Dirham','AED'),
  (6,'EGP','Egyptian Pound','EGP'),
  (7,'QAR','Qatari Riyal','QAR'),
  (8,'KWD','Kuwaiti Dinar','KWD');

INSERT INTO source_system (source_system_id, code, name, description) VALUES
  (1,'SAP','SAP ERP','Actual cost postings and commitments'),
  (2,'PRIMAVERA','Primavera P6','Schedule and progress'),
  (3,'EXCEL','Manual workbook','Budget, forecast and mapping maintained by cost control'),
  (4,'PDF','PDF report','Scanned or exported PDF cost reports');

INSERT INTO report_definition
  (report_definition_id, source_system_id, code, name, module, description, expected_frequency, staleness_days) VALUES
  (1,1,'SAP_ACTUAL_LINE','SAP actual cost line items','ACTUAL','Line-item actual postings by WBS and cost element','MONTHLY',35),
  (2,1,'SAP_ACTUAL_SUMMARY','SAP cost report (summary)','ACTUAL','Period totals by WBS / cost element','MONTHLY',35),
  (3,3,'BUDGET_BASELINE','Approved budget','BUDGET','Baseline budget by WBS and cost element','ADHOC',400),
  (4,3,'FORECAST_MONTHLY','Monthly forecast','FORECAST','ETC / EAC by WBS and period','MONTHLY',35),
  (5,3,'WBS_MASTER','WBS master','MASTER','Cost breakdown structure','ADHOC',400);

INSERT INTO app_setting (key, value) VALUES
  ('schema_version','1'),
  ('default_currency','USD'),
  ('app_name','Cost Intelligence');
