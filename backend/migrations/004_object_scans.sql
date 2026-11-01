-- 3D object scans from the phone (Apple Object Capture).
--
-- A surveyor walks round one thing (a machine, a rack, a bench) and the
-- iPhone builds a photo-textured USDZ model of it on the device. Each scan
-- is one file, kept per account and, when the app knows it, per facility.
-- It is not a capture: it adds no plan version and nothing reviews it.
--
-- The upload is the same chunked, signed-URL upload as a capture's files,
-- one file per scan, so its multipart state lives on the row.

CREATE TABLE object_scans (
  id               CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id       CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  facility_id      CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  -- Who scanned it.
  user_id          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- The app's retry key: the same key returns the same scan.
  idempotency_key  VARCHAR(100) NOT NULL,
  name             VARCHAR(120) NOT NULL,
  status           ENUM('uploading', 'ready') NOT NULL DEFAULT 'uploading',
  -- How many photos Object Capture built it from.
  photo_count      SMALLINT UNSIGNED NULL,
  bytes            BIGINT UNSIGNED NOT NULL,
  content_type     VARCHAR(100) NOT NULL,
  part_size        INT UNSIGNED NOT NULL,
  part_count       INT UNSIGNED NOT NULL,
  storage_key      VARCHAR(500) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  upload_id        VARCHAR(500) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scanned_at       DATETIME(3) NULL,
  ready_at         DATETIME(3) NULL,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_object_scan_idempotency (user_id, idempotency_key),
  UNIQUE KEY uq_object_scan_key (storage_key),
  KEY ix_object_scan_account (account_id, created_at),
  CONSTRAINT fk_object_scan_account FOREIGN KEY (account_id) REFERENCES accounts (id),
  CONSTRAINT fk_object_scan_facility FOREIGN KEY (facility_id) REFERENCES facilities (id),
  CONSTRAINT fk_object_scan_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT ck_object_scan_parts CHECK (part_count > 0 AND part_size > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
