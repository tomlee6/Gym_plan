#if canImport(RoomPlan)
import ARKit
import CoreImage
import Foundation
import RoomPlan
import UIKit
import simd

/// One RoomPlan capture, run through Apple's RoomCaptureView so the camera
/// shows the white wall outlines as they are found, while the Flutter
/// screen gets the room as a top-down outline.
///
/// A floor too big for one RoomPlan room is scanned in sections (F-01):
/// every section runs in the same ARSession, so they share one world frame
/// and line up on the live outline as they are. Finishing merges them into
/// one CapturedStructure with StructureBuilder (iOS 17); `scan.json` then
/// holds that structure, which the server's scan reader takes as it is
/// (shared/plan/reading.js). A scan of one section exports exactly as a
/// single room always has.
///
/// Everything here runs on the main thread: the Flutter channels require it,
/// and the update timer is scheduled on the main run loop.
final class RoomScanner: NSObject, RoomCaptureSessionDelegate {
  enum ScanError: LocalizedError {
    case noFrame
    case encodeFailed
    case alreadyFinished
    case busy
    case nothingScanned

    var errorDescription: String? {
      switch self {
      case .noFrame: return "The camera has not produced a frame yet."
      case .encodeFailed: return "The photo could not be saved."
      case .alreadyFinished: return "This scan has already finished."
      case .busy: return "A new section is already being started."
      case .nothingScanned: return "Nothing was scanned."
      }
    }
  }

  /// Wall ends closer than this count as joined, in metres.
  private static let joinTolerance: Float = 0.3

  private let session: RoomCaptureSession

  /// The one AR session every section runs in (F-01), so all of them share
  /// a world frame.
  private let arSession = ARSession()

  /// Apple's scanning view: the camera with each wall, edge and opening
  /// outlined in white, and a small 3D model of the room so far. Nil on a
  /// device without LiDAR.
  let roomCaptureView: RoomCaptureView?

  /// Keeps RoomCaptureView from showing its finished-room preview when a
  /// section closes; scanning carries straight on into the next one.
  private let presentation = SkipPresentation()

  /// Sections already closed, in the order they were scanned.
  private var completedRooms: [CapturedRoom] = []

  /// A section is being closed and the next one started.
  private var switchingSection = false

  /// The section being scanned now, counting from 1.
  private var sectionNumber: Int { completedRooms.count + 1 }

  /// Whoever was the session's delegate before this scanner took over,
  /// i.e. the RoomCaptureView. Every callback is passed on to it, or it
  /// stops drawing the wall outlines.
  private weak var forwardDelegate: RoomCaptureSessionDelegate?
  private let emit: ([String: Any]) -> Void
  private let ciContext = CIContext()

  /// Photos and exports for this scan. Application Support rather than tmp,
  /// because an upload may outlive the app process.
  private let folder: URL

  private var latestRoom: CapturedRoom?
  private var instruction: String?
  private var timer: Timer?
  private var elapsed: TimeInterval = 0
  private var resumedAt: Date?
  private var finished = false

  /// Set when Flutter ends the scan, so the end callback is not mistaken
  /// for a failure.
  private var endRequested = false
  private var endContinuation: CheckedContinuation<CapturedRoomData, Error>?

  init(emit: @escaping ([String: Any]) -> Void) throws {
    self.emit = emit
    let support = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask,
      appropriateFor: nil, create: true)
    folder = support
      .appendingPathComponent("Scans", isDirectory: true)
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

    if RoomCaptureSession.isSupported {
      let rcv = RoomCaptureView(frame: .zero, arSession: arSession)
      rcv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      self.roomCaptureView = rcv
      self.session = rcv.captureSession
    } else {
      self.roomCaptureView = nil
      self.session = RoomCaptureSession()
    }

