/**
 * Writes a level from shared/build3d as a binary glTF (GLB) (J-01, J-08).
 *
 * One glTF node per level part (floors, walls, ...) so the viewer can show,
 * hide or pick them, one primitive per material. The geometry is welded and
 * meshopt-compressed (EXT_meshopt_compression, which three.js decodes with
 * its MeshoptDecoder), positions quantised to 16 bits over the whole level:
 * about 1.5 mm on a 100 m building, the same for every part, so parts that
 * meet stay sealed. The scene's extras carry what the viewer needs besides
 * the picture: where the walker cannot go and where the walk starts.
 *
 * The file carries no timestamp: the same level always gives the same bytes
 * (GEN-01).
 */
import { Document, Logger, NodeIO, TextureInfo } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { meshopt, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

import { floorTexture } from '../../../shared/build3d/index.js';
import { encodePng } from './png.js';

const io = new NodeIO()
  .setLogger(new Logger(Logger.Verbosity.ERROR))
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

/**
 * `level` is the output of `buildLevel`; `meta` is recorded in the scene's
 * extras: `{ generatorVersion, contentHash }`. `compress: false` leaves the
 * geometry as plain floats, for looking at the file by eye. Returns the GLB
 * as a Uint8Array.
 */
export async function toGlb(level, { generatorVersion, contentHash }, { compress = true } = {}) {
  // Errors only: the transforms otherwise log a line per mesh into the worker's logs.
  const doc = new Document().setLogger(new Logger(Logger.Verbosity.ERROR));
  doc.getRoot().getAsset().generator = `Flex Gym build3d ${generatorVersion}`;
  const buffer = doc.createBuffer('level');

  const materials = new Map();
  for (const [key, m] of Object.entries(level.materials)) {
    const alpha = m.alpha ?? 1;
    const material = doc
      .createMaterial(key)
      .setBaseColorFactor([...m.color, alpha])
      .setMetallicFactor(m.metallic ?? 0)
      .setRoughnessFactor(m.roughness ?? 1)
      .setDoubleSided(Boolean(m.doubleSided))
      .setAlphaMode(alpha < 1 ? 'BLEND' : 'OPAQUE');
    if (m.emissive) material.setEmissiveFactor(m.emissive.map((c) => Math.round(c * 1e6) / 1e6));
    if (m.texture) {
      // The pattern carries the colour, a metre a tile (texture coordinates are in metres).
      const image = doc.createTexture(m.texture).setImage(encodePng(floorTexture(m.texture))).setMimeType('image/png');
      material.setBaseColorFactor([1, 1, 1, alpha]).setBaseColorTexture(image);
      material
        .getBaseColorTextureInfo()
        .setWrapS(TextureInfo.WrapMode.REPEAT)
        .setWrapT(TextureInfo.WrapMode.REPEAT)
        .setMagFilter(TextureInfo.MagFilter.LINEAR)
        .setMinFilter(TextureInfo.MinFilter.LINEAR_MIPMAP_LINEAR);
    }
    materials.set(key, material);
  }

  const scene = doc.createScene('level');
  for (const part of level.nodes) {
    const mesh = doc.createMesh(part.name);
    for (const p of part.primitives) {
      const count = p.positions.length / 3;
      const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
      const primitive = doc
        .createPrimitive()
        .setAttribute('POSITION', accessor('VEC3', new Float32Array(p.positions)))
        .setAttribute('NORMAL', accessor('VEC3', new Float32Array(p.normals)))
        .setAttribute('TEXCOORD_0', accessor('VEC2', new Float32Array(p.uvs)))
        .setIndices(accessor('SCALAR', count > 65535 ? new Uint32Array(p.indices) : new Uint16Array(p.indices)))
        .setMaterial(materials.get(p.material));
      mesh.addPrimitive(primitive);
    }
    scene.addChild(doc.createNode(part.name).setMesh(mesh));
  }

  scene.setExtras({
    generator: 'build3d',
    generatorVersion,
    contentHash: contentHash ?? null,
    bounds: level.bounds,
    stats: level.stats,
    defaultsUsed: level.defaultsUsed,
    skipped: level.skipped ?? [],
    walk: level.walk ?? null,
  });
  doc.getRoot().setDefaultScene(scene);

  if (compress) {
    await MeshoptEncoder.ready;
    await doc.transform(
      weld(),
      meshopt({ encoder: MeshoptEncoder, level: 'high', quantizationVolume: 'scene', quantizePosition: 16, quantizeTexcoord: 16 }),
    );
  }
  return io.writeBinary(doc);
}

/** Reads a GLB this module wrote (compressed or not) back into a glTF-Transform document. */
export async function readGlb(bytes) {
  await MeshoptDecoder.ready;
  return io.readBinary(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}
