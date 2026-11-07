/**
 * The equipment library (migration 006): standard machines with their
 * sizes and safe floor clearances, for placing on a plan in a fit-out.
 *
 * Read by anyone signed in (the editor's library and fit-out schedule):
 *
 *   GET    /v1/equipment-library                      active machines, active makers
 *
 * Kept by platform admins:
 *
 *   GET    /v1/admin/equipment-library                every row, archived too
 *   POST   /v1/admin/equipment-library                add a machine
 *   PATCH  /v1/admin/equipment-library/:id            edit, archive or restore one
 *   POST   /v1/admin/equipment-library/import         add or update many at once
 *   GET    /v1/admin/equipment-manufacturers          the makers
 *   POST   /v1/admin/equipment-manufacturers          add a maker
 *   PATCH  /v1/admin/equipment-manufacturers/:id      rename, archive or restore one
 *
 * The import is how a manufacturer's own catalogue comes in: rows are
 * matched on (manufacturer, key), so the same file run again updates its
 * machines instead of adding them twice, and `dryRun` says what it would
 * do without doing it. It takes JSON rows; a CSV or a maker's own portal
 * can feed the same endpoint later.
 *
 * Rows are archived, never deleted: a plan keeps its own copy of what was
 * placed, so archiving changes no plan, and the audit log keeps the record.
 */
import { Router } from 'express';
import { z } from 'zod';

import { audit } from '../audit.js';
import { many, one, pool, transaction } from '../db/pool.js';
import { conflict, notFound } from '../errors.js';
import { isId, newId } from '../ids.js';
import { requireAuth, requireStaff } from '../middleware/auth.js';

/** Most rows one import may carry: a big maker's whole catalogue. */
export const MAX_IMPORT_ROWS = 2000;

export const router = Router();
router.use(requireAuth);

export const adminRouter = Router();
adminRouter.use(requireAuth, requireStaff('admin'));

const actor = (req) => ({ id: req.user.id });
const num = (v) => (v === null || v === undefined ? null : Number(v));

/* Validation ---------------------------------------------------------- */

const key = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'A key may only use lower-case letters, digits, dot, dash and underscore.');
const size = (max) => z.number().finite().positive().max(max);
const clearance = z.number().finite().min(0).max(10);
const text = (max) => z.string().trim().min(1).max(max);
const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

const machineFields = {
  key,
  name: text(120),
  category: text(40),
  type: text(40).regex(/^[A-Za-z0-9 _-]+$/, 'A type may only use letters, digits, spaces, dash and underscore.'),
  widthM: size(30),
  depthM: size(30),
  heightM: size(10),
  clearanceAroundM: clearance.default(0.6),
  clearanceBehindM: clearance.nullish(),
  modelCode: optionalText(80),
  description: optionalText(500),
  sortOrder: z.number().int().min(-100000).max(100000).default(0),
};

const machineBody = z.object({
  ...machineFields,
  manufacturerId: z.string().refine(isId, 'Unknown manufacturer.').nullish(),
});

