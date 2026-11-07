/**
 * Finishes for the walkthrough drawn from the plan: floors by each room's
 * finish, machines coloured by kind. Textures are drawn on a canvas (one
 * texture is one metre square), so nothing is downloaded, and from a fixed
 * seed, so the same plan always looks the same.
 */

/** What a room's floor is when the reviewer has not set its finish. */
export const FINISH_FOR_KIND = {
  gym_floor: 'rubber',
  studio: 'timber',
  changing: 'tile',
  reception: 'tile',
  office: 'carpet',
  corridor: 'tile',
  storage: 'concrete',
  other: 'concrete',
};

/** The finish to draw a room's floor in. */
export function finishOf(space) {
  return space?.finish ?? FINISH_FOR_KIND[space?.kind] ?? 'rubber';
}

/** Base colour and roughness of each finish, for lighting it believably. */
export const FINISHES = {
  rubber: { base: '#2b2e30', roughness: 0.95 },
  timber: { base: '#a8794b', roughness: 0.6 },
  turf: { base: '#3c7a37', roughness: 1 },
  carpet: { base: '#4a5563', roughness: 1 },
  tile: { base: '#d8d4cc', roughness: 0.35 },
  concrete: { base: '#8e9192', roughness: 0.85 },
};

/** A small fixed-seed random, so a texture is the same every time. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const shade = (hex, k) => {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${c(n >> 16)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`;
};

/** Speckles of `colours` over the whole square: rubber flecks, carpet pile, concrete. */
function speckle(ctx, size, rnd, count, colours, r) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colours[Math.floor(rnd() * colours.length)];
    ctx.fillRect(rnd() * size, rnd() * size, r, r);
  }
}

/**
 * Draws a finish on a 2D canvas context of `size` pixels (one metre).
 * Exported so it can be checked without WebGL.
 */
export function paintFinish(ctx, size, finish) {
  const f = FINISHES[finish] ?? FINISHES.rubber;
  const rnd = seeded(finish.length * 7919 + size);
  ctx.fillStyle = f.base;
  ctx.fillRect(0, 0, size, size);

  if (finish === 'rubber') {
    // Gym rubber: EPDM flecks in 1 m tiles.
    speckle(ctx, size, rnd, size * 6, ['#3b3f42', '#45494c', '#1f2123', '#5b6064'], 2);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, size - 2, size - 2);
  } else if (finish === 'timber') {
    // Sprung floor boards, 125 mm wide, each its own tone, joints staggered.
    const boards = 8;
    const h = size / boards;
    for (let i = 0; i < boards; i++) {
      ctx.fillStyle = shade(f.base, 0.85 + rnd() * 0.3);
      ctx.fillRect(0, i * h, size, h);
      ctx.strokeStyle = 'rgba(60, 35, 15, 0.25)';
      ctx.lineWidth = 1;
      for (let g = 0; g < 4; g++) {
        const y = i * h + rnd() * h;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(size * 0.3, y + rnd() * 3 - 1.5, size * 0.6, y + rnd() * 3 - 1.5, size, y);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(40, 22, 8, 0.6)';
      ctx.fillRect(0, i * h, size, 1.5);
      ctx.fillRect(((i * 0.37) % 1) * size, i * h, 1.5, h);
    }
  } else if (finish === 'turf') {
    speckle(ctx, size, rnd, size * 10, ['#478a41', '#356e31', '#2e6129', '#56a04f'], 1.5);
  } else if (finish === 'carpet') {
    speckle(ctx, size, rnd, size * 12, ['#525e6d', '#424c59', '#5c6878'], 1);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, size / 2 - 1, size / 2 - 1);
    ctx.strokeRect(size / 2 + 0.5, size / 2 + 0.5, size / 2 - 1, size / 2 - 1);
  } else if (finish === 'tile') {
    // 500 mm tiles with grout.
    const n = 2;
    const t = size / n;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        ctx.fillStyle = shade(f.base, 0.95 + rnd() * 0.08);
        ctx.fillRect(i * t, j * t, t, t);
      }
    }
    ctx.strokeStyle = '#a9a59c';
    ctx.lineWidth = 3;
    for (let i = 0; i <= n; i++) {
      ctx.beginPath();
      ctx.moveTo(i * t, 0);
      ctx.lineTo(i * t, size);
      ctx.moveTo(0, i * t);
      ctx.lineTo(size, i * t);
      ctx.stroke();
    }
  } else {
    speckle(ctx, size, rnd, size * 4, ['#9a9d9e', '#808384', '#a5a8a9', '#76797a'], 3);
  }
}

/** How each kind of machine is coloured: frame and finish. */
const MACHINE_COLOURS = {
  cardio: 0x5a6168,
  strength: 0x33373d,
  rack: 0x3a3f45,
  bench: 0x26282b,
  platform: 0x6b4e33,
  turf: 0x2f6b34,
  mat: 0x3d5a73,
  other: 0x5d6368,
  object: 0x6b6f72,
};

const KIND_OF_TYPE = {
  treadmill: 'cardio',
  exerciseBike: 'cardio',
  elliptical: 'cardio',
  rowingMachine: 'cardio',
  stairClimber: 'cardio',
  legPress: 'strength',
  chestPress: 'strength',
  shoulderPress: 'strength',
  latPulldown: 'strength',
  seatedRow: 'strength',
  legExtension: 'strength',
  legCurl: 'strength',
  cableMachine: 'strength',
  smithMachine: 'strength',
  squatRack: 'rack',
  dumbbellRack: 'rack',
  plateTree: 'rack',
  kettlebellRack: 'rack',
  rig: 'rack',
  bench: 'bench',
  plyoBox: 'bench',
  liftingPlatform: 'platform',
  turfLane: 'turf',
  stretchArea: 'mat',
};

/** The colour (0xrrggbb) a machine or object is drawn in. */
export function machineColour(object) {
  if (!object?.type) return MACHINE_COLOURS.object;
  return MACHINE_COLOURS[KIND_OF_TYPE[object.type] ?? 'other'];
}
