-- =============================================================================
-- MNL codes as the workbook uses them: MAT, SUB, EQU, LAB, OTHER.
-- `mnl` supersedes 022's single-letter mnl_code (kept, unused — its CHECK can't
-- hold the workbook's MAT/SUB/EQU/LAB/OTHER codes and 022 is already applied).
-- A NULL mnl (a type added later) reads as OTHER.
-- =============================================================================
ALTER TABLE dim_cost_type ADD COLUMN mnl TEXT;

UPDATE dim_cost_type SET mnl = CASE code
  WHEN 'MATERIAL'    THEN 'MAT'
  WHEN 'SUBCONTRACT' THEN 'SUB'
  WHEN 'EQUIPMENT'   THEN 'EQU'
  WHEN 'LABOR'       THEN 'LAB'
  ELSE 'OTHER' END;
