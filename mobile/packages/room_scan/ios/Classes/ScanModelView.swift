import Flutter
import SceneKit
import UIKit
import simd

/**
 The finished room as a 3D model, Polycam style: RoomPlan's exported
 `scan.usdz` in a SceneKit view the surveyor can turn and zoom. Flutter
 shows it as the `flex/scan_model_view` platform view (ScanModelPreview in
 room_scan.dart).

 With the scan's `scan.json`, each wall carries a label with its length,
 floating above the wall and always facing the camera.

 Measure mode: tap a point on the model, then another, and a line joins
 them with the straight-line distance in metres. Taps keep adding
 measurements; drags still turn the model and pinches zoom it.

 Each view has its own channel, `flex/scan_model_view_<id>`. Flutter calls
 `reset`, `top`, `labels` (on or off), `measure` (on or off),
 `undoMeasure` and `clearMeasures`; the view calls back `measured` with
 every finished measurement's length, in metres, after each change.

 The camera starts above and to one side of the room, looking down at its
 centre, so the whole floor is in view at once; SceneKit's own camera
 control then turns it round that centre.
 */
final class ScanModelPlatformView: NSObject, FlutterPlatformView {
  private let sceneView = SCNView()
  private var channel: FlutterMethodChannel?
  private var framing: ModelFraming?
  private let labels = SCNNode()

