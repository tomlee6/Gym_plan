/**
 * A stand-in for TRELLIS.2's own GLB (what the GPU worker writes before
 * L-06): a dense box with a bump at its front (+Z), in TRELLIS.2's unit
 * cube, under a node transform, with 2048 px WebP base colour and
 * metal/rough textures and vertex normals, as trimesh exports it.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import sharp from 'sharp';

/** A grid of `n` x `n` squares on one face of a box, as two triangles each. */
function face(out, origin, u, v, normal, n) {
  const base = out.positions.length / 3;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const a = i / n;
      const b = j / n;
      out.positions.push(origin[0] + u[0] * a + v[0] * b, origin[1] + u[1] * a + v[1] * b, origin[2] + u[2] * a + v[2] * b);
      out.normals.push(...normal);
      out.uvs.push(a, b);
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const p = base + j * (n + 1) + i;
      out.indices.push(p, p + 1, p + n + 2, p, p + n + 2, p + n + 1);
    }
  }
}

/** A box from `min` to `max`, each face an `n` x `n` grid, wound outwards. */
function box(out, min, max, n) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  face(out, [x0, y0, z1], [dx, 0, 0], [0, dy, 0], [0, 0, 1], n); // +Z
  face(out, [x1, y0, z0], [-dx, 0, 0], [0, dy, 0], [0, 0, -1], n); // -Z
  face(out, [x1, y0, z1], [0, 0, -dz], [0, dy, 0], [1, 0, 0], n); // +X
  face(out, [x0, y0, z0], [0, 0, dz], [0, dy, 0], [-1, 0, 0], n); // -X
  face(out, [x0, y1, z1], [dx, 0, 0], [0, 0, -dz], [0, 1, 0], n); // +Y
  face(out, [x0, y0, z0], [dx, 0, 0], [0, 0, dz], [0, -1, 0], n); // -Y
}

async function webp(size, seed) {
  const pixels = Buffer.alloc(size * size * 4);
  let x = seed;
  for (let i = 0; i < pixels.length; i += 4) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    pixels[i] = x & 255;
    pixels[i + 1] = (x >> 8) & 255;
    pixels[i + 2] = (x >> 16) & 255;
    pixels[i + 3] = 255;
  }
  return sharp(pixels, { raw: { width: size, height: size, channels: 4 } }).webp({ quality: 80 }).toBuffer();
}

/**
 * The model: a body `extents` big (x, y, z), long along X by default, with
 * a small bump on its +Z face so its front can be found, the body dense
 * enough to need simplifying (`grid` squares a side per face).
 */
export async function rawModel({ extents = [0.9, 0.62, 0.36], grid = 96, texture = 2048 } = {}) {
  const doc = new Document();
  doc.createExtension(EXTTextureWebP).setRequired(true);
  const buffer = doc.createBuffer();
  const out = { positions: [], normals: [], uvs: [], indices: [] };
  const [ex, ey, ez] = extents;
  // Centred in TRELLIS.2's cube, sitting a little off the middle.
  box(out, [-ex / 2, -ey / 2, -ez / 2], [ex / 2, ey / 2, ez / 2], grid);
  // The front: a bump in the middle of the +Z face.
  box(out, [-ex / 8, -ey / 8, ez / 2], [ex / 8, ey / 8, ez / 2 + ez / 6], 4);

  const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', accessor('VEC3', new Float32Array(out.positions)))
    .setAttribute('NORMAL', accessor('VEC3', new Float32Array(out.normals)))
    .setAttribute('TEXCOORD_0', accessor('VEC2', new Float32Array(out.uvs)))
    .setIndices(accessor('SCALAR', new Uint32Array(out.indices)));
  const material = doc
    .createMaterial('trellis')
    .setBaseColorTexture(doc.createTexture('base').setImage(await webp(texture, 1)).setMimeType('image/webp'))
    .setMetallicRoughnessTexture(doc.createTexture('mr').setImage(await webp(texture, 2)).setMimeType('image/webp'));
  prim.setMaterial(material);
  const mesh = doc.createMesh('model').addPrimitive(prim);
  // trimesh writes a node; give it a transform the optimiser must bake in.
  const node = doc.createNode('model').setMesh(mesh).setTranslation([0.05, 0.02, -0.03]);
  doc.createScene('scene').addChild(node);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  return Buffer.from(await io.writeBinary(doc));
}
