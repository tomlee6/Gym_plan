import ARKit
import CoreImage
import Foundation
import SceneKit
import UIKit
import simd

/**
 "3D Space": the whole room as a coloured LiDAR mesh, Polycam style, rather
 than RoomPlan's walls and boxes.

 The camera is live from `prepare()`. `start()` turns on ARKit's scene
 reconstruction, so a mesh forms over everything the LiDAR sees, drawn as a
 see-through purple layer on the camera as it grows. While scanning, a
 small keyframe (a downscaled camera image, its LiDAR depth, the camera's
 pose and intrinsics) is kept whenever the phone has moved or turned enough.

 `finish()` stops the session and colours every vertex from the keyframe
 that sees it best: in front of the camera, inside the image, closest, and
 not hidden behind something nearer (the keyframe's depth says so). It
 writes:
 - `mesh.obj`: the mesh with a colour per vertex (`v x y z r g b`), in the
   same world frame RoomPlan uses, metres, y up. Uploaded as the capture's
   `mesh` file, which the server and the reviewer's editor already read.
 - `space.scn`: the same mesh as a SceneKit scene, for the 3D viewer and
   the thumbnail on the phone.

 Everything here runs on the main thread except the colouring and file
 writing in `finish()`, which run in the background.
 */
final class MeshScanner: NSObject, ARSCNViewDelegate, ARSessionDelegate {
  enum MeshError: LocalizedError {
    case unsupported, nothingScanned

    var errorDescription: String? {
      switch self {
      case .unsupported: return "This device cannot build a LiDAR mesh."
      case .nothingScanned: return "Nothing was scanned. Walk round the room with the camera."
      }
    }
  }

  static var isSupported: Bool {
    ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
  }

  /// The camera with the mesh drawn over it.
  let view = ARSCNView(frame: .zero)

  private let folder: URL
  private var capturing = false
  private var startedAt: Date?
  private var elapsedBefore: TimeInterval = 0

  /// Keyframes for colouring, newest last.
  private var keyframes: [Keyframe] = []
  private var lastKeyframePose: simd_float4x4?
  private let ciContext = CIContext(options: [.useSoftwareRenderer: false])

  /// Keyframes kept: enough for a big floor, small enough for memory
  /// (each is about 0.4 MB).
  private static let maxKeyframes = 300
  private static let keyframeSize = CGSize(width: 256, height: 192)

  private let fill: SCNMaterial = {
    let m = SCNMaterial()
    m.diffuse.contents = UIColor(red: 0.45, green: 0.38, blue: 1.0, alpha: 0.35)
    m.lightingModel = .constant
    m.isDoubleSided = true
    m.writesToDepthBuffer = false
    return m
  }()

  private let wire: SCNMaterial = {
    let m = SCNMaterial()
    m.diffuse.contents = UIColor(white: 1, alpha: 0.35)
    m.lightingModel = .constant
    m.fillMode = .lines
    m.isDoubleSided = true
    return m
  }()

