-- CHANGE 2 and CHANGE 4: gym equipment on a capture, and the 360 degree
-- video recorded for each piece of it.
--
-- Equipment is part of the capture, not a thing of its own: it is scanned
-- with the room, travels with the capture, and is carried into the plan by
-- plan reading. The approved plan stays the single source of truth for
-- where a machine is; these rows are what the plan is read from, and what
-- the video hangs off.
--
-- Videos reuse capture_files, and so reuse the existing chunked, signed-URL
-- upload path unchanged. equipment_videos holds only what a file row cannot
-- say: which machine it shows, how long it runs, and how far along it is.

ALTER TABLE capture_files
  MODIFY kind ENUM('model', 'room', 'photo', 'source', 'source_image', 'video', 'thumbnail')
         NOT NULL,
  -- Set on a video or its thumbnail; null on the room scan's own files.
  ADD COLUMN equipment_id VARCHAR(40) NULL AFTER kind;

CREATE TABLE capture_equipment (
  id              VARCHAR(40)   NOT NULL PRIMARY KEY,
  org_id          VARCHAR(40)   NOT NULL,
  capture_id      VARCHAR(40)   NOT NULL,
  -- The reference the app and the reviewer use, e.g. 'EQ-001'. Unique
  -- within its capture, not across the estate.
  equipment_id    VARCHAR(64)   NOT NULL,
  -- Free text on purpose: the catalogue is extensible, so a gym may use a
  -- machine type this server has never heard of (CHANGE 2.1).
  type            VARCHAR(60)   NOT NULL,
  name            VARCHAR(120)  NOT NULL,
  -- Metres in the plan's own frame: x across, z along, matching the floor
  -- plan's [x, y]. Null until the machine has been placed.
  position_x      DECIMAL(10,4) NULL,
  position_z      DECIMAL(10,4) NULL,
  elevation_m     DECIMAL(10,4) NULL,
  rotation_deg    DECIMAL(7,3)  NULL,
  width_m         DECIMAL(10,4) NULL,
  depth_m         DECIMAL(10,4) NULL,
  height_m        DECIMAL(10,4) NULL,
  confidence      DECIMAL(5,4)  NULL,
  -- Who placed it: RoomPlan found the object, the surveyor marked it on the
  -- phone, or the reviewer corrected it.
  source          ENUM('roomplan', 'surveyor', 'reviewer') NOT NULL DEFAULT 'surveyor',
  -- The plan object this was matched to, once the plan has been read.
  plan_object_id  VARCHAR(64)   NULL,
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_capture_equipment (capture_id, equipment_id),
  KEY ix_equipment_org (org_id),
  CONSTRAINT fk_equipment_org FOREIGN KEY (org_id) REFERENCES organisations (id),
  CONSTRAINT fk_equipment_capture FOREIGN KEY (capture_id) REFERENCES captures (id)
) ENGINE=InnoDB;

CREATE TABLE equipment_videos (
  id                VARCHAR(40)  NOT NULL PRIMARY KEY,
  org_id            VARCHAR(40)  NOT NULL,
  capture_id        VARCHAR(40)  NOT NULL,
  equipment_id      VARCHAR(40)  NOT NULL,
  -- The uploaded files, as ordinary capture_files rows.
  file_id           VARCHAR(40)  NULL,
  thumbnail_file_id VARCHAR(40)  NULL,
  duration_seconds  DECIMAL(8,2) NULL,
  -- 'processing' and 'failed' exist for a transcoding step that is not
  -- built: the thumbnail is taken on the phone, so an uploaded video is
  -- ready as it stands and never blocks plan reading (CHANGE 4.2).
  status            ENUM('pending', 'uploading', 'uploaded', 'processing', 'ready', 'failed')
                    NOT NULL DEFAULT 'pending',
  failure_reason    VARCHAR(500) NULL,
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                 ON UPDATE CURRENT_TIMESTAMP(3),
  -- One 360 video per machine: a retake replaces the one before it.
  UNIQUE KEY uq_equipment_video (equipment_id),
  KEY ix_video_capture (capture_id),
  CONSTRAINT fk_video_org FOREIGN KEY (org_id) REFERENCES organisations (id),
  CONSTRAINT fk_video_capture FOREIGN KEY (capture_id) REFERENCES captures (id),
  CONSTRAINT fk_video_equipment FOREIGN KEY (equipment_id) REFERENCES capture_equipment (id)
                                ON DELETE CASCADE
) ENGINE=InnoDB;
