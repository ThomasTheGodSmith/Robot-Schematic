import { Matrix4, Vector3 } from "three";
import type { RobotDesign } from "./schema/design";
import { defaultJointPositions, forwardKinematics, type JointPositions, type Topology } from "./math/frames";
import { pointOnLink, solveChainIK } from "./math/ik";

/**
 * Behaviour trajectories shared by the validator (to derive operating points)
 * and the simulator controller (to generate set-points), so that what is
 * validated is what is simulated.
 */

export type Gait = NonNullable<RobotDesign["behavior"]["gait"]>;

/** Foot offset (forward x, up z) from its nominal position, in the body frame, for a leg phase in [0,1). */
export function footOffset(phase: number, gait: Pick<Gait, "dutyFactor" | "strideLength_m" | "stepHeight_m">): { dx: number; dz: number; stance: boolean } {
  const p = ((phase % 1) + 1) % 1;
  const d = gait.dutyFactor;
  const L = gait.strideLength_m;
  if (p < d) {
    const s = p / d;
    return { dx: L / 2 - L * s, dz: 0, stance: true };
  }
  const s = (p - d) / (1 - d);
  return { dx: -L / 2 + (L * (1 - Math.cos(Math.PI * s))) / 2, dz: gait.stepHeight_m * Math.sin(Math.PI * s), stance: false };
}

export function legPhase(t: number, gait: Gait, legIndex: number): number {
  return t * gait.frequency_Hz + gait.legs[legIndex].phase;
}

/** Nominal foot contact points in the root frame (from the nominal pose). */
export function nominalFeet(design: RobotDesign, topo: Topology): Map<string, Vector3> {
  const q = defaultJointPositions(design);
  const T = forwardKinematics(topo, q);
  const out = new Map<string, Vector3>();
  for (const leg of design.behavior.gait?.legs ?? []) {
    const link = topo.links.get(leg.footLinkId);
    if (!link) continue;
    out.set(leg.name, pointOnLink(T, leg.footLinkId, link.contact?.point ?? [0, 0, 0]));
  }
  return out;
}

export interface BehaviorSample {
  t: number;
  q: JointPositions;
  /** Feet (link ids) in contact with the ground in this sample */
  stanceLinks: string[];
  ikError: number;
}

/** Sample one cycle of the design's behaviour as joint positions + contact sets. */
export function sampleBehavior(design: RobotDesign, topo: Topology, n = 32): BehaviorSample[] {
  const b = design.behavior;
  const q0 = defaultJointPositions(design);
  const allContacts = design.links.filter((l) => l.contact).map((l) => l.id);
  if (b.mode === "legged_gait" && b.gait && b.gait.legs.length) {
    const gait = b.gait;
    const feet = nominalFeet(design, topo);
    const period = 1 / gait.frequency_Hz;
    const samples: BehaviorSample[] = [];
    let qPrev = { ...q0 };
    for (let i = 0; i < n; i++) {
      const t = (i / n) * period;
      const q = { ...qPrev };
      const stance: string[] = [];
      let ikError = 0;
      gait.legs.forEach((leg, li) => {
        const off = footOffset(legPhase(t, gait, li), gait);
        if (off.stance) stance.push(leg.footLinkId);
        const nominal = feet.get(leg.name);
        const link = topo.links.get(leg.footLinkId);
        if (!nominal || !link) return;
        const target = nominal.clone().add(new Vector3(off.dx, 0, off.dz));
        const r = solveChainIK(topo, leg.jointIds, leg.footLinkId, link.contact?.point ?? [0, 0, 0], target, q);
        Object.assign(q, Object.fromEntries(leg.jointIds.map((j) => [j, r.q[j]])));
        ikError = Math.max(ikError, r.error);
      });
      samples.push({ t, q, stanceLinks: stance, ikError });
      qPrev = q;
    }
    return samples;
  }
  if (b.mode === "manipulator" && b.manipulator) {
    const wps = b.manipulator.waypoints;
    const T = wps[wps.length - 1].t || 1;
    const samples: BehaviorSample[] = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * T;
      samples.push({ t, q: manipulatorPose(design, t), stanceLinks: allContacts, ikError: 0 });
    }
    return samples;
  }
  return [{ t: 0, q: q0, stanceLinks: allContacts, ikError: 0 }];
}

/** Joint-space waypoint interpolation with smoothstep blending. */
export function manipulatorPose(design: RobotDesign, t: number): JointPositions {
  const q0 = defaultJointPositions(design);
  const m = design.behavior.manipulator;
  if (!m) return q0;
  const wps = [...m.waypoints].sort((a, b) => a.t - b.t);
  const Tend = wps[wps.length - 1].t;
  let tt = m.loop && Tend > 0 ? t % Tend : Math.min(t, Tend);
  let k = 0;
  while (k < wps.length - 2 && tt > wps[k + 1].t) k++;
  const a = wps[k], b = wps[k + 1];
  const span = Math.max(1e-6, b.t - a.t);
  const s = Math.min(1, Math.max(0, (tt - a.t) / span));
  const w = s * s * (3 - 2 * s);
  const q = { ...q0 };
  for (const jid of Object.keys(q0)) {
    const qa = a.pose[jid] ?? q0[jid];
    const qb = b.pose[jid] ?? q0[jid];
    q[jid] = qa + (qb - qa) * w;
  }
  return q;
}

/** Finite-difference joint velocities for a cyclic sample set. */
export function sampleVelocities(samples: BehaviorSample[], period: number): JointPositions[] {
  const n = samples.length;
  if (n < 2) return samples.map((s) => Object.fromEntries(Object.keys(s.q).map((k) => [k, 0])));
  const dt = period / n;
  return samples.map((s, i) => {
    const a = samples[(i - 1 + n) % n].q, b = samples[(i + 1) % n].q;
    return Object.fromEntries(Object.keys(s.q).map((k) => [k, ((b[k] ?? 0) - (a[k] ?? 0)) / (2 * dt)]));
  });
}

export function behaviorPeriod(design: RobotDesign): number {
  const b = design.behavior;
  if (b.mode === "legged_gait" && b.gait) return 1 / b.gait.frequency_Hz;
  if (b.mode === "manipulator" && b.manipulator) return b.manipulator.waypoints[b.manipulator.waypoints.length - 1].t || 1;
  return 1;
}

/** Lowest world z of contact points in a pose (root at identity), used to place the robot on the ground. */
export function lowestContactZ(design: RobotDesign, topo: Topology, q: JointPositions, base = new Matrix4()): number {
  const T = forwardKinematics(topo, q, base);
  let z = Infinity;
  for (const l of design.links) {
    if (!l.contact) continue;
    const p = pointOnLink(T, l.id, l.contact.point);
    z = Math.min(z, p.z - l.contact.radius);
  }
  return z;
}
