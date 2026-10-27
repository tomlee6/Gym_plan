-- Gym Plan schema: one clean baseline (task plan C-01).
--
-- Nothing has been deployed yet, so the four earlier migrations were
-- replaced by this single file built to the target schema rather than
-- layered with more ALTER statements. From here on: one change per file.
--
-- Conventions
--   * Every primary key is a UUIDv7 in CHAR(36) ASCII (C-02): time-ordered,
--     so inserts land at the end of each index. Every column ending in _id
--     is a foreign key; `ref` is the human reference (e.g. EQ-001).
--   * Times are DATETIME(3) in UTC (C-12): each connection sets
--     time_zone = '+00:00' and the code writes UTC_TIMESTAMP(3) only.
--   * Every table declares utf8mb4_0900_ai_ci; ids are ascii_bin (C-13).
--   * Tenancy: customer rows carry account_id, and children use composite
--     foreign keys (account_id, parent_id) -> parent (account_id, id), so a
--     child's account can never differ from its parent's (C-08).
--   * Uniqueness the code relies on is enforced here too (C-09), mostly by
--     UNIQUE indexes on generated columns that are NULL except in the state
--     that must be unique.
--   * Ranges the API validates are CHECK constraints as well (C-11).
--   * MySQL 8.4 LTS (C-14).

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------
-- Accounts and people (C-03; B-01..B-05).

