/**
 * Demo data: the Northgate Group account the prototypes show, plus Flex
 * staff. Safe to run again: it clears and recreates only these rows.
 *
 *   npm run db:seed
 *
 *   sam.okafor@northgatefitness.com / flex1234     owner (app and web)
 *   maya.restrepo@flexmotion.app    / review1234   reviewer
 *   admin@flexmotion.app            / admin1234    platform admin
 *
 * Every version gets a plan, read from a synthetic scan the way a real one
 * would be, so the reviewer editor and the walkthrough have something to
 * show.
 */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { canonicalJson, planFromScan, summary } from '../../../shared/plan/index.js';
import { hashPassword } from '../modules/auth.js';
import { pool, transaction } from './pool.js';

const ago = ({ days = 0, hours = 0, minutes = 0 }) =>
  new Date(Date.now() - ((days * 24 + hours) * 60 + minutes) * 60000);

/**
 * Like `ago`, for the plans that have to count against this month's quota.
 *
 * The demo shows 6 of 10 used this month, and the count resets on the 1st,
 * so a plan seeded "13 days ago" fell into last month whenever the seed ran
 * before the 14th — the quota quietly changed with the day it was run.
 *
 * When the month so far is shorter than the oldest of these plans needs,
 * the whole run of them is squeezed into the part of the month that has
 * happened. Squeezing everything by one factor keeps the events in the same
 * order and the same proportions, just closer together; on the 14th or
 * later nothing is squeezed and these are ordinary `ago` dates.
 */
function monthWindow(oldestDays) {
  const now = Date.now();
  const start = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) + 3600000;
  const squeeze = Math.min(1, (now - start) / (oldestDays * 86400000));
  return ({ days = 0, hours = 0, minutes = 0 }) =>
    new Date(now - ((days * 24 + hours) * 60 + minutes) * 60000 * squeeze);
}

