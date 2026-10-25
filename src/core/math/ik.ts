import { Matrix4, Vector3 } from "three";
import { axisVector, forwardKinematics, type JointPositions, type Topology } from "./frames";

export interface IKResult {
  q: JointPositions;
  error: number;
  iterations: number;
}

/** World position of a link-local point. */
export function pointOnLink(linkT: Map<string, Matrix4>, linkId: string, local: number[]): Vector3 {
  return new Vector3(local[0], local[1], local[2]).applyMatrix4(linkT.get(linkId)!);
}

/**
 * Damped-least-squares position IK for a serial chain (e.g. one leg).
 * Only the joints in `chain` are moved; positions are clamped to joint limits.
 * `target` is expressed in the same frame as `base` (normally the root link frame).
 */
export function solveChainIK(
  topo: Topology,
  chain: string[],
  endLink: string,
  endPoint: number[],
  target: Vector3,
  q0: JointPositions,
  opts: { iterations?: number; lambda?: number; tol?: number; base?: Matrix4 } = {},
): IKResult {
  const iterations = opts.iterations ?? 60;
  const lambda = opts.lambda ?? 0.02;
  const tol = opts.tol ?? 1e-5;
  const q = { ...q0 };
  let err = Infinity;
  let it = 0;
  for (; it < iterations; it++) {
    const T = forwardKinematics(topo, q, opts.base);
    const p = pointOnLink(T, endLink, endPoint);
    const e = target.clone().sub(p);
    err = e.length();
    if (err < tol) break;
    // Jacobian columns
    const cols: Vector3[] = chain.map((jid) => {
      const j = topo.joints.get(jid)!;
      const Tc = T.get(j.child)!;
      const axis = axisVector(j.axis).transformDirection(Tc);
      if (j.type === "prismatic") return axis;
      if (j.type === "fixed") return new Vector3();
      const anchor = new Vector3().setFromMatrixPosition(Tc);
      return axis.clone().cross(p.clone().sub(anchor));
    });
    // dq = J^T (J J^T + λ² I)^-1 e  (3x3 solve)
    const A = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (const c of cols) {
      const v = [c.x, c.y, c.z];
      for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) A[r][k] += v[r] * v[k];
    }
    for (let r = 0; r < 3; r++) A[r][r] += lambda * lambda;
    const y = solve3(A, [e.x, e.y, e.z]);
    if (!y) break;
    const yv = new Vector3(y[0], y[1], y[2]);
    // Limit the step near singularities so the iteration cannot jump to a far branch.
    const dq = cols.map((c) => c.dot(yv));
    const maxStep = Math.max(...dq.map(Math.abs));
    const scale = maxStep > 0.25 ? 0.25 / maxStep : 1;
    chain.forEach((jid, i) => {
      const j = topo.joints.get(jid)!;
      let v = (q[jid] ?? 0) + dq[i] * scale;
      if (j.limits && j.type !== "continuous") v = Math.min(j.limits.upper, Math.max(j.limits.lower, v));
      q[jid] = v;
    });
  }
  return { q, error: err, iterations: it };
}

function solve3(A: number[][], b: number[]): number[] | null {
  const m = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-14) return null;
    [m[c], m[piv]] = [m[piv], m[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}
