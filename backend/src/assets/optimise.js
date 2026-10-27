/**
 * Scale, align and optimise (task L-06): TRELLIS.2's model made ready for
 * the walkthrough. Runs in the backend worker when a GPU job succeeds
 * (outcomes.js), from the GPU's own GLB, which is kept so the model can be
 * made again, turned another way, without the GPU.
 *
 * - **Up** is glTF's +Y, as TRELLIS.2 writes it (it learnt from upright
 *   objects).
 * - **Lined up with the scanned footprint**: X along its width, Z along its
 *   depth (the footprint's own frame on the plan). When the model's long
 *   side runs the other way to the footprint's, it is given a quarter turn.
 * - **The front** cannot be told from the shape. TRELLIS.2's own front is
 *   left wherever the line-up takes it, and flagged: the reviewer turns the
 *   model until its front faces the way the plan says the machine faces
 *   (L-08), and the walkthrough then places it by the footprint's rotation
 *   alone (J-06).
 * - **Turns** are about the up axis, right-handed: a quarter turn takes +Z
 *   to +X.
 * - **Scaled, never stretched**: one factor for all three axes, the one that
 *   fits the scanned width, depth and height best together (the geometric
 *   mean of the three ratios). If any axis is then more than 15 % off, the
 *   model is flagged. A machine with no scanned size is made 1.2 m tall,
 *   flagged. A measured model (L-04) is already in metres and keeps its
 *   size (`keepScale`); it is still checked against the scan and flagged.
 * - **Placed**: standing on y = 0, centred on its footprint, so the
 *   walkthrough puts it at the machine's position and facing as it is.
 * - **Levels of detail**: three, nearest first, as set in
 *   shared/build3d/budget.js (at most 20,000 triangles with 1024 px
 *   textures, 5,000 with 512 px, 1,500 with 256 px). Geometry is
 *   compressed with meshopt, as the levels are.
 * - **Textures** are KTX2 (`textures: 'ktx2'`, the worker's default,
 *   MODEL_TEXTURES; Basis Universal ETC1S with mipmaps, J-08, N-01), or
 *   WebP (this function's own default, and quicker). KTX2 stays compressed
 *   on the graphics card, a quarter to an eighth of the memory WebP takes
 *   once decoded; the web app reads it with a transcoder built without
 *   eval (web/vendor/basis). KTX2 colour is sRGB, the rest (metal and
 *   roughness) linear. Either way the same input gives the same bytes, as
 *   the stored names need.
 *
 * Encoding is slow and holds the thread (tens of seconds for a model), so
 * the worker runs this in a thread of its own (optimise-thread.js).
 */
import { createHash } from 'node:crypto';

import { Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions';
import {
  clearNodeTransform,
  cloneDocument,
  dedup,
  getBounds,
  getTextureColorSpace,
  meshopt,
  prune,
  simplify,
  textureCompress,
  transformMesh,
  weld,
} from '@gltf-transform/functions';
import { encodeToKTX2 } from 'ktx2-encoder';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

import { LEVELS_OF_DETAIL } from '../../../shared/build3d/budget.js';

const quiet = new Logger(Logger.Verbosity.WARN);
const io = new NodeIO()
  .setLogger(quiet)
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

// Shared with the viewer, which switches between them by distance (K-03), and held to the budget (K-04).
export const LODS = LEVELS_OF_DETAIL;
export const MISMATCH_PCT = 15;
export const UNSIZED_HEIGHT_M = 1.2;
/** Sides within this share of each other: the footprint says nothing about which way it runs. */
const SQUARE = 0.1;
/** Simplification gives up shape only this far (a share of the model's size), then further if the budget needs it. */
const ERRORS = [0.001, 0.005, 0.02, 0.1];

/** A texture's pixels, as the KTX2 encoder takes them. */
async function decodeImage(buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

/** Every texture of a document as KTX2 (ETC1S, mipmapped): colour in sRGB, data linear. */
export async function toKtx2(doc) {
  const textures = doc.getRoot().listTextures();
  if (!textures.length) return;
  // One at a time: the encoder is a single WebAssembly instance.
  for (const texture of textures) {
    const colour = getTextureColorSpace(texture) === 'srgb';
    const encoded = await encodeToKTX2(new Uint8Array(texture.getImage()), {
      isUASTC: false,
      qualityLevel: colour ? 160 : 128,
      compressionLevel: 2,
      generateMipmap: true,
      isPerceptual: colour,
      isSetKTX2SRGBTransferFunc: colour,
      imageDecoder: decodeImage,
    });
    texture.setImage(new Uint8Array(encoded)).setMimeType('image/ktx2');
  }
  doc.createExtension(KHRTextureBasisu).setRequired(true);
}

/** Something wrong with the GPU's model itself: making it again will not help. */
export class ModelError extends Error {}

/** Triangles in a document's meshes. */
export function triangleCount(doc) {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue;
      n += Math.floor((prim.getIndices() ?? prim.getAttribute('POSITION')).getCount() / 3);
    }
  }
  return n;
}

const nearly = (a, b) => Math.abs(a - b) / Math.max(a, b) < SQUARE;

/** The quarter turn (0 or 90) that lines the model's long side up with the footprint's. */
export function turnFor([x, , z], box) {
  if (!(box?.w > 0 && box?.d > 0) || nearly(x, z) || nearly(box.w, box.d)) return 0;
  return x >= z === box.w >= box.d ? 0 : 90;
}