CREATE TABLE accounts (
  id            CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name          VARCHAR(200) NOT NULL,
  -- New plans per calendar month.
  plan_quota    INT UNSIGNED NOT NULL DEFAULT 10,
  region        ENUM('ap-southeast-2') NOT NULL DEFAULT 'ap-southeast-2',
  status        ENUM('active', 'removed') NOT NULL DEFAULT 'active',
  -- Set by account removal (ACC-07).
  removed_at    DATETIME(3) NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_account_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One row per person. The Hub holds the password; users are matched by
-- the Hub's user id only, never by email (B-05).
CREATE TABLE users (
  id               CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  hub_user_id      VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- Kept in step with the Hub by its events; used for notifications.
  email            VARCHAR(254) NOT NULL,
  name             VARCHAR(200) NOT NULL,
  -- Flex staff only; staff see every account.
  staff_role       ENUM('reviewer', 'admin') NULL,
  status           ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
  last_sign_in_at  DATETIME(3) NULL,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_hub (hub_user_id),
  KEY ix_user_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Which gym accounts a user belongs to, and the role in each (B-04).
CREATE TABLE memberships (
  account_id   CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id      CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  role         ENUM('owner', 'surveyor') NOT NULL,
  created_by   CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (account_id, user_id),
  KEY ix_membership_user (user_id),
  CONSTRAINT fk_membership_account FOREIGN KEY (account_id) REFERENCES accounts (id),
  CONSTRAINT fk_membership_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_membership_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Pending access, matched on the first Hub sign-in with a verified email.
CREATE TABLE invites (
  id                CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id        CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  email             VARCHAR(254) NOT NULL,
  role              ENUM('owner', 'surveyor') NOT NULL,
  invited_by        CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  expires_at        DATETIME(3) NOT NULL,
  accepted_at       DATETIME(3) NULL,
  accepted_user_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  revoked_at        DATETIME(3) NULL,
  -- The email while the invite is open, else NULL: one open invite per
  -- email per account (C-09).
  open_email        VARCHAR(254) GENERATED ALWAYS AS (
                      IF(accepted_at IS NULL AND revoked_at IS NULL, email, NULL)) STORED,
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_invite_open (account_id, open_email),
  KEY ix_invite_email (email),
  CONSTRAINT fk_invite_account FOREIGN KEY (account_id) REFERENCES accounts (id),
  CONSTRAINT fk_invite_by FOREIGN KEY (invited_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_invite_user FOREIGN KEY (accepted_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Flex refresh tokens issued after a Hub sign-in (B-06). Stored as SHA-256
-- only and rotated on every use.
CREATE TABLE sessions (
  id                   CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id              CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  token_hash           CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  client               ENUM('web', 'ios') NOT NULL,
  device_label         VARCHAR(100) NULL,
  -- From the Hub identity (sid), so a Hub sign-out can end this session.
  hub_session_id       VARCHAR(64) NULL,
  -- Sliding expiry, and the hard limit no refresh can push past.
  expires_at           DATETIME(3) NOT NULL,
  absolute_expires_at  DATETIME(3) NOT NULL,
  last_used_at         DATETIME(3) NULL,
  revoked_at           DATETIME(3) NULL,
  created_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_session_hash (token_hash),
  KEY ix_session_user (user_id, revoked_at),
  CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Capture settings per user (unchanged).
CREATE TABLE user_settings (
  user_id                CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  upload_on_mobile_data  BOOLEAN NOT NULL DEFAULT TRUE,
  warn_before_photos     BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id),
  CONSTRAINT fk_settings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Each Hub event processed once (B-02).
CREATE TABLE hub_events (
  event_id     VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  type         VARCHAR(40) NOT NULL,
  received_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------
-- Sites and levels.

CREATE TABLE facilities (
  id          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name        VARCHAR(200) NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_facility_account_id (account_id, id),
  UNIQUE KEY uq_facility_name (account_id, name),
  CONSTRAINT fk_facility_account FOREIGN KEY (account_id) REFERENCES accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One level of one facility. Each capture or revision adds a version.
CREATE TABLE plans (
  id            CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id    CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  facility_id   CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  level_number  SMALLINT NOT NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_plan_account_id (account_id, id),
  UNIQUE KEY uq_plan_level (facility_id, level_number),
  CONSTRAINT fk_plan_facility FOREIGN KEY (account_id, facility_id) REFERENCES facilities (account_id, id),
  CONSTRAINT ck_plan_level CHECK (level_number BETWEEN -5 AND 200)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------
-- Captures: a scan from the app or an uploaded drawing (C-06). The typed
-- columns replace the old metadata JSON; versions read them through
-- capture_id instead of keeping copies.

CREATE TABLE captures (
  id                 CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id         CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- Who captured it.
  user_id            CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- The app's retry key: the same key returns the same capture.
  idempotency_key    VARCHAR(100) NOT NULL,
  source             ENUM('lidar', 'upload', 'simulated') NOT NULL,
  status             ENUM('registered', 'uploading', 'received') NOT NULL DEFAULT 'registered',
  floor_to_floor_m   DECIMAL(5,2) NULL,
  coverage           DECIMAL(5,4) NULL,
  outline_closed     BOOLEAN NULL,
  override_reason    VARCHAR(500) NULL,
  -- The surveyor's own reading of the area, when the app reported one.
  area_m2            DECIMAL(10,2) NULL,
  duration_s         INT UNSIGNED NULL,
  photo_count        SMALLINT UNSIGNED NULL,
  weak_wall_count    SMALLINT UNSIGNED NULL,
  -- Error left after the control distances corrected the scale (F-05).
  scale_residual_mm  DECIMAL(8,2) NULL,
  captured_at        DATETIME(3) NULL,
  received_at        DATETIME(3) NULL,
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_capture_account_id (account_id, id),
  UNIQUE KEY uq_capture_idempotency (user_id, idempotency_key),
  CONSTRAINT fk_capture_account FOREIGN KEY (account_id) REFERENCES accounts (id),
  CONSTRAINT fk_capture_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT ck_capture_coverage CHECK (coverage IS NULL OR coverage BETWEEN 0 AND 1),
  CONSTRAINT ck_capture_floor CHECK (floor_to_floor_m IS NULL OR floor_to_floor_m > 0),
  CONSTRAINT ck_capture_area CHECK (area_m2 IS NULL OR area_m2 >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Extra facts for an uploaded drawing (UPL-01..03).
CREATE TABLE drawing_details (
  capture_id       CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  input_type       ENUM('pdf', 'dwg', 'jpg', 'png') NOT NULL,
  original_name    VARCHAR(200) NOT NULL,
  page             SMALLINT UNSIGNED NULL,
  page_count       SMALLINT UNSIGNED NULL,
  image_width_px   INT UNSIGNED NULL,
  image_height_px  INT UNSIGNED NULL,
  -- The owner's scale line, in image pixels.
  scale_ax         DECIMAL(10,2) NULL,
  scale_ay         DECIMAL(10,2) NULL,
  scale_bx         DECIMAL(10,2) NULL,
  scale_by         DECIMAL(10,2) NULL,
  scale_length_m   DECIMAL(8,3) NULL,
  ceiling_height_m DECIMAL(5,2) NULL,
  PRIMARY KEY (capture_id),
  CONSTRAINT fk_drawing_capture FOREIGN KEY (capture_id) REFERENCES captures (id) ON DELETE CASCADE,
  CONSTRAINT ck_drawing_scale CHECK (scale_length_m IS NULL OR scale_length_m > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Points tagged during the scan (RDR-03).
CREATE TABLE capture_tags (
  id          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  capture_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  type        ENUM('ceiling', 'fireExit', 'mirror', 'power', 'stair') NOT NULL,
  -- Metres in the scan's floor frame.
  x           DECIMAL(10,4) NOT NULL,
  y           DECIMAL(10,4) NOT NULL,
  -- Ceiling tags only.
  height_m    DECIMAL(6,3) NULL,
  PRIMARY KEY (id),
  KEY ix_tag_capture (capture_id),
  CONSTRAINT fk_tag_capture FOREIGN KEY (capture_id) REFERENCES captures (id) ON DELETE CASCADE,
  CONSTRAINT ck_tag_height CHECK (height_m IS NULL OR height_m > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Laser-measured distances used to correct the scale (F-03, F-05).
CREATE TABLE control_distances (
  id          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  capture_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- Ends, in metres, as marked on the scan.
  ax          DECIMAL(10,4) NOT NULL,
  ay          DECIMAL(10,4) NOT NULL,
  bx          DECIMAL(10,4) NOT NULL,
  `by`        DECIMAL(10,4) NOT NULL,
  -- The laser reading, and the scan's length before correction.
  measured_m  DECIMAL(8,4) NOT NULL,
  scanned_m   DECIMAL(8,4) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_control_capture (capture_id),
  CONSTRAINT fk_control_capture FOREIGN KEY (capture_id) REFERENCES captures (id) ON DELETE CASCADE,
  CONSTRAINT ck_control_positive CHECK (measured_m > 0 AND scanned_m > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Every uploaded file: scan, mesh, frames, photos, drawings, videos.
CREATE TABLE capture_files (
  id            CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  capture_id    CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind          ENUM('model', 'room', 'mesh', 'keyframes', 'photo', 'source', 'source_image',
                     'video', 'thumbnail', 'frames') NOT NULL,
  name          VARCHAR(200) NOT NULL,
  bytes         BIGINT UNSIGNED NOT NULL,
  content_type  VARCHAR(100) NOT NULL,
  sha256        CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  part_size     INT UNSIGNED NOT NULL,
  part_count    INT UNSIGNED NOT NULL,
  storage_key   VARCHAR(500) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  upload_id     VARCHAR(500) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status        ENUM('uploading', 'stored') NOT NULL DEFAULT 'uploading',
  -- Set once the retention job has moved the object to cold storage (E-05).
  archived_at   DATETIME(3) NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_capture_file_name (capture_id, name),
  UNIQUE KEY uq_capture_file_key (storage_key),
  CONSTRAINT fk_file_capture FOREIGN KEY (capture_id) REFERENCES captures (id),
  CONSTRAINT ck_file_parts CHECK (part_count > 0 AND part_size > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------
-- Machines (C-07). Rule: capture rows are the surveyor's original record;
-- the approved plan is the truth; models attach to the machine row.

-- Machine types, once each: the global list (account_id NULL) plus custom
-- types per account, so 'treadmill' and 'Treadmill' are one thing.
CREATE TABLE equipment_types (
  id          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  code        VARCHAR(40) NOT NULL,
  label       VARCHAR(80) NOT NULL,
  -- The account id, or 'global' for the shared list.
  scope       VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin
              GENERATED ALWAYS AS (COALESCE(account_id, 'global')) STORED,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_equipment_type (scope, code),
  CONSTRAINT fk_equipment_type_account FOREIGN KEY (account_id) REFERENCES accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- A machine on a capture. Replaces capture_equipment.
CREATE TABLE machines (
  id                  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  capture_id          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- The reference the app and the reviewer use, e.g. 'EQ-001'.
  ref                 VARCHAR(16) NOT NULL,
  equipment_type_id   CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  name                VARCHAR(120) NOT NULL,
  -- Metres in the plan's frame; null until the machine is placed.
  x                   DECIMAL(10,4) NULL,
  y                   DECIMAL(10,4) NULL,
  elevation_m         DECIMAL(10,4) NULL,
  width_m             DECIMAL(10,4) NULL,
  depth_m             DECIMAL(10,4) NULL,
  height_m            DECIMAL(10,4) NULL,
  rotation_deg        DECIMAL(7,3) NULL,
  confidence          DECIMAL(5,4) NULL,
  source              ENUM('roomplan', 'mesh', 'surveyor', 'reviewer') NOT NULL DEFAULT 'surveyor',
  -- Reuse another machine's model (L-08).
  same_as_machine_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_machine_account_id (account_id, id),
  UNIQUE KEY uq_machine_ref (capture_id, ref),
  CONSTRAINT fk_machine_capture FOREIGN KEY (account_id, capture_id) REFERENCES captures (account_id, id),
  CONSTRAINT fk_machine_type FOREIGN KEY (equipment_type_id) REFERENCES equipment_types (id),
  CONSTRAINT fk_machine_same_as FOREIGN KEY (same_as_machine_id) REFERENCES machines (id) ON DELETE SET NULL,
  CONSTRAINT ck_machine_sizes CHECK (
    (width_m IS NULL OR width_m > 0) AND (depth_m IS NULL OR depth_m > 0) AND (height_m IS NULL OR height_m > 0)),
  CONSTRAINT ck_machine_confidence CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The 360° walk-around of one machine. Replaces equipment_videos. One
-- direction only: the video names its files; files never name the machine.
CREATE TABLE machine_videos (
  id                 CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  machine_id         CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  video_file_id      CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  thumbnail_file_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  -- ARKit frames with positions and depth (I-05), when the app sends them.
  frames_file_id     CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  duration_s         DECIMAL(8,2) NULL,
  status             ENUM('uploading', 'ready', 'failed') NOT NULL DEFAULT 'uploading',
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_video_machine (machine_id),
  UNIQUE KEY uq_video_file (video_file_id),
  CONSTRAINT fk_video_machine FOREIGN KEY (machine_id) REFERENCES machines (id) ON DELETE CASCADE,
  CONSTRAINT fk_video_file FOREIGN KEY (video_file_id) REFERENCES capture_files (id),
  CONSTRAINT fk_video_thumbnail FOREIGN KEY (thumbnail_file_id) REFERENCES capture_files (id),
  CONSTRAINT fk_video_frames FOREIGN KEY (frames_file_id) REFERENCES capture_files (id),
  CONSTRAINT ck_video_duration CHECK (duration_s IS NULL OR duration_s > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- A 3D model built from a machine's 360° video (owned by the 3D team, C-15;
-- included here because the owner status and review read its state).
CREATE TABLE machine_models (
  id                   CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id           CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  machine_id           CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  route                ENUM('measured', 'generated') NOT NULL,
  generator_version    VARCHAR(20) NOT NULL,
  -- Same input, same model.
  input_hash           CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status               ENUM('queued', 'building', 'awaiting_review', 'approved', 'rejected', 'failed')
                       NOT NULL DEFAULT 'queued',
  glb_key              VARCHAR(500) CHARACTER SET ascii COLLATE ascii_bin NULL,
  bytes                BIGINT UNSIGNED NULL,
  triangle_count       INT UNSIGNED NULL,
  size_w_m             DECIMAL(8,4) NULL,
  size_d_m             DECIMAL(8,4) NULL,
  size_h_m             DECIMAL(8,4) NULL,
  -- Against the scanned box.
  scale_error_pct      DECIMAL(6,2) NULL,
  failure_reason       VARCHAR(500) NULL,
  reviewed_by          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  reviewed_at          DATETIME(3) NULL,
  -- One approved model per machine (C-09).
  approved_machine_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin
                       GENERATED ALWAYS AS (IF(status = 'approved', machine_id, NULL)) STORED,
  created_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_machine_model_approved (approved_machine_id),
  KEY ix_machine_model_machine (machine_id, status),
  -- No cascade: MySQL forbids one on the base of a stored generated column
  -- (approved_machine_id), so removal deletes models before machines.
  CONSTRAINT fk_machine_model_machine FOREIGN KEY (account_id, machine_id) REFERENCES machines (account_id, id),
  CONSTRAINT fk_machine_model_reviewer FOREIGN KEY (reviewed_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------
-- Plan versions: each version of a level's plan, frozen once approved.

CREATE TABLE plan_versions (
  id                       CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id               CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  plan_id                  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version_no               INT UNSIGNED NOT NULL,
  -- capture: from the app or an upload; revision: a change after approval
  -- (REV-09), which does not count against the monthly quota.
  origin                   ENUM('capture', 'revision') NOT NULL DEFAULT 'capture',
  based_on_version_id      CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  capture_id               CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status                   ENUM('uploading', 'processing', 'in_review', 'recapture', 'generating',
                                'generation_failed', 'ready', 'superseded') NOT NULL,
  -- The plan (shared/plan): produced by plan reading, edited by the
  -- reviewer, frozen on approval.
  plan_json                JSON NULL,
  -- Stale-save check.
  plan_revision            INT UNSIGNED NOT NULL DEFAULT 0,
  plan_saved_at            DATETIME(3) NULL,
  plan_saved_by            CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  submitted_at             DATETIME(3) NULL,
  review_started_at        DATETIME(3) NULL,
  review_last_activity_at  DATETIME(3) NULL,
  reviewed_at              DATETIME(3) NULL,
  superseded_at            DATETIME(3) NULL,
  reviewed_by              CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  -- Reviewer time excluding idle spells over 10 minutes (REV-10).
  review_active_seconds    INT UNSIGNED NOT NULL DEFAULT 0,
  rejection_reason         ENUM('incomplete_coverage', 'wrong_scale', 'unreadable_source',
                                'wrong_facility', 'other') NULL,
  reviewer_note            TEXT NULL,
  -- SHA-256 of the canonical plan at approval (REV-07).
  content_hash             CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,

  -- Measurements, always computed from plan_json so they can never
  -- disagree with it (C-05). `room` is refreshed by withMeasurements on
  -- every write of the plan.
  plan_format      VARCHAR(20)   GENERATED ALWAYS AS (plan_json ->> '$.format') STORED,
  area_m2          DECIMAL(10,2) GENERATED ALWAYS AS (CAST(NULLIF(plan_json ->> '$.room.areaM2', 'null') AS DECIMAL(10,2))) STORED,
  width_m          DECIMAL(10,3) GENERATED ALWAYS AS (CAST(NULLIF(plan_json ->> '$.room.widthM', 'null') AS DECIMAL(10,3))) STORED,
  length_m         DECIMAL(10,3) GENERATED ALWAYS AS (CAST(NULLIF(plan_json ->> '$.room.lengthM', 'null') AS DECIMAL(10,3))) STORED,
  perimeter_m      DECIMAL(10,3) GENERATED ALWAYS AS (CAST(NULLIF(plan_json ->> '$.room.perimeterM', 'null') AS DECIMAL(10,3))) STORED,
  wall_count       INT UNSIGNED  GENERATED ALWAYS AS (COALESCE(JSON_LENGTH(plan_json, '$.walls'), 0)) STORED,
  opening_count    INT UNSIGNED  GENERATED ALWAYS AS (COALESCE(JSON_LENGTH(plan_json, '$.openings'), 0)) STORED,
  machine_count    INT UNSIGNED  GENERATED ALWAYS AS (
                     COALESCE(JSON_LENGTH(JSON_EXTRACT(plan_json, '$.objects[*].equipment.equipmentId')), 0)) STORED,
  open_flag_count  INT UNSIGNED  GENERATED ALWAYS AS (
                     COALESCE(JSON_LENGTH(JSON_SEARCH(plan_json, 'all', 'open', NULL, '$.flags[*].status')), 0)) STORED,
  -- One ready version per plan, and one being generated (C-09).
  ready_plan_id       CHAR(36) CHARACTER SET ascii COLLATE ascii_bin
                      GENERATED ALWAYS AS (IF(status = 'ready', plan_id, NULL)) STORED,
  generating_plan_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin
                      GENERATED ALWAYS AS (IF(status = 'generating', plan_id, NULL)) STORED,

  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_version_account_id (account_id, id),
  UNIQUE KEY uq_plan_version (plan_id, version_no),
  UNIQUE KEY uq_version_ready (ready_plan_id),
  UNIQUE KEY uq_version_generating (generating_plan_id),
  -- The reviewer queue, and weekly reviewer time (C-10).
  KEY ix_version_queue (status, submitted_at),
  KEY ix_version_reviewer (reviewed_by, reviewed_at),
  KEY ix_version_capture (capture_id),
  KEY ix_version_account_created (account_id, origin, created_at),
  CONSTRAINT fk_version_plan FOREIGN KEY (account_id, plan_id) REFERENCES plans (account_id, id),
  CONSTRAINT fk_version_capture FOREIGN KEY (account_id, capture_id) REFERENCES captures (account_id, id),
  CONSTRAINT fk_version_based_on FOREIGN KEY (based_on_version_id) REFERENCES plan_versions (id),
  CONSTRAINT fk_version_saved_by FOREIGN KEY (plan_saved_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_version_reviewer FOREIGN KEY (reviewed_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The 3D level built from an approved version (owned by the 3D team, C-15;
-- the approval flow writes and reads it).
CREATE TABLE generated_models (
  id                 CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id         CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  plan_version_id    CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  generator_version  VARCHAR(20) NOT NULL,
  -- The approved plan's hash.
  content_hash       CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status             ENUM('queued', 'building', 'ready', 'failed') NOT NULL DEFAULT 'queued',
  glb_key            VARCHAR(500) CHARACTER SET ascii COLLATE ascii_bin NULL,
  bytes              BIGINT UNSIGNED NULL,
  triangle_count     INT UNSIGNED NULL,
  failure_reason     VARCHAR(500) NULL,
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at        DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_generated_model (plan_version_id, generator_version),
  CONSTRAINT fk_generated_version FOREIGN KEY (account_id, plan_version_id) REFERENCES plan_versions (account_id, id)
                                  ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- View-only links that need no sign-in (VIEW-07). Only the token's hash is
-- stored (D-06); a link opens its plan's newest ready version.
CREATE TABLE share_links (
  id             CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id     CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  plan_id        CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  token_hash     CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_by     CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  expires_at     DATETIME(3) NULL,
  revoked_at     DATETIME(3) NULL,
  -- One live link per plan (C-09).
  active_plan_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin
                 GENERATED ALWAYS AS (IF(revoked_at IS NULL, plan_id, NULL)) STORED,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_share_token (token_hash),
  UNIQUE KEY uq_share_active (active_plan_id),
  KEY ix_share_plan (plan_id),
  CONSTRAINT fk_share_plan FOREIGN KEY (account_id, plan_id) REFERENCES plans (account_id, id),
  CONSTRAINT fk_share_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------
-- Background work (E-01): the jobs table is also the outbox. A job is
-- written in the same transaction as the change that needs it; the
-- dispatcher sends it to SQS (enqueued_at) and a worker runs it.

CREATE TABLE jobs (
  id            CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id    CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  kind          ENUM('scan.read', 'drawing.read', 'plan.generate', 'asset.build',
                     'account.remove', 'retention') NOT NULL,
  -- The version, machine or account the job is about.
  subject_id    CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- The same work is queued once.
  dedupe_key    VARCHAR(100) NOT NULL,
  payload       JSON NULL,
  status        ENUM('queued', 'running', 'succeeded', 'failed', 'dead') NOT NULL DEFAULT 'queued',
  attempts      TINYINT UNSIGNED NOT NULL DEFAULT 0,
  last_error    TEXT NULL,
  run_after     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- NULL until the dispatcher has sent it to the queue.
  enqueued_at   DATETIME(3) NULL,
  started_at    DATETIME(3) NULL,
  finished_at   DATETIME(3) NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_job_dedupe (kind, dedupe_key),
  KEY ix_job_status (status, run_after),
  KEY ix_job_outbox (enqueued_at, status),
  KEY ix_job_subject (subject_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Every state change and admin action; also the plan history (E-04). No
-- foreign keys on purpose, so it outlives removed data; the readable
-- snapshots are cleared on account removal.
CREATE TABLE audit_log (
  id             CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id     CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  actor_user_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  actor_name     VARCHAR(200) NULL,
  action         VARCHAR(40) NOT NULL,
  target_type    VARCHAR(20) NOT NULL,
  target_id      CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  target_label   VARCHAR(300) NULL,
  version_no     INT UNSIGNED NULL,
  detail         JSON NULL,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_audit_target (target_type, target_id, created_at),
  KEY ix_audit_account (account_id, created_at),
  KEY ix_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The global machine type list (C-07). Accounts add their own.
INSERT INTO equipment_types (id, account_id, code, label) VALUES
  ('01920000-0000-7000-8000-000000000001', NULL, 'treadmill', 'Treadmill'),
  ('01920000-0000-7000-8000-000000000002', NULL, 'legPress', 'Leg press'),
  ('01920000-0000-7000-8000-000000000003', NULL, 'chestPress', 'Chest press'),
  ('01920000-0000-7000-8000-000000000004', NULL, 'latPulldown', 'Lat pulldown'),
  ('01920000-0000-7000-8000-000000000005', NULL, 'cableMachine', 'Cable machine'),
  ('01920000-0000-7000-8000-000000000006', NULL, 'exerciseBike', 'Exercise bike'),
  ('01920000-0000-7000-8000-000000000007', NULL, 'elliptical', 'Elliptical'),
  ('01920000-0000-7000-8000-000000000008', NULL, 'squatRack', 'Squat rack'),
  ('01920000-0000-7000-8000-000000000009', NULL, 'bench', 'Bench'),
  ('01920000-0000-7000-8000-00000000000a', NULL, 'dumbbellRack', 'Dumbbell rack'),
  ('01920000-0000-7000-8000-00000000000b', NULL, 'smithMachine', 'Smith machine'),
  ('01920000-0000-7000-8000-00000000000c', NULL, 'rowingMachine', 'Rowing machine');
