/**
 * The 3D generator's version. Bump it whenever the same plan would come out
 * differently, so levels stored by the old generator are rebuilt rather than
 * reused (GEN-01: the stored model is keyed by plan hash and this version).
 */
export const BUILD3D_VERSION = 1;

/** The `generated_models.generator_version` this generator writes. */
export const GENERATOR_VERSION = `build3d-${BUILD3D_VERSION}`;
