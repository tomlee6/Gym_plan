# 3D contract: what the generator reads from a plan

Task G-01. This is the agreement between the 2D plan (`shared/plan/`, Thomas) and the 3D generator (`shared/build3d/` and `backend/src/generator/`, Tejesh). It lists every plan field the generator uses, the unit, and what it does when the value is missing.

The plan format is `gymplan/3` (`shared/plan/model.js`). Older plans are run through `upgradePlan()` before generation. The approved plan itself is never changed: its content hash is frozen.

## Ground rules

- **Units.** Every length in the plan and in the output is in metres. Angles are as stated per field.
- **Coordinates.**
  - Plan `[x, y]` is the scan's floor plane (RoomPlan `x`, `z`). The output glTF puts plan `x` on glTF `x`, height on glTF `y` (up) and plan `y` on glTF `z`. This is ARKit's own frame, so nothing is mirrored and the 3D model lines up with the scan.
  - The floor of the level is at height 0.
- **Same input, same output (GEN-01).** Elements are processed in order of their `id`, numbers are rounded to the micrometre before they are written, and the GLB carries no timestamps. The same approved plan and generator version always give byte-identical files.
- **Measured values win.** When the plan carries a measurement, it is used as is. A default is only used when the value is `null`, and every default used is listed in the output's `extras.defaultsUsed` (`{kind, count, ids}`: `wall_kind`, `wall_thickness`, `wall_height`, `floor_finish`, `space_from_outline`, `opening_kind`, `opening_sill`, `opening_height`, `door_swing`, `door_hinge`, `ramp_direction`, `column_shape`, `column_height`, `rail_height`, `mirror_span`, `mirror_side`, `object_height`), so the reviewer and the owner can see what was assumed. Anything the generator had to leave out is listed in `extras.skipped` (`{kind, id, reason}`). The generator never edits the plan.
- **Validation first.** The generator only runs on approved plans, which have passed `validate()`. It still refuses (fails the job with a reason) a plan with no walls or no closed outline.

## Level

| Field | Used for | When missing |
|---|---|---|
| `ceilingHeightM` | Default ceiling and wall top for the whole level | Always present (default 3 m in `emptyPlan`) |
| `room.elevationM` | Not used: the level floor is placed at 0 | — |

## Spaces (rooms)

| Field | Used for | When missing |
|---|---|---|
| `points` | Floor and ceiling surface of the space | A space with fewer than three points is skipped. With no spaces at all, the floor outline is used as one space. |
| `kind` | Picks the default floor finish | `gym_floor` |
| `floorFinish` | Floor material | By kind: `gym_floor` rubber, `studio` timber, `changing` tile, `reception` tile, `office` carpet, `corridor` tile, `storage` concrete, `other` concrete |
| `ceilingHeightM` | Ceiling height of this space | The level's `ceilingHeightM` |
| `ceilingZones[]` `{points, heightM}` | Raised or dropped ceiling areas. The zone is cut out of the space's ceiling and drawn at its own height, with vertical faces where the heights meet (not along the space's own edge, where the wall is). A wall next to a raised zone goes up to it. | A zone without a height is skipped (listed in `skipped`) |

## Walls

| Field | Used for | When missing |
|---|---|---|
| `a`, `b` | The wall's line on the floor | — |
| `curveM` | Curved wall: the sagitta, positive to the left of a→b (`arcPoints()` in `geometry.js`) | Straight wall |
| `heightM` | Top of the wall | The highest ceiling of the spaces it bounds anywhere along its length (checked every metre, both sides), or the level's `ceilingHeightM` |
| `kind` | Thickness, material and which side the thickness goes | A wall on the floor outline is treated as `exterior`; any other wall as `interior` |
| `thicknessM` | Wall depth | By kind: `exterior` 0.20, `interior` 0.15, `partition` 0.10, `glass` 0.02 |
| Which side | An `exterior` wall's line is its **inside face** (the scan sees it from inside), so its thickness goes outwards, away from the floor. Every other wall is centred on its line. | — |
| `mirrors[]` `{fromM, toM, bottomM, topM}` | Reflective panels 6 mm thick on one face of the wall (`mirrors` node), over the solid wall only: a span running across a door or window stops at it. `fromM`/`toM` are along the chord like openings, mapped onto the arc on a curved wall; `topM` is clipped to the wall top. | `mirror: true` with no spans (older plans): the whole wall face is mirrored |
| Which face a mirror is on | An exterior wall's inside face. On any other wall, the side a `mirror` tag from the scan stands on (within 0.5 m of the wall); without one, the side facing a studio, else a gym floor, else the room side, and `mirror_side` is recorded as assumed. | — |

How walls are drawn:

- **Curved walls** follow their arc, drawn within 1 cm of the true curve. The floor, ceilings and any space edge that runs along the wall's chord follow the arc too.
- **Corners.** Two walls meeting end to end are mitred, each face meeting the other wall's face, so the corner closes inside and out. Where three or more walls meet, each runs past the point far enough to fill the middle; a wall carrying straight on from another stops flush. A wall that ends on another wall's side stops at that wall's line, inside it.
- **Materials.** Interior walls are painted. An exterior wall has the exterior finish on its outside face and top, and the rooms' paint on its inside face. Glass walls are glass, in the `glass` node.

## Openings (doors, windows)

Positions along a wall are measured from the wall's `a` end, along the straight line from `a` to `b`, which is how `validate()` checks them. On a curved wall the opening's middle is placed at the same fraction of the arc as of the chord, and its width is measured along the arc.

An opening is cut right through the wall from its sill to its head, with the reveals (sides, head and sill) drawn. An opening whose wall is not on the plan, or that falls outside its wall, is left out and listed in the output's `extras.skipped`.

| Field | Used for | When missing |
|---|---|---|
| `wallId`, `offset`, `width` | Where the cut is | An opening with no wall is skipped |
| `kind` | What fills the cut: `single_door`, `double_door`, `sliding_door`, `roller_shutter`, `window`, `fixed_glazing`, `opening` | From `type` (`defaultOpeningKind()`): `door` → single door, or double door when 1.5 m or wider; `window` → window; `opening` → opening |
| `sillHeightM` | Bottom of the cut | Windows 0.9 m; fixed glazing, doors and openings 0 |
| `heightM` | Height of the cut above the sill | Doors 2.1 m; roller shutters 3.0 m; windows 1.2 m; fixed glazing and openings up to the wall top. Always clipped to the wall top. |
| `leaves` | One or two door leaves | Double door 2, other doors 1 |
| `hinge` | `left` = hinge at the opening's start (towards `a`); `right` = at its end | `left`. This matches how the reviewer editor draws it. |
| `swingInto` | The space the door opens into | By `swing`: leaves open to the left of a→b; `outward` opens to the right |
| Door state | Hinged doors are drawn **open at 90°**, so the walkthrough can pass through. Sliding doors are drawn slid open, and roller shutters rolled up into a box above the head. | — |