  override init() {
    let support =
      (try? FileManager.default.url(
        for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    folder = support.appendingPathComponent("Spaces", isDirectory: true)
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    super.init()
    view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.automaticallyUpdatesLighting = false
    view.scene = SCNScene()
    view.delegate = self
    view.session.delegate = self
  }

  // MARK: - Lifecycle

  /// The live camera, nothing meshed yet.
  func prepare() {
    view.session.run(configuration(meshing: false))
  }

  /// Starts meshing, carrying on in the same session the camera is in.
  func start() throws {
    guard Self.isSupported else { throw MeshError.unsupported }
    view.session.run(configuration(meshing: true))
    capturing = true
    startedAt = Date()
    UIApplication.shared.isIdleTimerDisabled = true
  }

  /// Ends the scan without keeping anything.
  func cancel() {
    capturing = false
    view.session.pause()
    UIApplication.shared.isIdleTimerDisabled = false
    try? FileManager.default.removeItem(at: folder)
  }

  /// How far the scan has got, for the screen: seconds, mesh vertices and
  /// whether tracking is good.
  func status() -> [String: Any] {
    let anchors = view.session.currentFrame?.anchors.compactMap { $0 as? ARMeshAnchor } ?? []
    let vertices = anchors.reduce(0) { $0 + $1.geometry.vertices.count }
    var tracking = "normal"
    if let camera = view.session.currentFrame?.camera, case .limited = camera.trackingState {
      tracking = "limited"
    }
    return [
      "elapsedMs": Int(elapsed() * 1000),
      "vertices": vertices,
      "keyframes": keyframes.count,
      "tracking": tracking,
      "capturing": capturing,
    ]
  }

  private func elapsed() -> TimeInterval {
    elapsedBefore + (startedAt.map { Date().timeIntervalSince($0) } ?? 0)
  }

  private func configuration(meshing: Bool) -> ARWorldTrackingConfiguration {
    let config = ARWorldTrackingConfiguration()
    if meshing && Self.isSupported { config.sceneReconstruction = .mesh }
    if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) {
      config.frameSemantics.insert(.sceneDepth)
    }
    return config
  }

  // MARK: - Live mesh

  func renderer(_ renderer: SCNSceneRenderer, nodeFor anchor: ARAnchor) -> SCNNode? {
    guard let mesh = anchor as? ARMeshAnchor else { return nil }
    let node = SCNNode()
    node.addChildNode(SCNNode())
    node.addChildNode(SCNNode())
    update(node, with: mesh)
    return node
  }

  func renderer(_ renderer: SCNSceneRenderer, didUpdate node: SCNNode, for anchor: ARAnchor) {
    guard let mesh = anchor as? ARMeshAnchor else { return }
    update(node, with: mesh)
  }

  /// A see-through fill and a faint wireframe over the anchor's mesh.
  private func update(_ node: SCNNode, with anchor: ARMeshAnchor) {
    let geometry = Self.liveGeometry(anchor.geometry)
    guard node.childNodes.count == 2, let fillGeometry = geometry.copy() as? SCNGeometry,
      let wireGeometry = geometry.copy() as? SCNGeometry
    else { return }
    fillGeometry.materials = [fill]
    wireGeometry.materials = [wire]
    node.childNodes[0].geometry = fillGeometry
    node.childNodes[1].geometry = wireGeometry
  }

  private static func liveGeometry(_ mesh: ARMeshGeometry) -> SCNGeometry {
    let vertices = mesh.vertices
    let source = SCNGeometrySource(
      buffer: vertices.buffer, vertexFormat: vertices.format, semantic: .vertex,
      vertexCount: vertices.count, dataOffset: vertices.offset, dataStride: vertices.stride)
    let faces = mesh.faces
    let data = Data(
      bytes: faces.buffer.contents(),
      count: faces.count * faces.indexCountPerPrimitive * faces.bytesPerIndex)
    let element = SCNGeometryElement(
      data: data, primitiveType: .triangles, primitiveCount: faces.count,
      bytesPerIndex: faces.bytesPerIndex)
    return SCNGeometry(sources: [source], elements: [element])
  }

  // MARK: - Keyframes

  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    guard capturing, keyframes.count < Self.maxKeyframes else { return }
    let pose = frame.camera.transform
    if let last = lastKeyframePose, !Self.movedEnough(from: last, to: pose) { return }
    if case .limited = frame.camera.trackingState { return }
    guard let keyframe = makeKeyframe(frame) else { return }
    keyframes.append(keyframe)
    lastKeyframePose = pose
  }

  /// 25 cm moved, or 12° turned, since the last keyframe.
  private static func movedEnough(from a: simd_float4x4, to b: simd_float4x4) -> Bool {
    let moved = simd_distance(simd_make_float3(a.columns.3), simd_make_float3(b.columns.3))
    let fa = -simd_normalize(simd_make_float3(a.columns.2))
    let fb = -simd_normalize(simd_make_float3(b.columns.2))
    let turned = acos(max(-1, min(1, simd_dot(fa, fb))))
    return moved > 0.25 || turned > 12 * .pi / 180
  }

