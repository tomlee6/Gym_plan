/**
 * User-facing words (H-04). Pages ask for a string by key with `t(key,
 * vars)` rather than writing it inline, so a second language is one more
 * dictionary rather than an edit of every page.
 *
 * - Keys are dotted paths into the dictionary: t('owner.status.ready').
 * - `{name}` in a string is replaced by vars.name.
 * - A value may be { one, other } (and any other Intl.PluralRules
 *   category); vars.count picks the form, per the locale's own rules.
 * - A key missing from the current locale falls back to English, and a key
 *   missing from English shows the key itself, so a gap is visible in the
 *   page rather than blank.
 *
 * To add a locale: add a dictionary with the same shape to LOCALES (e.g.
 * `fr: { ... }`), and call setLocale('fr') at start-up.
 */

const en = {
  common: {
    loading: 'Loading…',
    tryAgain: 'Try again',
    refresh: 'Refresh',
    refreshing: 'Refreshing…',
    updated: 'Updated at {time}',
    dash: '—',
  },
  auth: {
    title: 'Sign in',
    lead: 'Gym owners, surveyors, reviewers and Flex staff all sign in with their Flex Gym Scan email and password.',
    button: 'Sign in',
    redirecting: 'Taking you to sign-in…',
    finishing: 'Finishing signing in…',
    retry: 'Sign in again',
    failedTitle: 'You are not signed in',
    errors: {
      hub_rejected: 'We could not confirm this sign-in. It may have taken too long. Please sign in again.',
      no_access:
        'You signed in, but your account has no access to Flex Gym Scan yet. Ask your gym’s owner or Flex to invite the email address you used.',
      state_mismatch:
        'This sign-in was started in a different tab or has expired. Start again from this tab.',
      cancelled: 'Sign-in was cancelled.',
      hub_error: 'We could not sign you in: {detail}',
      config: 'Sign-in is not available right now: {detail}',
      unknown: 'Something went wrong while signing in: {detail}',
    },
    noAccess: {
      title: 'No access to this account',
      body: 'Your role in this gym account does not include these pages. Choose another account, or ask its owner.',
    },
  },
  layout: {
    account: 'Account',
    switchAccount: 'Switch account',
    signOut: 'Sign out',
    staffRoles: { admin: 'Platform admin', reviewer: 'Reviewer' },
    accountRoles: { owner: 'Owner & Surveyor', surveyor: 'Surveyor' },
  },
  owner: {
    plans: {
      title: 'My plans',
      quota: '{used} of {quota} this month',
      upload: 'Upload a plan',
      loadFailed: 'Your plans could not be loaded',
      loading: 'Loading your plans…',
      noGyms: 'No gyms on this account yet',
      noGymsBody: 'Ask Flex to add your facilities, then scan them with the app or upload a plan.',
      levels: { one: '{count} level', other: '{count} levels' },
      noLevels: 'No levels yet',
      nothingYet: 'Nothing captured here yet. Scan a level with the Gym Scan app, or',
      nothingYetLink: 'upload a plan',
      openWalkthrough: 'Open walkthrough',
      reasonCode: 'REASON CODE',
      needsRecapture: 'Needs recapture',
      statusLabel: 'Status: {status}',
      machinesSummary: { one: '{count} machine · {ready} 3D model ready', other: '{count} machines · {ready} 3D models ready' },
    },
    plan: {
      title: 'Plan',
      back: 'My plans',
      notFound: 'This plan does not exist',
      loadFailed: 'The plan could not be loaded',
      loading: 'Loading the plan…',
      versionPrefix: 'Version {version} · ',
      sentBack: 'Why it was sent back',
      sentBackEyebrow: 'NEEDS RECAPTURE · REASON CODE',
      recaptureHelp: 'Scan this level again with the Gym Scan app, or',
      recaptureHelpLink: 'upload a plan',
      recaptureHelpAfter: '. The new capture becomes version {next}.',
      generating:
        'Approved. Flex is building the 3D walkthrough now; it usually takes a few minutes and this page updates by itself.',
      facts: 'Plan facts',
      factsEyebrow: 'PLAN',
      floorArea: 'Floor area',
      coverage: 'Scan coverage',
      walkthrough: 'Walkthrough',
      walkthroughVersion: 'Version {version}',
      notYet: 'Not yet',
      reviewer: 'Reviewer',
      history: 'Version history',
      noVersions: 'No versions yet.',
      revisedByFlex: 'Revised by Flex',
      by: 'by {name}',
      columns: {
        version: 'VERSION',
        state: 'STATE',
        input: 'INPUT',
        submitted: 'SUBMITTED',
        reviewed: 'REVIEWED',
        hash: 'CONTENT HASH',
      },
      timeline: 'Activity',
      machines: 'Machines',
      machinesCaption: 'Machines on this plan and the state of each one’s 3D model',
      noMachines: 'No machines have been named on this plan yet.',
      machineColumns: { ref: 'REFERENCE', name: 'NAME', type: 'TYPE', model: '3D MODEL' },
    },
    share: {
      eyebrow: 'SHARE LINK',
      notYet: 'Sharing becomes available once the walkthrough is approved.',
      about: 'Anyone with this link can open the walkthrough without an account. It always shows the newest approved version.',
      label: 'Share link',
      copy: 'Copy link',
      copied: 'Copied',
      copiedStatus: 'Link copied',
      copyBlocked: 'Copying was blocked. The link is selected: press Ctrl+C to copy it.',
      revoke: 'Revoke link',
      revoking: 'Revoking…',
      make: 'Make a view-only link for a colleague or investor. They need no account, and you can revoke it at any time.',
      create: 'Create share link',
      exists: 'A link exists (created {created}). Make a new link to copy it again — the old one stops working.',
      remake: 'Make a new link',
      creating: 'Creating…',
      confirmTitle: 'Revoke the share link?',
      confirmSubtitle: 'Anyone using it will see that it is no longer available.',
      keep: 'Keep it',
      after: 'You can create a new link afterwards; it will have a different address.',
    },
    status: {
      uploading: 'Received',
      processing: 'Processing complete, awaiting review',
      in_review: 'In review',
      generating: 'Building walkthrough',
      // A failed build is Flex's problem to fix, not the owner's: to them
      // the plan is still being reviewed.
      generation_failed: 'In review',
      recapture: 'Needs recapture',
      ready: 'Ready',
      superseded: 'Superseded',
    },
    note: {
      uploadingApp: 'Uploading from the app',
      uploading: 'Uploading',
      queuedSince: 'In the queue since {when}',
      queued: 'In the queue',
      with: 'With {name}',
      withSince: 'With {name} since {when}',
      inReview: 'In review',
      generating: 'Approved {when} · the 3D walkthrough is being built',
      generatingNoDate: 'Approved · the 3D walkthrough is being built',
      rejected: 'Rejected {when}',
      rejectedBy: 'Rejected {when} by {name}',
      ready: 'Approved {when} · version {version}',
    },
    timeline: {
      CAPTURED: 'Captured',
      PLAN_PRODUCED: 'Plan read from the capture',
      CLAIMED: 'Review started',
      RELEASED: 'Put back in the queue',
      CORRECTED: 'Corrected by Flex',
      APPROVED: 'Approved',
      REJECTED: 'Sent back for recapture',
      REVISED: 'Revised by Flex',
      SUPERSEDED: 'Superseded',
      GENERATED: '3D walkthrough built',
      SHARE_LINK_CREATED: 'Share link made',
      SHARE_LINK_REVOKED: 'Share link revoked',
    },
    model: {
      none: 'Not started',
      queued: 'Queued',
      building: 'Building',
      awaiting_review: 'Awaiting Flex review',
      approved: 'Ready',
      rejected: 'Being redone',
      failed: 'Being redone',
    },
  },
  queue: {
    title: 'Reviewer queue',
    oldestFirst: 'Oldest first',
    loadFailed: 'The queue could not be loaded',
    loading: 'Loading the queue…',
    clear: 'The queue is clear',
    clearBody: 'New scans appear here once their upload is confirmed.',
    footnote: 'Opening a plan claims it. Releasing it without approving or rejecting puts it back in the queue.',
    summary: 'Queue summary',
    caption: 'Plans waiting for review, oldest first',
    stats: {
      waiting: 'WAITING FOR REVIEW',
      unclaimed: '{count} unclaimed',
      oldest: 'OLDEST IN QUEUE',
      nothingWaiting: 'Nothing waiting',
      median: 'YOUR MEDIAN THIS WEEK',
      reviews: { one: '{count} review · target under 15 min', other: '{count} reviews · target under 15 min' },
      noReviews: 'No reviews yet this week',
      rejected: 'REJECTED THIS WEEK',
      approved: '{count} approved, all reviewers',
      overTarget: '(over target)',
      onTarget: '(on target)',
    },
    columns: {
      facility: 'FACILITY AND LEVEL',
      input: 'INPUT',
      confidence: 'CONFIDENCE',
      flags: 'FLAGS',
      age: 'AGE',
      reviewer: 'REVIEWER',
      action: 'ACTION',
    },
    submitted: '{organisation} · submitted {time}',
    revision: 'Revision',
    none: 'None',
    you: 'You',
    unclaimed: 'Unclaimed',
    taken: 'Taken',
    open: 'Open',
    continue: 'Continue',
    opening: 'Opening…',
    openLabel: '{action} {facility}, {level}',
    flags: {
      toConfirm: '{count} to confirm',
      outlineOpen: 'Outline open',
      finishedEarly: 'Finished early',
      weakWalls: { one: '{count} weak wall', other: '{count} weak walls' },
      simulated: 'Simulated',
      generationFailed: '3D build failed',
    },
    failureReason: '3D build failed: {reason}',
    failureUnknown: 'no reason was recorded',
  },
};

const LOCALES = { en };
let current = 'en';

/** Switches the language for strings asked for from now on. */
export function setLocale(locale) {
  if (LOCALES[locale]) current = locale;
  return current;
}

export function locale() {
  return current;
}

function lookup(dict, key) {
  return key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), dict);
}

function plural(value, count) {
  if (typeof value !== 'object' || value === null) return value;
  const category = new Intl.PluralRules(current).select(count ?? 0);
  return value[category] ?? value.other;
}

/** The string for `key` in the current locale, with `{vars}` filled in. */
export function t(key, vars = {}) {
  let value = lookup(LOCALES[current], key);
  if (value === undefined) value = lookup(en, key);
  if (value === undefined) return key;
  value = plural(value, vars.count);
  if (typeof value !== 'string') return key;
  return value.replace(/\{(\w+)\}/g, (m, name) => (vars[name] === undefined || vars[name] === null ? m : String(vars[name])));
}

/** Test hook: add or replace a locale. */
export function defineLocale(name, dict) {
  LOCALES[name] = dict;
}