/**
 * The one scale for all three axes, the size it gives, how far that is
 * from the scanned size on the worst axis, and what to flag.
 */
export function fit([x, y, z], box, { keepScale = false } = {}) {
  const pairs = [
    [box?.w, x],
    [box?.h, y],
    [box?.d, z],
  ].filter(([want, have]) => want > 0 && have > 0);
  const flags = [];
  let scale;
  let errorPct = null;
  if (!pairs.length) {
    scale = keepScale ? 1 : UNSIZED_HEIGHT_M / y;
    if (!keepScale) flags.push('no_scanned_size');
  } else {
    scale = keepScale ? 1 : Math.exp(pairs.reduce((sum, [want, have]) => sum + Math.log(want / have), 0) / pairs.length);
    errorPct = Math.max(...pairs.map(([want, have]) => (Math.abs(have * scale - want) / want) * 100));
    if (errorPct > MISMATCH_PCT) flags.push('size_mismatch');
  }
  const round = (v) => Math.round(v * 10000) / 10000;
  return { scale, sizeM: { w: round(x * scale), d: round(z * scale), h: round(y * scale) }, errorPct: errorPct === null ? null : Math.round(errorPct * 100) / 100, flags };
}

/** Column-major: move `centre` (footprint middle, floor) to the origin, turn about +Y, then scale. */
export function placement(turnDeg, scale, [cx, floor, cz]) {
  const r = (turnDeg * Math.PI) / 180;
  // Exact for quarter turns, so a turned model has no stray sliver of rotation.
  const c = Math.round(Math.cos(r) * 1e12) / 1e12;
  const s = Math.round(Math.sin(r) * 1e12) / 1e12;
  return [
    scale * c, 0, -scale * s, 0,
    0, scale, 0, 0,
    scale * s, 0, scale * c, 0,
    -scale * (c * cx + s * cz), -scale * floor, -scale * (-s * cx + c * cz), 1,
  ];
}

function preorder(nodes, out = []) {
  for (const node of nodes) {
    out.push(node);
    preorder(node.listChildren(), out);
  }
  return out;
}

/**
 * Makes the walkthrough's model from the GPU's GLB. `box` is the scanned
 * size `{ w, d, h }` (metres, any of them may be missing); `turnDeg` a
 * reviewer's turn (0, 90, 180 or 270), or null to line it up with the box;
 * `keepScale` keeps a measured model's own size; `textures` is 'webp' or 'ktx2'.
 * Returns the levels of detail, nearest first (`glb`, `sha256`, `bytes`,
 * `triangles`, `texture`), with the size, scale error, turn and flags.
 */
export async function optimiseModel(raw, { box = null, turnDeg = null, keepScale = false, textures = 'webp' } = {}) {
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
  let doc;
  try {
    doc = (await io.readBinary(new Uint8Array(raw))).setLogger(quiet);
  } catch (err) {
    throw new ModelError(`it is not a GLB that can be read (${err.message})`);
  }
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene || !triangleCount(doc)) throw new ModelError('it has no triangles');

  // Everything in the scene's own frame: node transforms baked into the meshes, parents first.
  for (const node of preorder(scene.listChildren())) clearNodeTransform(node);
  const { min, max } = getBounds(scene);
  const extents = [0, 1, 2].map((i) => max[i] - min[i]);
  if (extents.some((e) => !(e > 0) || !Number.isFinite(e))) throw new ModelError('it is flat or empty');

  const turn = turnDeg ?? turnFor(extents, box);
  const turned = turn % 180 ? [extents[2], extents[1], extents[0]] : extents;
  const { scale, sizeM, errorPct, flags } = fit(turned, box, { keepScale });
  if (turnDeg === null) flags.push('front_guessed');
  const matrix = placement(turn, scale, [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2]);
  for (const mesh of root.listMeshes()) transformMesh(mesh, matrix);
  await doc.transform(dedup(), prune(), weld());

  const lods = [];
  for (const lod of LODS) {
    const copy = cloneDocument(doc).setLogger(quiet);
    for (const error of ERRORS) {
      const have = triangleCount(copy);
      if (have <= lod.triangles * 1.1) break;
      await copy.transform(simplify({ simplifier: MeshoptSimplifier, ratio: lod.triangles / have, error }));
    }
    if (textures === 'ktx2') {
      // Resized without loss, then compressed once, to KTX2.
      await copy.transform(textureCompress({ encoder: sharp, targetFormat: 'png', resize: [lod.texture, lod.texture] }));
      await toKtx2(copy);
    } else {
      await copy.transform(textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [lod.texture, lod.texture], quality: 85 }));
    }
    await copy.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }));
    const glb = Buffer.from(await io.writeBinary(copy));
    const texture = Math.max(0, ...copy.getRoot().listTextures().map((t) => Math.max(...(t.getSize() ?? [0]))));
    lods.push({
      glb,
      sha256: createHash('sha256').update(glb).digest('hex'),
      bytes: glb.length,
      triangles: triangleCount(copy),
      texture,
    });
  }
  return { lods, sizeM, scaleErrorPct: errorPct, turnDeg: turn, flags };
}

/** A built model's GLB read back (tests, and anything that inspects a stored model). */
export async function readModel(glb) {
  await MeshoptDecoder.ready;
  return io.readBinary(new Uint8Array(glb));
}