  /// A small copy of the frame: RGBA pixels, LiDAR depth, pose and the
  /// intrinsics scaled to the small image. Copied at once, so ARKit's frame
  /// is not held on to.
  private func makeKeyframe(_ frame: ARFrame) -> Keyframe? {
    let size = Self.keyframeSize
    let full = frame.camera.imageResolution
    let image = CIImage(cvPixelBuffer: frame.capturedImage)
      .transformed(by: CGAffineTransform(scaleX: size.width / full.width, y: size.height / full.height))
    let width = Int(size.width), height = Int(size.height)
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    ciContext.render(
      image, toBitmap: &pixels, rowBytes: width * 4,
      bounds: CGRect(x: 0, y: 0, width: width, height: height),
      format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())

    var depth: [Float] = []
    var depthWidth = 0, depthHeight = 0
    if let map = frame.sceneDepth?.depthMap {
      CVPixelBufferLockBaseAddress(map, .readOnly)
      depthWidth = CVPixelBufferGetWidth(map)
      depthHeight = CVPixelBufferGetHeight(map)
      let rowBytes = CVPixelBufferGetBytesPerRow(map)
      if let base = CVPixelBufferGetBaseAddress(map) {
        depth.reserveCapacity(depthWidth * depthHeight)
        for y in 0..<depthHeight {
          let row = base.advanced(by: y * rowBytes).assumingMemoryBound(to: Float32.self)
          for x in 0..<depthWidth { depth.append(row[x]) }
        }
      }
      CVPixelBufferUnlockBaseAddress(map, .readOnly)
    }

    let k = frame.camera.intrinsics
    let sx = Float(size.width / full.width), sy = Float(size.height / full.height)
    return Keyframe(
      pose: frame.camera.transform,
      inversePose: frame.camera.transform.inverse,
      fx: k[0][0] * sx, fy: k[1][1] * sy, cx: k[2][0] * sx, cy: k[2][1] * sy,
      width: width, height: height, pixels: pixels,
      depth: depth, depthWidth: depthWidth, depthHeight: depthHeight)
  }

  // MARK: - Finish

  /// Stops the scan, colours the mesh and writes it. Returns the files and
  /// the room's extent in metres.
  @MainActor
  func finish() async throws -> [String: Any] {
    if let since = startedAt { elapsedBefore += Date().timeIntervalSince(since) }
    startedAt = nil
    capturing = false
    let anchors = view.session.currentFrame?.anchors.compactMap { $0 as? ARMeshAnchor } ?? []
    view.session.pause()
    UIApplication.shared.isIdleTimerDisabled = false
    guard !anchors.isEmpty else { throw MeshError.nothingScanned }

    // ARKit's buffers are copied out here, on the main thread, before the
    // heavy work moves off it.
    let parts = anchors.map { MeshPart(anchor: $0) }
    let frames = keyframes
    keyframes.removeAll()
    let folder = self.folder
    let seconds = elapsedBefore

    return try await Task.detached(priority: .userInitiated) {
      try MeshExport.write(parts: parts, keyframes: frames, to: folder, seconds: seconds)
    }.value
  }
}

/// One small saved camera frame, for colouring the mesh.
struct Keyframe {
  let pose: simd_float4x4
  let inversePose: simd_float4x4
  let fx: Float, fy: Float, cx: Float, cy: Float
  let width: Int, height: Int
  let pixels: [UInt8]
  let depth: [Float]
  let depthWidth: Int, depthHeight: Int

  var position: simd_float3 { simd_make_float3(pose.columns.3) }

