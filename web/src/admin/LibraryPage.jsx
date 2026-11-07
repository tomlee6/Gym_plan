import { LIBRARY_CATEGORIES } from '@shared/plan/index.js';
import { useMemo, useState } from 'react';

import { adminApi } from '../lib/client.js';
import Modal from '../lib/Modal.jsx';
import { useLoader } from '../lib/useLoader.js';
import { useTitle } from '../lib/useTitle.js';
import { readCatalogue } from './libraryImport.js';
import './admin.css';

const loadAll = () => Promise.all([adminApi.library(), adminApi.manufacturers()]).then(([l, m]) => ({ items: l.items, manufacturers: m.manufacturers }));

const SOURCE_LABELS = { platform: 'Built in', admin: 'Added by admin', import: 'Imported' };
const m2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—');

/**
 * The equipment library (/admin/library): the machines the plan editor
 * offers for a fit-out, with their sizes and safe floor clearances, and
 * the manufacturers who make them. Machines are archived rather than
 * deleted; a plan keeps its own copy of what was placed, so no change here
 * alters an existing plan.
 */
export default function LibraryPage() {
  useTitle('Equipment library');
  const { data, error, reload } = useLoader(loadAll, 'library');
  const [query, setQuery] = useState('');
  const [maker, setMaker] = useState('all');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(null); // a row, or {} for a new one
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [busy, setBusy] = useState(null);

  const shown = useMemo(() => {
    if (!data) return [];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return data.items.filter((i) => {
      if (!showArchived && i.status === 'archived') return false;
      if (maker === 'generic' && i.manufacturer) return false;
      if (maker !== 'all' && maker !== 'generic' && i.manufacturer?.id !== maker) return false;
      const text = `${i.name} ${i.key} ${i.type} ${i.category} ${i.manufacturer?.name ?? ''} ${i.modelCode ?? ''}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }, [data, query, maker, showArchived]);

  async function act(label, fn) {
    setBusy(label);
    setActionError(null);
    try {
      const message = await fn();
      if (message) setNotice(message);
      await reload();
      return true;
    } catch (err) {
      setActionError(err.message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  const setStatus = (item, status) =>
    act(item.id, async () => {
      await adminApi.updateLibraryItem(item.id, { status });
      return status === 'archived' ? `${item.name} is archived. It is no longer offered in the editor.` : `${item.name} is offered again.`;
    });

  return (
    <>
      <header className="rv-header">
        <h1>Equipment library</h1>
        <span className="muted small">Machines the plan editor offers for a fit-out</span>
        <span className="rv-header-actions">
          <button type="button" className="rv-button ghost" onClick={() => setImporting(true)} disabled={!data}>
            Import
          </button>
          <button type="button" className="rv-button primary" onClick={() => setEditing({})} disabled={!data}>
            Add machine
          </button>
        </span>
      </header>
      <div className="rv-content">
        {notice && (
          <p className="rv-notice" role="status">
            {notice}
          </p>
        )}
        {actionError && (
          <p className="rv-error" role="alert">
            {actionError}
          </p>
        )}
        {!data && error ? (
          <div className="rv-empty" role="alert">
            <h2>The library could not be loaded</h2>
            <p className="muted">{error.message}</p>
            <button type="button" className="rv-button primary" onClick={reload}>
              Try again
            </button>
          </div>
        ) : !data ? (
          <div className="rv-empty" role="status">
            <span className="rv-spinner" aria-hidden="true" />
            <p className="muted">Loading the library…</p>
          </div>
        ) : (
          <>
            <div className="ad-filters">
              <label className="rv-field">
                <span>Search</span>
                <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, type, maker, model code" />
              </label>
              <label className="rv-field">
                <span>Manufacturer</span>
                <select value={maker} onChange={(e) => setMaker(e.target.value)}>
                  <option value="all">All</option>
                  <option value="generic">Generic (no maker)</option>
                  {data.manufacturers.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {m.status === 'archived' ? ' (archived)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="ad-check">
                <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
                Show archived
              </label>
            </div>
            <MachineTable items={shown} busy={busy} onEdit={setEditing} onStatus={setStatus} />
            <Manufacturers manufacturers={data.manufacturers} busy={busy} act={act} />
          </>
        )}
      </div>

      {editing && (
        <MachineDialog
          item={editing.id ? editing : null}
          manufacturers={data.manufacturers.filter((m) => m.status === 'active' || m.id === editing.manufacturer?.id)}
          categories={[...new Set([...LIBRARY_CATEGORIES, ...data.items.map((i) => i.category)])]}
          busy={busy === 'save'}
          onCancel={() => setEditing(null)}
          onSave={async (body) => {
            const ok = await act('save', async () => {
              if (editing.id) await adminApi.updateLibraryItem(editing.id, body);
              else await adminApi.addLibraryItem(body);
              return `${body.name} is saved.`;
            });
            if (ok) setEditing(null);
          }}
        />
      )}
      {importing && (
        <ImportDialog
          manufacturers={data.manufacturers.filter((m) => m.status === 'active')}
          onCancel={() => setImporting(false)}
          onDone={async (message) => {
            setImporting(false);
            setNotice(message);
            await reload();
          }}
        />
      )}
    </>
  );
}

function MachineTable({ items, busy, onEdit, onStatus }) {
  if (!items.length) {
    return (
      <div className="rv-empty">
        <h2>No machines match</h2>
        <p className="muted">Change the search or filters, or add a machine.</p>
      </div>
    );
  }
  return (
    <div className="rv-table-wrap">
      <table className="rv-table" aria-label="Library machines">
        <thead>
          <tr>
            <th scope="col">MACHINE</th>
            <th scope="col">MAKER</th>
            <th scope="col">CATEGORY</th>
            <th scope="col">SIZE W × D × H (M)</th>
            <th scope="col">CLEARANCE (M)</th>
            <th scope="col">SOURCE</th>
            <th scope="col">
              <span className="sr-only">ACTIONS</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id} className={i.status === 'archived' ? 'ad-archived' : undefined}>
              <td data-label="Machine">
                <strong>{i.name}</strong>
                <span className="muted small"> {i.key}</span>
                {i.status === 'archived' && <span className="ed-pill poor"> Archived</span>}
              </td>
              <td data-label="Maker">
                {i.manufacturer?.name ?? <span className="muted">Generic</span>}
                {i.modelCode && <span className="muted small"> · {i.modelCode}</span>}
              </td>
              <td data-label="Category">{i.category}</td>
              <td data-label="Size">
                {m2(i.widthM)} × {m2(i.depthM)} × {m2(i.heightM)}
              </td>
              <td data-label="Clearance">
                {m2(i.clearance.aroundM)} round
                {i.clearance.behindM > i.clearance.aroundM ? `, ${m2(i.clearance.behindM)} behind` : ''}
              </td>
              <td data-label="Source">{SOURCE_LABELS[i.source] ?? i.source}</td>
              <td className="ad-actions">
                <button type="button" className="rv-button small ghost" onClick={() => onEdit(i)} aria-label={`Edit ${i.name}`}>
                  Edit
                </button>
                <button
                  type="button"
                  className="rv-button small ghost"
                  disabled={busy === i.id}
                  onClick={() => onStatus(i, i.status === 'archived' ? 'active' : 'archived')}
                  aria-label={`${i.status === 'archived' ? 'Restore' : 'Archive'} ${i.name}`}
                >
                  {i.status === 'archived' ? 'Restore' : 'Archive'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const blankForm = {
  key: '',
  name: '',
  category: 'Cardio',
  type: '',
  widthM: '',
  depthM: '',
  heightM: '',
  clearanceAroundM: '0.6',
  clearanceBehindM: '',
  modelCode: '',
  description: '',
  manufacturerId: '',
  sortOrder: '0',
};

const formOf = (item) =>
  item
    ? {
        key: item.key,
        name: item.name,
        category: item.category,
        type: item.type,
        widthM: String(item.widthM),
        depthM: String(item.depthM),
        heightM: String(item.heightM),
        clearanceAroundM: String(item.clearance.aroundM),
        clearanceBehindM: item.clearance.behindM !== item.clearance.aroundM ? String(item.clearance.behindM) : '',
        modelCode: item.modelCode ?? '',
        description: item.description ?? '',
        manufacturerId: item.manufacturer?.id ?? '',
        sortOrder: String(item.sortOrder ?? 0),
      }
    : blankForm;

/** What is wrong with the form, field by field (the server checks again). */
export function machineFormProblems(f) {
  const p = {};
  const pos = (v, max) => {
    const n = Number(v);
    return v !== '' && Number.isFinite(n) && n > 0 && n <= max;
  };
  if (!f.name.trim()) p.name = 'Give the machine a name.';
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(f.key.trim().toLowerCase())) p.key = 'Lower-case letters, digits, dot, dash or underscore.';
  if (!f.category.trim()) p.category = 'Choose a category.';
  if (!/^[A-Za-z0-9 _-]+$/.test(f.type.trim())) p.type = 'A type such as treadmill or legPress.';
  if (!pos(f.widthM, 30)) p.widthM = 'More than 0, up to 30 m.';
  if (!pos(f.depthM, 30)) p.depthM = 'More than 0, up to 30 m.';
  if (!pos(f.heightM, 10)) p.heightM = 'More than 0, up to 10 m.';
  const clear = (v) => v === '' || (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 10);
  if (f.clearanceAroundM === '' || !clear(f.clearanceAroundM)) p.clearanceAroundM = '0 to 10 m.';
  if (!clear(f.clearanceBehindM)) p.clearanceBehindM = '0 to 10 m, or blank for the same as all round.';
  return p;
}

function MachineDialog({ item, manufacturers, categories, busy, onCancel, onSave }) {
  const [form, setForm] = useState(() => formOf(item));
  const [tried, setTried] = useState(false);
  const problems = machineFormProblems(form);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  function submit(e) {
    e?.preventDefault?.();
    setTried(true);
    if (Object.keys(problems).length) return;
    const body = {
      key: form.key.trim().toLowerCase(),
      name: form.name.trim(),
      category: form.category.trim(),
      type: form.type.trim(),
      widthM: Number(form.widthM),
      depthM: Number(form.depthM),
      heightM: Number(form.heightM),
      clearanceAroundM: Number(form.clearanceAroundM),
      clearanceBehindM: form.clearanceBehindM === '' ? null : Number(form.clearanceBehindM),
      modelCode: form.modelCode.trim() || null,
      description: form.description.trim() || null,
      manufacturerId: form.manufacturerId || null,
      sortOrder: Math.round(Number(form.sortOrder) || 0),
    };
    onSave(body);
  }

  // The message sits outside the label, so the field keeps its own name.
  const field = (k, label, props = {}) => {
    const bad = tried && problems[k];
    return (
      <div className={`rv-field ${props.wide ? 'wide' : ''}`}>
        <label className="rv-field">
          <span>{label}</span>
          <input
            value={form[k]}
            onChange={set(k)}
            aria-invalid={bad ? 'true' : undefined}
            aria-describedby={bad ? `machine-${k}-error` : undefined}
            {...props.input}
          />
        </label>
        {bad && (
          <small id={`machine-${k}-error`} className="rv-field-error">
            {problems[k]}
          </small>
        )}
      </div>
    );
  };

  return (
    <Modal
      title={item ? `Edit ${item.name}` : 'Add a machine'}
      subtitle="Plans already made keep the size they were given; a change here applies to machines placed from now on."
      onClose={onCancel}
      busy={busy}
      footer={
        <>
          <button type="button" className="rv-button ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="rv-button primary" onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : 'Save machine'}
          </button>
        </>
      }
    >
      <form className="ad-form-grid" onSubmit={submit} noValidate>
        {field('name', 'Name', { wide: true })}
        {field('key', 'Key', { input: { placeholder: 'e.g. t5-treadmill' } })}
        {field('type', 'Equipment type', { input: { placeholder: 'e.g. treadmill' } })}
        <label className="rv-field">
          <span>Category</span>
          <input list="library-categories" value={form.category} onChange={set('category')} />
          <datalist id="library-categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
        <label className="rv-field">
          <span>Manufacturer</span>
          <select value={form.manufacturerId} onChange={set('manufacturerId')}>
            <option value="">Generic (no maker)</option>
            {manufacturers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        {field('modelCode', 'Model code')}
        {field('widthM', 'Width (m)', { input: { inputMode: 'decimal' } })}
        {field('depthM', 'Depth (m)', { input: { inputMode: 'decimal' } })}
        {field('heightM', 'Height (m)', { input: { inputMode: 'decimal' } })}
        {field('clearanceAroundM', 'Clearance all round (m)', { input: { inputMode: 'decimal' } })}
        {field('clearanceBehindM', 'Clearance behind (m)', { input: { inputMode: 'decimal', placeholder: 'Same as all round' } })}
        {field('sortOrder', 'Sort order', { input: { inputMode: 'numeric' } })}
        {field('description', 'Description', { wide: true })}
      </form>
    </Modal>
  );
}

function Manufacturers({ manufacturers, busy, act }) {
  const [form, setForm] = useState({ name: '', slug: '', website: '' });
  const slugFrom = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

  async function add(e) {
    e.preventDefault();
    const ok = await act('maker', async () => {
      await adminApi.addManufacturer({ name: form.name.trim(), slug: form.slug.trim() || slugFrom(form.name), website: form.website.trim() || null });
      return `${form.name.trim()} is added. Import its machines, or add them one at a time.`;
    });
    if (ok) setForm({ name: '', slug: '', website: '' });
  }

  return (
    <section className="ad-section" aria-label="Manufacturers">
      <h2>Manufacturers</h2>
      <p className="muted small">
        A maker’s machines are listed with its name and model codes. Archiving a maker takes its machines out of the editor until it is
        restored.
      </p>
      {manufacturers.length > 0 && (
        <div className="rv-table-wrap">
          <table className="rv-table" aria-label="Manufacturers">
            <thead>
              <tr>
                <th scope="col">NAME</th>
                <th scope="col">SLUG</th>
                <th scope="col">MACHINES</th>
                <th scope="col">
                  <span className="sr-only">ACTIONS</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {manufacturers.map((m) => (
                <tr key={m.id} className={m.status === 'archived' ? 'ad-archived' : undefined}>
                  <td data-label="Name">
                    {m.website ? (
                      <a href={m.website} target="_blank" rel="noreferrer noopener">
                        {m.name}
                      </a>
                    ) : (
                      m.name
                    )}
                    {m.status === 'archived' && <span className="ed-pill poor"> Archived</span>}
                  </td>
                  <td data-label="Slug">
                    <code>{m.slug}</code>
                  </td>
                  <td data-label="Machines">{m.machines ?? 0}</td>
                  <td className="ad-actions">
                    <button
                      type="button"
                      className="rv-button small ghost"
                      disabled={busy === m.id}
                      aria-label={`${m.status === 'archived' ? 'Restore' : 'Archive'} ${m.name}`}
                      onClick={() =>
                        act(m.id, async () => {
                          const status = m.status === 'archived' ? 'active' : 'archived';
                          await adminApi.updateManufacturer(m.id, { status });
                          return status === 'archived' ? `${m.name} is archived.` : `${m.name} is restored.`;
                        })
                      }
                    >
                      {m.status === 'archived' ? 'Restore' : 'Archive'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form className="ad-inline-form" onSubmit={add}>
        <label className="rv-field">
          <span>Manufacturer name</span>
          <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </label>
        <label className="rv-field">
          <span>Slug</span>
          <input value={form.slug} placeholder={slugFrom(form.name) || 'e.g. acme-fitness'} onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))} />
        </label>
        <label className="rv-field">
          <span>Website</span>
          <input type="url" value={form.website} placeholder="https://" onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))} />
        </label>
        <button type="submit" className="rv-button" disabled={busy === 'maker' || form.name.trim().length < 2}>
          Add manufacturer
        </button>
      </form>
    </section>
  );
}

/**
 * Importing a catalogue: pick the maker (or generic), choose a CSV or JSON
 * file, check what it would do (a dry run on the server), then import.
 */
function ImportDialog({ manufacturers, onCancel, onDone }) {
  const [maker, setMaker] = useState('');
  const [file, setFile] = useState(null); // { name, rows, problems }
  const [check, setCheck] = useState(null); // the dry run's answer
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function choose(e) {
    const f = e.target.files?.[0];
    setCheck(null);
    setError(null);
    if (!f) return setFile(null);
    const text = await f.text();
    setFile({ name: f.name, ...readCatalogue(text, f.name) });
  }

  async function send(dryRun) {
    setBusy(true);
    setError(null);
    try {
      const body = { manufacturer: maker || null, dryRun, rows: file.rows };
      const res = await adminApi.importLibrary(body);
      if (dryRun) setCheck(res);
      else onDone(`Imported: ${res.added.length} added, ${res.updated.length} updated.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const ready = file && file.rows.length > 0 && file.problems.length === 0;
  return (
    <Modal
      title="Import machines"
      subtitle="A CSV or JSON file with a row per machine: name, category, type, widthM, depthM, heightM, and optionally key, clearanceAroundM, clearanceBehindM, modelCode, description. Machines already in the library with the same key are updated."
      onClose={onCancel}
      busy={busy}
      footer={
        <>
          <button type="button" className="rv-button ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          {check ? (
            <button type="button" className="rv-button primary" onClick={() => send(false)} disabled={busy}>
              {busy ? 'Importing…' : `Import ${check.added.length + check.updated.length} machines`}
            </button>
          ) : (
            <button type="button" className="rv-button primary" onClick={() => send(true)} disabled={busy || !ready}>
              {busy ? 'Checking…' : 'Check file'}
            </button>
          )}
        </>
      }
    >
      <div className="ad-form-grid">
        <label className="rv-field wide">
          <span>Manufacturer</span>
          <select
            value={maker}
            onChange={(e) => {
              setMaker(e.target.value);
              setCheck(null);
            }}
          >
            <option value="">Generic machines (no maker)</option>
            {manufacturers.map((m) => (
              <option key={m.id} value={m.slug}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="rv-field wide">
          <span>Catalogue file</span>
          <input type="file" accept=".csv,.json,text/csv,application/json" onChange={choose} />
        </label>
      </div>
      {file && (
        <div className="ad-import-result" aria-live="polite">
          <p className="small">
            {file.name}: {file.rows.length} rows.
          </p>
          {file.problems.length > 0 && (
            <ul className="rv-error small" role="alert">
              {file.problems.slice(0, 10).map((p) => (
                <li key={p}>{p}</li>
              ))}
              {file.problems.length > 10 && <li>… and {file.problems.length - 10} more.</li>}
            </ul>
          )}
          {check && (
            <p className="rv-notice small" role="status">
              {check.added.length} will be added and {check.updated.length} updated.
            </p>
          )}
        </div>
      )}
      {error && (
        <p className="rv-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
