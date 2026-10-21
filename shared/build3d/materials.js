/**
 * The one default finish set (GEN-03): every material the generator uses,
 * as glTF PBR values. No per-customer styling.
 *
 * `color` is linear-space RGB (glTF baseColorFactor), `alpha` below 1 makes
 * the material blended. `texture` names a floor pattern (textures.js): the
 * GLB then carries the pattern, which already holds the colour, and `color`
 * is its average, for anything drawing without textures.
 */
const srgb = (hex) => {
  const c = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return c.map((v) => Math.round(v * 1e6) / 1e6);
};

export const MATERIALS = {
  floor_rubber: { color: srgb(0x3a4146), metallic: 0, roughness: 0.95, texture: 'rubber' },
  floor_timber: { color: srgb(0xa47a52), metallic: 0, roughness: 0.6, texture: 'timber' },
  floor_turf: { color: srgb(0x3f7d3a), metallic: 0, roughness: 1, texture: 'turf' },
  floor_carpet: { color: srgb(0x5b6470), metallic: 0, roughness: 1, texture: 'carpet' },
  floor_tile: { color: srgb(0xc9ccc9), metallic: 0, roughness: 0.45, texture: 'tile' },
  floor_concrete: { color: srgb(0x9a9a96), metallic: 0, roughness: 0.9, texture: 'concrete' },
  ceiling: { color: srgb(0xeef0ef), metallic: 0, roughness: 1 },
  wall_interior: { color: srgb(0xd8dbd9), metallic: 0, roughness: 0.85 },
  wall_exterior: { color: srgb(0xb9bcbb), metallic: 0, roughness: 0.9 },
  glass: { color: srgb(0xcfe3e8), alpha: 0.3, metallic: 0, roughness: 0.05, doubleSided: true },
  door: { color: srgb(0x8d7b68), metallic: 0, roughness: 0.6 },
  metal: { color: srgb(0x8e9396), metallic: 0.7, roughness: 0.4 },
  beam: { color: srgb(0xa9aba8), metallic: 0, roughness: 0.85 },
  roof: { color: srgb(0x6f7477), metallic: 0, roughness: 0.9 },
  ground: { color: srgb(0x9ea39a), metallic: 0, roughness: 1 },
  void: { color: srgb(0x2b2e30), metallic: 0, roughness: 1 },
  mirror: { color: srgb(0xdde3e6), metallic: 1, roughness: 0.03 },
  machine: { color: srgb(0x2f4650), metallic: 0.2, roughness: 0.6 },
  object: { color: srgb(0x56656c), metallic: 0.1, roughness: 0.7 },
  exit_sign: { color: srgb(0x00c260), emissive: srgb(0x00c260).map((c) => c * 0.8), metallic: 0, roughness: 0.5 },
  power_point: { color: srgb(0xffcc00), emissive: srgb(0xffcc00).map((c) => c * 0.4), metallic: 0, roughness: 0.5 },
  zone: { color: srgb(0xfb485b), emissive: srgb(0xfb485b).map((c) => c * 0.5), alpha: 0.22, metallic: 0, roughness: 1, doubleSided: true },
};

/** The floor finish a space of this kind gets when none was set (docs/3d-contract.md). */
export const DEFAULT_FINISH_BY_KIND = {
  gym_floor: 'rubber',
  studio: 'timber',
  changing: 'tile',
  reception: 'tile',
  office: 'carpet',
  corridor: 'tile',
  storage: 'concrete',
  other: 'concrete',
};

export function floorMaterial(finish) {
  const key = `floor_${finish}`;
  return MATERIALS[key] ? key : 'floor_concrete';
}
