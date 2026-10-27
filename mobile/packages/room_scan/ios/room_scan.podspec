#
# LiDAR room scanning for Flex Gym Scan, backed by Apple RoomPlan.
#
Pod::Spec.new do |s|
  s.name             = 'room_scan'
  s.version          = '0.1.0'
  s.summary          = 'LiDAR room scanning via Apple RoomPlan.'
  s.description      = 'Runs a RoomPlan capture session and streams walls, coverage and position to Flutter.'
  s.homepage         = 'http://example.com'
  s.license          = { :type => 'Proprietary', :text => 'Internal use only.' }
  s.author           = 'Flex Motion Technologies'
  s.source           = { :path => '.' }
  s.source_files     = 'Classes/**/*'
  s.dependency 'Flutter'

  # The app's minimum is iOS 17 (I-01), so RoomPlan and ARKit are always present and are
  # linked normally. A device without LiDAR still runs the app: RoomCaptureSession.isSupported
  # answers false and the app shows its "needs LiDAR" screen. CoreMotion feeds the
  # walk-around coverage ring; AVFoundation records the (silent) equipment video.
  s.platform         = :ios, '17.0'
  s.frameworks       = 'UIKit', 'CoreImage', 'RoomPlan', 'ARKit', 'AVFoundation', 'CoreMotion'

  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'i386' }
  s.swift_version    = '5.0'
end
