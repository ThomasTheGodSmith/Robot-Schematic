import { Matrix4, Vector3 } from "three";

/** Oriented bounding box in world space. */
export interface OBB {
  center: Vector3;
  axes: [Vector3, Vector3, Vector3];
  half: [number, number, number];
}

export function makeOBB(world: Matrix4, half: [number, number, number], shrink = 0): OBB {
  const center = new Vector3().setFromMatrixPosition(world);
  const e = world.elements;
  const axes: [Vector3, Vector3, Vector3] = [
    new Vector3(e[0], e[1], e[2]).normalize(),
    new Vector3(e[4], e[5], e[6]).normalize(),
    new Vector3(e[8], e[9], e[10]).normalize(),
  ];
  return { center, axes, half: half.map((h) => Math.max(1e-5, h - shrink)) as [number, number, number] };
}

/** Separating-axis overlap test between two OBBs. */
export function obbOverlap(a: OBB, b: OBB): boolean {
  const t = b.center.clone().sub(a.center);
  // quick sphere rejection
  const ra0 = Math.hypot(...a.half), rb0 = Math.hypot(...b.half);
  if (t.length() > ra0 + rb0) return false;
  const R: number[][] = [], AbsR: number[][] = [];
  for (let i = 0; i < 3; i++) {
    R[i] = [];
    AbsR[i] = [];
    for (let j = 0; j < 3; j++) {
      R[i][j] = a.axes[i].dot(b.axes[j]);
      AbsR[i][j] = Math.abs(R[i][j]) + 1e-9;
    }
  }
  const T = [t.dot(a.axes[0]), t.dot(a.axes[1]), t.dot(a.axes[2])];
  const A = a.half, B = b.half;
  for (let i = 0; i < 3; i++) {
    const ra = A[i], rb = B[0] * AbsR[i][0] + B[1] * AbsR[i][1] + B[2] * AbsR[i][2];
    if (Math.abs(T[i]) > ra + rb) return false;
  }
  for (let j = 0; j < 3; j++) {
    const ra = A[0] * AbsR[0][j] + A[1] * AbsR[1][j] + A[2] * AbsR[2][j], rb = B[j];
    if (Math.abs(T[0] * R[0][j] + T[1] * R[1][j] + T[2] * R[2][j]) > ra + rb) return false;
  }
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      const i1 = (i + 1) % 3, i2 = (i + 2) % 3, j1 = (j + 1) % 3, j2 = (j + 2) % 3;
      const ra = A[i1] * AbsR[i2][j] + A[i2] * AbsR[i1][j];
      const rb = B[j1] * AbsR[i][j2] + B[j2] * AbsR[i][j1];
      if (Math.abs(T[i2] * R[i1][j] - T[i1] * R[i2][j]) > ra + rb) return false;
    }
  return true;
}
