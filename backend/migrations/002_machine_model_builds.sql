-- Machine model builds (L-07, owned by the 3D team).
--
-- What a build needs beyond the baseline's columns: the seed it was made
-- with (TRELLIS.2 invents the sides the video does not show, so another
-- seed gives another model), which try at building it this is (a failed
-- build is tried again on the same row, and each try is its own job), the
-- GPU job building it, the key of the worker's metadata.json beside the
-- GLB, and the reviewer's note on an approval or rejection.
--
-- One row per (machine, route, input, generator version, seed): the same
-- video built again by the same generator with the same seed is the same
-- model, so asking for it again finds the row rather than making another.

ALTER TABLE machine_models
  ADD COLUMN seed         INT UNSIGNED NULL AFTER input_hash,
  ADD COLUMN attempt      SMALLINT UNSIGNED NOT NULL DEFAULT 1 AFTER status,
  ADD COLUMN gpu_job_id   VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER attempt,
  ADD COLUMN metadata_key VARCHAR(500) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER glb_key,
  ADD COLUMN review_note  VARCHAR(500) NULL AFTER failure_reason,
  ADD UNIQUE KEY uq_machine_model_input (machine_id, route, input_hash, generator_version, seed);
