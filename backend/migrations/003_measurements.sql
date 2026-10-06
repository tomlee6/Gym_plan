-- CHANGE 1: high-accuracy floor plan measurements.
--
-- The measurements themselves live in plan_versions.plan_json, which stays
-- the single source of truth. These columns are a denormalised copy of the
-- overall room figures, so the owner's plan list and the reviewer queue can
-- show and sort on size without parsing every plan.
--
-- Every column is nullable: a version read before this migration keeps NULLs
-- until it is read again or the reviewer saves it, and nothing recomputes an
-- approved plan, whose content hash was taken over the bytes it was frozen
-- with.

ALTER TABLE plan_versions
  -- 'gymplan/1' for a plan read before this change, 'gymplan/2' after it.
  ADD COLUMN plan_format     VARCHAR(20)   NULL AFTER plan_json,
  -- Axis-aligned extent of the floor outline, in metres.
  ADD COLUMN width_m         DECIMAL(10,3) NULL AFTER area_m2,
  ADD COLUMN length_m        DECIMAL(10,3) NULL AFTER width_m,
  -- The wall run around the outline.
  ADD COLUMN perimeter_m     DECIMAL(10,3) NULL AFTER length_m,
  -- Floor level above the scan's origin, where RoomPlan reported a floor.
  ADD COLUMN elevation_m     DECIMAL(10,3) NULL AFTER perimeter_m,
  ADD COLUMN wall_count      INT           NULL AFTER elevation_m,
  ADD COLUMN opening_count   INT           NULL AFTER wall_count,
  ADD COLUMN object_count    INT           NULL AFTER opening_count,
  -- Objects carrying equipment metadata (CHANGE 2).
  ADD COLUMN equipment_count INT           NULL AFTER object_count;
