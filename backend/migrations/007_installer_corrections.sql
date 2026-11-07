-- Installers, and the corrections they send from site.
--
-- An installer fits out a gym from its approved plan, usually on a tablet,
-- and is the first to find where the plan and the room differ: a column
-- that is not where the plan has it, a door that opens the other way.
--
--   * memberships / invites: a third account role, 'installer'. An
--     installer sees the account's plans and walkthroughs and may send a
--     correction; they do not scan, upload or share.
--   * plan_versions.origin 'correction': the installer's corrected plan
--     becomes a new version that waits in the reviewer queue like any
--     other. The approved plan stays live until a reviewer approves the
--     correction (then it is superseded, as after a revision) or rejects it
--     (then nothing changes). Like a revision, it is not counted against
--     the account's monthly quota.
--   * correction_note / corrected_by: what the installer said was wrong,
--     and who said it, for the reviewer.

ALTER TABLE memberships
  MODIFY role ENUM('owner', 'surveyor', 'installer') NOT NULL;

ALTER TABLE invites
  MODIFY role ENUM('owner', 'surveyor', 'installer') NOT NULL;

ALTER TABLE plan_versions
  MODIFY origin ENUM('capture', 'revision', 'correction') NOT NULL DEFAULT 'capture',
  ADD COLUMN correction_note VARCHAR(1000) NULL AFTER reviewer_note,
  ADD COLUMN corrected_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER correction_note,
  ADD CONSTRAINT fk_version_corrected_by FOREIGN KEY (corrected_by) REFERENCES users (id) ON DELETE SET NULL;
