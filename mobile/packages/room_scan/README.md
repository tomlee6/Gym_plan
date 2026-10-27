# room_scan

LiDAR room scanning for Flex Gym Scan, backed by Apple RoomPlan, plus the
360° equipment walkaround recorder. iOS only.

The Swift side runs a `RoomCaptureSession` without Apple's scanning view and
streams a top-down snapshot to Flutter about ten times a second. The app
draws its own outline from it (`lib/services/lidar_scan_session.dart`).

## Requirements

- iOS 17 or later: the app's minimum (I-01). RoomPlan, ARKit, AVFoundation
  and CoreMotion are linked normally; there is no weak linking and no
  `#available` checks left.
- A LiDAR iPhone or iPad Pro (iPhone 12 Pro or later Pro models) to scan.
  Other devices report `supported: false`; the app then shows its blocking
  "This app needs an iPhone with LiDAR" screen at launch in release builds,
  and falls back to the simulated walk in debug builds.
- A Mac with Xcode to build. The simulator has no LiDAR, so test on a device.

## First build on the Mac

```sh
cd mobile
flutter pub get
cd ios && pod install && cd ..
flutter run --release   # on a connected LiDAR iPhone
```

The app's `Info.plist` already has `NSCameraUsageDescription`; iOS asks for
camera access the first time a scan starts. There is deliberately **no**
`NSMicrophoneUsageDescription`: the equipment walkaround is recorded without
sound (no audio input is added at all, A-04), so members' voices are never
stored, and the app never asks for the microphone.

## Channel protocol

Methods on `flex/room_scan`:

| Method          | Returns                                                     |
| --------------- | ----------------------------------------------------------- |
| `deviceInfo`    | `{supported, model, systemVersion, reason?}`                |
| `start`         | Starts a new capture. Prompts for camera access.            |
| `pause`         | Freezes the clock and updates; tracking continues.          |
| `resume`        |                                                             |
| `stop`          | Abandons the capture.                                       |
| `capturePhoto`  | Path of a JPEG of the current camera frame.                 |
| `finish`        | `{usdzPath, jsonPath, bytes, room}` after RoomBuilder runs. |
| `video.prepare` | Starts the camera for a walkaround (refused during a scan). |
| `video.start`   | `{equipmentId}`: starts recording (video only, no audio).   |
| `video.stop`    | `{equipmentId, path, thumbnailPath, bytes, durationSeconds, contentType}` |
| `video.discard` | `{path}`: deletes a take and its poster frame.              |
| `video.dispose` | Releases the camera.                                        |

Events on `flex/room_scan/events` are either an update:

```
{type: "update", walls: [{a: [x, y], b: [x, y], confidence}], objects: [[[x, y] ×4]],
 coverage, closed, elapsedMs, position?: [x, y], heading?, areaM2?, instruction?}
```

or `{type: "error", code, message}` when the capture ends unexpectedly.
Coordinates are metres on the floor plane: `x` is world x, `y` is world z.

Events on `flex/room_scan/video_events` arrive about ten times a second while
a walkaround is recording (I-06):

```
{type: "motion", headingDeg, pitchDeg}
```

`headingDeg` (0–360, against an arbitrary but fixed reference) is the
camera's horizontal direction, from CoreMotion's device attitude;
`pitchDeg` is how far the camera points above (+) or below (−) the horizon.
The app turns them into the walk-around coverage ring
(`lib/services/walk_coverage.dart`).

## Not yet verified on hardware

This code was written without a Mac or a LiDAR device to hand. Check first:

- that it compiles (`pod install`, then an Xcode build);
- that walls appear in the Flutter outline and line up with the room;
- the coverage and `closed` heuristic (`RoomScanner.coverage`) on a real gym
  floor, and the 0.3 m join tolerance;
- `finish` on a large floor: RoomBuilder can take several seconds;
- that photos come out upright (`oriented(.right)` assumes portrait);
- that the equipment video is recorded with no audio track and no longer
  crashes the app;
- the motion samples: `headingDeg` should sweep once through 360 as you
  walk round a machine with the camera on it. Which way round the attitude's
  rotation matrix is gets checked against gravity on each sample
  (`EquipmentVideoRecorder.startMotion`), and samples with the camera
  pointing straight up or down are skipped.
