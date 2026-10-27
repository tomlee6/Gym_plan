/**
 * The 3D level generator (task J-01): what plan.generate runs when
 * GENERATOR_DRIVER=glb. Builds the level from the approved plan
 * (shared/build3d), writes it as a GLB to the models store, and hands the
 * key back to the job, which records it in generated_models.
 *
 * Importing this module installs the generator, the same way handlers.js
 * registers the job handlers: app.js and worker.js both import it.
 *
 * The stored key is the plan's content hash plus the generator version, so
 * running the job again for the same approved plan rewrites the same object
 * with the same bytes (GEN-01), and a new generator version never overwrites
 * an older version's file.
 */
import { Build3dError, buildLevel } from '../../../shared/build3d/index.js';
import { config } from '../config.js';
import { setGenerator } from '../jobs/handlers.js';
import { PermanentJobError } from '../jobs/index.js';
import { modelStorage } from '../storage/index.js';
import { toGlb } from './glb.js';

/** Where a version's level is stored. Under the account, so account removal finds it. */
export function levelKey(v, generatorVersion = config.generator.version) {
  return `models/accounts/${v.account_id}/levels/${v.content_hash}/${generatorVersion}.glb`;
}

/** Another error's message, short enough that the reason's code survives the queue's 500-character limit. */
const gist = (err) => String(err?.message ?? err).slice(0, 200);

/**
 * A generation that cannot succeed as things stand (J-09). The job fails
 * for good and the plan goes back to the reviewer queue (GEN-05), which
 * shows the message. The message says what went wrong and what to do; the
 * code in brackets at its end is the machine reason, for reports and alerts.
 */
export class GenerationError extends PermanentJobError {
  constructor(code, message) {
    super(`${message} [${code}]`);
    this.code = code;
  }
}

/**
 * Builds and stores the level for an approved version row (`id`,
 * `plan_json`, `content_hash`, `account_id`). Returns `{ glbKey, bytes,
 * triangleCount }`.
 *
 * Building is deterministic, so a plan that fails once fails every time:
 * any build failure is a GenerationError, never retried. Only saving the
 * file, which can fail for a moment, is left to the job's retries.
 */
export async function generateLevel(
  v,
  { store = modelStorage(), generatorVersion = config.generator.version, maxBytes = config.generator.maxBytes } = {},
) {
  if (!v?.plan_json) throw new GenerationError('no_plan', 'The approved version has no plan to build. Tell the 3D team.');
  if (!v.content_hash) throw new GenerationError('no_plan', 'The approved version has no content hash. Tell the 3D team.');

  let level;
  let glb;
  try {
    level = buildLevel(v.plan_json);
    glb = await toGlb(level, { generatorVersion, contentHash: v.content_hash });
  } catch (err) {
    if (err instanceof Build3dError) throw new GenerationError(err.code, err.message);
    // A bug, not the plan's fault: the team needs the whole story, the reviewer the gist.
    console.error(`3D build of plan version ${v.id} failed:`, err);
    throw new GenerationError(
      'build_error',
      `The 3D build hit a problem it cannot get past (${gist(err)}). Tell the 3D team; changing the plan may get round it.`,
    );
  }

  // Over budget, the viewer would be too slow to load on a phone: refuse rather than store it.
  if (glb.byteLength > maxBytes) {
    const mb = (n) => (n / (1024 * 1024)).toFixed(1);
    throw new GenerationError(
      'too_large',
      `The model is ${mb(glb.byteLength)} MB, over the ${mb(maxBytes)} MB limit for one level. Tell the 3D team.`,
    );
  }

  const glbKey = levelKey(v, generatorVersion);
  try {
    await store.write(glbKey, glb, { contentType: 'model/gltf-binary' });
  } catch (err) {
    // Retried by the job; this is the reason shown if every retry fails.
    throw new Error(`The model could not be saved to storage (${gist(err)}). [store_failed]`);
  }
  return { glbKey, bytes: glb.byteLength, triangleCount: level.stats.triangles };
}

if (config.generator.driver === 'glb') {
  setGenerator((v) => generateLevel(v));
}
