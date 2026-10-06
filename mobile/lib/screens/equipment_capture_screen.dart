import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:room_scan/room_scan.dart';

import '../models/equipment.dart';
import '../models/scan.dart';
import '../theme/app_theme.dart';
import '../widgets/hairline_container.dart';
import '../widgets/nav_bar.dart';
import '../widgets/primary_button.dart';
import '../services/equipment_recording.dart';

/// CHANGE 3: the 360 degree walk round each gym machine.
///
/// This is a second capture stage, after the LiDAR room scan and before the
/// capture is submitted. It does not replace the scan: the geometry still
/// comes from LiDAR, and these videos hang off the machines as reference.
///
/// Each machine is marked first — on an object the scan already found where
/// possible, so the measured footprint is kept and only the name is typed —
/// and then walked round with the camera.
///
/// Requires an iOS device to test: there is no camera in the simulator, and
/// `EquipmentRecorder.prepare` fails there.
class EquipmentCaptureScreen extends StatefulWidget {
  const EquipmentCaptureScreen({
    super.key,
    required this.result,
    required this.equipment,
    this.videos = const <String, EquipmentVideo>{},
  });

  final ScanResult result;

  /// Machines marked so far, which the screen adds to.
  final List<Equipment> equipment;

  /// Walkarounds recorded so far, by equipment id.
  final Map<String, EquipmentVideo> videos;

  @override
  State<EquipmentCaptureScreen> createState() => _EquipmentCaptureScreenState();
}

class _EquipmentCaptureScreenState extends State<EquipmentCaptureScreen> {
  late List<Equipment> _equipment = List<Equipment>.of(widget.equipment);
  late Map<String, EquipmentVideo> _videos = Map<String, EquipmentVideo>.of(
    widget.videos,
  );