export const DEMO = {
  org: 'org_northgate',
  flexOrg: 'org_flex',
  owner: { id: 'usr_sam', email: 'sam.okafor@northgatefitness.com', password: 'flex1234' },
  reviewer: { id: 'usr_maya', email: 'maya.restrepo@flexmotion.app', password: 'review1234' },
  admin: { id: 'usr_admin', email: 'admin@flexmotion.app', password: 'admin1234' },
  facilities: {
    northgate: 'fac_northgate',
    riverside: 'fac_riverside',
    eastbrook: 'fac_eastbrook',
  },
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
function gym(w, d, { lowWall = false, studio = true, column = false } = {}) {
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
function planFor(w, d, opts = {}, { resolved = false } = {}) {
  const plan = planFromScan(gym(w, d, opts), { floorToFloorM: 3.5, tags: TAGS(w, d) });
  if (resolved) {
    for (const f of plan.flags) {
      f.status = 'resolved';
      f.resolution = 'confirmed';
    }
  }
  return plan;
}

const hashOf = (plan) => createHash('sha256').update(canonicalJson(plan)).digest('hex');

export async function seed() {
  const [ownerHash, reviewerHash, adminHash] = await Promise.all([
    hashPassword(DEMO.owner.password),
    hashPassword(DEMO.reviewer.password),
    hashPassword(DEMO.admin.password),
  ]);
  const f = DEMO.facilities;

  await transaction(async (db) => {
    // Clear earlier demo rows, children first.
    for (const org of [DEMO.org, DEMO.flexOrg]) {
      await db.query('DELETE FROM audit_log WHERE org_id = ?', [org]);
      await db.query('DELETE FROM share_links WHERE org_id = ?', [org]);
      await db.query(
        'DELETE cf FROM capture_files cf JOIN captures c ON c.id = cf.capture_id WHERE c.org_id = ?',
        [org],
      );
      await db.query('DELETE FROM plan_versions WHERE org_id = ?', [org]);
      await db.query('DELETE FROM captures WHERE org_id = ?', [org]);
      await db.query('DELETE FROM plans WHERE org_id = ?', [org]);
    }
    // Versions in other accounts may name a demo reviewer.
    await db.query('UPDATE plan_versions SET reviewed_by = NULL WHERE reviewed_by IN (?, ?)', [
      DEMO.reviewer.id,
      DEMO.admin.id,
    ]);
    for (const org of [DEMO.org, DEMO.flexOrg]) {
      await db.query('DELETE FROM users WHERE org_id = ?', [org]);
      await db.query('DELETE FROM facilities WHERE org_id = ?', [org]);
      await db.query('DELETE FROM organisations WHERE id = ?', [org]);
    }

    await db.query(
      `INSERT INTO organisations (id, name, plan_quota, created_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
      [
        DEMO.org, 'Northgate Group', 10, ago({ days: 220 }),
        DEMO.flexOrg, 'Flex Motion Technologies', 1000, ago({ days: 400 }),
      ],
    );
    await db.query('INSERT INTO facilities (id, org_id, name) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)', [
      f.northgate, DEMO.org, 'Northgate Fitness',
      f.riverside, DEMO.org, 'Riverside Gym',
      f.eastbrook, DEMO.org, 'Eastbrook Athletic Club',
    ]);
    await db.query(
      `INSERT INTO users (id, org_id, email, password_hash, name, role, role_label, default_facility_id)
       VALUES (?, ?, ?, ?, ?, 'owner', 'Owner & Surveyor', ?),
              (?, ?, ?, ?, ?, 'reviewer', 'Reviewer', NULL),
              (?, ?, ?, ?, ?, 'admin', 'Platform admin', NULL)`,
      [
        DEMO.owner.id, DEMO.org, DEMO.owner.email, ownerHash, 'Sam Okafor', f.northgate,
        DEMO.reviewer.id, DEMO.flexOrg, DEMO.reviewer.email, reviewerHash, 'Maya Restrepo',
        DEMO.admin.id, DEMO.flexOrg, DEMO.admin.email, adminHash, 'Jordan Kaur',
      ],
    );

    const plans = [
      ['plan_ng1', f.northgate, 1],
      ['plan_ng2', f.northgate, 2],
      ['plan_ng3', f.northgate, 3],
      ['plan_rv0', f.riverside, 0],
      ['plan_rv1', f.riverside, 1],
      ['plan_eb0', f.eastbrook, 0],
    ];
    const names = { plan_ng1: 'Northgate Fitness · Level 1', plan_ng2: 'Northgate Fitness · Level 2', plan_ng3: 'Northgate Fitness · Level 3', plan_rv0: 'Riverside Gym · Ground', plan_rv1: 'Riverside Gym · Level 1', plan_eb0: 'Eastbrook Athletic Club · Ground' };
    for (const [id, facility, level] of plans) {
      await db.query('INSERT INTO plans (id, org_id, facility_id, level) VALUES (?, ?, ?, ?)', [
        id, DEMO.org, facility, level,
      ]);
    }

    const version = (v) => {
      const plan = v.plan ?? null;
      return db.query(
        `INSERT INTO plan_versions
          (id, org_id, plan_id, version, status, input_type, submitted_at, coverage, override_reason,
           area_m2, review_started_at, reviewed_by, reviewed_at, review_seconds, review_active_seconds,
           review_last_activity_at, rejection_reason, reviewer_note, plan_json, content_hash,
           superseded_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'lidar', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          v.id, DEMO.org, v.plan_id, v.version, v.status, v.submitted ?? null, v.coverage ?? null,
          v.override ?? null, plan ? summary(plan).areaM2 : null, v.reviewStarted ?? null,
          v.reviewer ?? null, v.reviewed ?? null, v.reviewSeconds ?? null, v.reviewSeconds ?? 0,
          v.lastActivity ?? null, v.reason ?? null, v.note ?? null,
          plan ? JSON.stringify(plan) : null,
          v.status === 'ready' || v.status === 'superseded' ? hashOf(plan) : null,
          v.superseded ?? null, v.created, v.updated ?? v.created,
        ],
      );
    };
    const log = (action, planId, ver, at, actor = DEMO.reviewer.id, detail = null) =>
      db.query(
        `INSERT INTO audit_log (id, org_id, actor_id, actor_name, action, target_type, target_id,
                                target_label, version, detail, created_at)
         VALUES (?, ?, ?, ?, ?, 'plan', ?, ?, ?, ?, ?)`,
        [
          `aud_seed_${planId}_${ver}_${action}`, DEMO.org, actor,
          actor === DEMO.owner.id ? 'Sam Okafor' : actor ? 'Maya Restrepo' : 'System',
          action, planId, names[planId], ver, detail ? JSON.stringify(detail) : null, at,
        ],
      );

    const maya = DEMO.reviewer.id;
    // Both of these are meant to count against this month's quota, so they
    // are kept inside the month however early in it the seed is run.
    // 13 days is the oldest of the two, so it sets the squeeze for both.
    const inMonth = monthWindow(13);
    // Level 1: version 1 approved last month, superseded by version 2. The
    // quota then shows 6 of 10 this month, as in the prototype.
    await version({
      id: 'pv_ng1_1', plan_id: 'plan_ng1', version: 1, status: 'superseded', coverage: 0.9,
      plan: planFor(23.5, 16, {}, { resolved: true }),
      submitted: ago({ days: 45 }), reviewStarted: ago({ days: 44 }), reviewer: maya,
      reviewed: ago({ days: 44 }), reviewSeconds: 700, superseded: ago({ days: 2 }),
      created: ago({ days: 45 }),
    });
    await version({
      id: 'pv_ng1_2', plan_id: 'plan_ng1', version: 2, status: 'ready', coverage: 0.97,
      plan: planFor(24, 16, {}, { resolved: true }),
      submitted: ago({ days: 3 }), reviewStarted: ago({ days: 2, minutes: 12 }), reviewer: maya,
      reviewed: ago({ days: 2 }), reviewSeconds: 680, created: ago({ days: 3 }), updated: ago({ days: 2 }),
    });
    await version({
      id: 'pv_ng2_1', plan_id: 'plan_ng2', version: 1, status: 'in_review', coverage: 0.94,
      plan: planFor(20, 14, { lowWall: true, column: true }),
      submitted: ago({ hours: 3 }), reviewStarted: ago({ hours: 1 }), reviewer: maya,
      lastActivity: ago({ hours: 1 }), created: ago({ hours: 3 }), updated: ago({ hours: 1 }),
    });
    await version({
      id: 'pv_ng3_1', plan_id: 'plan_ng3', version: 1, status: 'uploading', created: ago({ minutes: 20 }),
    });
    await version({
      id: 'pv_rv0_1', plan_id: 'plan_rv0', version: 1, status: 'recapture', coverage: 0.71,
      plan: planFor(18, 12, { lowWall: true, studio: false }),
      override: 'Wall behind fixed rig, cannot pass', submitted: inMonth({ days: 10 }),
      reviewStarted: inMonth({ days: 9, hours: 1 }), reviewer: maya, reviewed: inMonth({ days: 9 }),
      reviewSeconds: 540, reason: 'Incomplete coverage',
      note:
        'The north-east corner is missing about 6 m of wall and the free-weight area reads as ' +
        'one block, so the plan cannot be closed. Please rewalk that corner slowly and keep the ' +
        'phone at waist height.',
      created: inMonth({ days: 10 }), updated: inMonth({ days: 9 }),
    });
    await version({
      id: 'pv_rv1_1', plan_id: 'plan_rv1', version: 1, status: 'processing', coverage: 0.95,
      plan: planFor(22, 15, { column: true }),
      submitted: ago({ minutes: 6 }), created: ago({ minutes: 40 }), updated: ago({ minutes: 6 }),
    });
    await version({
      id: 'pv_eb0_1', plan_id: 'plan_eb0', version: 1, status: 'ready', coverage: 0.96,
      plan: planFor(16, 12, {}, { resolved: true }),
      submitted: inMonth({ days: 13 }), reviewStarted: inMonth({ days: 12, minutes: 9 }), reviewer: maya,
      reviewed: inMonth({ days: 12 }), reviewSeconds: 485, created: inMonth({ days: 13 }), updated: inMonth({ days: 12 }),
    });

    // The history those versions imply.
    await log('CAPTURED', 'plan_ng1', 1, ago({ days: 45 }), DEMO.owner.id, { input: 'lidar' });
    await log('APPROVED', 'plan_ng1', 1, ago({ days: 44 }));
    await log('CAPTURED', 'plan_eb0', 1, inMonth({ days: 13 }), DEMO.owner.id, { input: 'lidar' });
    await log('APPROVED', 'plan_eb0', 1, inMonth({ days: 12 }));
    await log('CAPTURED', 'plan_rv0', 1, inMonth({ days: 10 }), DEMO.owner.id, { input: 'lidar' });
    await log('REJECTED', 'plan_rv0', 1, inMonth({ days: 9 }), maya, { reason: 'Incomplete coverage' });
    await log('CAPTURED', 'plan_ng1', 2, ago({ days: 3 }), DEMO.owner.id, { input: 'lidar' });
    await log('APPROVED', 'plan_ng1', 2, ago({ days: 2 }));
    await log('SUPERSEDED', 'plan_ng1', 1, ago({ days: 2 }), maya, { by: 2 });
    await log('CAPTURED', 'plan_ng2', 1, ago({ hours: 3 }), DEMO.owner.id, { input: 'lidar' });
    await log('PLAN_PRODUCED', 'plan_ng2', 1, ago({ hours: 3 }), null);
    await log('CLAIMED', 'plan_ng2', 1, ago({ hours: 1 }));
    await log('CAPTURED', 'plan_rv1', 1, ago({ minutes: 40 }), DEMO.owner.id, { input: 'lidar' });
    await log('PLAN_PRODUCED', 'plan_rv1', 1, ago({ minutes: 6 }), null);
    await log('CAPTURED', 'plan_ng3', 1, ago({ minutes: 20 }), DEMO.owner.id, { input: 'lidar' });
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
