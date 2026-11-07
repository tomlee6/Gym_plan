/**
 * Reading an equipment catalogue file for import: CSV (as a maker would
 * export from a spreadsheet) or JSON, into the rows the import endpoint
 * takes. The server checks every row again; this is so the admin sees
 * problems with the file before anything is sent.
 */

/** Column names a file may use for each field, compared lower-case without spaces, dashes or underscores. */
const ALIASES = {
  key: ['key', 'librarykey', 'id', 'sku', 'code'],
  name: ['name', 'machine', 'model', 'modelname', 'product'],
  category: ['category', 'group'],
  type: ['type', 'equipmenttype', 'kind'],
  widthM: ['widthm', 'width', 'w'],
  depthM: ['depthm', 'depth', 'lengthm', 'length', 'd'],
  heightM: ['heightm', 'height', 'h'],
  clearanceAroundM: ['clearancearoundm', 'clearancearound', 'clearance', 'clearancem', 'freespace'],
  clearanceBehindM: ['clearancebehindm', 'clearancebehind', 'runoff', 'behind'],
  modelCode: ['modelcode', 'modelnumber', 'partnumber', 'model#'],
  description: ['description', 'notes'],
  sortOrder: ['sortorder', 'order', 'sort'],
};
const NUMBERS = ['widthM', 'depthM', 'heightM', 'clearanceAroundM', 'clearanceBehindM', 'sortOrder'];
const REQUIRED = ['key', 'name', 'category', 'type', 'widthM', 'depthM', 'heightM'];
const norm = (h) => String(h).toLowerCase().replace(/[\s_\-()]/g, '');

/** CSV text as rows of fields (RFC 4180: quoted fields, doubled quotes, newlines inside quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/** A key made from a name, when a file has none: "Acme T5 Treadmill" → "acme-t5-treadmill". */
export function keyFrom(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** One file row, by field name, as the endpoint wants it; `problems` lists what is wrong. */
function rowFrom(raw, line) {
  const row = {};
  const problems = [];
  for (const [field, value] of Object.entries(raw)) {
    if (value === undefined || value === null || String(value).trim() === '') continue;
    if (NUMBERS.includes(field)) {
      const n = Number(String(value).replace(',', '.'));
      if (!Number.isFinite(n)) problems.push(`line ${line}: ${field} “${value}” is not a number`);
      else row[field] = field === 'sortOrder' ? Math.round(n) : n;
    } else row[field] = String(value).trim();
  }
  if (!row.key && row.name) row.key = keyFrom(row.name);
  if (row.key) row.key = row.key.toLowerCase();
  for (const f of REQUIRED) if (row[f] === undefined) problems.push(`line ${line}: no ${f}`);
  for (const f of ['widthM', 'depthM', 'heightM']) {
    if (row[f] !== undefined && !(row[f] > 0)) problems.push(`line ${line}: ${f} must be more than 0`);
  }
  return { row, problems };
}

/**
 * A catalogue file's text as `{ rows, problems }`. JSON may be an array of
 * rows or `{ rows: [...] }`; CSV needs a header line. Unknown columns are
 * ignored, so a maker's own spreadsheet can be used as it is.
 */
export function readCatalogue(text, fileName = '') {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { rows: [], problems: ['The file is empty.'] };
  const json = /\.json$/i.test(fileName) || trimmed.startsWith('[') || trimmed.startsWith('{');
  let records;
  if (json) {
    try {
      const data = JSON.parse(trimmed);
      records = Array.isArray(data) ? data : data?.rows;
      if (!Array.isArray(records)) return { rows: [], problems: ['The JSON has no list of rows.'] };
    } catch {
      return { rows: [], problems: ['The file is not valid JSON.'] };
    }
    records = records.map((r) => {
      const out = {};
      for (const [k, v] of Object.entries(r ?? {})) {
        const field = Object.keys(ALIASES).find((f) => ALIASES[f].includes(norm(k)));
        if (field) out[field] = v;
      }
      return out;
    });
  } else {
    const [header, ...lines] = parseCsv(trimmed);
    const fields = header.map((h) => Object.keys(ALIASES).find((f) => ALIASES[f].includes(norm(h))) ?? null);
    if (!fields.includes('name')) return { rows: [], problems: ['The CSV needs a header line with at least a name column.'] };
    records = lines.map((cells) => Object.fromEntries(fields.map((f, i) => [f, cells[i]]).filter(([f]) => f)));
  }
  const rows = [];
  const problems = [];
  records.forEach((r, i) => {
    const out = rowFrom(r, json ? i + 1 : i + 2);
    rows.push(out.row);
    problems.push(...out.problems);
  });
  const seen = new Set();
  for (const r of rows) {
    if (r.key && seen.has(r.key)) problems.push(`The key “${r.key}” is used more than once.`);
    seen.add(r.key);
  }
  return { rows, problems };
}
