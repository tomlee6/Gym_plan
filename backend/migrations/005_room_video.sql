-- The room video recorded in the background of a LiDAR room scan.
--
-- The phone records it from the scan's own camera frames and sends it with
-- the scan's 3D model, as one more file of the same capture. It therefore
-- belongs to the same capture, plan version, plan (facility level),
-- account and surveyor as the model, and is stored, signed, retried,
-- archived and removed exactly like the capture's other files. The
-- reviewer watches it beside the 3D model to check the scan.
--
-- Its own kind, apart from 'video': that one is a machine's 360 walkaround,
-- which belongs to the machine and finishes on its own, while the room
-- video is part of the capture and must land before the capture is
-- received. Captures from older app builds simply have no room video.
--
-- Appending a value to the ENUM is a metadata-only change in MySQL 8.

ALTER TABLE capture_files
  MODIFY kind ENUM('model', 'room', 'mesh', 'keyframes', 'photo', 'source', 'source_image',
                   'video', 'thumbnail', 'frames', 'room_video') NOT NULL;
