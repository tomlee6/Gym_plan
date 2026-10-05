import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import '../models/scan.dart';
import '../services/api_client.dart';
import '../services/capture_service.dart';
import '../theme/app_theme.dart';
import '../widgets/capture_fields.dart';
import '../widgets/detail_widgets.dart';
import '../widgets/nav_bar.dart';
import '../widgets/primary_button.dart';
import 'scanning_screen.dart';

/// Capture setup: pick the facility, level and floor-to-floor height, confirm
/// the device can scan, then start.
class NewCaptureScreen extends StatefulWidget {
  const NewCaptureScreen({
    super.key,
    this.initialFacility,
    this.initialLevel = '2',
    this.captureService,
  });

  /// Pre-selects the gym, by name, the user was last looking at.
  final String? initialFacility;

  /// Prefills the level, e.g. the next floor up or the level to recapture.
  final String initialLevel;

  /// Injectable so tests can drive the unsupported-device path.
  final CaptureService? captureService;

  @override
  State<NewCaptureScreen> createState() => _NewCaptureScreenState();
}

class _NewCaptureScreenState extends State<NewCaptureScreen> {
  /// The 3D model extrudes walls to this height, so keep it plausible for a
  /// gym floor rather than accepting any number.
  static const double _minHeightM = 2.0;
  static const double _maxHeightM = 12.0;

  late final TextEditingController _levelController = TextEditingController(
    text: widget.initialLevel,
  );
  final TextEditingController _heightController = TextEditingController(
    text: '3.20',
  );
  final FocusNode _levelFocus = FocusNode();
  final FocusNode _heightFocus = FocusNode();

  late final CaptureService _service =
      widget.captureService ?? CaptureService();

  List<Facility> _facilities = const <Facility>[];
  Facility? _facility;
  DeviceCapability? _device;
  String? _loadError;
  bool _noFacilities = false;

  String? _levelError;
  String? _heightError;

  @override
  void initState() {
    super.initState();
    _loadSetup();
  }

  @override
  void dispose() {
    _levelController.dispose();
    _heightController.dispose();
    _levelFocus.dispose();
    _heightFocus.dispose();
    super.dispose();
  }

  Future<void> _loadSetup() async {
    setState(() {
      _loadError = null;
      _noFacilities = false;
    });
    final FacilityList list;
    final DeviceCapability device;
    try {
      list = await _service.facilities();
      device = await _service.checkDevice();
    } on ApiException catch (e) {
      if (mounted) setState(() => _loadError = e.message);
      return;
    } catch (_) {
      // Anything unexpected still ends the spinner with a way to retry.
      if (mounted) {
        setState(() => _loadError = 'The capture setup could not be loaded.');
      }
      return;
    }
    if (!mounted) return;

    // A new account has no gyms until its admin adds one; there is nothing
    // to capture against, so say so rather than wait.
    if (list.facilities.isEmpty) {
      setState(() => _noFacilities = true);
      return;
    }

    Facility? named(String? name) =>
        list.facilities.where((Facility f) => f.name == name).firstOrNull;
    Facility? byId(String? id) =>
        list.facilities.where((Facility f) => f.id == id).firstOrNull;

    setState(() {
      _facilities = list.facilities;
      _device = device;
      // The gym passed in if the user can pick it, else their default.
      _facility =
          named(widget.initialFacility) ??
          byId(list.defaultId) ??
          list.facilities.firstOrNull;
    });
  }

  bool get _ready => _device != null && _facility != null;

