/// Dates and durations as the app shows them. The backend sends UTC; these
/// show the phone's local time.
class Formatting {
  const Formatting._();

  static const List<String> _months = <String>[
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];

  static String _two(int n) => n.toString().padLeft(2, '0');

  /// "09:14".
  static String time(DateTime t) {
    final DateTime l = t.toLocal();
    return '${_two(l.hour)}:${_two(l.minute)}';
  }

  /// "14 Mar".
  static String day(DateTime t) {
    final DateTime l = t.toLocal();
    return '${l.day} ${_months[l.month - 1]}';
  }

  /// "14 Mar, 16:42".
  static String stamp(DateTime t) => '${day(t)}, ${time(t)}';

  /// "just now", "5 min ago", "3 hours ago", "yesterday", "2 days ago",
  /// then the date.
  static String ago(DateTime t, {DateTime? now}) {
    final Duration d = (now ?? DateTime.now()).difference(t);
    if (d.inMinutes < 1) return 'just now';
    if (d.inMinutes < 60) return '${d.inMinutes} min ago';
    if (d.inHours < 24) {
      return d.inHours == 1 ? '1 hour ago' : '${d.inHours} hours ago';
    }
    if (d.inDays == 1) return 'yesterday';
    if (d.inDays < 7) return '${d.inDays} days ago';
    return day(t);
  }

  /// "11 min 20 s".
  static String duration(int seconds) {
    final int m = seconds ~/ 60;
    final int s = seconds % 60;
    if (m == 0) return '$s s';
    return '$m min ${_two(s)} s';
  }

  static DateTime? parse(Object? iso) =>
      iso is String ? DateTime.tryParse(iso)?.toUtc() : null;
}
