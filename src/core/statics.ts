import { Matrix4, Vector3 } from "three";
import type { MassProps } from "./math/massprops";
import { axisVector, subtreeLinks, type Topology } from "./math/frames";

export interface PointForce {
  linkId: string;
  point: Vector3; // world
  force: Vector3; // world
}

export interface JointLoad {
  /** Torque (or force, prismatic) the actuator must supply about the joint axis */
  torque: number;
  /** Total force transmitted through the joint (bearing load), world frame */
  reaction: Vector3;
  /** Total moment transmitted through the joint about its anchor, world frame (structural load on the child link root) */
  moment: Vector3;
}

/**
 * Quasi-static joint loads. For every joint, sums gravity on the child subtree
 * plus external forces applied to it and takes moments about the joint anchor.
 * Exact for static equilibrium of a tree; dynamic effects are covered by the
 * caller's load factor.
 */
export function staticJointLoads(
  topo: Topology,
  linkT: Map<string, Matrix4>,
  linkMP: Map<string, MassProps>,
  external: PointForce[],
  gravity = new Vector3(0, 0, -9.81),
): Map<string, JointLoad> {
  const out = new Map<string, JointLoad>();
  const worldCom = new Map<string, Vector3>();
  for (const [id, mp] of linkMP) {
    const T = linkT.get(id);
    if (T) worldCom.set(id, mp.com.clone().applyMatrix4(T));
  }
  for (const j of topo.joints.values()) {
    const T = linkT.get(j.child);
    if (!T) continue;
    const anchor = new Vector3().setFromMatrixPosition(T);
    const axis = axisVector(j.axis).transformDirection(T);
    const sub = new Set(subtreeLinks(topo, j.child));
    const F = new Vector3();
    const M = new Vector3();
    for (const id of sub) {
      const mp = linkMP.get(id);
      const c = worldCom.get(id);
      if (!mp || !c) continue;
      const f = gravity.clone().multiplyScalar(mp.mass);
      F.add(f);
      M.add(c.clone().sub(anchor).cross(f));
    }
    for (const e of external) {
      if (!sub.has(e.linkId)) continue;
      F.add(e.force);
      M.add(e.point.clone().sub(anchor).cross(e.force));
    }
    const torque = j.type === "prismatic" ? -axis.dot(F) : -axis.dot(M);
    out.set(j.id, { torque, reaction: F.clone().negate(), moment: M.clone().negate() });
  }
  return out;
}
