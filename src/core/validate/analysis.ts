import { Matrix4, Vector3 } from "three";
import type { Library } from "../library";
import type { Part, RobotDesign } from "../schema/design";
import { buildTopology, defaultJointPositions, forwardKinematics, type JointPositions, type Topology } from "../math/frames";
import { allLinkMassProps, robotCom, type LinkMassProps } from "../math/massprops";
import { isResolved, motorElectrical, resolveDrivetrain, type ResolvedDrivetrain } from "../drivetrain";
import { behaviorPeriod, sampleBehavior, sampleVelocities, type BehaviorSample } from "../behavior";
import { staticJointLoads, type JointLoad, type PointForce } from "../statics";
import { pointOnLink } from "../math/ik";
import { poseToMatrix } from "../math/frames";

export interface PartRef {
  part: Part;
  linkId: string;
}

export interface BatteryPack {
  partIds: string[];
  voltage: number;
  minVoltage: number;
  capacity_Ah: number;
  energy_Wh: number;
  maxContinuous_A: number;
  peak_A: number;
  internalResistance: number;
}

export interface JointOps {
  /** Peak-case torque per sample (dynamic load factor applied) */
  torquePeak: number[];
  /** Nominal static torque per sample */
  torqueStatic: number[];
  speed: number[];
}

export interface Analysis {
  design: RobotDesign;
  lib: Library;
  topo: Topology;
  linkMP: Map<string, LinkMassProps>;
  totalMass: number;
  q0: JointPositions;
  T0: Map<string, Matrix4>;
  parts: Map<string, PartRef>;
  partWorld0: Map<string, Matrix4>;
  drivetrains: Map<string, ResolvedDrivetrain>; // keyed by joint id
  drivetrainErrors: string[];
  samples: BehaviorSample[];
  period: number;
  velocities: JointPositions[];
  ops: Map<string, JointOps>;
  /** Max (over samples) joint loads in the peak case */
  peakLoads: Map<string, { reaction: number; moment: Vector3; momentMag: number; torque: number }>;
  /** Per-sample world contact forces in the peak case (for structural checks of the root) */
  peakContacts: PointForce[][];
  battery: BatteryPack | null;
  busVoltage: number | null;
  /** Per-sample total motor electrical power (static case), W */
  motorPowerStatic: number[];
  /** Per-sample total motor electrical power (peak case), W */
  motorPowerPeak: number[];
}

export function buildAnalysis(design: RobotDesign, lib: Library): Analysis {
  const topo = buildTopology(design);
  const linkMP = allLinkMassProps(design, lib);
  const totalMass = [...linkMP.values()].reduce((s, m) => s + m.mass, 0);
  const q0 = defaultJointPositions(design);
  const T0 = forwardKinematics(topo, q0);

  const parts = new Map<string, PartRef>();
  const partWorld0 = new Map<string, Matrix4>();
  for (const l of design.links)
    for (const p of l.parts) {
      parts.set(p.id, { part: p, linkId: l.id });
      const T = T0.get(l.id);
      if (T) partWorld0.set(p.id, T.clone().multiply(poseToMatrix(p.pose)));
    }

  const drivetrains = new Map<string, ResolvedDrivetrain>();
  const drivetrainErrors: string[] = [];
  for (const dt of design.drivetrains) {
    const r = resolveDrivetrain(dt, design, lib);
    if (isResolved(r)) {
      drivetrains.set(dt.jointId, r);
      drivetrainErrors.push(...r.errors.map((e) => `${dt.id}: ${e}`));
    } else drivetrainErrors.push(...r.errors.map((e) => `${dt.id}: ${e}`));
  }

  const samples = topo.errors.length ? [{ t: 0, q: q0, stanceLinks: [], ikError: 0 }] : sampleBehavior(design, topo, 32);
  const period = behaviorPeriod(design);
  const velocities = sampleVelocities(samples, period);

  const g = 9.81;
  const W = totalMass * g;
  const dlf = design.requirements.dynamicLoadFactor;
  const ops = new Map<string, JointOps>();
  for (const j of design.joints) ops.set(j.id, { torquePeak: [], torqueStatic: [], speed: [] });
  const peakLoads = new Map<string, { reaction: number; moment: Vector3; momentMag: number; torque: number }>();
  const peakContacts: PointForce[][] = [];

  const contactsFor = (T: Map<string, Matrix4>, stance: string[], factor: number): PointForce[] => {
    if (design.rootFixed || stance.length === 0) return [];
    const f = (W * factor) / stance.length;
    return stance.map((id) => {
      const link = topo.links.get(id)!;
      return { linkId: id, point: pointOnLink(T, id, link.contact?.point ?? [0, 0, 0]), force: new Vector3(0, 0, f) };
    });
  };

  samples.forEach((s, i) => {
    const T = forwardKinematics(topo, s.q);
    const cPeak = contactsFor(T, s.stanceLinks, dlf);
    const cStatic = contactsFor(T, s.stanceLinks, 1);
    peakContacts.push(cPeak);
    const lp = staticJointLoads(topo, T, linkMP, cPeak, new Vector3(0, 0, -g * dlf));
    const ls = staticJointLoads(topo, T, linkMP, cStatic, new Vector3(0, 0, -g));
    for (const j of design.joints) {
      const o = ops.get(j.id)!;
      const p = lp.get(j.id), st = ls.get(j.id);
      o.torquePeak.push(p?.torque ?? 0);
      o.torqueStatic.push(st?.torque ?? 0);
      o.speed.push(velocities[i]?.[j.id] ?? 0);
      if (p) mergePeak(peakLoads, j.id, p);
    }
  });

  // Slope load case (nominal pose, gravity tilted about the body's lateral axis).
  if (design.requirements.maxSlope_deg > 0 && !design.rootFixed) {
    const th = (design.requirements.maxSlope_deg * Math.PI) / 180;
    const gv = new Vector3(-Math.sin(th), 0, -Math.cos(th)).multiplyScalar(g * dlf);
    const stance = design.links.filter((l) => l.contact).map((l) => l.id);
    const cs = contactsFor(T0, stance, dlf).map((c) => ({ ...c, force: gv.clone().negate().multiplyScalar(totalMass / stance.length) }));
    const lp = staticJointLoads(topo, T0, linkMP, cs, gv);
    for (const j of design.joints) {
      const p = lp.get(j.id);
      if (!p) continue;
      ops.get(j.id)!.torquePeak.push(p.torque);
      ops.get(j.id)!.torqueStatic.push(p.torque / dlf);
      ops.get(j.id)!.speed.push(0);
      mergePeak(peakLoads, j.id, p);
    }
  }

  // Manipulators: apply the dynamic factor as an acceleration allowance on gravity loads (already in lp via g*dlf).

  const battery = resolveBattery(design, lib, parts);
  const busVoltage = battery?.voltage ?? null;

  const nOps = Math.max(...[...ops.values()].map((o) => o.torquePeak.length), 0);
  const motorPowerStatic = new Array(nOps).fill(0);
  const motorPowerPeak = new Array(nOps).fill(0);
  for (const [jid, rd] of drivetrains) {
    const o = ops.get(jid);
    if (!o) continue;
    for (let i = 0; i < o.torquePeak.length; i++) {
      motorPowerStatic[i] += motorElectrical(rd, o.torqueStatic[i], o.speed[i]).electricalPower;
      motorPowerPeak[i] += motorElectrical(rd, o.torquePeak[i], o.speed[i]).electricalPower;
    }
  }

  return {
    design,
    lib,
    topo,
    linkMP,
    totalMass,
    q0,
    T0,
    parts,
    partWorld0,
    drivetrains,
    drivetrainErrors,
    samples,
    period,
    velocities,
    ops,
    peakLoads,
    peakContacts,
    battery,
    busVoltage,
    motorPowerStatic,
    motorPowerPeak,
  };
}