const machinePatch = z
  .object({
    ...Object.fromEntries(
      Object.entries(machineFields).map(([k, v]) => [k, k === 'clearanceAroundM' ? clearance : k === 'sortOrder' ? z.number().int() : v]),
    ),
    manufacturerId: z.string().refine(isId, 'Unknown manufacturer.').nullable(),
    status: z.enum(['active', 'archived']),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change.');

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'A slug may only use lower-case letters, digits and dashes.');

const manufacturerBody = z.object({
  name: text(120),
  slug,
  website: z.url({ protocol: /^https?$/ }).max(300).nullish(),
});

const manufacturerPatch = manufacturerBody
  .extend({ status: z.enum(['active', 'archived']) })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change.');

const importBody = z.object({
  // The maker every row belongs to, by slug; absent for generic machines.
  manufacturer: slug.nullish(),
  dryRun: z.boolean().default(false),
  rows: z.array(z.object(machineFields)).min(1).max(MAX_IMPORT_ROWS),
});

/* Reading ------------------------------------------------------------- */

function machineOut(r) {
  const around = num(r.clearance_around_m);
  return {
    id: r.id,
    key: r.library_key,
    name: r.name,
    category: r.category,
    type: r.equipment_type,
    widthM: num(r.width_m),
    depthM: num(r.depth_m),
    heightM: num(r.height_m),
    clearance: { aroundM: around, behindM: num(r.clearance_behind_m) ?? around },
    modelCode: r.model_code ?? null,
    description: r.description ?? null,
    manufacturer: r.manufacturer_id ? { id: r.manufacturer_id, name: r.manufacturer_name, slug: r.manufacturer_slug } : null,
    source: r.source,
    status: r.status,
    sortOrder: r.sort_order,
    updatedAt: r.updated_at,
  };
}

const manufacturerOut = (m) => ({
  id: m.id,
  name: m.name,
  slug: m.slug,
  website: m.website ?? null,
  status: m.status,
  machines: m.machines === undefined ? undefined : Number(m.machines),
});

const SELECT_MACHINES = `
  SELECT l.*, m.name AS manufacturer_name, m.slug AS manufacturer_slug, m.status AS manufacturer_status
    FROM equipment_library l
    LEFT JOIN equipment_manufacturers m ON m.id = l.manufacturer_id`;
const ORDER = ' ORDER BY l.sort_order, l.name, l.id';

async function machineOr404(db, id) {
  const row = isId(id) ? await one(db, `${SELECT_MACHINES} WHERE l.id = ?`, [id]) : null;
  if (!row) throw notFound('This machine is not in the library.');
  return row;
}

async function manufacturerOr404(db, id, { mustBeActive = false } = {}) {
  const m = isId(id) ? await one(db, 'SELECT * FROM equipment_manufacturers WHERE id = ?', [id]) : null;
  if (!m) throw notFound('This manufacturer does not exist.');
  if (mustBeActive && m.status !== 'active') throw conflict(`${m.name} is archived. Restore it first.`);
  return m;
}

/** A unique-key clash as a 409 the admin can act on. */
async function unique(fn, message) {
  try {
    return await fn();
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') throw conflict(message);
    throw err;
  }
}

/**
 * The library the editor offers: active machines whose maker (if any) is
 * active too, in the admins' order.
 */
router.get('/', async (_req, res) => {
  const rows = await many(
    pool,
    `${SELECT_MACHINES} WHERE l.status = 'active' AND (l.manufacturer_id IS NULL OR m.status = 'active')${ORDER}`,
  );
  const manufacturers = await many(pool, `SELECT * FROM equipment_manufacturers WHERE status = 'active' ORDER BY name`);
  res.json({ items: rows.map(machineOut), manufacturers: manufacturers.map(manufacturerOut) });
});

/* Admin: machines ----------------------------------------------------- */

adminRouter.get('/equipment-library', async (_req, res) => {
  const rows = await many(pool, `${SELECT_MACHINES}${ORDER}`);
  res.json({ items: rows.map(machineOut) });
});

adminRouter.post('/equipment-library', async (req, res) => {
  const b = machineBody.parse(req.body);
  const id = await transaction(async (db) => {
    if (b.manufacturerId) await manufacturerOr404(db, b.manufacturerId, { mustBeActive: true });
    const rowId = newId();
    await unique(
      () =>
        db.query(
          `INSERT INTO equipment_library
             (id, manufacturer_id, library_key, model_code, name, category, equipment_type, width_m, depth_m, height_m,
              clearance_around_m, clearance_behind_m, description, source, sort_order, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin', ?, ?, ?)`,
          [
            rowId,
            b.manufacturerId ?? null,
            b.key,
            b.modelCode,
            b.name,
            b.category,
            b.type,
            b.widthM,
            b.depthM,
            b.heightM,
            b.clearanceAroundM,
            b.clearanceBehindM ?? b.clearanceAroundM,
            b.description,
            b.sortOrder,
            req.user.id,
            req.user.id,
          ],
        ),
      `The key “${b.key}” is already used${b.manufacturerId ? ' for this manufacturer' : ''}. Choose another.`,
    );
    await audit(db, { accountId: null, actor: actor(req), action: 'LIBRARY_ITEM_ADDED', target: { type: 'library', id: rowId, label: b.name } });
    return rowId;
  });
  res.status(201).json(machineOut(await machineOr404(pool, id)));
});

const COLUMN = {
  key: 'library_key',
  name: 'name',
  category: 'category',
  type: 'equipment_type',
  widthM: 'width_m',
  depthM: 'depth_m',
  heightM: 'height_m',
  clearanceAroundM: 'clearance_around_m',
  clearanceBehindM: 'clearance_behind_m',
  modelCode: 'model_code',
  description: 'description',
  sortOrder: 'sort_order',
  manufacturerId: 'manufacturer_id',
  status: 'status',
};

adminRouter.patch('/equipment-library/:id', async (req, res) => {
  const b = machinePatch.parse(req.body);
  await transaction(async (db) => {
    const row = await machineOr404(db, req.params.id);
    if (b.manufacturerId) await manufacturerOr404(db, b.manufacturerId, { mustBeActive: true });
    // No clearance behind given: the same as all round.
    if (b.clearanceBehindM === null) b.clearanceBehindM = b.clearanceAroundM ?? num(row.clearance_around_m);
    const sets = Object.entries(b).map(([k]) => `${COLUMN[k]} = ?`);
    const values = Object.values(b).map((v) => (v === undefined ? null : v));
    await unique(
      () => db.query(`UPDATE equipment_library SET ${sets.join(', ')}, updated_by = ? WHERE id = ?`, [...values, req.user.id, row.id]),
      `That key is already used${(b.manufacturerId ?? row.manufacturer_id) ? ' for this manufacturer' : ''}. Choose another.`,
    );
    const action = b.status === 'archived' ? 'LIBRARY_ITEM_ARCHIVED' : b.status === 'active' && row.status === 'archived' ? 'LIBRARY_ITEM_RESTORED' : 'LIBRARY_ITEM_UPDATED';
    await audit(db, {
      accountId: null,
      actor: actor(req),
      action,
      target: { type: 'library', id: row.id, label: b.name ?? row.name },
      detail: { changed: Object.keys(b) },
    });
  });
  res.json(machineOut(await machineOr404(pool, req.params.id)));
});

/**
 * Adds or updates many machines, matched on (manufacturer, key). With
 * `dryRun` nothing is written: the answer says what would be added and
 * updated, so an admin can check a maker's file first.
 */
adminRouter.post('/equipment-library/import', async (req, res) => {
  const b = importBody.parse(req.body);
  const keys = b.rows.map((r) => r.key);
  const twice = keys.find((k, i) => keys.indexOf(k) !== i);
  if (twice) throw conflict(`The key “${twice}” appears more than once in this file.`);

  const result = await transaction(async (db) => {
    let manufacturer = null;
    if (b.manufacturer) {
      manufacturer = await one(db, 'SELECT * FROM equipment_manufacturers WHERE slug = ?', [b.manufacturer]);
      if (!manufacturer) throw notFound(`No manufacturer has the slug “${b.manufacturer}”. Add it first.`);
      if (manufacturer.status !== 'active') throw conflict(`${manufacturer.name} is archived. Restore it first.`);
    }
    const scope = manufacturer?.id ?? 'generic';
    const existing = new Map(
      (await many(db, 'SELECT id, library_key FROM equipment_library WHERE scope = ? FOR UPDATE', [scope])).map((r) => [r.library_key, r.id]),
    );
    const added = [];
    const updated = [];
    for (const r of b.rows) {
      const values = [
        r.modelCode,
        r.name,
        r.category,
        r.type,
        r.widthM,
        r.depthM,
        r.heightM,
        r.clearanceAroundM,
        r.clearanceBehindM ?? r.clearanceAroundM,
        r.description,
        r.sortOrder,
      ];
      const id = existing.get(r.key);
      if (id) {
        updated.push(r.key);
        if (!b.dryRun) {
          await db.query(
            `UPDATE equipment_library
                SET model_code = ?, name = ?, category = ?, equipment_type = ?, width_m = ?, depth_m = ?, height_m = ?,
                    clearance_around_m = ?, clearance_behind_m = ?, description = ?, sort_order = ?,
                    status = 'active', updated_by = ?
              WHERE id = ?`,
            [...values, req.user.id, id],
          );
        }
      } else {
        added.push(r.key);
        if (!b.dryRun) {
          await db.query(
            `INSERT INTO equipment_library
               (id, manufacturer_id, library_key, model_code, name, category, equipment_type, width_m, depth_m, height_m,
                clearance_around_m, clearance_behind_m, description, sort_order, source, created_by, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?)`,
            [newId(), manufacturer?.id ?? null, r.key, ...values, req.user.id, req.user.id],
          );
        }
      }
    }
    if (!b.dryRun) {
      await audit(db, {
        accountId: null,
        actor: actor(req),
        action: 'LIBRARY_IMPORTED',
        target: { type: 'library', id: manufacturer?.id ?? null, label: manufacturer?.name ?? 'Generic machines' },
        detail: { added: added.length, updated: updated.length },
      });
    }
    return { added, updated };
  });
  res.status(b.dryRun ? 200 : 201).json({ dryRun: b.dryRun, ...result });
});

/* Admin: manufacturers ------------------------------------------------ */

adminRouter.get('/equipment-manufacturers', async (_req, res) => {
  const rows = await many(
    pool,
    `SELECT m.*, (SELECT COUNT(*) FROM equipment_library l WHERE l.manufacturer_id = m.id AND l.status = 'active') AS machines
       FROM equipment_manufacturers m ORDER BY m.name`,
  );
  res.json({ manufacturers: rows.map(manufacturerOut) });
});

adminRouter.post('/equipment-manufacturers', async (req, res) => {
  const b = manufacturerBody.parse(req.body);
  const id = await transaction(async (db) => {
    const rowId = newId();
    await unique(
      () =>
        db.query('INSERT INTO equipment_manufacturers (id, name, slug, website) VALUES (?, ?, ?, ?)', [rowId, b.name, b.slug, b.website ?? null]),
      'A manufacturer with that name or slug already exists.',
    );
    await audit(db, { accountId: null, actor: actor(req), action: 'MANUFACTURER_ADDED', target: { type: 'manufacturer', id: rowId, label: b.name } });
    return rowId;
  });
  res.status(201).json(manufacturerOut(await manufacturerOr404(pool, id)));
});

adminRouter.patch('/equipment-manufacturers/:id', async (req, res) => {
  const b = manufacturerPatch.parse(req.body);
  await transaction(async (db) => {
    const m = await manufacturerOr404(db, req.params.id);
    const sets = Object.keys(b).map((k) => `${k} = ?`);
    await unique(
      () => db.query(`UPDATE equipment_manufacturers SET ${sets.join(', ')} WHERE id = ?`, [...Object.values(b).map((v) => v ?? null), m.id]),
      'A manufacturer with that name or slug already exists.',
    );
    await audit(db, {
      accountId: null,
      actor: actor(req),
      action: b.status === 'archived' ? 'MANUFACTURER_ARCHIVED' : 'MANUFACTURER_UPDATED',
      target: { type: 'manufacturer', id: m.id, label: b.name ?? m.name },
      detail: { changed: Object.keys(b) },
    });
  });
  res.json(manufacturerOut(await manufacturerOr404(pool, req.params.id)));
});
