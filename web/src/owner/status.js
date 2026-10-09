/**
 * How the owner pages describe a plan's state (PRD section 4, D-05). The
 * words live in lib/i18n.js under `owner.*`; this module decides which.
 */
import { day, levelLabel, time } from '../lib/format.js';
import { t } from '../lib/i18n.js';

const SCANS = ['lidar', 'simulated'];

/**
 * The tone of each state's pill. The pill always carries its label too, so
 * the colour only reinforces what the words say (WCAG 1.4.1).
 *
 * `generation_failed` is Flex's to fix (the reviewer queue picks it up
 * again), so the owner sees it as still in review rather than as an error.
 */
const TONES = {
  uploading: 'accent',
  processing: 'fair',
  in_review: 'fair',
  generating: 'accent',
  generation_failed: 'fair',
  recapture: 'danger',
  ready: 'good',
  superseded: 'muted',
};

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

/** A state's label and tone, e.g. { label: 'Building walkthrough', tone: 'accent' }. */
export function statusOf(planOrStatus) {
  const status = typeof planOrStatus === 'string' ? planOrStatus : planOrStatus.status;
  const label = t(`owner.status.${status}`);
  return label === `owner.status.${status}` ? { label: status, tone: 'muted' } : { label, tone: TONES[status] ?? 'muted' };
}

/** The line under a plan's state, e.g. "With Maya Restrepo since 08:41". */
export function noteFor(plan) {
  switch (plan.status) {
    case 'uploading':
      return SCANS.includes(plan.inputType) ? t('owner.note.uploadingApp') : t('owner.note.uploading');
    case 'processing':
      return plan.submittedAt ? t('owner.note.queuedSince', { when: when(plan.submittedAt) }) : t('owner.note.queued');
    case 'in_review':
    // The owner is not told a build failed; Flex is fixing it.
    // falls through
    case 'generation_failed':
      if (!plan.reviewerName) return t('owner.note.inReview');
      return plan.reviewStartedAt
        ? t('owner.note.withSince', { name: plan.reviewerName, when: when(plan.reviewStartedAt) })
        : t('owner.note.with', { name: plan.reviewerName });
    case 'generating':
      return plan.reviewedAt
        ? t('owner.note.generating', { when: day(plan.reviewedAt) })
        : t('owner.note.generatingNoDate');
    case 'recapture':
      return plan.reviewerName
        ? t('owner.note.rejectedBy', { when: day(plan.reviewedAt) ?? '', name: plan.reviewerName })
        : t('owner.note.rejected', { when: day(plan.reviewedAt) ?? '' }).trim();
    case 'ready':
      return t('owner.note.ready', { when: day(plan.reviewedAt) ?? '', version: plan.version });
    default:
      return null;
  }
}

/** What the owner is told about a machine's 3D model, and its tone. */
const MODEL_TONES = {
  none: 'muted',
  queued: 'fair',
  building: 'fair',
  awaiting_review: 'fair',
  approved: 'good',
  rejected: 'fair',
  failed: 'fair',
};

export function modelStatusOf(modelStatus) {
  const key = MODEL_TONES[modelStatus] ? modelStatus : 'none';
  return { label: t(`owner.model.${key}`), tone: MODEL_TONES[key] };
}

/** "3 machines · 2 3D models ready", or null when no machines were named. */
export function machinesSummary(machines) {
  if (!machines?.length) return null;
  const ready = machines.filter((m) => m.modelStatus === 'approved').length;
  return t('owner.plans.machinesSummary', { count: machines.length, ready });
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
