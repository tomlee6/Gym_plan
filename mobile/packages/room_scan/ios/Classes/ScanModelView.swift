import Flutter
import SceneKit
import UIKit

/**
 The finished room as a 3D model, Polycam style: RoomPlan's exported
 `scan.usdz` in a SceneKit view the surveyor can turn and zoom before
 submitting. Flutter shows it as the `flex/scan_model_view` platform view
 (ScanModelPreview in room_scan.dart).

 The camera starts above and to one side of the room, looking down at its
 centre, so the whole floor is in view at once; SceneKit's own camera
 control then turns it round that centre.
 */
final class ScanModelPlatformView: NSObject, FlutterPlatformView {
  private let sceneView = SCNView()

  init(frame: CGRect, path: String?) {
    super.init()
    sceneView.frame = frame
    sceneView.backgroundColor = UIColor(red: 0.04, green: 0.07, blue: 0.09, alpha: 1)
    sceneView.antialiasingMode = .multisampling4X
    sceneView.allowsCameraControl = true
    sceneView.autoenablesDefaultLighting = true
    sceneView.defaultCameraController.interactionMode = .orbitTurntable
    sceneView.defaultCameraController.inertiaEnabled = true

    guard let path = path,
      let scene = try? SCNScene(url: URL(fileURLWithPath: path), options: nil)
    else {
      showMessage("The 3D model could not be opened.")
      return
    }
    sceneView.scene = scene
    aimCamera(at: scene)
  }

  func view() -> UIView { sceneView }

  /// Puts a camera above and to one side of the room, aimed at its centre,
  /// far enough back to see all of it.
  private func aimCamera(at scene: SCNScene) {
    let (low, high) = scene.rootNode.boundingBox
    let centre = SCNVector3(
      (low.x + high.x) / 2, (low.y + high.y) / 2, (low.z + high.z) / 2)
    let size = max(high.x - low.x, high.y - low.y, high.z - low.z, 1)

    let camera = SCNCamera()
    camera.zNear = 0.05
    camera.zFar = Double(size) * 20
    camera.fieldOfView = 45

    let node = SCNNode()
    node.camera = camera
    node.position = SCNVector3(
      centre.x + size * 0.75, centre.y + size * 0.95, centre.z + size * 0.75)
    node.look(at: centre)
    scene.rootNode.addChildNode(node)

    sceneView.pointOfView = node
    sceneView.defaultCameraController.target = centre
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

final class ScanModelViewFactory: NSObject, FlutterPlatformViewFactory {
  func create(withFrame frame: CGRect, viewIdentifier viewId: Int64, arguments args: Any?)
    -> FlutterPlatformView
  {
    let path = (args as? [String: Any])?["path"] as? String
    return ScanModelPlatformView(frame: frame, path: path)
  }

  /// The path arrives in the creation arguments, as a map.
  func createArgsCodec() -> FlutterMessageCodec & NSObjectProtocol {
    FlutterStandardMessageCodec.sharedInstance()
  }
}