  // Measure mode.
  private let rulers = SCNNode()
  private var measuring = false
  /// The first end of a measurement still waiting for its second.
  private var pending: (point: SCNVector3, dot: SCNNode)?
  /// Each finished measurement: its dots, line and label, and its length.
  private var measures: [(node: SCNNode, metres: Float)] = []
  private lazy var tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))

  init(frame: CGRect, viewId: Int64, args: [String: Any], messenger: FlutterBinaryMessenger) {
    super.init()
    sceneView.frame = frame
    sceneView.backgroundColor = ModelFraming.background
    sceneView.antialiasingMode = .multisampling4X
    sceneView.allowsCameraControl = true
    sceneView.autoenablesDefaultLighting = true
    sceneView.defaultCameraController.interactionMode = .orbitTurntable
    sceneView.defaultCameraController.inertiaEnabled = true

    channel = FlutterMethodChannel(
      name: "flex/scan_model_view_\(viewId)", binaryMessenger: messenger)
    channel?.setMethodCallHandler { [weak self] call, result in
      self?.handle(call)
      result(nil)
    }

    guard let path = args["path"] as? String,
      let scene = try? SCNScene(url: URL(fileURLWithPath: path), options: nil)
    else {
      showMessage("The 3D model could not be opened.")
      return
    }
    sceneView.scene = scene
    let framing = ModelFraming(scene: scene)
    self.framing = framing
    scene.rootNode.addChildNode(framing.camera)
    sceneView.pointOfView = framing.camera
    sceneView.defaultCameraController.target = framing.centre

    if let dataPath = args["dataPath"] as? String {
      for wall in RoomWalls.read(from: URL(fileURLWithPath: dataPath)) where wall.width >= 0.5 {
        let label = MeasureLabel.node(
          String(format: "%.2f m", wall.width), height: framing.labelHeight)
        label.position = SCNVector3(
          wall.centre.x, wall.centre.y + wall.height / 2 + Float(framing.labelHeight), wall.centre.z)
        labels.addChildNode(label)
      }
      scene.rootNode.addChildNode(labels)
    }
    labels.isHidden = !((args["labels"] as? Bool) ?? true)

    scene.rootNode.addChildNode(rulers)
    tap.isEnabled = false
    sceneView.addGestureRecognizer(tap)
  }

  func view() -> UIView { sceneView }

  private func handle(_ call: FlutterMethodCall) {
    guard let framing = framing else { return }
    switch call.method {
    case "reset":
      move(to: framing.startPosition, up: SCNVector3(0, 1, 0))
    case "top":
      // Straight down; "up" on screen is the room's far side.
      let above = SCNVector3(
        framing.centre.x, framing.centre.y + framing.size * 1.6, framing.centre.z + 0.001)
      move(to: above, up: SCNVector3(0, 0, -1))
    case "labels":
      labels.isHidden = !((call.arguments as? Bool) ?? true)
    case "measure":
      measuring = (call.arguments as? Bool) ?? false
      tap.isEnabled = measuring
      if !measuring { dropPending() }
    case "undoMeasure":
      if pending != nil {
        dropPending()
      } else if let last = measures.popLast() {
        last.node.removeFromParentNode()
        sendMeasures()
      }
    case "clearMeasures":
      dropPending()
      for m in measures { m.node.removeFromParentNode() }
      measures.removeAll()
      sendMeasures()
    default:
      break
    }
  }

  // MARK: - Measure mode

  /// One end of a measurement where the tap meets the model's surface;
  /// the second end finishes it with a line and its length.
  @objc private func tapped(_ gesture: UITapGestureRecognizer) {
    guard measuring, let framing = framing else { return }
    let hits = sceneView.hitTest(
      gesture.location(in: sceneView),
      options: [
        .searchMode: SCNHitTestSearchMode.closest.rawValue,
        // The model only, never the labels and rulers drawn over it.
        .categoryBitMask: ModelFraming.modelCategory,
        .ignoreHiddenNodes: true,
      ])
    guard let point = hits.first?.worldCoordinates else { return }

    let dot = Ruler.dot(radius: framing.dotRadius)
    dot.position = point

    guard let start = pending else {
      rulers.addChildNode(dot)
      pending = (point, dot)
      return
    }
    pending = nil

    let metres = Ruler.distance(start.point, point)
    let group = SCNNode()
    start.dot.removeFromParentNode()
    group.addChildNode(start.dot)
    group.addChildNode(dot)
    group.addChildNode(Ruler.line(from: start.point, to: point, radius: framing.dotRadius * 0.4))
    let label = MeasureLabel.node(
      String(format: "%.2f m", metres), height: framing.labelHeight, stroke: Ruler.colour)
    label.position = SCNVector3(
      (start.point.x + point.x) / 2,
      (start.point.y + point.y) / 2 + Float(framing.labelHeight) * 0.9,
      (start.point.z + point.z) / 2)
    group.addChildNode(label)
    rulers.addChildNode(group)
    measures.append((group, metres))
    sendMeasures()
  }

  private func dropPending() {
    pending?.dot.removeFromParentNode()
    pending = nil
  }

  private func sendMeasures() {
    channel?.invokeMethod("measured", arguments: measures.map { Double($0.metres) })
  }

  // MARK: - Camera

  private func move(to position: SCNVector3, up: SCNVector3) {
    guard let framing = framing else { return }
    SCNTransaction.begin()
    SCNTransaction.animationDuration = 0.45
    framing.camera.position = position
    framing.camera.look(at: framing.centre, up: up, localFront: SCNVector3(0, 0, -1))
    SCNTransaction.commit()
    sceneView.pointOfView = framing.camera
    sceneView.defaultCameraController.target = framing.centre
  }

  private func showMessage(_ text: String) {
    let label = UILabel()
    label.text = text
    label.textColor = UIColor(white: 0.55, alpha: 1)
    label.font = .systemFont(ofSize: 13)
    label.textAlignment = .center
    label.numberOfLines = 0
    label.translatesAutoresizingMaskIntoConstraints = false
    sceneView.addSubview(label)
    NSLayoutConstraint.activate([
      label.centerXAnchor.constraint(equalTo: sceneView.centerXAnchor),
      label.centerYAnchor.constraint(equalTo: sceneView.centerYAnchor),
      label.leadingAnchor.constraint(greaterThanOrEqualTo: sceneView.leadingAnchor, constant: 16),
    ])
  }
}

/// Where the camera goes for a model: above and to one side of the room,
/// aimed at its centre, far enough back to see all of it.
struct ModelFraming {
  static let background = UIColor(red: 0.04, green: 0.07, blue: 0.09, alpha: 1)

  /// The model's own nodes keep SceneKit's default category; everything
  /// drawn over it (labels, rulers) is put in another, so a measuring tap
  /// lands on the room, not on a label.
  static let modelCategory = 1
  static let overlayCategory = 2

