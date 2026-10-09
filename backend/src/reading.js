/**
 * Plan reading for a received capture (PRD section 6), as the scan.read and
 * drawing.read jobs run it (E-03).
 *
 * A room file that cannot be read yields an empty plan and a flag, never a
 * failed capture: the reviewer can still trace or reject it.
 */
import { newElementId, parseObjVertices, planFromScan, planFromUpload } from '../../shared/plan/index.js';
import { many, one } from './db/pool.js';
import { equipmentForPlan } from './modules/equipment.js';
import { storage } from './storage/index.js';

/** A mesh this big is not one floor of a gym; reading it would only stall the worker. */
const MAX_MESH_BYTES = 300 * 1024 * 1024;

const num = (v) => (v === null || v === undefined ? null : Number(v));

/** The flag a reviewer sees when there is nothing the plan could be read from. */
export function unreadableFlag(detail) {
  return {
    id: newElementId('f'),
    kind: 'unreadable',
    elementId: null,
    title: 'Room data unreadable',
    detail,
    status: 'open',
  };
}

/**
 * The plan for a capture, from its stored files and typed details. Returns
 * `{ plan, scaleResidualMm }`; the second is what the control distances
 * left over, or null when there were none.
 */
export async function readCapturePlan(db, captureId) {
  const capture = await one(db, 'SELECT * FROM captures WHERE id = ?', [captureId]);
  const files = await many(db, `SELECT * FROM capture_files WHERE capture_id = ? AND status = 'stored'`, [captureId]);

  if (capture.source === 'upload') {
    const d = await one(db, 'SELECT * FROM drawing_details WHERE capture_id = ?', [captureId]);
    const image =
      files.find((f) => f.kind === 'source_image') ??
      (['jpg', 'png'].includes(d?.input_type) ? files.find((f) => f.kind === 'source') : null);
    const plan = planFromUpload({
      inputType: d?.input_type,
      scale:
        d?.scale_length_m !== null && d?.scale_length_m !== undefined
          ? { a: [num(d.scale_ax), num(d.scale_ay)], b: [num(d.scale_bx), num(d.scale_by)], lengthM: num(d.scale_length_m) }
          : null,
      imageWidth: num(d?.image_width_px),
      imageHeight: num(d?.image_height_px),
      ceilingHeightM: num(d?.ceiling_height_m) ?? undefined,
      imageFileId: image?.id ?? null,
    });
    return { plan, scaleResidualMm: null };
  }

  const roomFile = files.find((f) => f.kind === 'room');
  let room = null;
  let problem = null;
  if (roomFile) {
    try {
      room = JSON.parse((await storage().read(roomFile.storage_key)).toString('utf8'));
    } catch {
      problem = 'The room data in scan.json could not be read.';
    }
  }

  /*
   * The LiDAR mesh, when the app recorded one (F-02), finds machines
   * RoomPlan missed (F-06). A mesh that cannot be read is skipped: it only
   * ever adds suggestions.
   */
  const meshFile = files.find((f) => f.kind === 'mesh' && Number(f.bytes) <= MAX_MESH_BYTES);
  let meshVertices = [];
  if (meshFile) {
    try {
      meshVertices = parseObjVertices((await storage().read(meshFile.storage_key)).toString('utf8'));
    } catch (err) {
      console.error('Could not read the scan mesh:', err);
    }
  }

  const tags = await many(db, 'SELECT type, x, y, height_m FROM capture_tags WHERE capture_id = ? ORDER BY id', [captureId]);
  const controls = await many(
    db,
    'SELECT ax, ay, bx, `by`, measured_m FROM control_distances WHERE capture_id = ? ORDER BY id',
    [captureId],
  );
  /*
   * The machines the surveyor marked are read in with the room, so the 2D
   * plan carries where each one is (CHANGE 2.1). They are part of the same
   * capture, and arrive in the same coordinate frame as the walls.
   */
  const equipment = await equipmentForPlan(db, captureId);
  const plan = planFromScan(room, {
    floorToFloorM: num(capture.floor_to_floor_m) ?? undefined,
    tags: tags.map((t) => ({ type: t.type, x: num(t.x), y: num(t.y), heightM: num(t.height_m) })),
    controlDistances: controls.map((c) => ({
      a: [num(c.ax), num(c.ay)],
      b: [num(c.bx), num(c.by)],
      measuredM: num(c.measured_m),
    })),
    equipment,
    meshVertices,
  });
  if (problem) {
    plan.flags.push(
      unreadableFlag(`${problem} Trace the plan from the photos, or reject it as an unreadable source.`),
    );
  }
  const control = plan.scale?.control;
  return { plan, scaleResidualMm: control?.applied ? control.residualMm : null };
}
