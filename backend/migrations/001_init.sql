-- Gym Plan schema.
--
-- Tenancy: every customer row carries org_id, and every query in the API
-- filters on the caller's org_id (PRD: tenant isolation at the data layer).
-- Ids are prefixed strings (e.g. "plan_…") so they are safe to expose and
-- easy to recognise in logs.

CREATE TABLE organisations (
  id           VARCHAR(40)  NOT NULL PRIMARY KEY,
  name         VARCHAR(200) NOT NULL,
  -- Plans (new versions) allowed per calendar month on the current tier.
  plan_quota   INT          NOT NULL DEFAULT 10,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE facilities (
  id           VARCHAR(40)  NOT NULL PRIMARY KEY,
  org_id       VARCHAR(40)  NOT NULL,
  name         VARCHAR(200) NOT NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_facility_name (org_id, name),
  CONSTRAINT fk_facility_org FOREIGN KEY (org_id) REFERENCES organisations (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE users (
  id                    VARCHAR(40)  NOT NULL PRIMARY KEY,
  org_id                VARCHAR(40)  NOT NULL,
  email                 VARCHAR(254) NOT NULL,
  password_hash         VARCHAR(100) NOT NULL,
  name                  VARCHAR(200) NOT NULL,
  -- owner: the gym side; surveyor: captures only; reviewer: Flex staff.
  role                  ENUM('owner', 'surveyor', 'reviewer') NOT NULL,
  -- Shown as e.g. "Owner & Surveyor" on the profile.
  role_label            VARCHAR(100) NOT NULL,
  default_facility_id   VARCHAR(40)  NULL,
  active                TINYINT(1)   NOT NULL DEFAULT 1,
  created_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_user_email (email),
  KEY ix_user_org (org_id),
  CONSTRAINT fk_user_org FOREIGN KEY (org_id) REFERENCES organisations (id),
  CONSTRAINT fk_user_facility FOREIGN KEY (default_facility_id) REFERENCES facilities (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE user_settings (
  user_id                  VARCHAR(40) NOT NULL PRIMARY KEY,
  upload_on_mobile_data    TINYINT(1)  NOT NULL DEFAULT 1,
  warn_before_photos       TINYINT(1)  NOT NULL DEFAULT 1,
  updated_at               DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                       ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_settings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Refresh tokens are stored hashed; the raw token only ever lives on the
-- phone. Rotated on every refresh.
CREATE TABLE refresh_tokens (
  id           VARCHAR(40)  NOT NULL PRIMARY KEY,
  user_id      VARCHAR(40)  NOT NULL,
  token_hash   CHAR(64)     NOT NULL,
  expires_at   DATETIME(3)  NOT NULL,
  revoked_at   DATETIME(3)  NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_refresh_hash (token_hash),
  CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE password_resets (
  id           VARCHAR(40)  NOT NULL PRIMARY KEY,
  user_id      VARCHAR(40)  NOT NULL,
  token_hash   CHAR(64)     NOT NULL,
  expires_at   DATETIME(3)  NOT NULL,
  used_at      DATETIME(3)  NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_reset_hash (token_hash),
  CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- One plan per facility level. Each capture or recapture adds a version;
-- versions are never edited once reviewed (PRD: rejected versions stay in
-- history).
CREATE TABLE plans (
  id           VARCHAR(40) NOT NULL PRIMARY KEY,
  org_id       VARCHAR(40) NOT NULL,
  facility_id  VARCHAR(40) NOT NULL,
  level        INT         NOT NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_plan_level (facility_id, level),
  KEY ix_plan_org (org_id),
  CONSTRAINT fk_plan_org FOREIGN KEY (org_id) REFERENCES organisations (id),
  CONSTRAINT fk_plan_facility FOREIGN KEY (facility_id) REFERENCES facilities (id)
) ENGINE=InnoDB;

CREATE TABLE captures (
  id                VARCHAR(40)  NOT NULL PRIMARY KEY,
  org_id            VARCHAR(40)  NOT NULL,
  user_id           VARCHAR(40)  NOT NULL,
  facility_id       VARCHAR(40)  NOT NULL,
  level             INT          NOT NULL,
  -- The app's retry key: the same key returns the same capture.
  idempotency_key   VARCHAR(100) NOT NULL,
  source            ENUM('lidar', 'simulated') NOT NULL,
  metadata          JSON         NOT NULL,
  status            ENUM('registered', 'uploading', 'received') NOT NULL DEFAULT 'registered',
  received_at       DATETIME(3)  NULL,
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_capture_idempotency (user_id, idempotency_key),
  KEY ix_capture_org (org_id),
  CONSTRAINT fk_capture_org FOREIGN KEY (org_id) REFERENCES organisations (id),
  CONSTRAINT fk_capture_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_capture_facility FOREIGN KEY (facility_id) REFERENCES facilities (id)
) ENGINE=InnoDB;

CREATE TABLE plan_versions (
  id                  VARCHAR(40)  NOT NULL PRIMARY KEY,
  org_id              VARCHAR(40)  NOT NULL,
  plan_id             VARCHAR(40)  NOT NULL,
  version             INT          NOT NULL,
  status              ENUM('uploading', 'processing', 'in_review', 'ready', 'recapture')
                      NOT NULL,
  capture_id          VARCHAR(40)  NULL,
  submitted_at        DATETIME(3)  NULL,
  coverage            DECIMAL(5,4) NULL,
  override_reason     VARCHAR(500) NULL,
  area_m2             DECIMAL(10,2) NULL,
  review_started_at   DATETIME(3)  NULL,
  reviewed_by         VARCHAR(40)  NULL,
  reviewed_at         DATETIME(3)  NULL,
  review_seconds      INT          NULL,
  rejection_reason    VARCHAR(200) NULL,
  reviewer_note       TEXT         NULL,
  -- Set once the walkthrough is generated.
  walkthrough_url     VARCHAR(500) NULL,
  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                   ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_plan_version (plan_id, version),
  KEY ix_version_org (org_id),
  CONSTRAINT fk_version_org FOREIGN KEY (org_id) REFERENCES organisations (id),
  CONSTRAINT fk_version_plan FOREIGN KEY (plan_id) REFERENCES plans (id),
  CONSTRAINT fk_version_capture FOREIGN KEY (capture_id) REFERENCES captures (id),
  CONSTRAINT fk_version_reviewer FOREIGN KEY (reviewed_by) REFERENCES users (id)
) ENGINE=InnoDB;

CREATE TABLE capture_files (
  id              VARCHAR(40)  NOT NULL PRIMARY KEY,
  capture_id      VARCHAR(40)  NOT NULL,
  name            VARCHAR(200) NOT NULL,
  kind            ENUM('model', 'room', 'photo') NOT NULL,
  bytes           BIGINT       NOT NULL,
  content_type    VARCHAR(100) NOT NULL,
  part_size       INT          NOT NULL,
  part_count      INT          NOT NULL,
  storage_key     VARCHAR(500) NOT NULL,
  upload_id       VARCHAR(500) NOT NULL,
  status          ENUM('uploading', 'stored') NOT NULL DEFAULT 'uploading',
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_capture_file_name (capture_id, name),
  CONSTRAINT fk_file_capture FOREIGN KEY (capture_id) REFERENCES captures (id)
) ENGINE=InnoDB;

CREATE TABLE share_links (
  id                VARCHAR(40)  NOT NULL PRIMARY KEY,
  org_id            VARCHAR(40)  NOT NULL,
  plan_version_id   VARCHAR(40)  NOT NULL,
  token             VARCHAR(64)  NOT NULL,
  created_by        VARCHAR(40)  NOT NULL,
  expires_at        DATETIME(3)  NULL,
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_share_token (token),
  CONSTRAINT fk_share_version FOREIGN KEY (plan_version_id) REFERENCES plan_versions (id),
  CONSTRAINT fk_share_user FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB;
