import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import type { Joint, Link, RobotDesign } from "../schema/design";
import type { Pose } from "../schema/common";

/** URDF rpy (fixed X, then Y, then Z) == intrinsic Z-Y-X. */
export function rpyToQuaternion(rpy: number[]): Quaternion {
  return new Quaternion().setFromEuler(new Euler(rpy[0], rpy[1], rpy[2], "ZYX"));
}

export function poseToMatrix(pose: Pose | undefined): Matrix4 {
  const m = new Matrix4();
  if (!pose) return m;
  return m.compose(new Vector3(...(pose.xyz as [number, number, number])), rpyToQuaternion(pose.rpy), new Vector3(1, 1, 1));
}

export function axisVector(axis: number[]): Vector3 {
  const v = new Vector3(axis[0], axis[1], axis[2]);
  if (v.lengthSq() < 1e-12) return new Vector3(0, 0, 1);
  return v.normalize();
}

/** Transform from the joint's child link frame to its parent link frame for joint position q. */
export function jointTransform(joint: Joint, q: number): Matrix4 {
  const origin = poseToMatrix(joint.origin);
  const motion = new Matrix4();
  if (joint.type === "revolute" || joint.type === "continuous") {
    motion.makeRotationAxis(axisVector(joint.axis), q);
  } else if (joint.type === "prismatic") {
    const a = axisVector(joint.axis).multiplyScalar(q);
    motion.makeTranslation(a.x, a.y, a.z);
  }
  return origin.multiply(motion);
}

export interface Topology {
  links: Map<string, Link>;
  joints: Map<string, Joint>;
  /** child link id -> joint connecting it to its parent */
  parentJoint: Map<string, Joint>;
  /** link id -> joints whose parent is this link */
  childJoints: Map<string, Joint[]>;
  /** link ids in depth-first order from the root */
  order: string[];
  errors: string[];
}

export function buildTopology(design: Pick<RobotDesign, "links" | "joints" | "rootLink">): Topology {
  const errors: string[] = [];
  const links = new Map(design.links.map((l) => [l.id, l] as const));
  const joints = new Map(design.joints.map((j) => [j.id, j] as const));
  const parentJoint = new Map<string, Joint>();
  const childJoints = new Map<string, Joint[]>();
  for (const j of design.joints) {
    if (!links.has(j.parent)) errors.push(`Joint '${j.id}' references unknown parent link '${j.parent}'`);
    if (!links.has(j.child)) errors.push(`Joint '${j.id}' references unknown child link '${j.child}'`);
    if (parentJoint.has(j.child)) errors.push(`Link '${j.child}' has more than one parent joint (kinematic loops are not supported)`);
    parentJoint.set(j.child, j);
    childJoints.set(j.parent, [...(childJoints.get(j.parent) ?? []), j]);
  }
  if (!links.has(design.rootLink)) errors.push(`Root link '${design.rootLink}' does not exist`);
  if (parentJoint.has(design.rootLink)) errors.push(`Root link '${design.rootLink}' must not be the child of a joint`);
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) {
      errors.push(`Cycle detected at link '${id}'`);
      return;
    }
    seen.add(id);
    order.push(id);
    for (const j of childJoints.get(id) ?? []) visit(j.child);
  };
  if (links.has(design.rootLink)) visit(design.rootLink);
  for (const l of design.links) if (!seen.has(l.id)) errors.push(`Link '${l.id}' is not connected to the root link`);
  return { links, joints, parentJoint, childJoints, order, errors };
}

export type JointPositions = Record<string, number>;

/** World transforms of every link frame. `base` places the root link. */
export function forwardKinematics(topo: Topology, q: JointPositions, base: Matrix4 = new Matrix4()): Map<string, Matrix4> {
  const out = new Map<string, Matrix4>();
  for (const id of topo.order) {
    const pj = topo.parentJoint.get(id);
    if (!pj) {
      out.set(id, base.clone());
      continue;
    }
    const parentT = out.get(pj.parent)!;
    out.set(id, parentT.clone().multiply(jointTransform(pj, q[pj.id] ?? 0)));
  }
  return out;
}

/** World-space joint axis and anchor (child frame origin) for each joint, given link transforms. */
export function jointWorldFrames(topo: Topology, linkT: Map<string, Matrix4>) {
  const out = new Map<string, { anchor: Vector3; axis: Vector3 }>();
  for (const j of topo.joints.values()) {
    const T = linkT.get(j.child);
    if (!T) continue;
    const anchor = new Vector3().setFromMatrixPosition(T);
    const axis = axisVector(j.axis).transformDirection(T);
    out.set(j.id, { anchor, axis });
  }
  return out;
}

/** Chain of joints from the root down to (and including) the parent joint of `linkId`. */
export function chainToLink(topo: Topology, linkId: string): Joint[] {
  const chain: Joint[] = [];
  let cur = linkId;
  while (topo.parentJoint.has(cur)) {
    const j = topo.parentJoint.get(cur)!;
    chain.unshift(j);
    cur = j.parent;
  }
  return chain;
}

/** All link ids in the subtree rooted at `linkId` (inclusive). */
export function subtreeLinks(topo: Topology, linkId: string): string[] {
  const out: string[] = [];
  const stack = [linkId];
  while (stack.length) {
    const id = stack.pop()!;
    out.push(id);
    for (const j of topo.childJoints.get(id) ?? []) stack.push(j.child);
  }
  return out;
}

export function defaultJointPositions(design: Pick<RobotDesign, "joints" | "behavior">): JointPositions {
  const q: JointPositions = {};
  for (const j of design.joints) {
    let v = design.behavior.nominalPose[j.id] ?? 0;
    if (j.limits && j.type !== "continuous") v = Math.min(j.limits.upper, Math.max(j.limits.lower, v));
    q[j.id] = v;
  }
  return q;
}
