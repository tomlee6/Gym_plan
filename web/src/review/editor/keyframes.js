/**
 * Keyframes: the still photos the phone kept while scanning (H-03).
 *
 * `keyframes.json` lists each frame with its camera pose: `transform` is a
 * 4×4 camera-to-world matrix in column-major order, in the plan's frame
 * (x across, y up, z the plan's y). For a machine the reviewer selects,
 * the frames whose camera was near it and pointing at it are the quickest
 * way to see what it really is, without scrubbing through a whole video.
 */

/** Where a frame's camera stood on the plan, and which way it looked (unit vector). */
export function cameraPose(transform) {
  if (!Array.isArray(transform) || transform.length !== 16) return null;
  // Translation is the last column; the camera looks down its own -Z axis,
  // which is the third column negated. Height is dropped: the plan is flat.
  const position = [transform[12], transform[14]];
  const fx = -transform[8];
  const fy = -transform[10];
  const len = Math.hypot(fx, fy);
  if (!Number.isFinite(position[0]) || !Number.isFinite(position[1])) return null;
  // A camera pointing straight at the floor or ceiling has no heading.
  const forward = len > 1e-6 ? [fx / len, fy / len] : null;
  return { position, forward };
}

/** The frames list from a parsed keyframes.json, keeping only usable entries. */
export function readKeyframes(json) {
  const frames = Array.isArray(json?.frames) ? json.frames : [];
  return frames.filter((f) => f && f.file && cameraPose(f.transform));
}

/**
 * The frames that see `object`: its centre within `maxDistanceM` of the
 * camera and inside the camera's view, taken as `halfAngleDeg` either side
 * of where it pointed (a phone's camera is roughly 60° across, so 60° is
 * generous enough for a machine at the edge of the frame). Nearest first,
 * at most `limit`.
 */
export function keyframesSeeing(frames, object, { maxDistanceM = 8, limit = 6, halfAngleDeg = 60 } = {}) {
  if (!object || !Array.isArray(frames)) return [];
  const cosLimit = Math.cos((halfAngleDeg * Math.PI) / 180);
  const seen = [];
  for (const frame of frames) {
    const pose = cameraPose(frame.transform);
    if (!pose?.forward) continue;
    const to = [object.x - pose.position[0], object.y - pose.position[1]];
    const distanceM = Math.hypot(to[0], to[1]);
    if (distanceM > maxDistanceM) continue;
    // Standing on top of it counts as seeing it.
    if (distanceM > 0.05) {
      const cos = (to[0] * pose.forward[0] + to[1] * pose.forward[1]) / distanceM;
      if (cos < cosLimit) continue;
    }
    seen.push({ frame, distanceM });
  }
  seen.sort((a, b) => a.distanceM - b.distanceM);
  return seen.slice(0, limit);
}

/** The keyframes.json file of a version, if any. */
export function keyframesIndexFile(files = []) {
  return files.find((f) => f.kind === 'keyframes' && f.name === 'keyframes.json' && f.url) ?? null;
}

/** The signed URL of a frame's image, named `keyframes/<file>` in the version's files. */
export function keyframeUrl(files = [], frame) {
  const name = `keyframes/${frame.file}`;
  return files.find((f) => f.name === name)?.url ?? null;
}
