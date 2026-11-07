/**
 * The gym equipment library: standard machines with typical footprints,
 * for planning a fit-out by placing equipment on a plan, rather than only
 * naming what a scan found.
 *
 * Sizes are typical of commercial equipment of each kind, not any one
 * maker's model: a planner swaps in the exact size once the model is
 * chosen. `clearance` is the free floor each needs to be used safely: 0.6 m
 * all round is the usual training-area allowance (as in ISO 20957-1), and a
 * treadmill needs a clear run-off behind it (2 m, as in ISO 20957-6).
 *
 * `type` is the plan's equipment type, so a placed machine reads like any
 * other: a type outside `EQUIPMENT_TYPES` is fine, the list is open.
 */

/** Library groups, in the order the editor lists them. */
export const LIBRARY_CATEGORIES = ['Cardio', 'Strength', 'Free weights', 'Functional', 'Studio & recovery'];

const AROUND = 0.6;

/** One library entry: `key` is stable, so a plan can say where a machine came from. */
const item = (key, category, name, type, widthM, depthM, heightM, clearance = {}) => ({
  key,
  category,
  name,
  type,
  widthM,
  depthM,
  heightM,
  clearance: { aroundM: AROUND, behindM: AROUND, ...clearance },
});

export const EQUIPMENT_LIBRARY = [
  item('treadmill', 'Cardio', 'Treadmill', 'treadmill', 0.9, 2.1, 1.6, { behindM: 2 }),
  item('upright-bike', 'Cardio', 'Upright bike', 'exerciseBike', 0.6, 1.1, 1.4),
  item('recumbent-bike', 'Cardio', 'Recumbent bike', 'exerciseBike', 0.7, 1.6, 1.3),
  item('spin-bike', 'Cardio', 'Spin bike', 'exerciseBike', 0.55, 1.2, 1.2),
  item('cross-trainer', 'Cardio', 'Cross-trainer', 'elliptical', 0.75, 2.0, 1.7),
  item('rower', 'Cardio', 'Rowing machine', 'rowingMachine', 0.6, 2.4, 1.0),
  item('stair-climber', 'Cardio', 'Stair climber', 'stairClimber', 0.9, 1.5, 2.0),
  item('air-bike', 'Cardio', 'Air bike', 'exerciseBike', 0.65, 1.3, 1.3),

  item('chest-press', 'Strength', 'Chest press', 'chestPress', 1.3, 1.5, 1.6),
  item('shoulder-press', 'Strength', 'Shoulder press', 'shoulderPress', 1.3, 1.4, 1.6),
  item('lat-pulldown', 'Strength', 'Lat pulldown', 'latPulldown', 1.3, 1.6, 2.2),
  item('seated-row', 'Strength', 'Seated row', 'seatedRow', 1.2, 1.9, 1.9),
  item('leg-press', 'Strength', 'Leg press', 'legPress', 1.6, 2.3, 1.5),
  item('leg-extension', 'Strength', 'Leg extension', 'legExtension', 1.2, 1.4, 1.5),
  item('leg-curl', 'Strength', 'Leg curl', 'legCurl', 1.2, 1.6, 1.5),
  item('cable-crossover', 'Strength', 'Cable crossover', 'cableMachine', 4.0, 1.0, 2.3),
  item('functional-trainer', 'Strength', 'Functional trainer', 'cableMachine', 1.6, 1.2, 2.2),
  item('smith-machine', 'Strength', 'Smith machine', 'smithMachine', 2.2, 1.6, 2.3),

  item('power-rack', 'Free weights', 'Power rack', 'squatRack', 1.7, 1.9, 2.4),
  item('half-rack', 'Free weights', 'Half rack', 'squatRack', 1.6, 1.8, 2.3),
  item('flat-bench', 'Free weights', 'Flat bench', 'bench', 0.6, 1.3, 0.45),
  item('adjustable-bench', 'Free weights', 'Adjustable bench', 'bench', 0.7, 1.4, 0.5),
  item('dumbbell-rack', 'Free weights', 'Dumbbell rack, 10 pairs', 'dumbbellRack', 2.4, 0.8, 0.9),
  item('plate-tree', 'Free weights', 'Plate tree', 'plateTree', 0.7, 0.7, 1.2),
  item('lifting-platform', 'Free weights', 'Lifting platform', 'liftingPlatform', 3.0, 2.4, 0.05, { aroundM: 1 }),

  item('rig-4m', 'Functional', 'Functional rig, 4 m', 'rig', 4.0, 1.8, 2.7, { aroundM: 1 }),
  item('kettlebell-rack', 'Functional', 'Kettlebell rack', 'kettlebellRack', 1.2, 0.6, 0.9),
  item('turf-lane', 'Functional', 'Turf sled lane, 10 m', 'turfLane', 2.0, 10.0, 0.02, { aroundM: 0.3, behindM: 0.3 }),
  item('box-stack', 'Functional', 'Plyo box stack', 'plyoBox', 0.9, 0.8, 0.8),

  item('stretch-mat', 'Studio & recovery', 'Stretch mat', 'stretchArea', 1.0, 2.0, 0.02, { aroundM: 0.3, behindM: 0.3 }),
  item('massage-chair', 'Studio & recovery', 'Recovery chair', 'recoveryChair', 0.8, 1.6, 1.2),
  item('water-fountain', 'Studio & recovery', 'Water fountain', 'waterFountain', 0.5, 0.5, 1.1, { aroundM: 0.5, behindM: 0 }),
];

/** A library entry by its key, or null. */
export function libraryItem(key) {
  return EQUIPMENT_LIBRARY.find((i) => i.key === key) ?? null;
}

/** Entries whose name, key, type, group, maker or model code contains every word of `query`. */
export function searchLibrary(query, library = EQUIPMENT_LIBRARY) {
  const words = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return library;
  return library.filter((i) => {
    const text = `${i.name} ${i.key} ${i.type} ${i.category} ${i.manufacturer?.name ?? ''} ${i.modelCode ?? ''}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/**
 * A reference for a machine placed from the library ("LIB-001"), unused by
 * the plan and by any machine recorded on the phone, so it can never be
 * mistaken for one (and pick up its video).
 */
export function nextLibraryId(plan, recorded = []) {
  const used = new Set([
    ...(plan.objects ?? []).map((o) => o.equipment?.equipmentId),
    ...(recorded ?? []).map((e) => e.equipmentId),
  ]);
  for (let n = 1; n <= 9999; n++) {
    const id = `LIB-${String(n).padStart(3, '0')}`;
    if (!used.has(id)) return id;
  }
  return `LIB-${Date.now().toString(36)}`;
}

/** A library entry as the editor places it: what `placeEquipment` takes. */
export function libraryPlacement(entry, plan, recorded = []) {
  return {
    equipmentId: nextLibraryId(plan, recorded),
    type: entry.type,
    name: entry.name,
    widthM: entry.widthM,
    depthM: entry.depthM,
    heightM: entry.heightM,
    libraryKey: entry.libraryKey ?? entry.key,
    // The entry as the editor lists it (its row id, for the database's).
    entryKey: entry.key,
  };
}

/**
 * The free floor a machine of `type` needs: from the library in use (the
 * database's, when the editor has it), a generic entry first, or the usual
 * 0.6 m all round.
 */
export function clearanceFor(type, library = EQUIPMENT_LIBRARY) {
  const entry = library.find((i) => i.type === type && !i.manufacturer) ?? library.find((i) => i.type === type);
  return entry ? entry.clearance : { aroundM: 0.6, behindM: 0.6 };
}