  /// Where a world point falls in this frame, how far in front it is, and
  /// whether it is hidden behind something nearer. Nil when it is behind
  /// the camera or outside the image.
  func look(at world: simd_float3) -> (u: Float, v: Float, distance: Float)? {
    let p = inversePose * simd_float4(world, 1)
    // ARKit's camera looks down -z, with y up; the image's v runs down.
    let z = -p.z
    guard z > 0.1 else { return nil }
    let u = fx * (p.x / z) + cx
    let v = fy * (-p.y / z) + cy
    guard u >= 0, v >= 0, u < Float(width), v < Float(height) else { return nil }
    if depthWidth > 0 {
      let dx = min(depthWidth - 1, Int(u / Float(width) * Float(depthWidth)))
      let dy = min(depthHeight - 1, Int(v / Float(height) * Float(depthHeight)))
      let seen = depth[dy * depthWidth + dx]
      // Something nearer is in the way: this frame cannot see the point.
      if seen > 0, z > seen + 0.12 { return nil }
    }
    return (u, v, z)
  }

  func colour(u: Float, v: Float) -> simd_float3 {
    let i = (min(height - 1, Int(v)) * width + min(width - 1, Int(u))) * 4
    return simd_float3(Float(pixels[i]), Float(pixels[i + 1]), Float(pixels[i + 2])) / 255
  }
}

/// One ARMeshAnchor's geometry, copied into plain arrays in world space.
struct MeshPart {
  let vertices: [simd_float3]
  let faces: [UInt32]

  init(anchor: ARMeshAnchor) {
    let g = anchor.geometry
    let t = anchor.transform
    var vertices: [simd_float3] = []
    vertices.reserveCapacity(g.vertices.count)
    let base = g.vertices.buffer.contents().advanced(by: g.vertices.offset)
    for i in 0..<g.vertices.count {
      let v = base.advanced(by: i * g.vertices.stride).assumingMemoryBound(to: (Float, Float, Float).self)
        .pointee
      let world = t * simd_float4(v.0, v.1, v.2, 1)
      vertices.append(simd_make_float3(world))
    }
    var faces: [UInt32] = []
    let count = g.faces.count * g.faces.indexCountPerPrimitive
    faces.reserveCapacity(count)
    let raw = g.faces.buffer.contents()
    for i in 0..<count {
      if g.faces.bytesPerIndex == 4 {
        faces.append(raw.advanced(by: i * 4).assumingMemoryBound(to: UInt32.self).pointee)
      } else {
        faces.append(UInt32(raw.advanced(by: i * 2).assumingMemoryBound(to: UInt16.self).pointee))
      }
    }
    self.vertices = vertices
    self.faces = faces
  }
}

/// Colours the mesh and writes `mesh.obj` and `space.scn`.
enum MeshExport {
  /// For a vertex no keyframe saw.
  static let unseen = simd_float3(0.62, 0.62, 0.64)

