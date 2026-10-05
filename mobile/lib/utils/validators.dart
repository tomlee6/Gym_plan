/// Shared field validation. Returns an error message, or null when valid.
class Validators {
  const Validators._();

  static final RegExp _email = RegExp(r'^[\w.+-]+@[\w-]+(\.[\w-]+)+$');

  static String? email(String value) {
    final String trimmed = value.trim();
    if (trimmed.isEmpty) return 'Enter your email address.';
    if (!_email.hasMatch(trimmed)) return 'Enter a valid email address.';
    return null;
  }

  static String? password(String value) {
    if (value.isEmpty) return 'Enter your password.';
    if (value.length < 8) return 'Password must be at least 8 characters.';
    return null;
  }
}
