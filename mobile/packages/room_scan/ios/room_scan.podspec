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

  # The app supports iOS 14+ (background uploads need it); RoomPlan needs iOS 16 and a LiDAR sensor,
  # so it is weak-linked and every use is behind an availability check.
  s.platform         = :ios, '14.0'
  s.weak_frameworks  = 'RoomPlan', 'ARKit'
  s.frameworks       = 'UIKit', 'CoreImage'

  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'i386' }
  s.swift_version    = '5.0'
end
