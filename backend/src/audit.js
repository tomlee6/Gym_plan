/**
 * The audit log (ACC-06): every state change and approval, with who, when
 * and which version. Written in the same transaction as the change it
 * records, so the log and the data never disagree.
 *
 * It is also the plan history (E-04): there is no second history table.
 * Each version's captured, produced, claimed, corrected, approved,
 * generated, rejected and superseded moments are its rows here.
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
export async function audit(db, { accountId, actor, action, target, version = null, detail = null }) {
  const name = actor ? (actor.name ?? (await actorName(db, actor.id))) : 'System';
  await db.query(
    `INSERT INTO audit_log
       (id, account_id, actor_user_id, actor_name, action, target_type, target_id, target_label,
        version_no, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      accountId ?? null,
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

/** A plan's history, oldest first, from the audit log (E-04). */
export function planEventsSql() {
  return `SELECT action, actor_name, version_no, detail, created_at FROM audit_log
          WHERE target_type = 'plan' AND target_id = ? ORDER BY created_at, id`;
}
