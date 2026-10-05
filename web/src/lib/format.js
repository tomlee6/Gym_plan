/**
 * Dates, sizes and labels for every page. The backend sends UTC; these show
 * the viewer's local time. Wording follows the mobile app
 * (lib/utils/formatting.dart) and the PRD's state table (section 4).
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parse(iso) {
  if (!iso) return null;
  const d = iso instanceof Date ? iso : new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const two = (n) => String(n).padStart(2, '0');

/** "Ground" for level 0, otherwise "Level n". */
export function levelLabel(level) {
  return level === 0 ? 'Ground' : `Level ${level}`;
}

/** "08:47". */
export function time(iso) {
  const d = parse(iso);
  return d ? `${two(d.getHours())}:${two(d.getMinutes())}` : '—';
}

/** "22 Sep 2026", or null. */
export function date(iso) {
  const d = parse(iso);
  return d ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : null;
}

/** "22 Sep", or null. */
export function day(iso) {
  const d = parse(iso);
  return d ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : null;
}

/** "22 Sep 2026, 08:47". */
export function stamp(iso) {
  const d = parse(iso);
  return d ? `${date(d)}, ${time(d)}` : '—';
}

/** "22 Sep 08:47:19", as the audit log shows it. */
export function stampSeconds(iso) {
  const d = parse(iso);
  return d ? `${day(d)} ${time(d)}:${two(d.getSeconds())}` : '—';
}

/** "3h 12m", "21m", "40s": how long something has waited. */
export function age(iso, now = Date.now()) {
  const d = parse(iso);
  if (!d) return '—';
  const s = Math.max(0, Math.floor((now - d.getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "11m 20s", as the prototype shows reviewer time. */
export function duration(seconds) {
  if (seconds == null) return '—';
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  if (m === 0) return `${s}s`;
  if (m < 60) return `${m}m ${two(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${two(m % 60)}m`;
}

/** "298.0 MB". */
export function bytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** "486 m²", or null. */
export function area(m2) {
  return m2 == null ? null : `${Math.round(m2).toLocaleString('en-GB')} m²`;
}

/** "7.42 m". */
export function metres(m, digits = 2) {
  return m == null ? '—' : `${Number(m).toFixed(digits)} m`;
}

export function percent(fraction) {
  return fraction == null ? '—' : `${Math.round(fraction * 100)}%`;
}

/** The prototype's confidence bands: green, blue, orange. */
export function coverageTone(fraction) {
  if (fraction == null) return 'muted';
  if (fraction >= 0.9) return 'good';
  if (fraction >= 0.75) return 'fair';
  return 'poor';
}

const INPUT_LABELS = {
  lidar: 'LiDAR scan',
  simulated: 'Simulated scan',
  pdf: 'PDF',
  dwg: 'DWG',
  jpg: 'JPG image',
  png: 'PNG image',
};

/** "LiDAR scan", "PDF", …: what a plan was made from. */
export function inputLabel(inputType) {
  return INPUT_LABELS[inputType] ?? 'No capture';
}

/** @deprecated Use inputLabel. */
export const sourceLabel = inputLabel;

export const TAG_LABELS = {
  ceiling: 'Ceiling height',
  fireExit: 'Fire exit',
  mirror: 'Mirror wall',
  power: 'Power point',
  stair: 'Stair or lift',
};

/** How the reviewer pages name each state. */
export const STATUS_LABELS = {
  uploading: 'Uploading',
  processing: 'Waiting',
  in_review: 'In review',
  ready: 'Approved',
  recapture: 'Sent back',
  superseded: 'Superseded',
};

/** What the owner sees for each state (PRD section 4). */
export const OWNER_STATUS = {
  uploading: { label: 'Received', tone: 'accent' },
  processing: { label: 'Processing complete, awaiting review', tone: 'fair' },
  in_review: { label: 'In review', tone: 'fair' },
  recapture: { label: 'Needs recapture', tone: 'danger' },
  ready: { label: 'Ready', tone: 'good' },
  superseded: { label: 'Superseded', tone: 'muted' },
};
