/**
 * The audit log (ACC-06): every state change and approval, with who, when
 * and which version. Written in the same transaction as the change it
 * records, so the log and the data never disagree.
 */
import { one } from './db/pool.js';
import { newId } from './ids.js';

/** The acting user's name, for a readable log. */
export async function actorName(db, userId) {
  if (!userId) return null;
  const row = await one(db, 'SELECT name FROM users WHERE id = ?', [userId]);
  return row?.name ?? null;
}

/**
 * Records one event. `actor` is `{ id, name? }` or null for the system.
 * `target` is `{ type, id, label }`.
 */
export async function audit(db, { orgId, actor, action, target, version = null, detail = null }) {
  const name = actor ? (actor.name ?? (await actorName(db, actor.id))) : 'System';
  await db.query(
    `INSERT INTO audit_log
       (id, org_id, actor_id, actor_name, action, target_type, target_id, target_label, version, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId('aud'),
      orgId ?? null,
      actor?.id ?? null,
      name,
      action,
      target.type,
      target.id ?? null,
      target.label ?? null,
      version,
      detail ? JSON.stringify(detail) : null,
    ],
  );
}

/** "Northgate Fitness · Level 2", as the log and emails name a plan. */
export function planLabel(facility, level) {
  return `${facility} · ${level === 0 ? 'Ground' : `Level ${level}`}`;
}
