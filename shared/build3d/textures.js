/**
 * The floor finishes' textures (task J-05): one tile of each pattern, a
 * metre square, as plain pixels. The level's texture coordinates are in
 * metres, so each tile repeats once a metre and the joints show true
 * scale, which gives walking its sense of pace. The same name always gives
 * the same pixels (GEN-01).
 *
 * Pixels are sRGB, three bytes each, row by row; the GLB writer packs them.
 */

/** Pixels per metre. */
export const TEXTURE_SIZE = 256;

const hex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const shade = (rgb, k) => rgb.map((c) => Math.max(0, Math.min(255, Math.round(c * k))));

/** `count` lines across a metre, `width` pixels wide, starting at `offset` pixels. */
const onLine = (px, count, width, offset = 0) => (((px - offset) % (TEXTURE_SIZE / count)) + TEXTURE_SIZE) % (TEXTURE_SIZE / count) < width;

/** What colour each pixel is, by pattern. */
const PATTERNS = {
  // Interlocking rubber tiles, a metre square.
  rubber: (x, y) => (onLine(x, 1, 3) || onLine(y, 1, 3) ? hex(0x4b5358) : hex(0x3a4146)),

  // Boards 12.5 cm wide along the room's x, each with its own tone and its
  // end joints staggered from its neighbours'.
  timber: (x, y) => {
    const board = Math.floor(y / (TEXTURE_SIZE / 8));
    const base = shade(hex(0xa47a52), [1, 0.94, 1.05, 0.97, 1.02, 0.92, 1.07, 0.99][board]);
    const joint = Math.round(((board * 3) % 8) * (TEXTURE_SIZE / 8));
    if (onLine(y, 8, 2) || onLine(x, 1, 2, joint)) return shade(base, 0.72);
    return base;
  },

  // Half-metre tiles with grout.
  tile: (x, y) => (onLine(x, 2, 3) || onLine(y, 2, 3) ? hex(0xa9adaa) : hex(0xc9ccc9)),

  // Half-metre carpet tiles, laid quarter-turned, so the seams barely show.
  carpet: (x, y) => {
    const turned = (Math.floor(x / (TEXTURE_SIZE / 2)) + Math.floor(y / (TEXTURE_SIZE / 2))) % 2;
    if (onLine(x, 2, 1) || onLine(y, 2, 1)) return hex(0x535b66);
    return turned ? hex(0x5f6874) : hex(0x5b6470);
  },

  // Mown stripes half a metre wide.
  turf: (x) => (Math.floor(x / (TEXTURE_SIZE / 2)) % 2 ? hex(0x447f3e) : hex(0x3c7636)),

  // Saw-cut joints a metre apart.
  concrete: (x, y) => (onLine(x, 1, 2) || onLine(y, 1, 2) ? hex(0x8a8a86) : hex(0x9a9a96)),
};

export const TEXTURE_NAMES = Object.keys(PATTERNS);

/** One metre of a pattern: `{ width, height, rgb }`, where `rgb` is a Uint8Array. */
export function floorTexture(name) {
  const pattern = PATTERNS[name];
  if (!pattern) throw new Error(`Unknown texture ${name}`);
  const rgb = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 3);
  for (let y = 0; y < TEXTURE_SIZE; y++) {
    for (let x = 0; x < TEXTURE_SIZE; x++) rgb.set(pattern(x, y), (y * TEXTURE_SIZE + x) * 3);
  }
  return { width: TEXTURE_SIZE, height: TEXTURE_SIZE, rgb };
}