  let centre: SCNVector3
  let size: Float
  let startPosition: SCNVector3
  let camera: SCNNode

  /// How tall a label is in the scene, in metres: readable from the
  /// opening angle whether the room is a studio or a whole gym floor.
  var labelHeight: CGFloat { CGFloat(max(0.18, size * 0.035)) }

  /// A measurement's end dot, sized to the room like the labels.
  var dotRadius: CGFloat { CGFloat(max(0.03, size * 0.006)) }

  init(scene: SCNScene) {
    let (low, high) = scene.rootNode.boundingBox
    centre = SCNVector3((low.x + high.x) / 2, (low.y + high.y) / 2, (low.z + high.z) / 2)
    size = max(high.x - low.x, high.y - low.y, high.z - low.z, 1)
    startPosition = SCNVector3(
      centre.x + size * 0.75, centre.y + size * 0.95, centre.z + size * 0.75)

    let lens = SCNCamera()
    lens.zNear = 0.05
    lens.zFar = Double(size) * 20
    lens.fieldOfView = 45
    camera = SCNNode()
    camera.camera = lens
    camera.position = startPosition
    camera.look(at: centre)
  }
}

/// The dots and lines of a measurement, drawn over the model.
enum Ruler {
  static let colour = UIColor(red: 0.45, green: 0.38, blue: 1.0, alpha: 1)

  static func distance(_ a: SCNVector3, _ b: SCNVector3) -> Float {
    simd_distance(simd_float3(a.x, a.y, a.z), simd_float3(b.x, b.y, b.z))
  }

  static func dot(radius: CGFloat) -> SCNNode {
    let node = SCNNode(geometry: SCNSphere(radius: radius))
    node.geometry?.materials = [overlay(colour)]
    node.renderingOrder = 110
    node.categoryBitMask = ModelFraming.overlayCategory
    return node
  }

  /// A thin rod from `a` to `b`. SceneKit's cylinder stands along its own
  /// y axis, so it is turned to point from one end to the other.
  static func line(from a: SCNVector3, to b: SCNVector3, radius: CGFloat) -> SCNNode {
    let from = simd_float3(a.x, a.y, a.z)
    let to = simd_float3(b.x, b.y, b.z)
    let length = simd_distance(from, to)
    let rod = SCNCylinder(radius: radius, height: CGFloat(length))
    rod.materials = [overlay(colour)]
    let node = SCNNode(geometry: rod)
    node.simdPosition = (from + to) / 2
    if length > 0.0001 {
      node.simdOrientation = simd_quatf(from: simd_float3(0, 1, 0), to: (to - from) / length)
    }
    node.renderingOrder = 105
    node.categoryBitMask = ModelFraming.overlayCategory
    return node
  }

  /// Flat colour, always drawn on top so a measurement stays visible.
  private static func overlay(_ colour: UIColor) -> SCNMaterial {
    let material = SCNMaterial()
    material.diffuse.contents = colour
    material.lightingModel = .constant
    material.readsFromDepthBuffer = false
    return material
  }
}

/// The walls in RoomPlan's `scan.json`: a CapturedRoom, or a
/// CapturedStructure with its walls at the top or only in its `rooms`.
/// Each has a `transform` (16 numbers, column by column) and `dimensions`
/// (width, height, depth), as shared/plan/reading.js reads them too.
enum RoomWalls {
  struct Wall {
    let centre: SCNVector3
    let width: Float
    let height: Float
  }

  static func read(from url: URL) -> [Wall] {
    guard let data = try? Data(contentsOf: url),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return [] }
    var walls = (json["walls"] as? [[String: Any]]) ?? []
    if walls.isEmpty {
      for room in (json["rooms"] as? [[String: Any]]) ?? [] {
        walls += (room["walls"] as? [[String: Any]]) ?? []
      }
    }
    return walls.compactMap { wall in
      let t = flatten(wall["transform"])
      let d = flatten(wall["dimensions"])
      guard t.count == 16, d.count >= 2 else { return nil }
      return Wall(centre: SCNVector3(t[12], t[13], t[14]), width: d[0], height: d[1])
    }
  }

  /// Numbers in any nesting of arrays, in order.
  private static func flatten(_ value: Any?) -> [Float] {
    if let n = value as? NSNumber { return [n.floatValue] }
    if let list = value as? [Any] { return list.flatMap { flatten($0) } }
    return []
  }
}