  @override
  Widget build(BuildContext context) {
    final List<RoomScanObject> unmarked = _unmarkedObjects();

    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Column(
          children: <Widget>[
            NavBar(
              backLabel: 'Review',
              onBack: () => Navigator.of(context).pop(_outcome()),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                children: <Widget>[
                  const _Intro(),
                  const SizedBox(height: 16),
                  if (_equipment.isEmpty && unmarked.isEmpty)
                    const HairlineContainer(
                      radius: 12,
                      child: Padding(
                        padding: EdgeInsets.all(16),
                        child: Text(
                          'The scan recognised no objects to mark. Add a machine by hand to '
                          'record a walkaround for it.',
                          style: TextStyle(color: AppColors.textMuted),
                        ),
                      ),
                    ),
                  for (final Equipment e in _equipment)
                    _MachineCard(
                      equipment: e,
                      video: _videos[e.equipmentId],
                      onRecord: () => _record(e),
                      onRename: () => _rename(e),
                      onRemove: () => _remove(e),
                    ),
                  if (unmarked.isNotEmpty) ...<Widget>[
                    const SizedBox(height: 8),
                    Text(
                      'Objects the scan found (${unmarked.length})',
                      style: const TextStyle(
                        color: AppColors.textMuted,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 8),
                    for (final RoomScanObject o in unmarked)
                      _DetectedCard(object: o, onMark: () => _markDetected(o)),
                  ],
                  const SizedBox(height: 12),
                  OutlinedButton(
                    onPressed: _addByHand,
                    child: const Text('Add a machine by hand'),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
              child: Column(
                children: <Widget>[
                  if (_missingVideos > 0)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Text(
                        '$_missingVideos machine${_missingVideos == 1 ? '' : 's'} '
                        'still need${_missingVideos == 1 ? 's' : ''} a walkaround.',
                        style: AppTheme.footnote,
                        textAlign: TextAlign.center,
                      ),
                    ),
                  PrimaryButton(
                    label: 'Done',
                    // The scan cannot be submitted until this step is
                    // finished, so Done is only offered once every machine
                    // marked has been walked round.
                    onPressed: _missingVideos > 0 ? null : _finish,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Machines marked but not yet walked round.
  int get _missingVideos => _equipment
      .where((Equipment e) => !_videos.containsKey(e.equipmentId))
      .length;

  /// Leaving by the back arrow keeps whatever was done, but does not mark
  /// the step finished: the scan stays unsubmittable until Done is pressed.
  EquipmentCaptureOutcome _outcome({bool complete = false}) =>
      EquipmentCaptureOutcome(
        equipment: _equipment,
        videos: _videos,
        complete: complete,
      );

  /// Finishes the step.
  ///
  /// A level with no equipment on it is a real case — a studio, a stairwell
  /// — so it can be finished, but only by saying so out loud. Otherwise a
  /// surveyor who simply skipped the step could never submit the scan.
  Future<void> _finish() async {
    if (_equipment.isEmpty) {
      final bool confirmed =
          await showDialog<bool>(
            context: context,
            builder: (BuildContext context) => AlertDialog(
              backgroundColor: AppColors.surface,
              title: const Text(
                'No equipment here?',
                style: TextStyle(color: AppColors.textPrimary),
              ),
              content: const Text(
                'Nothing has been marked on this level. Confirm there is no gym '
                'equipment to record.',
                style: TextStyle(color: AppColors.textMuted),
              ),
              actions: <Widget>[
                TextButton(
                  onPressed: () => Navigator.of(context).pop(false),
                  child: const Text('Go back'),
                ),
                TextButton(
                  onPressed: () => Navigator.of(context).pop(true),
                  child: const Text('No equipment'),
                ),
              ],
            ),
          ) ??
          false;
      if (!confirmed || !mounted) return;
    }
    Navigator.of(context).pop(_outcome(complete: true));
  }

  /// Objects the scan found that have not been named yet. One object is
  /// never marked twice.
  List<RoomScanObject> _unmarkedObjects() {
    final Set<int> taken = _equipment
        .map((Equipment e) => e.detectedIndex)
        .whereType<int>()
        .toSet();
    return widget.result.detected
        .where((RoomScanObject o) => !taken.contains(o.index))
        .toList();
  }

  Future<void> _markDetected(RoomScanObject object) async {
    final _Named? named = await _askName();
    if (named == null) return;
    setState(() {
      _equipment = <Equipment>[
        ..._equipment,
        Equipment.fromDetected(
          equipmentId: nextEquipmentId(_equipment),
          type: named.type,
          name: named.name,
          object: object,
        ),
      ];
    });
  }

  /// A machine the scan missed. It has no measured footprint, so the
  /// reviewer sizes it: nothing is invented here.
  Future<void> _addByHand() async {
    final _Named? named = await _askName();
    if (named == null) return;
    setState(() {
      _equipment = <Equipment>[
        ..._equipment,
        Equipment(
          equipmentId: nextEquipmentId(_equipment),
          type: named.type,
          name: named.name,
        ),
      ];
    });
  }

  Future<void> _rename(Equipment equipment) async {
    final _Named? named = await _askName(
      type: equipment.type,
      name: equipment.name,
    );
    if (named == null) return;
    setState(() {
      _equipment = <Equipment>[
        for (final Equipment e in _equipment)
          if (e.equipmentId == equipment.equipmentId)
            e.copyWith(type: named.type, name: named.name)
          else
            e,
      ];
    });
  }

  void _remove(Equipment equipment) {
    final EquipmentVideo? video = _videos[equipment.equipmentId];
    if (video != null) unawaited(EquipmentRecorder.discard(video));
    setState(() {
      _equipment = _equipment
          .where((Equipment e) => e.equipmentId != equipment.equipmentId)
          .toList();
      _videos = Map<String, EquipmentVideo>.of(_videos)
        ..remove(equipment.equipmentId);
    });
  }

  Future<_Named?> _askName({String? type, String? name}) =>
      showModalBottomSheet<_Named>(
        context: context,
        backgroundColor: AppColors.surface,
        isScrollControlled: true,
        builder: (_) => _NameSheet(type: type, name: name),
      );

  Future<void> _record(Equipment equipment) async {
    final EquipmentVideo? recorded = await Navigator.of(context)
        .push<EquipmentVideo>(
          MaterialPageRoute<EquipmentVideo>(
            builder: (_) => _RecordScreen(
              equipment: equipment,
              existing: _videos[equipment.equipmentId],
            ),
          ),
        );
    if (recorded == null || !mounted) return;
    setState(() {
      _videos = Map<String, EquipmentVideo>.of(_videos)
        ..[equipment.equipmentId] = recorded;
    });
  }
}

/// What the equipment step produced, handed back to the review screen.
class EquipmentCaptureOutcome {
  const EquipmentCaptureOutcome({
    required this.equipment,
    required this.videos,
    this.complete = false,
  });

  final List<Equipment> equipment;
  final Map<String, EquipmentVideo> videos;

  /// The surveyor finished the step, rather than stepping back out of it.
  /// The scan cannot be submitted until this is true.
  final bool complete;
}

class _Intro extends StatelessWidget {
  const _Intro();

  @override
  Widget build(BuildContext context) => const HairlineContainer(
    radius: 12,
    child: Padding(
      padding: EdgeInsets.all(16),
      child: Text(
        'Name each machine, then walk once around it with the camera. The walkaround is '
        'for the reviewer to look at: the plan still comes from the scan.',
        style: TextStyle(color: AppColors.textMuted, height: 1.4),
      ),
    ),
  );
}

class _DetectedCard extends StatelessWidget {
  const _DetectedCard({required this.object, required this.onMark});

  final RoomScanObject object;
  final VoidCallback onMark;

  @override
  Widget build(BuildContext context) {
    final String size =
        '${object.widthM.toStringAsFixed(2)} × ${object.depthM.toStringAsFixed(2)} m';
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: HairlineContainer(
        radius: 12,
        child: ListTile(
          title: Text(size, style: const TextStyle(color: Colors.white)),
          subtitle: Text(
            // RoomPlan's own category, which has nothing for gym machines.
            object.category == 'object'
                ? 'Unrecognised object'
                : 'Read as ${equipmentLabel(object.category).toLowerCase()}',
            style: const TextStyle(color: AppColors.textMuted),
          ),
          trailing: TextButton(onPressed: onMark, child: const Text('Name it')),
        ),
      ),
    );
  }
}

class _MachineCard extends StatelessWidget {
  const _MachineCard({
    required this.equipment,
    required this.video,
    required this.onRecord,
    required this.onRename,
    required this.onRemove,
  });

  final Equipment equipment;
  final EquipmentVideo? video;
  final VoidCallback onRecord;
  final VoidCallback onRename;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final bool recorded = video != null;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: HairlineContainer(
        radius: 12,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                children: <Widget>[
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          equipment.name,
                          style: const TextStyle(
                            color: Colors.white,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        Text(
                          '${equipment.equipmentId} · ${equipmentLabel(equipment.type)}'
                          '${equipment.placed ? '' : ' · not placed'}',
                          style: const TextStyle(
                            color: AppColors.textMuted,
                            fontSize: 12,
                          ),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    onPressed: onRename,
                    icon: const Icon(
                      Icons.edit_outlined,
                      color: AppColors.textMuted,
                    ),
                    tooltip: 'Rename',
                  ),
                  IconButton(
                    onPressed: onRemove,
                    icon: const Icon(
                      Icons.delete_outline,
                      color: AppColors.textMuted,
                    ),
                    tooltip: 'Remove',
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Row(
                children: <Widget>[
                  if (recorded)
                    Expanded(
                      child: Text(
                        // A demo walk says so, so nobody takes it for a
                        // real recording that failed to upload.
                        video!.simulated
                            ? 'Simulated walkaround · ${video!.duration.inSeconds} s'
                            : '360° recorded · ${video!.duration.inSeconds} s',
                        style: TextStyle(
                          color: video!.simulated
                              ? AppColors.textMuted
                              : AppColors.accent,
                          fontSize: 12,
                        ),
                      ),
                    )
                  else
                    const Expanded(
                      child: Text(
                        'No walkaround yet',
                        style: TextStyle(
                          color: AppColors.textMuted,
                          fontSize: 12,
                        ),
                      ),
                    ),
                  TextButton(
                    onPressed: onRecord,
                    child: Text(recorded ? 'Retake' : 'Start 360° capture'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Named {
  const _Named(this.type, this.name);
  final String type;
  final String name;
}

/// Naming a machine. The type is a free text field with the catalogue as
/// suggestions, so a gym may use a machine nothing else has heard of.
class _NameSheet extends StatefulWidget {
  const _NameSheet({this.type, this.name});

  final String? type;
  final String? name;

  @override
  State<_NameSheet> createState() => _NameSheetState();
}

class _NameSheetState extends State<_NameSheet> {
  late final TextEditingController _type = TextEditingController(
    text: widget.type ?? '',
  );
  late final TextEditingController _name = TextEditingController(
    text: widget.name ?? '',
  );

  @override
  void dispose() {
    _type.dispose();
    _name.dispose();
    super.dispose();
  }

  void _choose(String type) {
    setState(() {
      _type.text = type;
      // The name follows the type until it has been typed over.
      if (_name.text.isEmpty ||
          kEquipmentTypes.any((String t) => _name.text == equipmentLabel(t))) {
        _name.text = equipmentLabel(type);
      }
    });
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.fromLTRB(
      16,
      16,
      16,
      MediaQuery.of(context).viewInsets.bottom + 16,
    ),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        const Text(
          'What is this machine?',
          style: TextStyle(
            color: Colors.white,
            fontSize: 18,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: <Widget>[
            for (final String t in kEquipmentTypes)
              ChoiceChip(
                label: Text(equipmentLabel(t)),
                selected: _type.text == t,
                onSelected: (_) => _choose(t),
              ),
          ],
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _type,
          decoration: const InputDecoration(
            labelText: 'Type',
            helperText: 'Any type is accepted, not only the ones above.',
          ),
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 8),
        TextField(
          controller: _name,
          decoration: const InputDecoration(labelText: 'Name'),
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 16),
        PrimaryButton(
          label: 'Save',
          onPressed: _type.text.trim().isEmpty || _name.text.trim().isEmpty
              ? null
              : () => Navigator.of(
                  context,
                ).pop(_Named(_type.text.trim(), _name.text.trim())),
        ),
      ],
    ),
  );
}

/// Recording one walkaround: viewfinder, start, stop, then keep or retake
/// (CHANGE 3.2).
class _RecordScreen extends StatefulWidget {
  const _RecordScreen({required this.equipment, this.existing});

  final Equipment equipment;
  final EquipmentVideo? existing;

  @override
  State<_RecordScreen> createState() => _RecordScreenState();
}

class _RecordScreenState extends State<_RecordScreen> {
  /// Real on an iPhone, a demo walk anywhere else.
  final EquipmentRecording _recorder = EquipmentCaptureBackend.create();
  bool _ready = false;
  bool _recording = false;
  String? _error;
  EquipmentVideo? _take;
  Timer? _ticker;
  Duration _elapsed = Duration.zero;

  @override
  void initState() {
    super.initState();
    _prepare();
  }

  @override
  void dispose() {
    _ticker?.cancel();
    // Hand the camera back; the next machine prepares it again.
    unawaited(_recorder.dispose());
    super.dispose();
  }

  Future<void> _prepare() async {
    final String? refused = await EquipmentCaptureBackend.detect();
    if (refused != null) {
      if (mounted) setState(() => _error = refused);
      return;
    }
    try {
      await _recorder.prepare();
      if (mounted) setState(() => _ready = true);
    } on RoomScanException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _start() async {
    try {
      await _recorder.start(widget.equipment.equipmentId);
      if (!mounted) return;
      setState(() {
        _recording = true;
        _elapsed = Duration.zero;
      });
      const Duration tick = Duration(milliseconds: 100);
      _ticker = Timer.periodic(tick, (_) {
        if (mounted) setState(() => _elapsed += tick);
      });
    } on RoomScanException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _stop() async {
    _ticker?.cancel();
    try {
      final EquipmentVideo stopped = await _recorder.stop();
      // A simulated take carries no file, so the machine and the length
      // walked are filled in here.
      final EquipmentVideo video = stopped.simulated
          ? EquipmentVideo(
              equipmentId: widget.equipment.equipmentId,
              path: '',
              thumbnailPath: null,
              bytes: 0,
              duration: _elapsed,
              contentType: stopped.contentType,
              simulated: true,
            )
          : stopped;
      if (!mounted) return;
      setState(() {
        _recording = false;
        _take = video;
      });
    } on RoomScanException catch (e) {
      if (mounted) {
        setState(() {
          _recording = false;
          _error = e.message;
        });
      }
    }
  }

  Future<void> _retake() async {
    final EquipmentVideo? take = _take;
    if (take != null) await _recorder.discard(take);
    if (mounted) setState(() => _take = null);
  }

  @override
  Widget build(BuildContext context) {
    final EquipmentVideo? take = _take;
    return Scaffold(
      backgroundColor: Colors.black,
      body: SafeArea(
        child: Column(
          children: <Widget>[
            NavBar(
              backLabel: 'Equipment',
              onBack: () => Navigator.of(context).pop(),
            ),
            Expanded(
              child: Center(
                child: switch ((_error, take)) {
                  (final String error?, _) => Padding(
                    padding: const EdgeInsets.all(24),
                    child: Text(
                      error,
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: AppColors.textMuted),
                    ),
                  ),
                  (_, final EquipmentVideo video?) => _Preview(video: video),
                  _ =>
                    _ready
                        ? _recorder.preview(
                            recording: _recording,
                            elapsed: _elapsed,
                          )
                        : const CircularProgressIndicator(),
                },
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(16),
              child: take == null
                  ? Column(
                      children: <Widget>[
                        if (_recording)
                          Text(
                            '${_elapsed.inSeconds} s · walk once around the machine',
                            style: const TextStyle(color: AppColors.accent),
                          )
                        else
                          const Text(
                            'Stand back far enough to see the whole machine.',
                            style: TextStyle(color: AppColors.textMuted),
                            textAlign: TextAlign.center,
                          ),
                        const SizedBox(height: 12),
                        PrimaryButton(
                          label: _recording
                              ? 'Stop capture'
                              : 'Start 360° capture',
                          onPressed: _ready && _error == null
                              ? (_recording ? _stop : _start)
                              : null,
                        ),
                      ],
                    )
                  : Row(
                      children: <Widget>[
                        Expanded(
                          child: OutlinedButton(
                            onPressed: _retake,
                            child: const Text('Retake'),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: PrimaryButton(
                            label: 'Use video',
                            onPressed: () => Navigator.of(context).pop(take),
                          ),
                        ),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The take just recorded: its poster frame and how long it runs. The frame
/// was taken on the phone, so there is something to show at once.
class _Preview extends StatelessWidget {
  const _Preview({required this.video});

  final EquipmentVideo video;

  @override
  Widget build(BuildContext context) {
    final String? thumbnail = video.thumbnailPath;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (thumbnail != null && File(thumbnail).existsSync())
          ClipRRect(
            borderRadius: BorderRadius.circular(12),
            child: Image.file(File(thumbnail), height: 280, fit: BoxFit.cover),
          ),
        const SizedBox(height: 12),
        Text(
          '${video.duration.inSeconds} s recorded',
          style: const TextStyle(color: Colors.white),
        ),
      ],
    );
  }
}
