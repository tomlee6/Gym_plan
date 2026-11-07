-- The equipment library: standard machines with their sizes and the free
-- floor each needs, placed on a plan for a fit-out (the web editor's
-- Equipment library and Fit-out schedule).
--
-- Until now the library lived in code (shared/plan/library.js). It moves
-- here so platform admins can keep it up to date, and so equipment makers
-- can later supply their own models with exact sizes:
--
--   * equipment_manufacturers  who makes a machine. A library row with no
--     manufacturer is a generic one ("Treadmill, typical size").
--   * equipment_library        one machine model. `library_key` is stable
--     and unique within its manufacturer (or among the generic rows), so
--     an import can be run again to update rows rather than duplicate them.
--     `source` says where a row came from: the platform's own list, typed
--     in by an admin, or a manufacturer's import.
--
-- A placed machine keeps its own copy of name, type and size in the plan,
-- so editing or archiving a library row never changes an existing plan.
-- Rows are archived, not deleted, so the record of what was offered stays.

CREATE TABLE equipment_manufacturers (
  id          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name        VARCHAR(120) NOT NULL,
  -- Lower-case, for URLs and import files: 'life-fitness'.
  slug        VARCHAR(60) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  website     VARCHAR(300) NULL,
  status      ENUM('active', 'archived') NOT NULL DEFAULT 'active',
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_manufacturer_slug (slug),
  UNIQUE KEY uq_manufacturer_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE equipment_library (
  id                   CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  manufacturer_id      CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  library_key          VARCHAR(60) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- The maker's own model number or SKU, when it has one.
  model_code           VARCHAR(80) NULL,
  name                 VARCHAR(120) NOT NULL,
  category             VARCHAR(40) NOT NULL,
  -- The plan's equipment type ('treadmill', 'legPress', ...). Open-ended,
  -- like equipment_types.code: a new kind needs no migration.
  equipment_type       VARCHAR(40) NOT NULL,
  width_m              DECIMAL(6,3) NOT NULL,
  depth_m              DECIMAL(6,3) NOT NULL,
  height_m             DECIMAL(6,3) NOT NULL,
  -- Free floor needed all round, and behind (a treadmill's run-off).
  clearance_around_m   DECIMAL(5,2) NOT NULL DEFAULT 0.60,
  clearance_behind_m   DECIMAL(5,2) NOT NULL DEFAULT 0.60,
  description          VARCHAR(500) NULL,
  source               ENUM('platform', 'admin', 'import') NOT NULL DEFAULT 'admin',
  status               ENUM('active', 'archived') NOT NULL DEFAULT 'active',
  sort_order           INT NOT NULL DEFAULT 0,
  created_by           CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  updated_by           CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  -- The manufacturer id, or 'generic', so keys are unique per maker.
  scope                VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin
                       GENERATED ALWAYS AS (COALESCE(manufacturer_id, 'generic')) STORED,
  created_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_library_key (scope, library_key),
  KEY ix_library_list (status, category, sort_order),
  CONSTRAINT fk_library_manufacturer FOREIGN KEY (manufacturer_id) REFERENCES equipment_manufacturers (id),
  CONSTRAINT fk_library_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_library_updated_by FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_library_sizes CHECK (
    width_m > 0 AND width_m <= 30 AND depth_m > 0 AND depth_m <= 30 AND height_m > 0 AND height_m <= 10),
  CONSTRAINT ck_library_clearance CHECK (
    clearance_around_m >= 0 AND clearance_around_m <= 10 AND clearance_behind_m >= 0 AND clearance_behind_m <= 10)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The platform's generic library: what the editor offered from code, so
-- nothing changes for anyone on the day this runs.
INSERT INTO equipment_library
  (id, library_key, name, category, equipment_type, width_m, depth_m, height_m,
   clearance_around_m, clearance_behind_m, sort_order, source) VALUES
  ('01930000-0000-7000-8000-000000000001', 'treadmill', 'Treadmill', 'Cardio', 'treadmill', 0.9, 2.1, 1.6, 0.6, 2, 0, 'platform'),
  ('01930000-0000-7000-8000-000000000002', 'upright-bike', 'Upright bike', 'Cardio', 'exerciseBike', 0.6, 1.1, 1.4, 0.6, 0.6, 1, 'platform'),
  ('01930000-0000-7000-8000-000000000003', 'recumbent-bike', 'Recumbent bike', 'Cardio', 'exerciseBike', 0.7, 1.6, 1.3, 0.6, 0.6, 2, 'platform'),
  ('01930000-0000-7000-8000-000000000004', 'spin-bike', 'Spin bike', 'Cardio', 'exerciseBike', 0.55, 1.2, 1.2, 0.6, 0.6, 3, 'platform'),
  ('01930000-0000-7000-8000-000000000005', 'cross-trainer', 'Cross-trainer', 'Cardio', 'elliptical', 0.75, 2, 1.7, 0.6, 0.6, 4, 'platform'),
  ('01930000-0000-7000-8000-000000000006', 'rower', 'Rowing machine', 'Cardio', 'rowingMachine', 0.6, 2.4, 1, 0.6, 0.6, 5, 'platform'),
  ('01930000-0000-7000-8000-000000000007', 'stair-climber', 'Stair climber', 'Cardio', 'stairClimber', 0.9, 1.5, 2, 0.6, 0.6, 6, 'platform'),
  ('01930000-0000-7000-8000-000000000008', 'air-bike', 'Air bike', 'Cardio', 'exerciseBike', 0.65, 1.3, 1.3, 0.6, 0.6, 7, 'platform'),
  ('01930000-0000-7000-8000-000000000009', 'chest-press', 'Chest press', 'Strength', 'chestPress', 1.3, 1.5, 1.6, 0.6, 0.6, 108, 'platform'),
  ('01930000-0000-7000-8000-00000000000a', 'shoulder-press', 'Shoulder press', 'Strength', 'shoulderPress', 1.3, 1.4, 1.6, 0.6, 0.6, 109, 'platform'),
  ('01930000-0000-7000-8000-00000000000b', 'lat-pulldown', 'Lat pulldown', 'Strength', 'latPulldown', 1.3, 1.6, 2.2, 0.6, 0.6, 110, 'platform'),
  ('01930000-0000-7000-8000-00000000000c', 'seated-row', 'Seated row', 'Strength', 'seatedRow', 1.2, 1.9, 1.9, 0.6, 0.6, 111, 'platform'),
  ('01930000-0000-7000-8000-00000000000d', 'leg-press', 'Leg press', 'Strength', 'legPress', 1.6, 2.3, 1.5, 0.6, 0.6, 112, 'platform'),
  ('01930000-0000-7000-8000-00000000000e', 'leg-extension', 'Leg extension', 'Strength', 'legExtension', 1.2, 1.4, 1.5, 0.6, 0.6, 113, 'platform'),
  ('01930000-0000-7000-8000-00000000000f', 'leg-curl', 'Leg curl', 'Strength', 'legCurl', 1.2, 1.6, 1.5, 0.6, 0.6, 114, 'platform'),
  ('01930000-0000-7000-8000-000000000010', 'cable-crossover', 'Cable crossover', 'Strength', 'cableMachine', 4, 1, 2.3, 0.6, 0.6, 115, 'platform'),
  ('01930000-0000-7000-8000-000000000011', 'functional-trainer', 'Functional trainer', 'Strength', 'cableMachine', 1.6, 1.2, 2.2, 0.6, 0.6, 116, 'platform'),
  ('01930000-0000-7000-8000-000000000012', 'smith-machine', 'Smith machine', 'Strength', 'smithMachine', 2.2, 1.6, 2.3, 0.6, 0.6, 117, 'platform'),
  ('01930000-0000-7000-8000-000000000013', 'power-rack', 'Power rack', 'Free weights', 'squatRack', 1.7, 1.9, 2.4, 0.6, 0.6, 218, 'platform'),
  ('01930000-0000-7000-8000-000000000014', 'half-rack', 'Half rack', 'Free weights', 'squatRack', 1.6, 1.8, 2.3, 0.6, 0.6, 219, 'platform'),
  ('01930000-0000-7000-8000-000000000015', 'flat-bench', 'Flat bench', 'Free weights', 'bench', 0.6, 1.3, 0.45, 0.6, 0.6, 220, 'platform'),
  ('01930000-0000-7000-8000-000000000016', 'adjustable-bench', 'Adjustable bench', 'Free weights', 'bench', 0.7, 1.4, 0.5, 0.6, 0.6, 221, 'platform'),
  ('01930000-0000-7000-8000-000000000017', 'dumbbell-rack', 'Dumbbell rack, 10 pairs', 'Free weights', 'dumbbellRack', 2.4, 0.8, 0.9, 0.6, 0.6, 222, 'platform'),
  ('01930000-0000-7000-8000-000000000018', 'plate-tree', 'Plate tree', 'Free weights', 'plateTree', 0.7, 0.7, 1.2, 0.6, 0.6, 223, 'platform'),
  ('01930000-0000-7000-8000-000000000019', 'lifting-platform', 'Lifting platform', 'Free weights', 'liftingPlatform', 3, 2.4, 0.05, 1, 0.6, 224, 'platform'),
  ('01930000-0000-7000-8000-00000000001a', 'rig-4m', 'Functional rig, 4 m', 'Functional', 'rig', 4, 1.8, 2.7, 1, 0.6, 325, 'platform'),
  ('01930000-0000-7000-8000-00000000001b', 'kettlebell-rack', 'Kettlebell rack', 'Functional', 'kettlebellRack', 1.2, 0.6, 0.9, 0.6, 0.6, 326, 'platform'),
  ('01930000-0000-7000-8000-00000000001c', 'turf-lane', 'Turf sled lane, 10 m', 'Functional', 'turfLane', 2, 10, 0.02, 0.3, 0.3, 327, 'platform'),
  ('01930000-0000-7000-8000-00000000001d', 'box-stack', 'Plyo box stack', 'Functional', 'plyoBox', 0.9, 0.8, 0.8, 0.6, 0.6, 328, 'platform'),
  ('01930000-0000-7000-8000-00000000001e', 'stretch-mat', 'Stretch mat', 'Studio & recovery', 'stretchArea', 1, 2, 0.02, 0.3, 0.3, 429, 'platform'),
  ('01930000-0000-7000-8000-00000000001f', 'massage-chair', 'Recovery chair', 'Studio & recovery', 'recoveryChair', 0.8, 1.6, 1.2, 0.6, 0.6, 430, 'platform'),
  ('01930000-0000-7000-8000-000000000020', 'water-fountain', 'Water fountain', 'Studio & recovery', 'waterFountain', 0.5, 0.5, 1.1, 0.5, 0, 431, 'platform');
