/**
 * The walkthrough's performance budget (task K-04, VIEW-09): the first view
 * in under 8 s on a 25 Mbps line, and 30 frames a second on a 2022
 * mid-range laptop and a 2021 iPad.
 *
 * Load time is worked out from what has to arrive before the first frame:
 * the app's JavaScript (gzipped), the level's GLB, and with machine models
 * the KTX2 transcoder and the farthest level of detail of each model
 * (nearer ones load as you walk up, K-03), plus a fixed allowance for the
 * browser to start, parse and draw (measured at 1.3 to 1.4 s in Chrome on
 * an Intel UHD laptop, K-04).
 *
 * Frame rate cannot be measured without a GPU, so it is held by what is
 * drawn at worst: the level, and every machine at the detail its distance
 * from you calls for, standing where the machines are thickest. A 2022
 * mid-range laptop's integrated GPU draws this comfortably at 30 fps; the
 * walkthrough ran at 60 (the screen's limit) with the 2,400 m² test gym
 * and 400 machine boxes.
 *
 * Checked by the backend's tests (levels and machine models, test/budget)
 * and the web build (its JavaScript, web/scripts/budget.mjs), both of
 * which the deploy pipeline runs.
 */
export const BUDGET = Object.freeze({
  mbps: 25,
  firstViewS: 8,
  // Start, parse, upload and first frame, on top of the download.
  allowanceS: 2.5,
  // The app's JavaScript for the walkthrough, gzipped.
  scriptKB: 400,
  // The KTX2 transcoder (three.js's Basis Universal build, gzipped): fetched
  // with the first machine model, whose textures it decodes (N-01).
  transcoderKB: 310,
  // Drawn at worst, for 30 fps on the target devices.
  triangles: 2_000_000,
  drawCalls: 1_500,
});

/**
 * A machine model's levels of detail (L-06 makes them, K-03 shows them):
 * nearest first, each at most so many triangles with textures at most so
 * many pixels, shown from so many metres away. Set so a gym packed with
 * machines (one every 4 m², as the 2,400 m² test gym is) stays within
 * BUDGET.triangles wherever you stand: about 20 machines are within 5 m
 * of you there, 90 more within 12 m, and the rest beyond.
 */
export const LEVELS_OF_DETAIL = Object.freeze([
  Object.freeze({ triangles: 20_000, texture: 1024, fromM: 0 }),
  Object.freeze({ triangles: 5_000, texture: 512, fromM: 5 }),
  Object.freeze({ triangles: 1_500, texture: 256, fromM: 12 }),
]);

/** Seconds to the first view for this many bytes to download. */
export function firstViewSeconds(bytes, { mbps = BUDGET.mbps, allowanceS = BUDGET.allowanceS } = {}) {
  return (bytes * 8) / (mbps * 1e6) + allowanceS;
}

/** What may be downloaded besides the JavaScript, in bytes, within the first-view budget. */
export function sceneBytesAllowed({ scriptBytes = BUDGET.scriptKB * 1024 } = {}) {
  return ((BUDGET.firstViewS - BUDGET.allowanceS) * BUDGET.mbps * 1e6) / 8 - scriptBytes;
}