    super.init()
    roomCaptureView?.delegate = presentation
    forwardDelegate = session.delegate
    session.delegate = self
  }

  // MARK: - Lifecycle

  func start() {
    session.run(configuration: RoomCaptureSession.Configuration())
    // A scan can take ten minutes; do not let the screen lock mid-walk.
    UIApplication.shared.isIdleTimerDisabled = true
    resume()
  }

  func resume() {
    guard !finished, timer == nil else { return }
    resumedAt = Date()
    timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
      self?.tick()
    }
  }

  /// Stops the clock and the updates. The capture keeps tracking, so
  /// resuming continues the same room.
  func pause() {
    if let since = resumedAt {
      elapsed += Date().timeIntervalSince(since)
    }
    resumedAt = nil
    timer?.invalidate()
    timer = nil
  }

  func stop() {
    pause()
    if !finished {
      finished = true
      endRequested = true
      session.stop()
    }
    UIApplication.shared.isIdleTimerDisabled = false
  }

  private func tick() {
    emit(snapshot(of: liveRooms, section: sectionNumber))
  }

  /// Every closed section, then the one being scanned.
  private var liveRooms: [CapturedRoom] {
    completedRooms + (latestRoom.map { [$0] } ?? [])
  }

  // MARK: - Sections (F-01)

  /// Closes the section being scanned and starts the next in the same AR
  /// session. `stop(pauseARSession: false)` keeps tracking, so the next
  /// section carries on in the same frame. RoomBuilder finalises the closed
  /// section; if it fails, the last live room stands in for it.
  ///
  /// On the main actor, so that after each `await` it carries on on the
  /// main thread: it restarts the capture session, and everything else in
  /// this class runs there too. Without it the code after the first
  /// `await` resumes on a background thread.
  @MainActor
  func nextSection() async throws {
    guard !finished else { throw ScanError.alreadyFinished }
    guard !switchingSection else { throw ScanError.busy }
    switchingSection = true
    defer { switchingSection = false }

    let data: CapturedRoomData
    do {
      data = try await withCheckedThrowingContinuation { continuation in
        endContinuation = continuation
        session.stop(pauseARSession: false)
      }
    } catch {
      // Carry on scanning the same section rather than leave the camera idle.
      session.run(configuration: RoomCaptureSession.Configuration())
      throw error
    }

    let closed: CapturedRoom?
    do {
      closed = try await RoomBuilder(options: [.beautifyObjects]).capturedRoom(from: data)
    } catch {
      closed = latestRoom
    }
    if let closed = closed { completedRooms.append(closed) }
    latestRoom = nil
    instruction = nil
    session.run(configuration: RoomCaptureSession.Configuration())
  }

  // MARK: - Photos

  /// Saves the current camera frame. Reads it from the scan's own AR
  /// session, so the scan keeps running.
  func capturePhoto() throws -> String {
    guard let frame = session.arSession.currentFrame else { throw ScanError.noFrame }
    // The sensor is landscape; the app is portrait.
    let image = CIImage(cvPixelBuffer: frame.capturedImage).oriented(.right)
    guard
      let space = CGColorSpace(name: CGColorSpace.sRGB),
      let data = ciContext.jpegRepresentation(of: image, colorSpace: space, options: [:])
    else { throw ScanError.encodeFailed }

    let url = folder.appendingPathComponent("photo-\(UUID().uuidString).jpg")
    try data.write(to: url)
    return url.path
  }

  // MARK: - Finish and export

  /// On the main actor, so that after each `await` it carries on on the
  /// main thread. It touches UIKit (the idle timer) and the AR session;
  /// resuming on a background thread, as an unisolated async method does,
  /// made iOS end the app as soon as a scan was finished. RoomBuilder and
  /// StructureBuilder still do their work off the main thread.
  @MainActor
  func finish() async throws -> [String: Any] {
    guard !finished else { throw ScanError.alreadyFinished }
    pause()

    let data: CapturedRoomData = try await withCheckedThrowingContinuation { continuation in
      endContinuation = continuation
      finished = true
      endRequested = true
      session.stop()
    }
    UIApplication.shared.isIdleTimerDisabled = false

    // RoomBuilder straightens walls and snaps objects. If it fails, the last
    // live room is still a usable, if rougher, result.
    var current: CapturedRoom?
    do {
      current = try await RoomBuilder(options: [.beautifyObjects]).capturedRoom(from: data)
    } catch {
      // With no earlier section to fall back on, the failure is the result.
      if latestRoom == nil && completedRooms.isEmpty { throw error }
      current = latestRoom
    }
    let rooms = completedRooms + (current.map { [$0] } ?? [])
    guard let first = rooms.first else { throw ScanError.nothingScanned }

    let usdz = folder.appendingPathComponent("scan.usdz")
    let json = folder.appendingPathComponent("scan.json")
    try? FileManager.default.removeItem(at: usdz)

    if rooms.count == 1 {
      try first.export(to: usdz)
      try JSONEncoder().encode(first).write(to: json)
    } else {
      try await exportSections(rooms, usdz: usdz, json: json)
    }

    return [
      "usdzPath": usdz.path,
      "jsonPath": json.path,
      "bytes": fileSize(usdz) + fileSize(json),
      "room": snapshot(of: rooms, section: rooms.count),
    ]
  }

  /**
   Writes a sectioned scan: the sections merged into one CapturedStructure
   by StructureBuilder, as the 3D model and as `scan.json`.

   If the merge fails (the sections did not overlap enough to join), the
   sections are still kept: `scan.json` holds them as a structure with only
   its `rooms`, which the server reader merges surface by surface, and the
   3D model is the section with the most walls. Nothing scanned is lost; the
   reviewer sees the joins.
   */
  private func exportSections(_ rooms: [CapturedRoom], usdz: URL, json: URL) async throws {
    do {
      let structure = try await StructureBuilder(options: [.beautifyObjects])
        .capturedStructure(from: rooms)
      try structure.export(to: usdz)
      try JSONEncoder().encode(structure).write(to: json)
    } catch {
      let encoded = try rooms.map { room -> Any in
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(room))
      }
      try JSONSerialization.data(withJSONObject: ["rooms": encoded]).write(to: json)
      let largest = rooms.max { $0.walls.count < $1.walls.count } ?? rooms[0]
      try? FileManager.default.removeItem(at: usdz)
      try largest.export(to: usdz)
    }
  }

  private func fileSize(_ url: URL) -> Int {
    let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
    return (attributes?[.size] as? NSNumber)?.intValue ?? 0
  }

  // MARK: - RoomCaptureSessionDelegate

  func captureSession(
    _ session: RoomCaptureSession, didStartWith configuration: RoomCaptureSession.Configuration
  ) {
    forwardDelegate?.captureSession(session, didStartWith: configuration)
  }

  func captureSession(_ session: RoomCaptureSession, didAdd room: CapturedRoom) {
    forwardDelegate?.captureSession(session, didAdd: room)
  }

  func captureSession(_ session: RoomCaptureSession, didChange room: CapturedRoom) {
    forwardDelegate?.captureSession(session, didChange: room)
  }

  func captureSession(_ session: RoomCaptureSession, didRemove room: CapturedRoom) {
    forwardDelegate?.captureSession(session, didRemove: room)
  }

  func captureSession(_ session: RoomCaptureSession, didUpdate room: CapturedRoom) {
    forwardDelegate?.captureSession(session, didUpdate: room)
    DispatchQueue.main.async { self.latestRoom = room }
  }

  func captureSession(
    _ session: RoomCaptureSession, didProvide instruction: RoomCaptureSession.Instruction
  ) {
    forwardDelegate?.captureSession(session, didProvide: instruction)
    DispatchQueue.main.async { self.instruction = Self.describe(instruction) }
  }

  func captureSession(
    _ session: RoomCaptureSession, didEndWith data: CapturedRoomData, error: Error?
  ) {
    forwardDelegate?.captureSession(session, didEndWith: data, error: error)
    DispatchQueue.main.async {
      if let continuation = self.endContinuation {
        self.endContinuation = nil
        if let error = error {
          continuation.resume(throwing: error)
        } else {
          continuation.resume(returning: data)
        }
        return
      }
      // Flutter stopped it on purpose, e.g. the scan was discarded.
      if self.endRequested { return }

      // Ended without being asked to, e.g. camera access was refused or
      // tracking failed. Tell Flutter so the screen can say so.
      self.pause()
      self.finished = true
      UIApplication.shared.isIdleTimerDisabled = false
      self.emit([
        "type": "error",
        "code": "scan_failed",
        "message": error?.localizedDescription
          ?? "The scan stopped. Check camera access in Settings and try again.",
      ])
    }
  }

  private static func describe(_ instruction: RoomCaptureSession.Instruction) -> String? {
    switch instruction {
    case .normal: return nil
    case .moveCloseToWall: return "Move closer to the wall"
    case .moveAwayFromWall: return "Step back from the wall"
    case .slowDown: return "Slow down"
    case .turnOnLight: return "Turn on more light"
    case .lowTexture: return "Point at a surface with more detail"
    @unknown default: return nil
    }
  }

  // MARK: - Snapshot

  /// The scanned sections projected onto the floor plane, as sent to
  /// Flutter: `rooms[i]` is section `i + 1`, and each wall says which
  /// section it is in. All sections share the AR session's frame, so their
  /// walls are put together as they are.
  private func snapshot(of rooms: [CapturedRoom], section: Int) -> [String: Any] {
    var event: [String: Any] = [
      "type": "update",
      "elapsedMs": Int(currentElapsed() * 1000),
      "section": section,
    ]
    if let instruction = instruction { event["instruction"] = instruction }

    if let frame = session.arSession.currentFrame {
      let t = frame.camera.transform
      // The camera looks down its own -z axis.
      let forward = -simd_make_float3(t.columns.2)
      event["position"] = [Double(t.columns.3.x), Double(t.columns.3.z)]
      event["heading"] = Double(atan2(forward.z, forward.x))
    }

    guard !rooms.isEmpty else {
      event["walls"] = [Any]()
      event["objects"] = [Any]()
      event["coverage"] = 0.0
      event["closed"] = false
      return event
    }

    var surfaces: [CapturedRoom.Surface] = []
    var sections: [Int] = []
    for (i, room) in rooms.enumerated() {
      surfaces += room.walls
      sections += Array(repeating: i + 1, count: room.walls.count)
    }
    // Earlier sections first, so an object's index stays put as later
    // sections are scanned.
    let objects = rooms.flatMap { $0.objects }

    let walls = surfaces.map { Self.segment(of: $0) }
    event["walls"] = walls.indices.map { i in
      [
        "a": [Double(walls[i].a.x), Double(walls[i].a.y)],
        "b": [Double(walls[i].b.x), Double(walls[i].b.y)],
        "confidence": Self.name(of: surfaces[i].confidence),
        "section": sections[i],
      ] as [String: Any]
    }
    event["objects"] = objects.map { object in
      Self.footprint(transform: object.transform, dimensions: object.dimensions)
        .map { [Double($0.x), Double($0.y)] }
    }

    /*
     * Each detected object with enough of its measurements to be marked as
     * a gym machine on the phone (CHANGE 2.1).
     *
     * RoomPlan has no gym machine categories — its list stops at furniture
     * — so `category` is only a hint. What makes an object a treadmill is
     * the surveyor naming it, which is what these let them do.
     */
    event["detected"] = objects.enumerated().map { index, object in
      let t = object.transform
      let centre = simd_make_float3(t.columns.3)
      let x = simd_make_float3(t.columns.0)
      return [
        // Stable within one scan, so a mark follows its object as the
        // scan is refined.
        "index": index,
        "x": Double(centre.x),
        "z": Double(centre.z),
        "elevationM": Double(centre.y - object.dimensions.y / 2),
        "widthM": Double(object.dimensions.x),
        "depthM": Double(object.dimensions.z),
        "heightM": Double(object.dimensions.y),
        "rotationDeg": Double(atan2(x.z, x.x) * 180 / .pi),
        "category": Self.name(of: object.category),
        "confidence": Self.name(of: object.confidence),
      ] as [String: Any]
    }

    let (coverage, closed) = Self.coverage(walls: walls, surfaces: surfaces)
    event["coverage"] = coverage
    event["closed"] = closed
    // Each section's recognised floor. Overlap between sections is counted
    // twice, so this is an estimate; the server measures the merged plan.
    let areas = rooms.compactMap { Self.floorArea(of: $0) }
    if !areas.isEmpty { event["areaM2"] = areas.reduce(0, +) }
    return event
  }

  private func currentElapsed() -> TimeInterval {
    elapsed + (resumedAt.map { Date().timeIntervalSince($0) } ?? 0)
  }

  /// A wall is a rectangle centred on its transform, `width` long along its
  /// local x axis. Seen from above that is a line.
  private static func segment(of wall: CapturedRoom.Surface) -> (a: SIMD2<Float>, b: SIMD2<Float>) {
    let t = wall.transform
    let centre = simd_make_float3(t.columns.3)
    let along = simd_make_float3(t.columns.0) * (wall.dimensions.x / 2)
    let a = centre - along
    let b = centre + along
    return (SIMD2(a.x, a.z), SIMD2(b.x, b.z))
  }

  /// The four floor-plane corners of a box.
  private static func footprint(transform t: simd_float4x4, dimensions d: simd_float3) -> [SIMD2<Float>] {
    let centre: simd_float3 = simd_make_float3(t.columns.3)
    let x: simd_float3 = simd_make_float3(t.columns.0) * (d.x / 2)
    let z: simd_float3 = simd_make_float3(t.columns.2) * (d.z / 2)
    // One corner per statement: the type checker times out on all four in one literal.
    let c0: simd_float3 = centre - x - z
    let c1: simd_float3 = centre + x - z
    let c2: simd_float3 = centre + x + z
    let c3: simd_float3 = centre - x + z
    let corners: [simd_float3] = [c0, c1, c2, c3]
    return corners.map { SIMD2<Float>($0.x, $0.z) }
  }

  private static func name(of confidence: CapturedRoom.Confidence) -> String {
    switch confidence {
    case .high: return "high"
    case .medium: return "medium"
    case .low: return "low"
    @unknown default: return "low"
    }
  }

  /**
   RoomPlan's own category for an object, as a plain string.

   These are furniture categories: RoomPlan recognises a table or a sofa,
   and has nothing for a treadmill or a squat rack. Anything it does not
   place comes back as "object", which is most of a gym.
   */
  private static func name(of category: CapturedRoom.Object.Category) -> String {
    switch category {
    case .storage: return "storage"
    case .refrigerator: return "refrigerator"
    case .stove: return "stove"
    case .bed: return "bed"
    case .sink: return "sink"
    case .washerDryer: return "washerDryer"
    case .toilet: return "toilet"
    case .bathtub: return "bathtub"
    case .oven: return "oven"
    case .dishwasher: return "dishwasher"
    case .table: return "table"
    case .sofa: return "sofa"
    case .chair: return "chair"
    case .fireplace: return "fireplace"
    case .television: return "television"
    case .stairs: return "stairs"
    @unknown default: return "object"
    }
  }

  /// Coverage blends how confident RoomPlan is in each wall, weighted by
  /// length, with how many wall ends join up. An outline with gaps cannot be
  /// complete however confident each wall is.
  private static func coverage(
    walls: [(a: SIMD2<Float>, b: SIMD2<Float>)], surfaces: [CapturedRoom.Surface]
  ) -> (Double, Bool) {
    guard !walls.isEmpty else { return (0, false) }

    var weighted: Float = 0
    var total: Float = 0
    for (wall, surface) in zip(walls, surfaces) {
      let length = simd_distance(wall.a, wall.b)
      let weight: Float
      switch surface.confidence {
      case .high: weight = 1
      case .medium: weight = 0.8
      default: weight = 0.4
      }
      weighted += length * weight
      total += length
    }
    let confidence = total > 0 ? weighted / total : 0

    var joined = 0
    for (i, wall) in walls.enumerated() {
      for end in [wall.a, wall.b] {
        let meets = walls.enumerated().contains { j, other in
          j != i
            && (simd_distance(end, other.a) < joinTolerance
              || simd_distance(end, other.b) < joinTolerance)
        }
        if meets { joined += 1 }
      }
    }
    let ends = walls.count * 2
    let closed = walls.count >= 3 && joined == ends
    let joinShare = Float(joined) / Float(ends)

    return (Double(confidence * (0.5 + 0.5 * joinShare)), closed)
  }

  /// Floor area from the recognised floor polygon (`floors` is iOS 17+,
  /// the app's minimum). Nil until RoomPlan has recognised the floor.
  private static func floorArea(of room: CapturedRoom) -> Double? {
    guard let floor = room.floors.first else { return nil }
    let corners = floor.polygonCorners.map { corner -> SIMD2<Float> in
      let world = floor.transform * SIMD4<Float>(corner, 1)
      return SIMD2(world.x, world.z)
    }
    guard corners.count >= 3 else { return nil }
    var twice: Float = 0
    for i in corners.indices {
      let p = corners[i]
      let q = corners[(i + 1) % corners.count]
      twice += p.x * q.y - q.x * p.y
    }
    return Double(abs(twice) / 2)
  }
}

/// RoomCaptureView's delegate, only to stop it showing its finished-room
/// preview when a section closes (F-01): the scan carries straight on, and
/// the export is built by RoomScanner, not by the view. RoomCaptureView
/// requires its delegate to support NSCoding; there is nothing to encode.
final class SkipPresentation: NSObject, RoomCaptureViewDelegate {
  override init() { super.init() }

  required init?(coder: NSCoder) { super.init() }

  func encode(with coder: NSCoder) {}

  func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool {
    false
  }
}
#endif
