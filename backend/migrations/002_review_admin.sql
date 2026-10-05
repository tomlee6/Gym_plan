-- The web module: reviewer editor, owner uploads, admin and audit.

-- Admin: Next XR platform operations (PRD section 3). Operator-wide like
-- reviewers, and may review.
ALTER TABLE users
  MODIFY role ENUM('owner', 'surveyor', 'reviewer', 'admin') NOT NULL;

-- Accounts: data region shown to admins; set when the account's data has
-- been removed on request (ACC-07).
ALTER TABLE organisations
  ADD COLUMN region VARCHAR(100) NOT NULL DEFAULT 'Australia (Sydney)',
  ADD COLUMN data_removed_at DATETIME(3) NULL;

-- An owner's uploaded drawing enters the same pipeline as a scan (UPL-01).
ALTER TABLE captures
  MODIFY source ENUM('lidar', 'simulated', 'upload') NOT NULL;

-- source: the original drawing, kept unchanged (UPL-04).
-- source_image: the chosen page of a PDF, rendered for tracing.
ALTER TABLE capture_files
  MODIFY kind ENUM('model', 'room', 'photo', 'source', 'source_image') NOT NULL;

ALTER TABLE plan_versions
  MODIFY status ENUM('uploading', 'processing', 'in_review', 'ready', 'recapture', 'superseded')
         NOT NULL,
  -- lidar, simulated, pdf, dwg, jpg, png.
  ADD COLUMN input_type VARCHAR(20) NULL AFTER capture_id,
  -- capture: from the app or an upload; revision: a change after approval
  -- (REV-09). Revisions do not count against the monthly quota.
  ADD COLUMN origin ENUM('capture', 'revision') NOT NULL DEFAULT 'capture' AFTER input_type,
  ADD COLUMN based_on_version_id VARCHAR(40) NULL AFTER origin,
  -- The internal plan (shared/plan/model.js): produced by plan reading,
  -- edited by the reviewer, frozen on approval.
  ADD COLUMN plan_json JSON NULL,
  ADD COLUMN plan_revision INT NOT NULL DEFAULT 0,
  ADD COLUMN plan_saved_at DATETIME(3) NULL,
  ADD COLUMN plan_saved_by VARCHAR(40) NULL,
  -- SHA-256 of the canonical plan at approval (REV-07).
  ADD COLUMN content_hash CHAR(64) NULL,
  -- Reviewer time excluding idle spells over 10 minutes (REV-10).
  ADD COLUMN review_active_seconds INT NOT NULL DEFAULT 0,
  ADD COLUMN review_last_activity_at DATETIME(3) NULL,
  ADD COLUMN superseded_at DATETIME(3) NULL;

-- A share link belongs to a plan and always opens its newest approved
-- version (GEN-06); owners can revoke it (VIEW-07).
ALTER TABLE share_links
  ADD COLUMN plan_id VARCHAR(40) NULL AFTER org_id,
  ADD COLUMN revoked_at DATETIME(3) NULL,
  MODIFY plan_version_id VARCHAR(40) NULL;

UPDATE share_links s JOIN plan_versions v ON v.id = s.plan_version_id
  SET s.plan_id = v.plan_id;

-- Every state change and approval, with actor, time and version (ACC-06).
-- Kept after an account's data is removed, with identifiers only: no
-- foreign keys, and the readable labels are cleared on removal.
CREATE TABLE audit_log (
  id              VARCHAR(40)  NOT NULL PRIMARY KEY,
  org_id          VARCHAR(40)  NULL,
  actor_id        VARCHAR(40)  NULL,
  actor_name      VARCHAR(200) NULL,
  action          VARCHAR(40)  NOT NULL,
  target_type     VARCHAR(20)  NOT NULL,
  target_id       VARCHAR(40)  NULL,
  target_label    VARCHAR(300) NULL,
  version         INT          NULL,
  detail          JSON         NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_audit_created (created_at),
  KEY ix_audit_org (org_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
