-- =============================================================================
-- The built-in work-package list: the 16 CSI MasterFormat divisions the user
-- actually codes against (confirmed against a real project mapping sheet),
-- grouped exactly the way their own workbook does — Civil / Arch / MEP,
-- straight into dim_work_package.group_label, no schema change needed there.
--
-- Seeded is_system = 1, the same rename-but-not-delete protection cost_type's
-- six built-ins get: the user can re-icon, re-colour or re-group any of
-- these, but not delete one out from under existing coding. INSERT OR IGNORE
-- so re-running this migration (or a code/group_label the user already
-- customised colliding with a division code) never clobbers anything.
--
-- sort_order is the CSI division number itself, so the Packages manager and
-- any package-grouped report read in CSI order rather than alphabetical.
-- =============================================================================

INSERT OR IGNORE INTO dim_work_package (code, label, group_label, icon, color, sort_order, is_system) VALUES
  ('DIV03', 'Concrete',                        'Civil', '🏗️', '#5b8dd6', 3,  1),
  ('DIV04', 'Masonry',                         'Civil', '🧱', '#5b8dd6', 4,  1),
  ('DIV05', 'Metals',                          'Arch',  '🔩', '#d6a15b', 5,  1),
  ('DIV06', 'Wood, Plastics and Composites',   'Arch',  '🪵', '#d6a15b', 6,  1),
  ('DIV07', 'Thermal and Moisture Protection', 'Civil', '💧', '#5b8dd6', 7,  1),
  ('DIV08', 'Openings',                        'Arch',  '🚪', '#d6a15b', 8,  1),
  ('DIV09', 'Finishes',                        'Arch',  '🎨', '#d6a15b', 9,  1),
  ('DIV10', 'Specialties',                     'Arch',  '🧰', '#d6a15b', 10, 1),
  ('DIV21', 'Fire Suppression',                'MEP',   '🧯', '#5bbf8a', 21, 1),
  ('DIV22', 'Plumbing',                        'MEP',   '🚰', '#5bbf8a', 22, 1),
  ('DIV23', 'HVAC',                            'MEP',   '❄️', '#5bbf8a', 23, 1),
  ('DIV26', 'Electrical',                      'MEP',   '⚡', '#5bbf8a', 26, 1),
  ('DIV27', 'Communications',                  'MEP',   '📡', '#5bbf8a', 27, 1),
  ('DIV31', 'Earthwork',                       'Civil', '⛏️', '#5b8dd6', 31, 1),
  ('DIV32', 'Exterior Improvements',           'Civil', '🌳', '#5b8dd6', 32, 1),
  ('DIV33', 'Utilities',                       'MEP',   '🔧', '#5bbf8a', 33, 1);
