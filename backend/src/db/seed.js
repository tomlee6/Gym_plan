/**
 * Demo data for the new schema (C-16): two gym accounts, a person in both,
 * Flex staff, captures with machines, 360 videos and a machine model, and
 * every plan state the screens show. Safe to run again: it clears and
 * recreates only these rows.
 *
 *   npm run db:seed
 *
 * Sign in through the dev Hub (HUB_DRIVER=dev) as:
 *
 *   Sam Okafor     owner of Northgate Group, surveyor at Kestrel Health Clubs
 *   Lee Tan        surveyor at Northgate Group
 *   Maya Restrepo  Flex reviewer
 *   Jordan Kaur    Flex platform admin
 *
 * Every version gets a plan, read from a synthetic scan the way a real one
 * would be, so the reviewer editor and the walkthrough have something to
 * show.
 */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { canonicalJson, planFromScan } from '../../../shared/plan/index.js';
import { pool, transaction } from './pool.js';

const ago = ({ days = 0, hours = 0, minutes = 0 }) =>
  new Date(Date.now() - ((days * 24 + hours) * 60 + minutes) * 60000);

/**
 * Like `ago`, for the plans that have to count against this month's quota.
 *
 * The demo shows 6 of 10 used this month, and the count resets on the 1st,
 * so a plan seeded "13 days ago" would fall into last month whenever the
 * seed ran before the 14th. When the month so far is shorter than the
 * oldest of these plans needs, the whole run of them is squeezed into the
 * part of the month that has happened, keeping their order.
 */
function monthWindow(oldestDays) {
  const now = Date.now();
  const start = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) + 3600000;
  const squeeze = Math.min(1, (now - start) / (oldestDays * 86400000));
  return ({ days = 0, hours = 0, minutes = 0 }) =>
    new Date(now - ((days * 24 + hours) * 60 + minutes) * 60000 * squeeze);
}