What fills each cut:

| Kind | Drawn as | Node |
|---|---|---|
| `window`, `fixed_glazing` | A glass pane in the middle of the wall's thickness | `glass` |
| `single_door`, `double_door` | Leaves 4 cm thick, open at 90° on the swing side, each hinged at the wall's face on that side. A double door has a leaf at each jamb. | `doors` |
| `sliding_door` | A panel 2 cm off the wall's face on the swing side, slid over the wall beside the opening. It slides towards `b` unless a wall end, another wall meeting this one, or another opening is in the way within its width; then towards `a`; if neither side is clear, towards the side with more room. | `doors` |
| `roller_shutter` | Rolled up into a 0.30 m box against the wall, just under the ceiling of the room it is in (or on top of the opening's head if that is lower). The box is on the side set by `swingInto`, else inside the building for an exterior wall, else to the left of a→b. | `doors` |
| `opening` | Nothing: an empty cut | — |

Under every door and opening that starts at the floor, the floor carries on through the wall's thickness (a threshold 3 mm above the floor, in `floors`), so there is no gap where an exterior wall's thickness lies outside the room.

## Columns, beams, level changes, stairs and lifts

| Element | Fields used | When missing |
|---|---|---|
| Column | `x`, `y`, `w`, `d`, `angle` (radians), `shape` (`rect`, `round`), `heightM` | Shape `rect`; height up to the ceiling over it (a ceiling zone's, if it stands in one). A round column is an ellipse `w` by `d`, drawn within about 4 cm per side. Painted like the walls. Skipped without a size. |
| Beam or bulkhead | `points`, `bottomM` (underside height), `kind` | Drawn from `bottomM` up to the highest ceiling over it (ceiling zones included), so there is no gap above it. A beam is bare (`beam` material); a bulkhead is boxed in and painted like the walls. Skipped without `bottomM`, or when its underside is at or above the ceiling. |
| Level change | `points`, `heightM` (rise; negative is sunken), `kind` (`step`, `platform`, `ramp`), `rampAngleDeg` (direction the ramp rises, same convention as `facingDeg`) | Finished like the floor of the space it stands in. A raised one has sides down to the floor; a sunken one is cut out of the floor, with its own floor below and sides up to the room's floor. A ramp's surface slopes from 0 to `heightM` the way it rises, with no side at its low end. Without a direction, it rises along the polygon's longest side, in the direction that side runs when the outline is taken anticlockwise. Skipped without a rise. |
| Stair, lift or void | `points`, `kind`, `railHeightM` | Stairs and voids are cut out of the floor of the space they are in, with a dark shaft going down one storey (3 m) so they do not open onto nothing, and a rail all round 3 cm back from the edge: a glass balustrade from 0.1 m and a 5 cm metal handrail on top, `railHeightM` high (1.0 m by default). The plan does not say where a stair is entered, so the rail goes all the way round. A lift is drawn as a closed shaft from floor to ceiling, and the floor is not cut. |

## Machines and other objects

| Field | Used for | When missing |
|---|---|---|
| `x`, `y`, `w`, `d`, `angle` (radians) | Footprint | — |
| `heightM` | Height | 1.2 m (`DEFAULT_OBJECT_HEIGHT_M`) |
| `elevationM` | Height of the underside above the floor | 0 |
| `equipment` `{equipmentId, type, name}` | Marks it as a gym machine (its own material and node name) | Not a machine: drawn as a plain object |
| `facingDeg` | Which way the front faces: degrees, front vector `(cos, sin)` in plan coordinates, same as `wallAngleDeg` | The object's own `angle` |
| `equipment.equipmentId` | Finds the machine's approved 3D model: the machine with that reference on the version's capture (J-06) | A plain box at the footprint |
| `sameAs` | Use another machine's model (L-08) | Its own |
| `modelRef` | Not used: the model is found by the machine's reference | — |
| `category` `mesh` | A lump from the LiDAR mesh that nobody named | Drawn as a plain object, like the others |

In the level's own file every object is a block over its footprint from `elevationM` up by `heightM`, never through the ceiling over it: machines in the `machines` node (`machine` material, the current viewer's colour), everything else in `objects` (a lighter `object` material). An object without a size is skipped.

**Machine models in the walkthrough (J-06).** The level's file is frozen with its plan version, while machine models are approved on their own, often after the level is built. So the models are not baked in:

- **Sent with the walkthrough.** Every walkthrough (the owner's, the reviewer's, a share link's) carries `machineModels`: each recorded machine on the version's capture with an approved model, by reference, with `modelId`, `sizeM` and signed links to its levels of detail.
- **Placed in the viewer** (`web/src/viewer/machines.js`):
  - It hides the level's `machines` node.
  - It draws each named machine: the model of the machine it is the same as, else its own, else a box like the level's.
  - Each model stands at `elevationM`, centred on the footprint, turned by the footprint's rotation (plan `angle` is -angle about +Y). Its front was settled in review.
- **Instancing.** A model used by several machines is loaded once, and the copies share its geometry and textures.
- **Detail by distance (K-03).** Each machine with a model is a level-of-detail node.
  - The farthest level loads with the level, so every machine shows at once.
  - A nearer level loads when the camera comes within 4 m of where it is needed. Nearest within 5 m, middle to 12 m, farthest beyond (`shared/build3d/budget.js`).
- **Cache (K-03).** Model files are kept for the session, across levels, by their path. Their names are their content, so a re-signed link finds the copy already loaded.
- **Collision.** It is the level's own, from the footprints.

## Tags and zones

| Element | Drawn as |
|---|---|
| Tag `fireExit` | A green, lit exit sign from 2.25 to 2.45 m (`signs` node). Within 0.5 m of a wall: a plate 0.40 m wide and 4 cm deep on the wall's face on the tag's side, square to the wall. Otherwise a 0.45 m block where the tag is. |
| Tag `power` | A yellow, lit power point from 0.30 to 0.42 m (`signs` node). Within 0.5 m of a wall: a plate 0.16 m wide and 3 cm deep on the face on the tag's side. Otherwise a 0.16 m block where the tag is. |
| Tags `ceiling`, `mirror`, `stair` | Not drawn: they already shaped the plan when it was read (a mirror tag also picks a mirror's face, see Walls) |
| No-build zone | A see-through red overlay 1 cm above the floor, in its own node (`zones`) so the viewer can hide it |

A tag on a wall's line, with no side to go by, goes on the room side.

## Exterior shell

An inside scan only sees the inside of the outer walls, so the outside of the building is built from what the plan knows:

- **Outer walls** at their thickness, outside the floor outline (see Walls).
- **Roof**: a slab 0.30 m thick over the building's outside edge (the outer walls' outside faces, exactly), sitting on the highest wall or ceiling, whichever is higher. Its edge comes down to the top of each outer wall, so a lower wall leaves no gap seen from outside. It has no underside: from inside, you see the ceilings. It is its own node, so the viewer can remove it for a dollhouse view.
- **Ground**: a rectangle 5 m beyond the building's outside edge on every side, level with the floor, with the building cut out of it (so it never shows inside, or in a sunken pit).
- The level's `bounds` are the building's: the ground is not included.

The real facade (cladding, signage, shopfront details) cannot be seen from inside and is not modelled.

## Finish set (GEN-03)

One set for every gym, no per-customer styling (`shared/build3d/materials.js`):

| Material | Used on | Look |
|---|---|---|
| `floor_rubber`, `floor_timber`, `floor_tile`, `floor_carpet`, `floor_turf`, `floor_concrete` | Floors by finish (see Spaces), steps, platforms and ramps, and thresholds (concrete) | Each carries a pattern a metre square, repeated once a metre, so the joints show true scale: rubber 1 m tiles, timber 12.5 cm boards with staggered ends, tile and carpet 0.5 m tiles, turf mown stripes, concrete 1 m joints. The pattern is a 256 px PNG in the GLB (KTX2 after J-08). |
| `wall_interior`, `wall_exterior` | Walls (see Walls), bulkheads, columns, lift shafts | Plain paint |
| `ceiling` | Ceilings and ceiling zones | Plain white |
| `mirror` | Mirror spans | Metallic 1, roughness 0.03: reflective once the viewer gives the scene an environment to reflect (the current viewer's `RoomEnvironment`) |
| `glass` | Windows, glazing, glass walls, balustrades | 30 % opaque, both sides |
| `door`, `metal`, `beam`, `roof`, `ground`, `void` | Door leaves and sliding doors; shutter boxes and handrails; bare beams; roof; ground; inside of stair shafts | Plain |
| `machine`, `object` | Machine and object blocks | Plain, as the current viewer |
| `exit_sign`, `power_point`, `zone` | Signs, power points, no-build overlay | Lit (emissive) so they read in any light; the zone 22 % opaque, both sides |

## What the generator hands back

- A GLB with these named nodes, so the viewer can show, hide or pick them: `floors`, `ceilings`, `walls`, `walls-exterior`, `glass`, `mirrors`, `doors`, `columns`, `beams`, `level-changes`, `voids`, `rails`, `machines`, `objects`, `signs`, `zones`, `roof`, `ground`. One mesh per node, one primitive per material.
- **Compression (J-08).** Geometry is welded and compressed with `EXT_meshopt_compression`; positions are quantised to 16 bits over the whole level (`KHR_mesh_quantization`), about 1.5 mm on a 100 m building, the same scale for every part so parts that meet stay sealed. Texture coordinates stay full floats (they are in metres). The viewer loads it with three.js's `GLTFLoader` and `MeshoptDecoder`.
- **Textures.** The floor patterns are 256 px PNGs of a few kilobytes each, smaller than KTX2 would make them, so they stay PNG. Machine models are KTX2, at a smaller size for each level of detail (L-06); see "KTX2 textures (N-01)" below.
- **Budget.** At most 25 MB per level, machines included (`GENERATOR_MAX_BYTES`). Over that, the job fails for good with the size in the reason and the plan goes back to the reviewer. A 2,400 m² test gym with 12 rooms, 28 openings, 48 columns and 400 machine boxes builds in under a second to about 200 KB.
- **Scene extras**, for the viewer and the reviewer: `generator`, `generatorVersion`, `contentHash`, `bounds` (the building's, ground left out), `stats`, `defaultsUsed`, `skipped`, and `walk`:
  - `walk.collision`: `[[ax, ay, bx, by], ...]`, plan metres: the outline of everything a walker cannot pass, gathered from the same pieces the level is drawn from. That is wall pieces reaching below 1.8 m (a door head is walked under, a window's sill stopped at), glass panes reaching below 1.8 m, door leaves and slid door panels, columns, lift shafts, stair and void rails, objects and machines from below 1.8 m to above 0.3 m, beams and bulkheads below 1.8 m, and steps, platforms and pits of more than 0.25 m. Ramps are walked.
  - `walk.start`: `{x, y, heading}`, `heading` in radians in (−π, π], plan x towards plan y (the viewer's own convention). Just inside an entrance with 0.9 m clear all round, looking into the room (a view out through a door does not count): doors on the outside first, double and sliding doors before single doors before roller shutters, then by position; tried 1.2, 2 and 3 m in, and up to 2 m to either side. If no door has room, the most open spot on the floor.
  - `walk.eyeHeightM`: 1.6.

  The same shared code (`shared/build3d/walk.js`) runs in the browser, so a viewer building from the plan gets the same answers.

## Performance budget (K-04)

The walkthrough must show its first view within 8 s on a 25 Mbps line, and hold 30 fps on a 2022 mid-range laptop and a 2021 iPad (VIEW-09). The figures are in `shared/build3d/budget.js`, and two checks hold them, both run by the deploy pipeline:

- **The app's JavaScript.** `npm run build` (web) ends with `scripts/budget.mjs`, which fails the build if a walkthrough loads more than 400 KB gzipped before its first frame. That counts what `index.html` loads, the walkthrough's own chunks and everything they import, but not other pages' code.
- **Levels and machine models.** `test/budget.test.js` (backend) builds the reference gym and the 2,400 m² test gym, with machine models made by L-06, and checks two things:
  - **First view.** The JavaScript allowance, the level and each machine model's farthest level of detail, at 25 Mbps, plus 2.5 s to start and draw, fit 8 s.
  - **Frame rate.** At the busiest spot, standing at each machine in turn, the triangles and draw calls drawn stay under 2 million and 1,500.

Frame rate itself needs a GPU to measure, so it is held by what is drawn. That figure comes from Chrome on an Intel UHD laptop GPU, which ran the 2,400 m² test gym at 60 fps (the screen's limit).

Today's figures:

| | Reference gym | 2,400 m² test gym, 400 machines of 20 models |
|---|---|---|
| JavaScript before the first frame | 298 KB gzipped | same |
| Level and machine models to download | 0.15 MB | 1.0 MB |
| First view, worked out | 2.7 s | 3.0 s |
| Triangles at the busiest spot | 41,000 | 1.22 million (17 machines near, 86 middle, 297 far) |
| Draw calls | 29 | 420 |

Measured in Chrome on an Intel UHD laptop GPU, at 25 Mbps with a cold cache, with machine models made by L-06 on the 2,400 m² gym. Every machine had one of 20 models, standing in an aisle among them:

| | Result |
|---|---|
| First view | 2.1 to 2.3 s (5.3 s on Chrome's very first start) |
| Frames a second on arrival, while nearer levels of detail stream in | 30 |
| Frames a second once they are in | 54 |
| Frames a second walking the aisle | 44 |

The stand-in model's nearest level is 1.2 MB, with a noise texture: the worst case. Real models' textures compress better.

Still to do: a 2021 iPad on the device.

## When generation fails (J-09)

A plan that cannot be built fails its job at once, without retries (building is deterministic, so a retry would fail the same way), and the version goes back to the reviewer queue as `generation_failed`, showing the reason. Each reason says what went wrong and what to do, and ends with a code in brackets for reports and alerts:

| Code | When | Retried |
|---|---|---|
| `too_few_walls` | Fewer than three usable walls | No |
| `open_outline` | The walls do not close round a floor | No |
| `too_large` | The model is over the size limit (25 MB) | No |
| `no_plan` | The approved version has no plan or content hash | No |
| `build_error` | A fault in the generator itself (logged in full for the 3D team) | No |
| `store_failed` | The model could not be saved | Yes, by the job's retries; the reason is kept if they all fail |

Smaller problems do not fail the build: an element that cannot be drawn (a wall of no length, an opening on no wall, a space or shape with fewer than three points, a beam above the ceiling) is left out and listed in `extras.skipped`, and every default filled in is listed in `extras.defaultsUsed`.

## Machine models (L-07)

A machine's 3D model is built from its 360 video by the `asset.build` job (`backend/src/assets/`) and checked by a reviewer before any walkthrough uses it.

| State | Meaning |
|---|---|
| `none` | No model has been asked for (no rows) |
| `queued`, `building` | Waiting for, or on, the GPU |
| `awaiting_review` | Built; a reviewer looks at it |
| `approved` | The one the walkthrough places (one per machine) |
| `rejected` | Turned down, with the reviewer's note |
| `failed` | Could not be built, with the reason |

- **Identity.** A model is its machine, route (`generated` now; `measured` after L-04), input (the video's stored file), generator version (`ASSET_GENERATOR_VERSION`) and seed. Asking for the same thing again finds the row. A retake is a new input.
- **Build again.** A failed build is tried again on the same row with the same seed. Otherwise the next seed makes another model to choose from, since TRELLIS.2 invents the sides the video does not show. One build per machine runs at a time.
- **Approval.** Only a built model (awaiting review, or rejected before) can be approved. Approving another rejects the one before with the note "Replaced by a newer approved model.", so a reviewer can always go back to an earlier choice. A rejection needs a note. Every step is in the audit log against the machine (`MACHINE_MODEL_QUEUED`, `_BUILT`, `_FAILED`, `_APPROVED`, `_REJECTED`).
- **Files.** Each try at a model has its own folder in the models store, `models/accounts/<account>/assets/<model id>/try-<n>/`, so a try never finds another's files. Account removal deletes the account's whole `models/accounts/<account>/` folder: levels, models and every try's files.
- **A retake while a build waits.** The build fails with "The 360 video changed after this build was queued", and the reviewer builds again.

Reviewer API (Flex staff only), taking `machineId` from each machine in `GET /v1/review/versions/:id`:

| Request | Does |
|---|---|
| `GET /v1/review/machines/:machineId/models` | The machine, its video's state, `canBuild`, `canMeasure` (it has ARKit frames too), `modelStatus` and every model, newest first, each with its `route`. A built model carries a signed `url` to its GLB and `urlExpiresAt`. |
| `POST /v1/review/machines/:machineId/models` `{route?}` | Builds one (202), or returns the build already running (200). `route` is `generated` (TRELLIS.2, the default) or `measured` (L-04). 409 without a finished video, or for `measured` without ARKit frames. A measured model is the same every time, so asking again returns it, unless it failed. |
| `POST /v1/review/models/:modelId/approve` `{note?}` | Approves it; `replaced` names the model it took over from. |
| `POST /v1/review/models/:modelId/reject` `{note}` | Rejects it. |
| `POST /v1/review/models/:modelId/turn` `{turnDeg}` | Turns a built model (0, 90, 180 or 270). The worker makes it again from the GPU's own GLB, without the GPU (202; 200 if it already faces that way). Its files change, so it goes back to `awaiting_review`, even if it was approved. |

### Frames (L-02)

The first step of a build picks the frames the model is made from (`gpu/trellis2/frames.py`, in the GPU worker's image):

- **Source.** The ARKit frames when the app sent them (below), otherwise the 360 video. An iPhone video stored sideways with a rotation is read upright.
- **Left out.** Frames that are too dark or too bright (mean grey level under 20 or over 235 of 255), flat (nothing in view), or blurred (less than 35 % as sharp as the walk's median frame). ARKit frames taken while tracking was not `normal` are left out too.
- **Spread round the orbit.** The orbit is split into equal steps (96 by default, at most half the usable frames) and each step gives its sharpest frame.
  - With ARKit frames, a frame's place is its bearing from the point all the cameras looked at.
  - From the video alone, its place is estimated from how far the view slid sideways (75 %) and from time (25 %), so a pause or a change of pace does not bunch the picks.
- **Candidates for TRELLIS.2.** The sharpest frame of each sixth of the orbit, sharpest first. The cut-out step (L-03) chooses among them.
- **Output.** `frames/` and `frames.json`, which records the source, the input's size, coverage, the widest gap in degrees (for the reviewer and the coverage guide, I-06), and how many frames were left out and why. For each frame it records its place, sharpness and, for ARKit, the camera with `uprightTurns` (quarter turns clockwise that stand the image upright).
- **Refusals.** A video shorter than 3 s, one that cannot be decoded, or fewer than 4 usable frames: the build fails with the reason.

### Cut-out (L-03)

The machine alone on a transparent background, from the best candidate frame (`gpu/trellis2/segment.py`). This is the image TRELLIS.2 is given, and the one the reviewer sees beside the model.

- **Foreground.** BiRefNet (MIT), the copy the TRELLIS.2 pipeline already loads, separates the foreground. TRELLIS.2's own background removal never runs, because the cut-out already has its background taken away.
- **The machine, not its neighbours.** The piece nearest the middle of the frame is kept, with any piece within 2 % of the frame's size of it (parts a gap splits). With ARKit frames, anything outside the columns the machine's scanned footprint can fill (standing at the orbit's middle, stretched 15 %) is dropped too.
- **Judged.** Each candidate is judged on:
  - **Edges.** Touching one edge of the frame counts against it. Touching two, filling under 2 % of the frame or over 85 % of it rules it out.
  - **People.** A person in the space round the machine counts against it. People are found with OpenCV's pedestrian detector, which has no weights and misses people seen only in part.
  - **Shape.** The outline's height against its width must be one the scanned box allows from some side.
  - **Matte.** How sure BiRefNet is.
  - **Sharpness.** Its sharpness from L-02.
- **Output.** `cutout.png` (cropped round the machine with an 8 % margin, at most 1024 px on the long side, soft-edged) and `cutout.json` (each candidate's scores and what counted against it). If no candidate shows the whole machine on its own, the build fails with each candidate's reasons.

### On the GPU (L-05)

Each try is one AWS Batch job on the GPU worker (`backend/src/assets/trellis2.js` submits it; `gpu/trellis2/worker.py` runs it):

- **When.** As soon as a machine's 360 video finishes uploading (`ASSET_AUTO_BUILD`, on wherever the GPU environment exists), and whenever a reviewer builds one.
- **In.** The video and, when the app sent them, the ARKit frames, from the captures bucket. The seed and the scanned box go in the job's parameters.
- **Out.** In the try's folder: `model.glb` and `metadata.json`, plus `frames.json`, `cutout.json` and `cutout.png` (L-02, L-03). On failure, `error.json` beside whatever it got as far as.
- **Back.** Batch's SUCCEEDED or FAILED event reaches the backend's worker through the `gpu-jobs` queue.
  - **Succeeded.** The model moves to `awaiting_review`, with the GLB's size and triangle count.
  - **Failed.** It moves to `failed` with the reason: the worker's own when it gave one, otherwise Batch's (a timeout, a lost host).
- **Retries.** Batch retries a try three times unless the input cannot be used, so FAILED is final, and the reviewer builds again.
- **Missing events.** A build still on the GPU six hours after it was submitted is settled by asking Batch.
- **Then.** Before the model goes to the reviewer, the backend worker makes it ready for the walkthrough (below).

### Measured route (L-04)

The other way to make a model: rebuilt from what the phone measured on the walk round, the ARKit frames, instead of invented from one photo by TRELLIS.2. Its shape and size are real; what the walk never saw is missing, not made up. It is built by `gpu/trellis2/measured.py`, in the same GPU job (`machine.route: measured`), but needs neither TRELLIS.2 nor its weights.

1. **Frames.** Those with tracking `normal` and a depth map, up to 150 spread over the walk. Depth with confidence 0 (low) is left out.
2. **Where.** The machine is the point every camera looked at (as frames.py finds it), standing on the floor. The floor is the lowest broad level in the depth round it.
3. **The volume.** What is rebuilt is a cylinder round that point:
   - **Width:** the scanned footprint's diagonal and a third more (2.5 m without a scan).
   - **Height:** from the floor to a quarter above the scanned height (2.5 m without a scan).
4. **Fusion (TSDF).** A voxel grid of 1.5 cm voxels, whatever the machine's size, up to 12 million voxels. Each voxel holds the signed distance to the nearest surface, averaged over the frames that saw it, and the colour of the photos there.
5. **Clean-up.** The floor is cut away, which closes the machine's underside. Of what is solid, only the piece over the middle of the footprint is kept, so a neighbour reaching into the cylinder goes.
6. **Surface.** Surface nets: a vertex in each cell the surface passes through, joined across every crossing between seen voxels, with the grid's colour there.
7. **Line-up.** Turned about the vertical so the smallest rectangle round its footprint lies along X and Z, centred, standing on y = 0. The front is for the reviewer, as ever.
8. **Photo texture (N-04).** The surface is laid flat in a texture, and each texel is coloured from the photos that see it best (below). Then L-06 as for any model, keeping its size.

**Output.** `model.glb`, with its photo texture, and `measured.json`. The report gives:
- the frames used, the voxel size, where the machine was and the floor's height;
- how many solid pieces there were;
- the size, the turn, the vertices and triangles;
- `texture`: its size, charts, texels a metre, the photos used, and the share of it the photos saw (`seenPct`).

#### Photo texture (N-04)

Per-vertex colour stops at the voxel size (1.5 cm); the photos hold detail of a millimetre or two. So the surface gets a texture baked from the frames it was built from (`gpu/trellis2/bake.py`). It is 1024 texels a side, the nearest level of detail's own size (`LEVELS_OF_DETAIL`); L-06 would cut a larger one down to that.

1. **Charts.** Each triangle goes with the side of a box it faces most (±x, ±y, ±z). The model is lined up with its footprint, so a machine's flat faces fall on one side each.
   - A stray triangle joins the side its neighbours chose, if it faces that side well enough.
   - A fleck of fewer than 16 triangles joins the chart beside it, when it faces that chart's side too.
   - Each connected stretch on one side is a chart, laid flat as seen from that side. One that fills less than half the rectangle round it (the side of a frame, an L) is cut in two, up to four times, so its empty middle is not packed.
2. **Atlas.** All charts at one scale, packed on shelves, tallest first, with a gap of 4 texels round each. They are also packed with every chart taller than wide turned on its side, and the closer packing is kept. About 70 % of the texture is used: 240 texels a metre on the 2.6 m cable crossover, 410 on a treadmill (4.2 and 2.4 mm a texel, three to six times finer than the voxels).
3. **Photos.** Up to 60 frames, spread over the walk. A frame counts for a texel when:
   - its point is in the photo, and the photo sees it within 75° of square on;
   - no other part of the model is in front of it (the model's own depth, as that frame saw it);
   - the depth did not see something in front of it that the model does not have, such as a person walking by or a neighbour.
4. **Colour.** Each frame that counts is weighted by how squarely it sees the point (cos⁸) and how close it is (1/distance²), so the best one or two dominate. Colours are averaged in linear light.
5. **Unseen texels.** A texel no frame sees keeps the fused colour.
6. **Edges.** Colour spreads 8 texels out round each chart, so L-06's smaller textures do not bleed the gaps into the edges.

The texture is stored as a JPEG (quality 92) in the GLB, which adds 0.1 to 0.3 MB. L-06 resizes and compresses it like any other texture (WebP or KTX2, 1024/512/256 by level). A vertex on a chart's edge is split, one copy a chart. A model whose charts cannot fit its texture is coloured per vertex instead, and `texture.skipped` says so; that only happens at sizes far below 1024.

Time on a laptop CPU, with 60 frames: 22 s for a treadmill (56,000 triangles), 17 s for the 2.6 m cable crossover. It is checked on the made-up treadmill, whose console carries level stripes 1 cm wide, narrower than a voxel:
- the photo texture puts 95 % of them back where they are;
- per-vertex colour blurs them into one blue (54 %, chance).

**Refusals.** Fewer than 12 usable frames, a depth map that is not 16-bit, or nothing solid in the middle: the build fails with the reason.

**Sample input.** Until the app records ARKit frames (I-05), it is built and tested against a made-up walk (`gpu/trellis2/sample_arkit.py`):

- **The scene:** a treadmill-like machine 0.8 × 1.9 × 1.45 m, black rubber deck, a console with 1 cm stripes, turned 30° from the world's axes, with a bench beside it, a wall behind and the floor.
- **The frames:** photos, depth with the sensor's noise and dropouts, and some frames with tracking lost.
- **The result:** it comes back as the treadmill alone, within a voxel or two of its true size, the bench and floor gone, in its colours.

**Not yet:**
- The photo texture averages the frames' colours as they are. Real frames vary in exposure and white balance, which shows as faint seams where the best frame changes; evening them out needs real recordings to tune against.
- It comes out a voxel or two wider than the machine (1.5 to 3 cm across a treadmill). That is how depth fusion treats edges seen side-on, worst on parts only ever seen from the side.
- It has not met real recordings: dark, shiny and mirrored machines will need tuning against them. On the made-up chrome rack it loses the chrome entirely (L-01).

### Route test (L-01)

Which route makes the main machine models is chosen on five real machines, the hardest kinds for one route or the other: chrome, black rubber, one against a wall, one in a row, and a large one.

`gpu/trellis2/route_test.py` runs both routes on each. How to run it is in `docs/runbooks/trellis2-worker.md`. For each machine and route it reports:

- **Processing time.**
- **File size** and **triangles** of the model as made.
- **Size off:** the worst axis against the tape-measured size. For TRELLIS.2 it is taken after L-06's one-factor fit, so it shows how far the proportions are off.
- **Completeness and accuracy** (made-up machines only, whose true surface is known): the share of the visible surface the model has within 2 cm, and the distance 90 % of the model lies within.

The models are written beside the report for a person to judge the look.

**Run on made-up machines (`--samples`), measured route only.** TRELLIS.2 needs a GPU host. CPU times are from a laptop.

| Machine | Time | File | Triangles | Size off (worst) | Complete | Accuracy (90 %) |
|---|---|---|---|---|---|---|
| Chrome squat rack | 43 s | 704 KB | 25,752 | 98 % (height) | 31 % | 31 mm |
| Treadmill, all black rubber | 46 s | 1.7 MB | 63,192 | 2.1 % | 95 % | 21 mm |
| Treadmill against a wall | 45 s | 1.4 MB | 51,824 | 2.9 % | 87 % | 19 mm |
| Treadmill in a row | 32 s | 1.6 MB | 57,956 | 2.6 % | 94 % | 20 mm |
| Cable crossover, 2.6 m | 138 s | 3.9 MB | 136,420 | 6.5 % (depth) | 92 % | 18 mm |

Times and files are from before the photo texture (N-04), which adds about 20 s and 0.1 to 0.3 MB to each.

What these say, under the assumed sensor model:

- **Chrome defeats the measured route.** Where the sensor gives nothing or a confident reflection, the chrome uprights vanish and only the base plate is left. TRELLIS.2, working from the photo, should do better there. This is the case to watch on real machines.
- **Black rubber, a wall, a row.** These come back at their size, alone. Against a wall, the far side is missing (87 % complete), as expected.
- **A large machine** comes back about 4 cm too deep, the same voxel or two as the others. It was 10 % out when its voxels grew with the volume (about 2 cm); they now stay at 1.5 cm (N-02), which costs time and a bigger model before L-06 cuts it down.

The choice of main route waits for real recordings (I-05) and a GPU run of both routes.

### Ready for the walkthrough (L-06)

When a GPU job succeeds, the backend worker makes the walkthrough's model from TRELLIS.2's GLB (`backend/src/assets/optimise.js`). It keeps the GPU's own GLB (`raw_glb_key`), so the model can be made again, turned another way, without the GPU.

| Step | What happens |
|---|---|
| Up | glTF +Y, as TRELLIS.2 writes it. |
| Line-up | The footprint's own frame: X along its width, Z along its depth. A quarter turn when the model's long side runs the other way to the scanned footprint's. Not turned when either is within 10 % of square. |
| Front | Cannot be told from the shape. TRELLIS.2's own front is left where the line-up takes it, and flagged `front_guessed`. In the review (L-08) the reviewer turns the model until its front faces the way the plan says the machine faces (`facingDeg`, or the footprint's rotation when that is not set: +X). `turn_deg` is 0, 90, 180 or 270, right-handed about +Y, so a quarter turn takes +Z to +X. |
| Size | One scale for all three axes, never stretched: the geometric mean of the scanned width, depth and height over the model's. More than 15 % off on any axis is flagged `size_mismatch`, with the worst axis in `scaleErrorPct`. No scanned size: 1.2 m tall, flagged `no_scanned_size`. A measured model (L-04) is in metres already and keeps its size. It is still checked against the scan and flagged the same way. |
| Placing | Standing on y = 0, centred on its footprint. J-06 puts it at the footprint's position and rotation as it is: its front was settled in review. |
| Levels of detail | Three, nearest first. Geometry is compressed with meshopt; textures are KTX2 (WebP with `MODEL_TEXTURES=webp`). |
| Storage | Each level is stored as `models/accounts/<account>/assets/<model id>/<sha256>.glb`. Making it again from the same GLB gives the same bytes, so a name never changes and links can be cached. |

The three levels of detail, set in `shared/build3d/budget.js` and shared with the viewer:

| Level | Most triangles | Texture size | Shown from |
|---|---|---|---|
| Nearest | 20,000 | 1024 px | 0 m |
| Middle | 5,000 | 512 px | 5 m |
| Farthest | 1,500 | 256 px | 12 m |

They were first 50,000, 12,000 and 3,000, shown from 0, 6 and 15 m. K-04's budget check found that, in a gym packed with machines, about 3.7 million triangles would be drawn at the busiest spot, nearly twice the budget. The levels above draw 1.2 million there.

The reviewer API gives each model `lods` (`url`, `urlExpiresAt`, `triangles`, `bytes`, `textureSize`, nearest first), `turnDeg`, and `flags` (`code` and what to check). `url` stays the nearest level.

A model of 480,000 triangles with 2048 px textures takes a few seconds and about 300 MB of memory. A GLB that cannot be read, or has no triangles, fails the model with the reason.

### KTX2 textures (N-01)

KTX2 (Basis Universal) textures stay compressed on the graphics card: a machine model's take a quarter to an eighth of the memory WebP needs once decoded. That matters most on the iPad. Machine models are made with them (`MODEL_TEXTURES=ktx2`, the default).

- **Making them.** L-06 makes ETC1S KTX2 with mipmaps, colour in sRGB and metal-roughness linear, the same bytes every time. The encoder is `ktx2-encoder`: MIT, with Basis Universal under Apache-2.0. It takes tens of seconds a model, so L-06 runs in a thread of its own, which keeps the worker answering its health check meanwhile. `MODEL_TEXTURES=webp` gives WebP instead.
- **Size.** On the stand-in model the levels are 410, 122 and 35 KB, against WebP's 1,186, 233 and 38 KB.
- **Reading them.** The walkthrough and the review preview read them with three.js's KTX2 loader, which transcodes them in a worker to whatever the graphics card takes: BC7 on a desktop GPU, ASTC or ETC2 on the iPad. The transcoder (256 KB gzipped, with its own allowance in the budget) is only fetched for a model that has KTX2 textures.
- **The transcoder, without eval.** three.js's own transcoder is compiled so its JavaScript glue makes functions from strings. The browser allows that only with `'unsafe-eval'` in the page's script policy (H-05), which the app rightly does not give. So `web/vendor/basis/` holds the same transcoder, with the same source, the same compiler and the same build, plus Emscripten's `-sDYNAMIC_EXECUTION=0`.
  - The web build points the loader at it (`basisTranscoder()` in `web/vite.config.js`), and `npm run build` fails on a transcoder that would need eval.
  - In headless Chrome, under the production policy, a KTX2 machine model loads with it. With three's own transcoder, the same model never loads.
  - Its README says how it was built and checked, and how to rebuild it when three.js moves to a newer transcoder; the build stops until then.

### Review in the editor (L-08)

Each named machine's equipment section in the editor has a 3D model panel. It shows the model's state and offers "Same machine as".

- **The review.** It opens in a dialog with the 360 video and the model side by side (`web/src/review/editor/MachineModel.jsx`).
  - **The model** is shown on a 1 m grid inside the outline of the scanned box, with an arrow where the plan says the machine faces, so its size and its front can be checked at a glance.
  - **Details.** Its flags, its size against the scan, and every model made for the machine, any of which can be looked at.
- **Actions.**
  - **Approve.**
  - **Reject**, with a reason.
  - **Turn** a quarter or half turn, until its front faces the arrow.
  - **Build another**, to get another model from the next seed.
  - The dialog checks on a build or a turn until it is done.
- **Same as.** This is on the plan (`object.sameAs`), so it is versioned and approved with the rest. A machine marked the same as another uses that one's approved model and needs none of its own.
  - It always points straight at the machine whose model is used: marking a machine the same as a copy points it at the original, and copies of a machine move with it.
  - A machine named on the plan without a recording (no video) gets its model this way.

### ARKit frames upload (the format I-05 records)

One file, uploaded as the video's `frames` file: a zip, stored without compression (the images are already JPEG). Inside it:

| Entry | Holds |
|---|---|
| `frames.json` | The list below |
| `images/000000.jpg`, … | `ARFrame.capturedImage` as captured (the sensor's landscape orientation, whichever way the phone was held), JPEG, faces blurred as for keyframes |
| `depth/000000.png`, … | `ARFrame.sceneDepth.depthMap`: 16-bit PNG, millimetres, at its own size (256 × 192). Each value is the distance along the camera's view axis (z, as ARKit gives it), over the same view as the photo |
| `confidence/000000.png`, … | `sceneDepth.confidenceMap`: 8-bit PNG, 0, 1 or 2 |

```json
{
  "format": "flexgym-arkit-frames",
  "version": 1,
  "device": "iPhone15,3",
  "frames": [
    {
      "image": "images/000000.jpg",
      "timeS": 0.0,
      "transform": [16 numbers],
      "intrinsics": [fx, fy, cx, cy],
      "tracking": "normal",
      "depth": "depth/000000.png",
      "confidence": "confidence/000000.png"
    }
  ]
}
```

- `transform` is `ARCamera.transform` (camera to world, metres), written column by column as simd stores it.
- `intrinsics` are from `ARCamera.intrinsics`, in pixels of `image`, with pixel centres at whole numbers (the top-left pixel's centre is 0, 0). The depth map's are the same, scaled to its size.
- **Used by** frame picking (L-02), the cut-out's footprint check (L-03) and the measured route (L-04).
- `tracking` is `normal`, `limited` or `notAvailable`.
- `depth` and `confidence` are `null` when the frame has none.
- **Rate.** About 5 frames a second is plenty: a one-minute walk is then about 300 frames.
- **Limits.** At most 5,000 frames and 20 MB per file; a name may not leave the archive.

## Monitoring (N-03)

The backend counts what happens to levels and machine models in CloudWatch, namespace `FlexGym/3D` (`backend/src/metrics3d.js`, embedded metric format, like the jobs' `FlexGym/Jobs`):

| Metric | Dimension | Counted when |
|---|---|---|
| `LevelsBuilt` | | A level is built and stored |
| `LevelsFailed` | `Reason`: the J-09 code, or `other` | A level fails for good and goes back to the reviewer |
| `LevelFaults` | | ... and the reason is not the plan's (`too_few_walls`, `open_outline` are the plan's) |
| `ModelsBuilt` | `Route`: `generated`, `measured` | A machine model is made ready and waits for review |
| `ModelsFailed` | `Cause`: `input`, `gpu`, `ready`, `lost`, `job` | A machine model fails for good |
| `ModelFaults` | | ... and the cause is not the recording's (`input`) |
| `BuildsOnGpu` | | Every 5 minutes: models on the GPU now |
| `OldestBuildSeconds` | | Every 5 minutes: since the oldest of them was sent there |

The causes of a failed machine model are:
- `input`: the video or frames cannot be used, or the video was retaken while the build was queued.
- `gpu`: the GPU worker failed, or Batch stopped it.
- `ready`: L-06 could not make the GPU's model ready.
- `lost`: the outcome never came back.
- `job`: the `asset.build` job gave up, either sending to Batch or on a turn.

The audit log's `MACHINE_MODEL_FAILED` entry records the cause too.

A failure that is the plan's or the recording's is already in front of the reviewer with its reason. Only faults raise an alarm. The alarms are in `infra/lib/models-monitoring.ts`, added to each environment's monitoring stack, its alarm topic and its dashboard (a "3D" row). What to do when each fires is in `docs/runbooks/3d-alarms.md`.

| Alarm | Fires when |
|---|---|
| `flexgym-<env>-3d-level-faults` | Any `LevelFaults` in a minute |
| `flexgym-<env>-3d-model-faults` | Any `ModelFaults` in a minute |
| `flexgym-<env>-3d-builds-stuck` | `OldestBuildSeconds` over 90 minutes. That is longer than an attempt's hour on the GPU, and well before the worker's own six-hour sweep. |
| `flexgym-<env>-3d-gpu-outcomes-old` | The `gpu-jobs` queue's oldest message over 15 minutes, for 5 minutes. Either nobody reads the queue, or a message fails every time it is read. |

The `gpu-jobs` dead-letter queue already had its alarm (`gpu-jobs-dlq-not-empty`); the runbook covers it too.

## Open points for Thomas

1. Are opening offsets and mirror spans on a curved wall measured along the straight `a`→`b` line (what `validate()` checks today) or along the arc (what `wallLength()` reports)? The editor is split: it places openings along the chord (`openingSegment()`) but draws mirror spans along the arc. The generator follows `validate()` and maps chord positions onto the arc in proportion, so a span of the whole chord covers the whole arc, until agreed.
2. RoomPlan reports an interior partition at one of its faces, not its middle, and the side is unknown. The generator centres the wall on the line, which can be out by half the wall's thickness (5–8 cm). A per-wall "line is the left/right face" setting in the editor would remove that.
3. A door with no `swingInto` and no `swing` opens to the left of a→b. Should the scan reader fill `swingInto` for exterior doors (always into the building)?
4. A mirror span does not say which face of an interior wall it is on. The generator uses the scan's mirror tag when there is one, then guesses the studio side and records `mirror_side`. A `side` field on the span (set in the editor) would remove the guess.
5. A stair void does not say where the stair is entered, so the rail runs all the way round it. An "entry edge" on the void would let the generator leave that edge open.
6. Deleting a machine (`DELETE /v1/captures/:captureId/equipment/:ref`) deletes its `machine_models` rows but leaves their files in the models store. Before deleting the rows, read their ids. Once the transaction commits, call `modelStorage().deleteFolder(modelFolder(model))` for each (`src/assets`), the way the video's objects are discarded. Account removal already clears the whole account folder.
7. For I-05, record the walk-around's frames as described under "ARKit frames upload" and send them as the video's `frames` file. iOS has no built-in zip writer; ZIPFoundation (MIT) writes one. Until then, models are made from the video alone.
8. The video-complete route (`POST /v1/captures/:captureId/equipment/:ref/video/complete`) now calls `buildOnArrival(machineId)` once the video is `ready` (one line, `src/modules/equipment.js`). It does nothing unless `ASSET_AUTO_BUILD` is on, and never fails the upload.
9. The `jobs-dead` alarm counts every job that dies, including those that end on purpose because the work cannot be done as things stand. Two examples: a plan whose walls do not meet (J-09 `too_few_walls`, `open_outline`), and a 360 video retaken while its build was queued. Both are already in front of the reviewer, so the alarm calls someone for nothing. One way out: a handler marks such an error as expected, for example with a flag on `PermanentJobError`, and the jobs framework counts it as something other than `JobsDead`. The 3D alarms already tell the two apart (N-03).
10. Monitoring (N-03) touches two shared files, a line or two each:
    - `infra/lib/monitoring-stack.ts` creates `ModelsMonitoring` (`infra/lib/models-monitoring.ts`) on the stack's alarm topic and dashboard.
    - The `plan.generate` handler in `backend/src/jobs/handlers.js` counts levels built and failed (`metric3d`, `levelFailed` from `src/metrics3d.js`).
11. The TRELLIS.2 image now has its own pipeline in the tooling account, `flexgym-trellis2-image` (N-05, `infra/lib/trellis2-image.ts`). Two things touch shared files and the release:
    - `pipeline-stack.ts` passes it the staging account (`goldenAccount`), whose GPU stack keeps the role the golden test runs as.
    - Once a person approves an image, the pipeline commits its digest into `infra/cdk.json` on the release branch, as "TRELLIS.2 image pipeline", and that commit starts a release. If the branch ever gets approval rules, that commit needs to be allowed through, or sent as a pull request instead.
12. KTX2 textures (N-01) need the Basis Universal transcoder in `web/vendor/basis/`, built without eval, because the app's script policy refuses three.js's own copy. `web/vite.config.js` gains `basisTranscoder()`, which points three's KTX2 loader at it. If a three.js upgrade moves that reference, the web build stops until the folder is rebuilt for the new version; its README and `build.sh` say how.