  static func write(parts: [MeshPart], keyframes: [Keyframe], to folder: URL, seconds: TimeInterval)
    throws -> [String: Any]
  {
    let objURL = folder.appendingPathComponent("mesh.obj")
    let scnURL = folder.appendingPathComponent("space.scn")
    FileManager.default.createFile(atPath: objURL.path, contents: nil)
    guard let obj = try? FileHandle(forWritingTo: objURL) else {
      throw CocoaError(.fileWriteUnknown)
    }
    defer { try? obj.close() }

    let scene = SCNScene()
    var buffer = Data()
    var low = simd_float3(repeating: .greatestFiniteMagnitude)
    var high = simd_float3(repeating: -.greatestFiniteMagnitude)
    var offset: UInt32 = 1
    var vertexCount = 0, faceCount = 0

    func flush(force: Bool = false) {
      if force || buffer.count > 1 << 20 {
        obj.write(buffer)
        buffer.removeAll(keepingCapacity: true)
      }
    }
    buffer.append("# Flex Gym Scan 3D Space: metres, y up, colour per vertex\n".data(using: .utf8)!)

    for part in parts {
      // Only the keyframes near this part are worth trying.
      let centre = part.vertices.reduce(simd_float3(), +) / Float(max(1, part.vertices.count))
      let nearby = keyframes.filter { simd_distance($0.position, centre) < 8 }
      // One buffer, written by many threads, each to its own slice: a
      // Swift array may not be mutated from several threads at once.
      let shared = UnsafeMutableBufferPointer<simd_float3>.allocate(capacity: part.vertices.count)
      shared.initialize(repeating: unseen)
      defer { shared.deallocate() }
      DispatchQueue.concurrentPerform(iterations: part.vertices.count / 512 + 1) { chunk in
        let start = chunk * 512
        let end = min(part.vertices.count, start + 512)
        guard start < end else { return }
        for i in start..<end {
          var best: (score: Float, colour: simd_float3)?
          for frame in nearby {
            guard let seen = frame.look(at: part.vertices[i]) else { continue }
            // Nearer and nearer the middle of the picture is better.
            let du = seen.u / Float(frame.width) - 0.5
            let dv = seen.v / Float(frame.height) - 0.5
            let score = seen.distance + 2 * (du * du + dv * dv)
            if best == nil || score < best!.score {
              best = (score, frame.colour(u: seen.u, v: seen.v))
            }
          }
          if let best = best { shared[i] = best.colour }
        }
      }
      let colours = Array(shared)

      var text = ""
      text.reserveCapacity(part.vertices.count * 48)
      for (v, c) in zip(part.vertices, colours) {
        low = simd_min(low, v)
        high = simd_max(high, v)
        text += String(
          format: "v %.4f %.4f %.4f %.3f %.3f %.3f\n", v.x, v.y, v.z, c.x, c.y, c.z)
      }
      for f in stride(from: 0, to: part.faces.count - 2, by: 3) {
        text += "f \(part.faces[f] + offset) \(part.faces[f + 1] + offset) \(part.faces[f + 2] + offset)\n"
      }
      buffer.append(text.data(using: .utf8)!)
      flush()

      scene.rootNode.addChildNode(node(part, colours: colours))
      offset += UInt32(part.vertices.count)
      vertexCount += part.vertices.count
      faceCount += part.faces.count / 3
    }
    flush(force: true)

    guard scene.write(to: scnURL, options: nil, delegate: nil, progressHandler: nil) else {
      throw CocoaError(.fileWriteUnknown)
    }
    let size = vertexCount > 0 ? high - low : simd_float3()
    return [
      "objPath": objURL.path,
      "scenePath": scnURL.path,
      "bytes": fileSize(objURL) + fileSize(scnURL),
      "vertexCount": vertexCount,
      "faceCount": faceCount,
      "widthM": Double(size.x),
      "lengthM": Double(size.z),
      "heightM": Double(size.y),
      "durationSeconds": Int(seconds),
    ]
  }

  /// A part as a SceneKit node, coloured per vertex, unlit so the colours
  /// are what the camera saw.
  private static func node(_ part: MeshPart, colours: [simd_float3]) -> SCNNode {
    let positions = part.vertices.map { SCNVector3($0.x, $0.y, $0.z) }
    let colourData = colours.withUnsafeBufferPointer { Data(buffer: $0) }
    let colourSource = SCNGeometrySource(
      data: colourData, semantic: .color, vectorCount: colours.count,
      usesFloatComponents: true, componentsPerVector: 3, bytesPerComponent: 4,
      dataOffset: 0, dataStride: MemoryLayout<simd_float3>.stride)
    let element = SCNGeometryElement(indices: part.faces, primitiveType: .triangles)
    let geometry = SCNGeometry(
      sources: [SCNGeometrySource(vertices: positions), colourSource], elements: [element])
    let material = SCNMaterial()
    material.lightingModel = .constant
    material.isDoubleSided = true
    geometry.materials = [material]
    return SCNNode(geometry: geometry)
  }

  private static func fileSize(_ url: URL) -> Int {
    ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.intValue
      ?? 0
  }
}
