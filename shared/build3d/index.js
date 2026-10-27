/**
 * The 3D level generator's geometry, shared by the backend (which writes it
 * as a GLB) and the web viewer. Owned by the 3D team; the rules it follows
 * are docs/3d-contract.md.
 */
export * from './fittings.js';
export * from './level.js';
export * from './materials.js';
export { cleanRing, MeshBuilder, signedArea } from './mesh.js';
export * from './shell.js';
export * from './spaces.js';
export * from './structure.js';
export * from './textures.js';
export * from './version.js';
export * from './walk.js';
export * from './walls.js';
