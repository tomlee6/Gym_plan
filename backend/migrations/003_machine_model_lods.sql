-- Machine models made ready for the walkthrough (L-06, owned by the 3D team).
--
-- The GPU's own GLB (raw_glb_key) is kept, so the model can be made again
-- from it, turned another way, without the GPU. What the walkthrough loads
-- is its levels of detail, nearest first (lods: key, bytes, triangles and
-- texture size of each); glb_key is the nearest. turn_deg is the quarter
-- turn about the up axis that lines the model up with its scanned footprint,
-- and flags lists what the reviewer should check (its size against the
-- scan, a guessed front).

ALTER TABLE machine_models
  ADD COLUMN raw_glb_key VARCHAR(500) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER glb_key,
  ADD COLUMN lods        JSON NULL AFTER metadata_key,
  ADD COLUMN turn_deg    SMALLINT NOT NULL DEFAULT 0 AFTER size_h_m,
  ADD COLUMN flags       JSON NULL AFTER scale_error_pct;