/** Fixed, readable UUIDv7-shaped ids, so tests and links can name demo rows. */
const fixed = (n) => `01930000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

export const DEMO = {
  account: fixed(0x100),
  kestrel: fixed(0x101),
  owner: { id: fixed(0x200), sub: 'hub|sam', email: 'sam.okafor@northgatefitness.com', name: 'Sam Okafor' },
  surveyor: { id: fixed(0x201), sub: 'hub|lee', email: 'lee.tan@northgatefitness.com', name: 'Lee Tan' },
  reviewer: { id: fixed(0x202), sub: 'hub|maya', email: 'maya.restrepo@flexmotion.app', name: 'Maya Restrepo' },
  admin: { id: fixed(0x203), sub: 'hub|admin', email: 'admin@flexmotion.app', name: 'Jordan Kaur' },
  facilities: {
    northgate: fixed(0x300),
    riverside: fixed(0x301),
    eastbrook: fixed(0x302),
    kestrel: fixed(0x303),
  },
  plans: {
    ng1: fixed(0x400),
    ng2: fixed(0x401),
    ng3: fixed(0x402),
    rv0: fixed(0x403),
    rv1: fixed(0x404),
    eb0: fixed(0x405),
  },
  versions: {
    ng1v1: fixed(0x500),
    ng1v2: fixed(0x501),
    ng2: fixed(0x502),
    ng3: fixed(0x503),
    rv0: fixed(0x504),
    rv1: fixed(0x505),
    eb0: fixed(0x506),
  },
  // The capture behind ng2, the plan in review: it carries the machines.
  captureNg2: fixed(0x6ff),
};

/* A synthetic RoomPlan scan: column-major transforms, rotation about y. */
function T(deg, x, z) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, 1.5, z, 1];
}
const surf = (deg, x, z, w, conf = 'high', h = 3.2) => ({
  confidence: { [conf]: {} },
  dimensions: [w, h, 0],
  transform: T(deg, x, z),
});
const obj = (x, z, w, d, h = 1.2, deg = 0, cat = 'storage') => ({
  category: { [cat]: {} },
  confidence: { high: {} },
  dimensions: [w, h, d],
  transform: T(deg, x, z),
});

/** A w × d gym: racks, a cardio row, a studio wall, doors and windows. */
export function gym(w, d, { lowWall = false, studio = true, column = false } = {}) {
  const walls = [
    surf(0, w / 2, 0, w),
    surf(90, w, d / 2, d),
    surf(0, w / 2, d, w, lowWall ? 'low' : 'high'),
    surf(90, 0, d / 2, d),
  ];
  // A studio in the south-east corner, closed on two sides by partitions.
  if (studio) {
    walls.push(surf(90, w * 0.68, d * 0.75, d * 0.5), surf(0, w * 0.84, d * 0.5, w * 0.32));
  }
  const racks = [0.15, 0.25, 0.35, 0.45].map((f) => obj(w * f, d * 0.22, 1.2, 2.2, 2.1));
  const cardio = [0.14, 0.24, 0.34].map((f) => obj(w * 0.88, d * f, 2, 0.9, 1.5, 0, 'table'));
  const extras = column ? [obj(w * 0.3, d * 0.62, 0.6, 0.6, 3.2)] : [];
  return {
    walls,
    doors: [surf(0, w * 0.12, 0, 1.8), ...(studio ? [surf(90, w * 0.68, d * 0.75, 0.9)] : [])],
    windows: [surf(0, w * 0.3, d, 3, 'medium'), surf(0, w * 0.52, d, 3)],
    openings: [],
    objects: [...racks, ...cardio, obj(w * 0.35, d * 0.7, 4, 1.4, 0.9), ...extras],
  };
}

const TAGS = (w, d) => [
  { type: 'fireExit', x: w, y: d * 0.4 },
  { type: 'mirror', x: w * 0.3, y: d },
  { type: 'power', x: w * 0.6, y: 0 },
  { type: 'ceiling', x: w * 0.5, y: d * 0.5, heightM: 3.18 },
];

/** A read plan; approved plans have every flag already resolved. */
function planFor(w, d, opts = {}, { resolved = false, equipment = [] } = {}) {
  const plan = planFromScan(gym(w, d, opts), { floorToFloorM: 3.5, tags: TAGS(w, d), equipment });
  if (resolved) {
    for (const f of plan.flags) {
      f.status = 'resolved';
      f.resolution = 'confirmed';
    }
  }
  return plan;
}

const hashOf = (plan) => createHash('sha256').update(canonicalJson(plan)).digest('hex');

/** Clears the demo rows, children first, as account removal would. */
async function clear(db) {
  const accounts = [DEMO.account, DEMO.kestrel];
  const people = [DEMO.owner, DEMO.surveyor, DEMO.reviewer, DEMO.admin];
  const each = async (sql) => {
    for (const a of accounts) await db.query(sql, [a]);
  };
  await each('DELETE FROM audit_log WHERE account_id = ?');
  await each('DELETE FROM jobs WHERE account_id = ?');
  await each('DELETE FROM share_links WHERE account_id = ?');
  await each('DELETE FROM generated_models WHERE account_id = ?');
  await each('DELETE FROM machine_models WHERE account_id = ?');
  await each('DELETE mv FROM machine_videos mv JOIN machines m ON m.id = mv.machine_id WHERE m.account_id = ?');
  await each('DELETE FROM machines WHERE account_id = ?');
  await each('UPDATE plan_versions SET based_on_version_id = NULL WHERE account_id = ?');
  await each('DELETE FROM plan_versions WHERE account_id = ?');
  await each('DELETE cf FROM capture_files cf JOIN captures c ON c.id = cf.capture_id WHERE c.account_id = ?');
  await each('DELETE FROM captures WHERE account_id = ?');
  await each('DELETE FROM plans WHERE account_id = ?');
  await each('DELETE FROM facilities WHERE account_id = ?');
  await each('DELETE FROM equipment_types WHERE account_id = ?');
  await each('DELETE FROM invites WHERE account_id = ?');
  await each('DELETE FROM memberships WHERE account_id = ?');
  // Versions in other accounts may name a demo reviewer; those links go.
  const ids = people.map((p) => p.id);
  await db.query('UPDATE plan_versions SET reviewed_by = NULL WHERE reviewed_by IN (?)', [ids]);
  await db.query('DELETE FROM users WHERE id IN (?) OR hub_user_id IN (?)', [ids, people.map((p) => p.sub)]);
  await each('DELETE FROM accounts WHERE id = ?');
}

export async function seed() {
  const f = DEMO.facilities;
  const p = DEMO.plans;
  const vs = DEMO.versions;
  const maya = DEMO.reviewer.id;
  const sam = DEMO.owner.id;
  const A = DEMO.account;

  await transaction(async (db) => {
    await clear(db);

    await db.query(`INSERT INTO accounts (id, name, plan_quota, created_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)`, [
      A, 'Northgate Group', 10, ago({ days: 220 }),
      DEMO.kestrel, 'Kestrel Health Clubs', 5, ago({ days: 90 }),
    ]);
    await db.query('INSERT INTO facilities (id, account_id, name) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)', [
      f.northgate, A, 'Northgate Fitness',
      f.riverside, A, 'Riverside Gym',
      f.eastbrook, A, 'Eastbrook Athletic Club',
      f.kestrel, DEMO.kestrel, 'Kestrel Fitzroy',
    ]);
    for (const [u, staff] of [[DEMO.owner, null], [DEMO.surveyor, null], [DEMO.reviewer, 'reviewer'], [DEMO.admin, 'admin']]) {
      await db.query('INSERT INTO users (id, hub_user_id, email, name, staff_role) VALUES (?, ?, ?, ?, ?)', [
        u.id, u.sub, u.email, u.name, staff,
      ]);
    }
    // Sam is in two accounts, with a different role in each (B-04).
    await db.query('INSERT INTO memberships (account_id, user_id, role) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)', [
      A, sam, 'owner',
      A, DEMO.surveyor.id, 'surveyor',
      DEMO.kestrel, sam, 'surveyor',
    ]);

    const names = {
      [p.ng1]: 'Northgate Fitness · Level 1',
      [p.ng2]: 'Northgate Fitness · Level 2',
      [p.ng3]: 'Northgate Fitness · Level 3',
      [p.rv0]: 'Riverside Gym · Ground',
      [p.rv1]: 'Riverside Gym · Level 1',
      [p.eb0]: 'Eastbrook Athletic Club · Ground',
    };
    for (const [id, facility, level] of [
      [p.ng1, f.northgate, 1],
      [p.ng2, f.northgate, 2],
      [p.ng3, f.northgate, 3],
      [p.rv0, f.riverside, 0],
      [p.rv1, f.riverside, 1],
      [p.eb0, f.eastbrook, 0],
    ]) {
      await db.query('INSERT INTO plans (id, account_id, facility_id, level_number) VALUES (?, ?, ?, ?)', [id, A, facility, level]);
    }

    let captureN = 0x600;
    let tagN = 0x6000;
    /** A version, with the capture it came from. */
    const version = async (v) => {
      const captureId = v.captureId ?? fixed(captureN++);
      await db.query(
        `INSERT INTO captures
           (id, account_id, user_id, idempotency_key, source, status, floor_to_floor_m, coverage,
            outline_closed, override_reason, duration_s, photo_count, weak_wall_count, received_at, created_at)
         VALUES (?, ?, ?, ?, 'lidar', ?, 3.5, ?, ?, ?, 900, 4, ?, ?, ?)`,
        [
          captureId, A, v.by ?? sam, `seed-${captureId}`, v.status === 'uploading' ? 'uploading' : 'received',
          v.coverage ?? null, v.coverage ? v.coverage > 0.8 : null, v.override ?? null, v.weak ?? 0,
          v.status === 'uploading' ? null : v.submitted, v.created,
        ],
      );
      if (v.status !== 'uploading') {
        const [w, d] = v.size;
        for (const t of TAGS(w, d)) {
          await db.query('INSERT INTO capture_tags (id, capture_id, type, x, y, height_m) VALUES (?, ?, ?, ?, ?, ?)', [
            fixed(tagN++), captureId, t.type, t.x, t.y, t.heightM ?? null,
          ]);
        }
      }
      const plan = v.plan ?? null;
      await db.query(
        `INSERT INTO plan_versions
          (id, account_id, plan_id, version_no, status, capture_id, submitted_at, review_started_at,
           reviewed_by, reviewed_at, review_active_seconds, review_last_activity_at, rejection_reason,
           reviewer_note, plan_json, content_hash, superseded_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          v.id, A, v.plan_id, v.version, v.status, captureId, v.submitted ?? null, v.reviewStarted ?? null,
          v.reviewer ?? null, v.reviewed ?? null, v.reviewSeconds ?? 0, v.lastActivity ?? null, v.reason ?? null,
          v.note ?? null, plan ? JSON.stringify(plan) : null,
          ['ready', 'superseded'].includes(v.status) ? hashOf(plan) : null,
          v.superseded ?? null, v.created, v.updated ?? v.created,
        ],
      );
      if (['ready', 'superseded'].includes(v.status)) {
        // The placeholder generator stores no file: the viewer builds the 3D.
        await db.query(
          `INSERT INTO generated_models
             (id, account_id, plan_version_id, generator_version, content_hash, status, created_at, finished_at)
           VALUES (?, ?, ?, 'browser-0', ?, 'ready', ?, ?)`,
          [fixed(0x700 + Object.values(vs).indexOf(v.id)), A, v.id, hashOf(plan), v.reviewed, v.reviewed],
        );
      }
      return captureId;
    };
    let auditN = 0x900;
    const log = (action, planId, ver, at, actor = maya, detail = null) =>
      db.query(
        `INSERT INTO audit_log (id, account_id, actor_user_id, actor_name, action, target_type, target_id,
                                target_label, version_no, detail, created_at)
         VALUES (?, ?, ?, ?, ?, 'plan', ?, ?, ?, ?, ?)`,
        [
          fixed(auditN++), A, actor,
          { [sam]: 'Sam Okafor', [maya]: 'Maya Restrepo', [DEMO.surveyor.id]: 'Lee Tan' }[actor] ?? 'System',
          action, planId, names[planId], ver, detail ? JSON.stringify(detail) : null, at,
        ],
      );

    // Both of these count against this month's quota, so they are kept
    // inside the month however early in it the seed is run.
    const inMonth = monthWindow(13);
    // Level 1: version 1 approved last month, superseded by version 2. The
    // quota then shows 6 of 10 this month, as in the prototype.
    await version({
      id: vs.ng1v1, plan_id: p.ng1, version: 1, status: 'superseded', coverage: 0.9, size: [23.5, 16],
      plan: planFor(23.5, 16, {}, { resolved: true }),
      submitted: ago({ days: 45 }), reviewStarted: ago({ days: 44 }), reviewer: maya,
      reviewed: ago({ days: 44 }), reviewSeconds: 700, superseded: ago({ days: 2 }), created: ago({ days: 45 }),
    });
    await version({
      id: vs.ng1v2, plan_id: p.ng1, version: 2, status: 'ready', coverage: 0.97, size: [24, 16],
      plan: planFor(24, 16, {}, { resolved: true }),
      submitted: ago({ days: 3 }), reviewStarted: ago({ days: 2, minutes: 12 }), reviewer: maya,
      reviewed: ago({ days: 2 }), reviewSeconds: 680, created: ago({ days: 3 }), updated: ago({ days: 2 }),
    });

    // Level 2, in review, carries machines: two placed, one the surveyor
    // added by hand with no position yet (D-03).
    const marked = [
      { equipmentId: 'EQ-001', type: 'treadmill', name: 'Treadmill 1', x: 17.6, y: 2.0, w: 2, d: 0.9, heightM: 1.5 },
      { equipmentId: 'EQ-002', type: 'legPress', name: 'Leg press', x: 7.0, y: 9.8, w: 2.2, d: 1.4, heightM: 1.4 },
    ];
    await version({
      id: vs.ng2, plan_id: p.ng2, version: 1, status: 'in_review', coverage: 0.94, weak: 1, size: [20, 14],
      captureId: DEMO.captureNg2,
      plan: planFor(20, 14, { lowWall: true, column: true }, { equipment: marked }),
      submitted: ago({ hours: 3 }), reviewStarted: ago({ hours: 1 }), reviewer: maya,
      lastActivity: ago({ hours: 1 }), created: ago({ hours: 3 }), updated: ago({ hours: 1 }),
    });
    const types = { treadmill: '01920000-0000-7000-8000-000000000001', legPress: '01920000-0000-7000-8000-000000000002', bench: '01920000-0000-7000-8000-000000000009' };
    const machines = [
      [fixed(0xa00), 'EQ-001', types.treadmill, 'Treadmill 1', 17.6, 2.0, 2, 0.9, 1.5, 'surveyor'],
      [fixed(0xa01), 'EQ-002', types.legPress, 'Leg press', 7.0, 9.8, 2.2, 1.4, 1.4, 'surveyor'],
      [fixed(0xa02), 'EQ-003', types.bench, 'Flat bench', null, null, 1.2, 0.5, 0.5, 'surveyor'],
    ];
    for (const [id, ref, type, name, x, y, w, d, h, source] of machines) {
      await db.query(
        `INSERT INTO machines (id, account_id, capture_id, ref, equipment_type_id, name, x, y, width_m, depth_m, height_m, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, A, DEMO.captureNg2, ref, type, name, x, y, w, d, h, source],
      );
    }
    // A 360 video for the treadmill, still uploading from the phone.
    const videoFile = fixed(0xb00);
    await db.query(
      `INSERT INTO capture_files (id, capture_id, kind, name, bytes, content_type, part_size, part_count, storage_key, upload_id)
       VALUES (?, ?, 'video', ?, 52428800, 'video/mp4', 8388608, 7, ?, 'seed-upload-0000000001')`,
      [
        videoFile, DEMO.captureNg2, `equipment/EQ-001/${fixed(0xb01)}/360.mp4`,
        `accounts/${A}/captures/${DEMO.captureNg2}/equipment/EQ-001/${fixed(0xb01)}/360.mp4`,
      ],
    );
    await db.query(
      `INSERT INTO machine_videos (id, machine_id, video_file_id, duration_s, status) VALUES (?, ?, ?, 48, 'uploading')`,
      [fixed(0xb01), machines[0][0], videoFile],
    );
    // And a machine model waiting for review (owned by the 3D team, L-07).
    await db.query(
      `INSERT INTO machine_models (id, account_id, machine_id, route, generator_version, input_hash, status, size_w_m, size_d_m, size_h_m)
       VALUES (?, ?, ?, 'generated', 'trellis2-0', ?, 'awaiting_review', 2, 0.9, 1.5)`,
      [fixed(0xc00), A, machines[0][0], 'a'.repeat(64)],
    );

    await version({
      id: vs.ng3, plan_id: p.ng3, version: 1, status: 'uploading', size: [20, 14], created: ago({ minutes: 20 }),
    });
    await version({
      id: vs.rv0, plan_id: p.rv0, version: 1, status: 'recapture', coverage: 0.71, size: [18, 12],
      plan: planFor(18, 12, { lowWall: true, studio: false }),
      override: 'Wall behind fixed rig, cannot pass', submitted: inMonth({ days: 10 }),
      reviewStarted: inMonth({ days: 9, hours: 1 }), reviewer: maya, reviewed: inMonth({ days: 9 }),
      reviewSeconds: 540, reason: 'incomplete_coverage',
      note:
        'The north-east corner is missing about 6 m of wall and the free-weight area reads as ' +
        'one block, so the plan cannot be closed. Please rewalk that corner slowly and keep the ' +
        'phone at waist height.',
      created: inMonth({ days: 10 }), updated: inMonth({ days: 9 }),
    });
    await version({
      id: vs.rv1, plan_id: p.rv1, version: 1, status: 'processing', coverage: 0.95, size: [22, 15],
      by: DEMO.surveyor.id, plan: planFor(22, 15, { column: true }),
      submitted: ago({ minutes: 6 }), created: ago({ minutes: 40 }), updated: ago({ minutes: 6 }),
    });
    await version({
      id: vs.eb0, plan_id: p.eb0, version: 1, status: 'ready', coverage: 0.96, size: [16, 12],
      plan: planFor(16, 12, {}, { resolved: true }),
      submitted: inMonth({ days: 13 }), reviewStarted: inMonth({ days: 12, minutes: 9 }), reviewer: maya,
      reviewed: inMonth({ days: 12 }), reviewSeconds: 485, created: inMonth({ days: 13 }), updated: inMonth({ days: 12 }),
    });

    // The history those versions imply (E-04: the audit log is the history).
    await log('CAPTURED', p.ng1, 1, ago({ days: 45 }), sam, { input: 'lidar' });
    await log('APPROVED', p.ng1, 1, ago({ days: 44 }));
    await log('GENERATED', p.ng1, 1, ago({ days: 44 }), null);
    await log('CAPTURED', p.eb0, 1, inMonth({ days: 13 }), sam, { input: 'lidar' });
    await log('APPROVED', p.eb0, 1, inMonth({ days: 12 }));
    await log('GENERATED', p.eb0, 1, inMonth({ days: 12 }), null);
    await log('CAPTURED', p.rv0, 1, inMonth({ days: 10 }), sam, { input: 'lidar' });
    await log('REJECTED', p.rv0, 1, inMonth({ days: 9 }), maya, { reason: 'Incomplete coverage' });
    await log('CAPTURED', p.ng1, 2, ago({ days: 3 }), sam, { input: 'lidar' });
    await log('APPROVED', p.ng1, 2, ago({ days: 2 }));
    await log('SUPERSEDED', p.ng1, 1, ago({ days: 2 }), null, { by: 2 });
    await log('GENERATED', p.ng1, 2, ago({ days: 2 }), null);
    await log('CAPTURED', p.ng2, 1, ago({ hours: 3 }), sam, { input: 'lidar' });
    await log('PLAN_PRODUCED', p.ng2, 1, ago({ hours: 3 }), null);
    await log('CLAIMED', p.ng2, 1, ago({ hours: 1 }));
    await log('CAPTURED', p.rv1, 1, ago({ minutes: 40 }), DEMO.surveyor.id, { input: 'lidar' });
    await log('PLAN_PRODUCED', p.rv1, 1, ago({ minutes: 6 }), null);
    await log('CAPTURED', p.ng3, 1, ago({ minutes: 20 }), sam, { input: 'lidar' });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seed()
    .then(() => console.log('Demo data loaded.'))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