function mergePeak(map: Map<string, { reaction: number; moment: Vector3; momentMag: number; torque: number }>, id: string, l: JointLoad) {
  const cur = map.get(id);
  const r = l.reaction.length(), mm = l.moment.length();
  if (!cur) {
    map.set(id, { reaction: r, moment: l.moment.clone(), momentMag: mm, torque: Math.abs(l.torque) });
    return;
  }
  cur.reaction = Math.max(cur.reaction, r);
  if (mm > cur.momentMag) {
    cur.moment = l.moment.clone();
    cur.momentMag = mm;
  }
  cur.torque = Math.max(cur.torque, Math.abs(l.torque));
}

export function resolveBattery(design: RobotDesign, lib: Library, parts: Map<string, PartRef>): BatteryPack | null {
  const packs = design.power.batteryPartIds
    .map((id) => parts.get(id)?.part)
    .filter((p): p is Extract<Part, { kind: "component" }> => !!p && p.kind === "component")
    .map((p) => ({ id: p.id, c: lib.getAs(p.componentId, "battery") }))
    .filter((x) => !!x.c);
  if (!packs.length) return null;
  const specs = packs.map((p) => p.c!.specs);
  const n = specs.length;
  const s0 = specs[0];
  const series = design.power.batteryConfig === "series";
  const voltage = series ? specs.reduce((s, b) => s + b.nominalVoltage_V, 0) : s0.nominalVoltage_V;
  const minVoltage = series ? specs.reduce((s, b) => s + b.minVoltage_V, 0) : s0.minVoltage_V;
  const capacity = series ? Math.min(...specs.map((b) => b.capacity_Ah)) : specs.reduce((s, b) => s + b.capacity_Ah, 0);
  const maxCont = series
    ? Math.min(...specs.map((b) => b.capacity_Ah * b.maxContinuousDischarge_C))
    : specs.reduce((s, b) => s + b.capacity_Ah * b.maxContinuousDischarge_C, 0);
  const peak = series
    ? Math.min(...specs.map((b) => b.capacity_Ah * b.peakDischarge_C))
    : specs.reduce((s, b) => s + b.capacity_Ah * b.peakDischarge_C, 0);
  const ir = series ? specs.reduce((s, b) => s + b.internalResistance_ohm, 0) : 1 / specs.reduce((s, b) => s + 1 / b.internalResistance_ohm, 0);
  void n;
  return {
    partIds: packs.map((p) => p.id),
    voltage,
    minVoltage,
    capacity_Ah: capacity,
    energy_Wh: voltage * capacity,
    maxContinuous_A: maxCont,
    peak_A: peak,
    internalResistance: ir,
  };
}

export function rms(xs: number[]): number {
  if (!xs.length) return 0;
  return Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / xs.length);
}

export function maxAbs(xs: number[]): number {
  return xs.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
}

export function robotComNominal(a: Analysis) {
  return robotCom(a.linkMP, a.T0);
}