  void _startScan() {
    FocusScope.of(context).unfocus();

    final String level = _levelController.text.trim();
    final double? height = double.tryParse(_heightController.text.trim());

    setState(() {
      _levelError = level.isEmpty ? 'Enter the level.' : null;
      if (height == null) {
        _heightError = 'Enter the floor-to-floor height.';
      } else if (height < _minHeightM || height > _maxHeightM) {
        _heightError =
            'Height must be between ${_minHeightM.toStringAsFixed(1)} and '
            '${_maxHeightM.toStringAsFixed(1)} m.';
      } else {
        _heightError = null;
      }
    });

    if (_levelError != null || _heightError != null) return;

    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ScanningScreen(
          config: ScanConfig(
            facilityId: _facility!.id,
            facility: _facility!.name,
            level: int.parse(level),
            heightM: height!,
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      // Let the body shrink for the keyboard so the focused field scrolls
      // into view and "Start scan" stays reachable above it.
      body: GestureDetector(
        // The numeric keyboards have no return key, so tapping away is the
        // only way to dismiss them.
        onTap: () => FocusScope.of(context).unfocus(),
        behavior: HitTestBehavior.opaque,
        child: SafeArea(
          child: Column(
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.only(left: 8, right: 12),
                child: NavBar(
                  backLabel: 'Home',
                  onBack: () => Navigator.of(context).maybePop(),
                  trailingLabel: 'Cancel',
                  onTrailing: () => Navigator.of(context).maybePop(),
                ),
              ),
              Expanded(
                child: _loadError != null
                    ? ErrorView(message: _loadError!, onRetry: _loadSetup)
                    : _noFacilities
                    ? ErrorView(
                        icon: Icons.store_mall_directory_outlined,
                        title: 'No facility available',
                        message:
                            'Your account has no gyms to capture yet. Ask '
                            'your account admin to add one, then try again.',
                        onRetry: _loadSetup,
                      )
                    : _ready
                    ? _buildForm()
                    : _buildLoading(),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildLoading() {
    return const Center(
      child: CupertinoActivityIndicator(color: AppColors.textMuted, radius: 12),
    );
  }

  Widget _buildForm() {
    final DeviceCapability device = _device!;

    return Column(
      children: <Widget>[
        Expanded(
          child: SingleChildScrollView(
            physics: const BouncingScrollPhysics(
              parent: AlwaysScrollableScrollPhysics(),
            ),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 10, 20, 0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  const Text('New capture', style: AppTheme.largeTitle),
                  const SizedBox(height: 8),
                  const Text(
                    'One level per capture. Set the height before you start — '
                    'the 3D model raises the walls to it.',
                    style: AppTheme.body,
                  ),
                  const SizedBox(height: 26),

                  LabelledField(
                    label: 'Facility',
                    child: PickerField(
                      icon: Icons.home_work_outlined,
                      value: _facility!.name,
                      options: <String>[
                        for (final Facility f in _facilities) f.name,
                      ],
                      onChanged: (String name) => setState(
                        () => _facility = _facilities.firstWhere(
                          (Facility f) => f.name == name,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 14),

                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Expanded(
                        child: LabelledField(
                          label: 'Level',
                          errorText: _levelError,
                          child: NumericField(
                            controller: _levelController,
                            focusNode: _levelFocus,
                            hasError: _levelError != null,
                            semanticLabel: 'Level',
                            onSubmitted: (_) => _heightFocus.requestFocus(),
                          ),
                        ),
                      ),
                      const SizedBox(width: 14),
                      Expanded(
                        child: LabelledField(
                          label: 'Floor to floor',
                          errorText: _heightError,
                          child: NumericField(
                            controller: _heightController,
                            focusNode: _heightFocus,
                            unit: 'm',
                            decimal: true,
                            hasError: _heightError != null,
                            semanticLabel: 'Floor to floor height in metres',
                            onSubmitted: (_) => _startScan(),
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 14),

                  LabelledField(
                    label: 'Device',
                    child: DeviceStatusRow(
                      supported: device.supported,
                      headline: device.headline,
                      detail: device.detail,
                    ),
                  ),
                  const SizedBox(height: 22),

                  const ChecklistCard(
                    title: 'Before you start',
                    steps: <String>[
                      'Walk the full perimeter without lifting the phone.',
                      'Tag fire exits, mirror walls and ceiling height as you '
                          'pass them.',
                      'Do not leave until the coverage check is clear.',
                    ],
                  ),
                  const SizedBox(height: 22),
                ],
              ),
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 34),
          child: PrimaryButton(
            label: 'Start scan',
            icon: Icons.crop_free_rounded,
            // A phone without LiDAR cannot produce a usable scan, so the
            // sign-in screen's warning is enforced here.
            onPressed: device.supported ? _startScan : null,
          ),
        ),
      ],
    );
  }
}