/// A length as a small pill in the scene ("4.20 m"), drawn on top of
/// everything and turned to face the camera.
enum MeasureLabel {
  static let teal = UIColor(red: 0.0, green: 0.79, blue: 0.70, alpha: 1)

  static func node(_ text: String, height: CGFloat, stroke: UIColor = teal) -> SCNNode {
    let font = UIFont.systemFont(ofSize: 40, weight: .semibold)
    let attributes: [NSAttributedString.Key: Any] = [
      .font: font, .foregroundColor: UIColor.white,
    ]
    let textSize = (text as NSString).size(withAttributes: attributes)
    let pad = CGSize(width: 24, height: 12)
    let size = CGSize(
      width: ceil(textSize.width + pad.width * 2), height: ceil(textSize.height + pad.height * 2))

    let image = UIGraphicsImageRenderer(size: size).image { _ in
      let pill = UIBezierPath(
        roundedRect: CGRect(origin: .zero, size: size).insetBy(dx: 2, dy: 2),
        cornerRadius: size.height / 2)
      UIColor(red: 0.01, green: 0.04, blue: 0.06, alpha: 0.9).setFill()
      pill.fill()
      stroke.setStroke()
      pill.lineWidth = 3
      pill.stroke()
      (text as NSString).draw(at: CGPoint(x: pad.width, y: pad.height), withAttributes: attributes)
    }

    let plane = SCNPlane(width: height * size.width / size.height, height: height)
    let material = SCNMaterial()
    material.diffuse.contents = image
    material.lightingModel = .constant
    material.isDoubleSided = true
    // Always readable, even behind a wall.
    material.readsFromDepthBuffer = false
    plane.materials = [material]

    let node = SCNNode(geometry: plane)
    node.renderingOrder = 100
    node.categoryBitMask = ModelFraming.overlayCategory
    node.constraints = [SCNBillboardConstraint()]
    return node
  }
}

/// A still of a model from the angle the 3D view opens at, for the
/// dashboard's scan thumbnails.
enum ModelThumbnail {
  static func render(modelPath: String, to outPath: String, side: CGFloat = 600) -> Bool {
    guard let scene = try? SCNScene(url: URL(fileURLWithPath: modelPath), options: nil),
      let device = MTLCreateSystemDefaultDevice()
    else { return false }
    scene.background.contents = ModelFraming.background
    let framing = ModelFraming(scene: scene)
    scene.rootNode.addChildNode(framing.camera)

    let renderer = SCNRenderer(device: device, options: nil)
    renderer.scene = scene
    renderer.autoenablesDefaultLighting = true
    renderer.pointOfView = framing.camera
    let image = renderer.snapshot(
      atTime: 0, with: CGSize(width: side, height: side), antialiasingMode: .multisampling4X)
    guard let png = image.pngData() else { return false }
    do {
      try png.write(to: URL(fileURLWithPath: outPath))
      return true
    } catch {
      return false
    }
  }
}

final class ScanModelViewFactory: NSObject, FlutterPlatformViewFactory {
  private let messenger: FlutterBinaryMessenger

  init(messenger: FlutterBinaryMessenger) {
    self.messenger = messenger
    super.init()
  }

  func create(withFrame frame: CGRect, viewIdentifier viewId: Int64, arguments args: Any?)
    -> FlutterPlatformView
  {
    ScanModelPlatformView(
      frame: frame, viewId: viewId, args: (args as? [String: Any]) ?? [:], messenger: messenger)
  }

  /// The paths arrive in the creation arguments, as a map.
  func createArgsCodec() -> FlutterMessageCodec & NSObjectProtocol {
    FlutterStandardMessageCodec.sharedInstance()
  }
}
