/** H-03: reading the scan mesh and flattening it onto the floor. */
import { describe, expect, it } from 'vitest';

import { floorTriangles, meshFile, parseObj, trianglesPath } from './scanMesh.js';

// A 2 × 1 m floor quad and one wall face, as RoomPlan's exporter writes them.
const OBJ = `# Flex Gym Scan mesh
mtllib mesh.mtl
o floor
v 0 0 0
v 2 0 0
v 2 0 1
v 0 0 1
vt 0 0
vn 0 1 0
usemtl floor
f 1/1/1 2/1/1 3/1/1 4/1/1
o wall
v 0 0 0
v 2 0 0
v 2 2.5 0
f -3 -2 -1
v not a number
`;

describe('parseObj', () => {
  it('reads vertices and fans polygons into triangles', () => {
    const mesh = parseObj(OBJ);
    // Eight vertices: the bad one keeps its place in the numbering.
    expect(mesh.vertices.length).toBe(8 * 3);
    expect(Array.from(mesh.triangles)).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6]);
  });

  it('resolves negative indices against the vertices read so far', () => {
    const mesh = parseObj('v 0 0 0\nv 1 0 0\nv 1 0 1\nf -3 -2 -1\nv 5 5 5\nf -1 -2 -3');
    expect(Array.from(mesh.triangles)).toEqual([0, 1, 2, 3, 2, 1]);
  });

  it('skips faces that point at vertices that do not exist, and CRLF files work', () => {
    const mesh = parseObj('v 0 0 0\r\nv 1 0 0\r\nv 1 0 1\r\nf 1 2 3\r\nf 1 2 9\r\n');
    expect(Array.from(mesh.triangles)).toEqual([0, 1, 2]);
    expect(parseObj('').triangles.length).toBe(0);
  });
});

describe('floorTriangles', () => {
  it('maps OBJ x and z to the plan, and drops faces standing on edge', () => {
    const flat = floorTriangles(parseObj(OBJ));
    // The two floor triangles survive; the vertical wall face flattens to nothing.
    expect(flat.length).toBe(12);
    expect(Array.from(flat.slice(0, 6))).toEqual([0, 0, 2, 0, 2, 1]);
  });

  it('thins a big mesh evenly to the cap', () => {
    const lines = [];
    for (let i = 0; i < 300; i++) lines.push(`v ${i} 0 0`, `v ${i + 1} 0 0`, `v ${i} 0 1`);
    for (let i = 0; i < 300; i++) lines.push(`f ${i * 3 + 1} ${i * 3 + 2} ${i * 3 + 3}`);
    const flat = floorTriangles(parseObj(lines.join('\n')), { maxTriangles: 100 });
    expect(flat.length).toBe(600);
    // Spread over the whole mesh, not the first hundred.
    expect(flat[flat.length - 6]).toBeGreaterThan(250);
  });
});

describe('drawing', () => {
  it('makes one path of closed triangles', () => {
    expect(trianglesPath(new Float32Array([0, 0, 2, 0, 2, 1]))).toBe('M0 0L2 0L2 1Z');
    expect(trianglesPath(new Float32Array())).toBe('');
  });

  it('finds the mesh file among a version’s files', () => {
    expect(meshFile([{ kind: 'photo', url: 'x' }])).toBeNull();
    expect(meshFile([{ kind: 'mesh', name: 'mesh.obj', url: 'https://s/mesh.obj?sig' }]).name).toBe('mesh.obj');
  });
});
