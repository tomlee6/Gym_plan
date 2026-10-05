# room_scan

LiDAR room scanning for Flex Gym Scan, backed by Apple RoomPlan. iOS only.

The Swift side runs a `RoomCaptureSession` without Apple's scanning view and
streams a top-down snapshot to Flutter about ten times a second. The app
draws its own outline from it (`lib/services/lidar_scan_session.dart`).

## Requirements

- A LiDAR iPhone or iPad Pro (iPhone 12 Pro or later Pro models) on iOS 16+.
  Other devices report `supported: false`; the app then blocks scanning in
  release builds and falls back to the simulated walk in debug builds.
- A Mac with Xcode to build. The simulator has no LiDAR, so test on a device.
- Floor area (`areaM2`) is only reported on iOS 17+.

## First build on the Mac

```sh
cd mobile
flutter pub get
cd ios && pod install && cd ..
flutter run --release   # on a connected LiDAR iPhone
```

The app's `Info.plist` already has `NSCameraUsageDescription`; iOS asks for
camera access the first time a scan starts.

## Channel protocol

Methods on `flex/room_scan`:

| Method         | Returns                                                     |
| -------------- | ----------------------------------------------------------- |
| `deviceInfo`   | `{supported, model, systemVersion, reason?}`                |
| `start`        | Starts a new capture. Prompts for camera access.            |
| `pause`        | Freezes the clock and updates; tracking continues.          |
| `resume`       |                                                             |
| `stop`         | Abandons the capture.                                       |
| `capturePhoto` | Path of a JPEG of the current camera frame.                 |
| `finish`       | `{usdzPath, jsonPath, bytes, room}` after RoomBuilder runs. |

Events on `flex/room_scan/events` are either an update:

```
{type: "update", walls: [{a: [x, y], b: [x, y], confidence}], objects: [[[x, y] ×4]],
 coverage, closed, elapsedMs, position?: [x, y], heading?, areaM2?, instruction?}
```

or `{type: "error", code, message}` when the capture ends unexpectedly.
Coordinates are metres on the floor plane: `x` is world x, `y` is world z.

## Not yet verified on hardware

This code was written without a Mac or a LiDAR device to hand. Check first:

- that it compiles (`pod install`, then an Xcode build);
- that walls appear in the Flutter outline and line up with the room;
- the coverage and `closed` heuristic (`RoomScanner.coverage`) on a real gym
  floor, and the 0.3 m join tolerance;
- `finish` on a large floor: RoomBuilder can take several seconds;
- that photos come out upright (`oriented(.right)` assumes portrait).
