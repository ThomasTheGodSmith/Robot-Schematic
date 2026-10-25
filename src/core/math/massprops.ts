import { Matrix4, Quaternion, Vector3 } from "three";
import type { Library } from "../library";
import type { Link, Part, RobotDesign } from "../schema/design";
import { poseToMatrix } from "./frames";
import { shapeInertia, shapeVolume } from "./shapes";
import type { Shape } from "../schema/common";

export type Mat3 = number[][]; // row-major 3x3

export const zero3 = (): Mat3 => [
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
];

export function addMat3(a: Mat3, b: Mat3): Mat3 {
  return a.map((row, i) => row.map((v, j) => v + b[i][j]));
}

/** R * diag(d) * R^T where R is the rotation of q. */
export function rotateDiagInertia(d: [number, number, number], q: Quaternion): Mat3 {
  const m = new Matrix4().makeRotationFromQuaternion(q).elements; // column-major
  const R = [
    [m[0], m[4], m[8]],
    [m[1], m[5], m[9]],
    [m[2], m[6], m[10]],
  ];
  const out = zero3();
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += R[i][k] * d[k] * R[j][k];
      out[i][j] = s;
    }
  return out;
}

/** Parallel-axis term m * (|r|^2 I - r r^T). */
export function parallelAxis(m: number, r: Vector3): Mat3 {
  const v = [r.x, r.y, r.z];
  const r2 = r.lengthSq();
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => m * ((i === j ? r2 : 0) - v[i] * v[j])));
}

/** Symmetric 3x3 eigen decomposition (cyclic Jacobi). Returns eigenvalues and column eigenvectors. */
export function symmetricEigen(A: Mat3): { values: [number, number, number]; vectors: Mat3 } {
  const a = A.map((r) => [...r]);
  const v: Mat3 = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
    if (off < 1e-30) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: [a[0][0], a[1][1], a[2][2]], vectors: v };
}

/** Quaternion for a set of column eigenvectors, flipping one if needed to keep a right-handed frame. */
export function eigenFrameQuaternion(vectors: Mat3): Quaternion {
  const c0 = new Vector3(vectors[0][0], vectors[1][0], vectors[2][0]);
  const c1 = new Vector3(vectors[0][1], vectors[1][1], vectors[2][1]);
  let c2 = new Vector3(vectors[0][2], vectors[1][2], vectors[2][2]);
  if (c0.clone().cross(c1).dot(c2) < 0) c2 = c2.negate();
  const m = new Matrix4().makeBasis(c0, c1, c2);
  return new Quaternion().setFromRotationMatrix(m);
}

export interface PartMass {
  partId: string;
  mass: number;
  /** Centroid in link frame */
  com: Vector3;
  shape: Shape;
  /** Pose of the shape in the link frame */
  transform: Matrix4;
  materialId?: string;
  componentId?: string;
}

export interface MassProps {
  mass: number;
  com: Vector3;
  /** Inertia about the COM, expressed in the owning frame */
  inertia: Mat3;
}

/** Resolve a part's mass and shape. Unknown materials/components yield mass 0 (flagged by the validator). */
export function partMass(part: Part, lib: Library): PartMass {
  const transform = poseToMatrix(part.pose);
  const com = new Vector3().setFromMatrixPosition(transform);
  if (part.kind === "fabricated") {
    const mat = lib.material(part.material);
    const mass = mat ? shapeVolume(part.shape) * mat.density_kg_m3 : 0;
    return { partId: part.id, mass, com, shape: part.shape, transform, materialId: part.material };
  }
  const c = lib.get(part.componentId);
  return {
    partId: part.id,
    mass: c?.mass_kg ?? 0,
    com,
    shape: c?.envelope ?? { type: "sphere", radius: 0.005 },
    transform,
    componentId: part.componentId,
  };
}

export function combine(items: { mass: number; com: Vector3; inertia: Mat3 }[]): MassProps {
  const mass = items.reduce((s, i) => s + i.mass, 0);
  const com = new Vector3();
  if (mass > 0) {
    for (const i of items) com.addScaledVector(i.com, i.mass);
    com.divideScalar(mass);
  }
  let inertia = zero3();
  for (const i of items) inertia = addMat3(addMat3(inertia, i.inertia), parallelAxis(i.mass, i.com.clone().sub(com)));
  return { mass, com, inertia };
}

export interface LinkMassProps extends MassProps {
  parts: PartMass[];
}

export function linkMassProps(link: Link, lib: Library, extraPointMasses: { mass: number; at: Vector3 }[] = []): LinkMassProps {
  const parts = link.parts.map((p) => partMass(p, lib));
  const items = parts.map((p) => {
    const q = new Quaternion().setFromRotationMatrix(p.transform);
    return { mass: p.mass, com: p.com, inertia: rotateDiagInertia(shapeInertia(p.shape, p.mass), q) };
  });
  for (const e of extraPointMasses) items.push({ mass: e.mass, com: e.at.clone(), inertia: zero3() });
  return { ...combine(items), parts };
}

/** Mass properties of every link, including the requirement payload as a point mass. */
export function allLinkMassProps(design: RobotDesign, lib: Library, includePayload = true): Map<string, LinkMassProps> {
  const out = new Map<string, LinkMassProps>();
  const req = design.requirements;
  const payloadLink = req.payloadLinkId ?? design.rootLink;
  for (const l of design.links) {
    const extra =
      includePayload && req.payload_kg > 0 && l.id === payloadLink
        ? [{ mass: req.payload_kg, at: new Vector3(...(req.payloadOffset as [number, number, number])) }]
        : [];
    out.set(l.id, linkMassProps(l, lib, extra));
  }
  return out;
}

/** Whole-robot COM in world frame for given link transforms. */
export function robotCom(linkMP: Map<string, MassProps>, linkT: Map<string, Matrix4>): { mass: number; com: Vector3 } {
  let mass = 0;
  const com = new Vector3();
  for (const [id, mp] of linkMP) {
    const T = linkT.get(id);
    if (!T) continue;
    com.addScaledVector(mp.com.clone().applyMatrix4(T), mp.mass);
    mass += mp.mass;
  }
  if (mass > 0) com.divideScalar(mass);
  return { mass, com };
}
