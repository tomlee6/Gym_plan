/** How the owner pages describe a plan's state (PRD section 4). */
import { day, levelLabel, OWNER_STATUS, time } from '../lib/format.js';

const SCANS = ['lidar', 'simulated'];

function isToday(iso) {
  const d = new Date(iso);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

/** "08:41" today, otherwise "15 Mar". */
function when(iso) {
  if (!iso) return null;
  return isToday(iso) ? time(iso) : day(iso);
}

export function statusOf(plan) {
  return OWNER_STATUS[plan.status] ?? { label: plan.status, tone: 'muted' };
}

/** The line under a plan's state, e.g. "With Maya Restrepo since 08:41". */
export function noteFor(plan) {
  switch (plan.status) {
    case 'uploading':
      return SCANS.includes(plan.inputType) ? 'Uploading from the app' : 'Uploading';
    case 'processing':
      return plan.submittedAt ? `In the queue since ${when(plan.submittedAt)}` : 'In the queue';
    case 'in_review':
      return plan.reviewerName
        ? `With ${plan.reviewerName}${plan.reviewStartedAt ? ` since ${when(plan.reviewStartedAt)}` : ''}`
        : 'In review';
    case 'recapture':
      return `Rejected ${day(plan.reviewedAt) ?? ''}${plan.reviewerName ? ` by ${plan.reviewerName}` : ''}`.trim();
    case 'ready':
      return `Approved ${day(plan.reviewedAt) ?? ''} · version ${plan.version}`;
    default:
      return null;
  }
}

/**
 * Facilities with their plans, levels in order. Facilities with no plans are
 * kept so the owner sees every gym. Plans for a facility the list does not
 * name (e.g. one just added) get their own group.
 */
export function groupByFacility(facilities, plans) {
  const groups = facilities.map((f) => ({ id: f.id, name: f.name, plans: [] }));
  const byId = new Map(groups.map((g) => [g.id, g]));
  for (const p of plans) {
    let g = byId.get(p.facilityId);
    if (!g) {
      g = { id: p.facilityId, name: p.site, plans: [] };
      byId.set(g.id, g);
      groups.push(g);
    }
    g.plans.push(p);
  }
  for (const g of groups) g.plans.sort((a, b) => a.level - b.level);
  return groups;
}

export function planTitle(plan) {
  return `${plan.site} · ${levelLabel(plan.level)}`;
}
