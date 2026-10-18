-- =============================================================================
-- MNL: the resource category the subcontract workbook (and later the material
-- workbook) prints next to a cost line — M Material, L Labor, S Subcontractor,
-- E Equipment, O Others. It is the app's cost type expressed as one letter, so
-- it is stored on dim_cost_type and edited in Cost types, not coded per line.
-- A user-added type defaults to O.
-- =============================================================================
ALTER TABLE dim_cost_type ADD COLUMN mnl_code TEXT NOT NULL DEFAULT 'O'
  CHECK (mnl_code IN ('M','L','S','E','O'));

UPDATE dim_cost_type SET mnl_code = 'M' WHERE code = 'MATERIAL';
UPDATE dim_cost_type SET mnl_code = 'L' WHERE code = 'LABOR';
UPDATE dim_cost_type SET mnl_code = 'S' WHERE code = 'SUBCONTRACT';
UPDATE dim_cost_type SET mnl_code = 'E' WHERE code = 'EQUIPMENT';
-- INDIRECT, OTHER, ASSET_DEPRECIATION, REVENUE and anything added later stay 'O'.
