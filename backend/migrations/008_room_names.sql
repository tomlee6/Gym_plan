-- Room names from the phone.
--
-- When a scan finds more than one room, the surveyor can name each one on
-- the review screen before uploading ("Free weights", "Studio 2"), instead
-- of the plan arriving with "Room 1", "Room 2". The names are kept with the
-- capture, in the order the scan lists the rooms, and plan reading gives
-- them to the plan's spaces. A reviewer can still rename any of them.

ALTER TABLE captures
  ADD COLUMN room_names JSON NULL AFTER override_reason;
