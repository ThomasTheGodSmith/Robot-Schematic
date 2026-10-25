import RAPIER from "@dimforge/rapier3d-compat";
import { Matrix4, Quaternion, Vector3 } from "three";
import type { Library } from "../core/library";
import type { Joint, Part, RobotDesign } from "../core/schema/design";
import type { Shape } from "../core/schema/common";
import {
  axisVector,
  buildTopology,
  defaultJointPositions,
  forwardKinematics,
  poseToMatrix,
  rpyToQuaternion,
  type JointPositions,
  type Topology,
} from "../core/math/frames";
import { allLinkMassProps, eigenFrameQuaternion, symmetricEigen, type LinkMassProps } from "../core/math/massprops";
import { pointOnLink, solveChainIK } from "../core/math/ik";
import { footOffset, legPhase, manipulatorPose, nominalFeet } from "../core/behavior";
import { staticJointLoads, type PointForce } from "../core/statics";
import { isResolved, motorElectrical, outputTorqueAt, resolveDrivetrain, type ResolvedDrivetrain } from "../core/drivetrain";
import { resolveBattery, type BatteryPack, type PartRef } from "../core/validate/analysis";
import type { JointTelemetry, ScenarioId, SimFrame, WorldDescriptor } from "./types";

let initPromise: Promise<void> | null = null;
/** Initialise the Rapier WASM module (idempotent). */
export function initPhysics(): Promise<void> {
  if (!initPromise) initPromise = RAPIER.init();
  return initPromise;
}

const G = 9.81;
const THERMAL_TAU_S = 90;
const CONTROL_HZ = 250;
const STAND_TIME_S = 1.0;
const RAMP_TIME_S = 1.0;
/**
 * Smart-servo datasheets rarely give rotor inertia. Small coreless/iron-core servo motors
 * have roughly 2e-6 kg·m² of rotor inertia per N·m of rotor stall torque; used only when
 * the library entry has no rotor inertia.
 */
const SERVO_ROTOR_INERTIA_PER_NM = 2e-6;

const X = new Vector3(1, 0, 0);
const v3 = (v: { x: number; y: number; z: number }) => new Vector3(v.x, v.y, v.z);
const q4 = (q: { x: number; y: number; z: number; w: number }) => new Quaternion(q.x, q.y, q.z, q.w);
const rv = (v: Vector3) => ({ x: v.x, y: v.y, z: v.z });
const rq = (q: Quaternion) => ({ x: q.x, y: q.y, z: q.z, w: q.w });

/** Minimal rotation taking +X onto `v` (matches Rapier's construction of joint frames from an axis). */
export function frameFromAxis(v: Vector3): Quaternion {
  const u = v.clone().normalize();
  if (u.dot(X) < -1 + 1e-9) return new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
  return new Quaternion().setFromUnitVectors(X, u);
}

/** Signed rotation angle of `q` about unit axis `a` (swing-twist twist angle). */
export function twistAngle(q: Quaternion, a: Vector3): number {
  const d = q.x * a.x + q.y * a.y + q.z * a.z;
  let ang = 2 * Math.atan2(d, q.w);
  if (ang > Math.PI) ang -= 2 * Math.PI;
  if (ang < -Math.PI) ang += 2 * Math.PI;
  return ang;
}

const wrap = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
};

interface SimJoint {
  joint: Joint;
  parent: RAPIER.RigidBody;
  child: RAPIER.RigidBody;
  axisLocal: Vector3; // in child frame
  originQ: Quaternion; // joint origin rotation (child frame wrt parent frame at q=0)
  originInv: Quaternion;
  rd?: ResolvedDrivetrain;
  kp: number;
  kd: number;
  /** True when Rapier enforces the limits; otherwise a soft stop is applied by us */
  hardLimits: boolean;
  target: number;
  targetVel: number;
  ff: number;
  cmd: number;
  applied: number;
  limit: number;
  saturated: boolean;
  temp: number;
  overheated: boolean;
  current: number;
  power: number;
  q: number;
  qd: number;
}

export interface SimOptions {
  scenario?: ScenarioId;
  dt?: number;
}

export class RobotSimulator {
  readonly design: RobotDesign;
  readonly lib: Library;
  readonly scenario: ScenarioId;
  readonly dt: number;
  time = 0;

  private topo: Topology;
  private rapier!: RAPIER.World;
  private bodies = new Map<string, RAPIER.RigidBody>();
  private joints: SimJoint[] = [];
  private contactColliders = new Map<string, RAPIER.Collider[]>();
  private massProps!: Map<string, LinkMassProps>;
  private totalMass = 0;
  private q0: JointPositions;
  private qTargetsIK: JointPositions;
  private feetNominal = new Map<string, Vector3>();
  private battery: BatteryPack | null;
  private electronicsW: number;
  private socJ = 0;
  private energyJ = 1;
  private lastBatteryCurrent = 0;
  private lastPower = 0;
  private controlEvery: number;
  private stepCount = 0;
  private initialHeight = 0;
  private startX = 0;
  private fallen = false;
  private fallMessage?: string;
  private pushUntil = -1;
  private pushForce = new Vector3();
  private nextAutoPush = 3;
  private slopeRad = 0;
  private worldDesc!: WorldDescriptor;
  private rootBody!: RAPIER.RigidBody;
  private armature = new Map<string, number[][]>();
  private gravityFilt = new Vector3(0, 0, -1);
  private nominalHeight = 0.3;

  constructor(design: RobotDesign, lib: Library, opts: SimOptions = {}) {
    this.design = design;
    this.lib = lib;
    this.scenario = opts.scenario ?? "flat";
    this.dt = opts.dt ?? 1 / 500;
    this.controlEvery = Math.max(1, Math.round(1 / CONTROL_HZ / this.dt));
    this.topo = buildTopology(design);
    if (this.topo.errors.length) throw new Error(`Cannot simulate: ${this.topo.errors.join("; ")}`);
    this.q0 = defaultJointPositions(design);
    this.qTargetsIK = { ...this.q0 };
    const parts = new Map<string, PartRef>();
    for (const l of design.links) for (const p of l.parts) parts.set(p.id, { part: p, linkId: l.id });
    this.battery = resolveBattery(design, lib, parts);
    this.electronicsW = electronicsTypicalPower(design, lib);
    this.build();
  }

  // ------------------------------------------------------------------ build
  private build() {
    const d = this.design;
    this.time = 0;
    this.stepCount = 0;
    this.fallen = false;
    this.fallMessage = undefined;
    this.pushUntil = -1;
    this.nextAutoPush = 3;
    this.bodies.clear();
    this.joints = [];
    this.contactColliders.clear();
    this.qTargetsIK = { ...this.q0 };
    this.energyJ = (this.battery?.energy_Wh ?? 0) * 3600;
    this.socJ = this.energyJ;

    // Mass properties (payload only in the payload scenario)
    let mpDesign = d;
    let payloadMass = 0;
    if (this.scenario === "payload") {
      const base = allLinkMassProps(d, this.lib, false);
      const m0 = [...base.values()].reduce((s, m) => s + m.mass, 0);
      payloadMass = d.requirements.payload_kg > 0 ? d.requirements.payload_kg : 0.2 * m0;
      mpDesign = { ...d, requirements: { ...d.requirements, payload_kg: payloadMass } };
    }
    this.massProps = allLinkMassProps(mpDesign, this.lib, this.scenario === "payload");
    this.totalMass = [...this.massProps.values()].reduce((s, m) => s + m.mass, 0);

    // Ground / obstacles
    this.slopeRad = this.scenario === "slope" ? ((d.requirements.maxSlope_deg > 0 ? d.requirements.maxSlope_deg : 10) * Math.PI) / 180 : 0;
    this.rapier = new RAPIER.World({ x: 0, y: 0, z: -G });
    this.rapier.timestep = this.dt;
    this.rapier.numSolverIterations = 8;
    const groundQ = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -this.slopeRad);
    const ground = this.rapier.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const gTop = new Vector3(0, 0, -0.5).applyQuaternion(groundQ);
    this.rapier.createCollider(RAPIER.ColliderDesc.cuboid(50, 50, 0.5).setTranslation(gTop.x, gTop.y, gTop.z).setRotation(rq(groundQ)).setFriction(1.0), ground);
    const obstacles: WorldDescriptor["obstacles"] = [];
    if (this.scenario === "steps") {
      // Three 5 cm steps forming a staircase ahead of the robot
      const stepH = 0.05;
      for (let i = 0; i < 3; i++) {
        const x0 = 0.55 + i * 0.35;
        const len = 3.0 - i * 0.35;
        const size = [len, 3, stepH];
        const p = [x0 + len / 2, 0, stepH * i + stepH / 2];
        this.rapier.createCollider(RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2).setTranslation(p[0], p[1], p[2]).setFriction(1.0), ground);
        obstacles.push({ id: `step_${i}`, size, p, q: [0, 0, 0, 1] });
      }
    }

    // Reflected rotor inertia ("armature") of each actuated joint, J_rotor * N^2, added to the
    // child link about the joint axis (approximation: in reality it acts on the relative motion).
    const armature = new Map<string, number[][]>();
    for (const j of d.joints) {
      const dt = d.drivetrains.find((x) => x.jointId === j.id);
      const r = dt ? resolveDrivetrain(dt, d, this.lib) : undefined;
      if (!r || !isResolved(r)) continue;
      const Jr = r.motor.rotorInertia > 0 ? r.motor.rotorInertia : SERVO_ROTOR_INERTIA_PER_NM * r.motor.stallTorque;
      const Ja = Jr * r.totalRatio * r.totalRatio;
      const a = axisVector(j.axis);
      const v = [a.x, a.y, a.z];
      const add = v.map((vi) => v.map((vj) => Ja * vi * vj));
      const cur = armature.get(j.child);
      armature.set(j.child, cur ? cur.map((row, i) => row.map((x, k) => x + add[i][k])) : add);
    }
    this.armature = armature;

    // Link placement at the nominal pose, aligned with the ground (slope) and lifted onto it
    const tilt = new Matrix4().makeRotationFromQuaternion(groundQ);
    const T = forwardKinematics(this.topo, this.q0, tilt);
    let lift = -Infinity;
    for (const l of d.links) {
      if (!l.contact) continue;
      const p = pointOnLink(T, l.id, l.contact.point);
      const surface = p.x * Math.tan(this.slopeRad);
      lift = Math.max(lift, surface - (p.z - l.contact.radius / Math.cos(this.slopeRad)));
    }
    if (!Number.isFinite(lift) || d.rootFixed) {
      // No contacts (or bolted down): keep the root where the design puts it
      lift = d.rootFixed ? 0 : 0.5;
    }
    lift += d.rootFixed ? 0 : 0.002;
    const base = new Matrix4().makeTranslation(0, 0, lift).multiply(d.rootFixed ? new Matrix4() : tilt);
    const Tw = forwardKinematics(this.topo, this.q0, base);

    for (const l of d.links) {
      const Tl = Tw.get(l.id)!;
      const p = new Vector3().setFromMatrixPosition(Tl);
      const q = new Quaternion().setFromRotationMatrix(Tl);
      const isRoot = l.id === d.rootLink;
      const desc = isRoot && d.rootFixed ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic();
      desc.setTranslation(p.x, p.y, p.z).setRotation(rq(q));
      const mp = this.massProps.get(l.id)!;
      if (!(isRoot && d.rootFixed)) {
        const arm = armature.get(l.id);
        const inertia = arm ? mp.inertia.map((row, i) => row.map((x, k) => x + arm[i][k])) : mp.inertia;
        const { values, vectors } = symmetricEigen(inertia);
        const frame = eigenFrameQuaternion(vectors);
        const mass = Math.max(mp.mass, 1e-3);
        const I = values.map((v) => Math.max(v, 1e-7));
        desc.setAdditionalMassProperties(mass, rv(mp.com), { x: I[0], y: I[1], z: I[2] }, rq(frame));
        desc.setAngularDamping(0.02).setLinearDamping(0.0);
        desc.setCanSleep(false);
      }
      const body = this.rapier.createRigidBody(desc);
      this.bodies.set(l.id, body);
      if (isRoot) this.rootBody = body;
      for (const part of l.parts) {
        if (!part.collide) continue;
        const shape = part.kind === "fabricated" ? part.shape : this.lib.get(part.componentId)?.envelope;
        if (!shape) continue;
        if (part.kind === "fabricated" && part.role === "foot" && l.contact) continue; // contact ball below represents the foot
        const cd = colliderFor(shape, part);
        if (cd) this.rapier.createCollider(cd.setDensity(0).setFriction(0.6), body);
      }
      if (l.contact) {
        const c = l.contact;
        const cd = RAPIER.ColliderDesc.ball(c.radius).setTranslation(c.point[0], c.point[1], c.point[2]).setDensity(0).setFriction(c.friction);
        this.contactColliders.set(l.id, [this.rapier.createCollider(cd, body)]);
      }
    }

    // Payload visual box (mass is already folded into the link's mass properties)
    let payload: WorldDescriptor["payload"];
    if (this.scenario === "payload") {
      const linkId = d.requirements.payloadLinkId ?? d.rootLink;
      const side = Math.cbrt(payloadMass / 2700) * 1.2;
      payload = { linkId, mass: payloadMass, size: [side, side, side], offset: [...d.requirements.payloadOffset] };
    }

    // Joints
    const pidDefault = d.behavior.pid.default;
    for (const j of d.joints) {
      const parent = this.bodies.get(j.parent)!;
      const child = this.bodies.get(j.child)!;
      const originQ = rpyToQuaternion(j.origin.rpy);
      const anchor1 = new Vector3(...(j.origin.xyz as [number, number, number]));
      const a = axisVector(j.axis);
      let hardLimits = false;
      if (j.type === "fixed" || j.type === "prismatic") {
        const jd = RAPIER.JointData.fixed(rv(anchor1), rq(originQ), { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
        this.rapier.createImpulseJoint(jd, parent, child, true).setContactsEnabled(false);
        if (j.type === "fixed") continue;
      } else {
        // Describe the hinge with whichever axis sign keeps both local axes away from -X, where
        // Rapier's frame construction (minimal rotation from +X) is degenerate.
        const sgn = hingeSign(originQ, a);
        const as = a.clone().multiplyScalar(sgn || 1);
        const axis1 = as.clone().applyQuaternion(originQ);
        const jd = RAPIER.JointData.revoluteWithAxes(rv(anchor1), { x: 0, y: 0, z: 0 }, rv(axis1), rv(as));
        const ij = this.rapier.createImpulseJoint(jd, parent, child, true) as RAPIER.RevoluteImpulseJoint;
        ij.setContactsEnabled(false);
        if (j.type === "revolute" && j.limits && sgn !== 0) {
          const off = revoluteLimitOffset(originQ, as);
          const [l0, l1] = sgn > 0 ? [j.limits.lower, j.limits.upper] : [-j.limits.upper, -j.limits.lower];
          const lo = l0 + off, hi = l1 + off;
          if (lo > -Math.PI && hi < Math.PI) {
            ij.setLimits(lo, hi);
            hardLimits = true;
          }
        }
      }
      const dt = d.drivetrains.find((x) => x.jointId === j.id);
      const r = dt ? resolveDrivetrain(dt, d, this.lib) : undefined;
      const gains = d.behavior.pid.overrides[j.id] ?? pidDefault;
      this.joints.push({
        joint: j,
        parent,
        child,
        axisLocal: a,
        originQ,
        originInv: originQ.clone().invert(),
        rd: r && isResolved(r) ? r : undefined,
        kp: gains.kp,
        kd: gains.kd,
        hardLimits,
        target: this.q0[j.id] ?? 0,
        targetVel: 0,
        ff: 0,
        cmd: 0,
        applied: 0,
        limit: 0,
        saturated: false,
        temp: d.requirements.ambientTemp_C,
        overheated: false,
        current: 0,
        power: 0,
        q: this.q0[j.id] ?? 0,
        qd: 0,
      });
    }

    this.feetNominal = nominalFeet(d, this.topo);
    this.gravityFilt = new Vector3(0, 0, -1).applyQuaternion(groundQ.clone().invert());
    const feetZ = [...this.feetNominal.values()].map((p) => p.z);
    this.nominalHeight = feetZ.length ? -Math.min(...feetZ) : 0.3;
    this.initialHeight = this.rootHeight();
    this.startX = this.rootBody.translation().x;
    this.worldDesc = {
      ground: { slope_deg: (this.slopeRad * 180) / Math.PI },
      obstacles,
      scenario: this.scenario,
      rootFixed: d.rootFixed,
      payload,
    };
    this.control();
  }

  world(): WorldDescriptor {
    return this.worldDesc;
  }

  reset() {
    this.rapier.free();
    this.build();
  }

  dispose() {
    this.rapier.free();
  }

  /** Apply a push force to the root body for 0.1 s (default: lateral, 3 N per kg). */
  push(force?: number[]) {
    const f = force ? new Vector3(force[0] ?? 0, force[1] ?? 0, force[2] ?? 0) : new Vector3(0, 3 * this.totalMass, 0);
    this.pushForce.copy(f);
    this.pushUntil = this.time + 0.1;
  }

  // ------------------------------------------------------------------ state
  private groundHeightAt(x: number) {
    let h = x * Math.tan(this.slopeRad);
    for (const o of this.worldDesc?.obstacles ?? []) if (x >= o.p[0] - o.size[0] / 2 && x <= o.p[0] + o.size[0] / 2) h = Math.max(h, o.p[2] + o.size[2] / 2);
    return h;
  }

  private rootHeight() {
    const t = this.rootBody.translation();
    return t.z - this.groundHeightAt(t.x);
  }

  private measure() {
    for (const s of this.joints) {
      const qp = q4(s.parent.rotation()), qc = q4(s.child.rotation());
      // Rotation of the child relative to its zero pose: originInv * parent^-1 * child
      const rel = s.originInv.clone().multiply(qp.clone().invert()).multiply(qc);
      s.q = twistAngle(rel, s.axisLocal);
      const axisW = s.axisLocal.clone().applyQuaternion(qc);
      const w = v3(s.child.angvel()).sub(v3(s.parent.angvel()));
      s.qd = w.dot(axisW);
    }
  }

  private rootAttitude() {
    const q = q4(this.rootBody.rotation());
    // ZYX: roll about x, pitch about y
    const m = new Matrix4().makeRotationFromQuaternion(q).elements;
    const r20 = m[2], r21 = m[6], r22 = m[10];
    const pitch = Math.asin(Math.max(-1, Math.min(1, -r20)));
    const roll = Math.atan2(r21, r22);
    return { roll, pitch };
  }

  // ------------------------------------------------------------------ control
  private control() {
    const d = this.design;
    const b = d.behavior;
    this.measure();
    const qMeas: JointPositions = Object.fromEntries(this.joints.map((s) => [s.joint.id, s.q]));
    let targets: JointPositions = { ...this.q0 };
    let vels: JointPositions = {};
    let stance: string[] = d.links.filter((l) => l.contact).map((l) => l.id);
    const t = this.time;

    if (b.mode === "legged_gait" && b.gait && b.gait.legs.length) {
      const gait = b.gait;
      const tg = t - STAND_TIME_S;
      const ramp = Math.max(0, Math.min(1, tg / RAMP_TIME_S));
      const g = { ...gait, strideLength_m: gait.strideLength_m * ramp, stepHeight_m: gait.stepHeight_m * ramp };
      const { roll, pitch } = this.rootAttitude();
      // Low-pass gravity direction in the body frame; shift the whole foot pattern so the
      // support polygon stays under the gravity-projected COM (slopes, leaning).
      const gB = new Vector3(0, 0, -1).applyQuaternion(q4(this.rootBody.rotation()).invert());
      const alpha = Math.min(1, (this.controlEvery * this.dt) / 1.0);
      this.gravityFilt.lerp(gB, alpha);
      const H = this.nominalHeight;
      const gz = Math.min(-0.3, this.gravityFilt.z);
      const shift = new Vector3((this.gravityFilt.x / -gz) * H, (this.gravityFilt.y / -gz) * H, 0);
      stance = [];
      gait.legs.forEach((leg, li) => {
        const off = tg > 0 ? footOffset(legPhase(tg, gait, li), g) : { dx: 0, dz: 0, stance: true };
        if (off.stance) stance.push(leg.footLinkId);
        const nominal = this.feetNominal.get(leg.name);
        const link = this.topo.links.get(leg.footLinkId);
        if (!nominal || !link) return;
        // Attitude balance: extend legs on the low side, retract on the high side
        const dzBal = gait.balanceGain * (roll * nominal.y - pitch * nominal.x);
        const target = nominal.clone().add(shift).add(new Vector3(off.dx, 0, off.dz + (off.stance ? dzBal : 0)));
        const r = solveChainIK(this.topo, leg.jointIds, leg.footLinkId, link.contact?.point ?? [0, 0, 0], target, this.qTargetsIK, { iterations: 12, tol: 1e-5 });
        for (const jid of leg.jointIds) this.qTargetsIK[jid] = r.q[jid];
      });
      targets = { ...this.qTargetsIK };
    } else if (b.mode === "manipulator" && b.manipulator) {
      targets = manipulatorPose(d, t);
      const ahead = manipulatorPose(d, t + 0.01);
      vels = Object.fromEntries(Object.keys(targets).map((k) => [k, (ahead[k] - targets[k]) / 0.01]));
    }

    // Quasi-static feedforward (gravity + stance support) from the same statics used by the validator
    // Evaluated in the root frame, so world gravity / vertical support are rotated into it.
    const ffT = forwardKinematics(this.topo, qMeas);
    const toBody = q4(this.rootBody.rotation()).invert();
    const gravityBody = new Vector3(0, 0, -G).applyQuaternion(toBody);
    const ext: PointForce[] = [];
    if (!d.rootFixed && stance.length) {
      const up = gravityBody.clone().multiplyScalar(-this.totalMass / stance.length);
      for (const id of stance) {
        const l = this.topo.links.get(id)!;
        ext.push({ linkId: id, point: pointOnLink(ffT, id, l.contact?.point ?? [0, 0, 0]), force: up.clone() });
      }
    }
    const loads = staticJointLoads(this.topo, ffT, this.massProps, ext, gravityBody);

    for (const s of this.joints) {
      const id = s.joint.id;
      if (b.mode === "wheeled" && b.wheels && [...b.wheels.left, ...b.wheels.right].includes(id)) {
        const side = b.wheels.left.includes(id) ? -1 : 1;
        const v = b.wheels.targetSpeed_m_s + side * b.wheels.turnRate_rad_s * 0.2;
        const ramp = Math.max(0, Math.min(1, (t - STAND_TIME_S) / RAMP_TIME_S));
        s.targetVel = (v / b.wheels.wheelRadius_m) * ramp;
        s.target = s.q;
        s.ff = 0;
        continue;
      }
      s.target = targets[id] ?? s.target;
      s.targetVel = vels[id] ?? 0;
      s.ff = loads.get(id)?.torque ?? 0;
    }
  }

  private actuate() {
    const stalled = this.battery !== null && this.socJ <= 0;
    let motorPower = 0;
    for (const s of this.joints) {
      const j = s.joint;
      const isWheelVel = this.design.behavior.mode === "wheeled" && this.design.behavior.wheels && [...this.design.behavior.wheels.left, ...this.design.behavior.wheels.right].includes(j.id);
      let err = s.target - s.q;
      if (j.type === "continuous") err = wrap(err);
      const cmd = isWheelVel ? s.kd * 10 * (s.targetVel - s.qd) : s.kp * err + s.kd * (s.targetVel - s.qd) + s.ff;
      s.cmd = cmd;
      let tau = 0;
      if (s.rd && !stalled) {
        const braking = cmd * s.qd < 0;
        const mode = s.overheated ? "continuous" : "peak";
        s.limit = outputTorqueAt(s.rd, braking ? 0 : s.qd, mode);
        tau = Math.max(-s.limit, Math.min(s.limit, cmd));
        s.saturated = Math.abs(cmd) > s.limit + 1e-9;
        const e = motorElectrical(s.rd, tau, s.qd);
        s.current = e.current;
        s.power = e.electricalPower;
        // First-order winding thermal model
        const Tss = this.design.requirements.ambientTemp_C + e.copperLoss * s.rd.motor.thermalResistance;
        s.temp += ((Tss - s.temp) * this.dt) / THERMAL_TAU_S;
        if (s.temp > s.rd.motor.maxWindingTemp) s.overheated = true;
        else if (s.temp < s.rd.motor.maxWindingTemp - 10) s.overheated = false;
      } else {
        s.limit = 0;
        s.saturated = Math.abs(cmd) > 1e-9;
        s.current = 0;
        s.power = 0;
      }
      s.applied = tau;
      motorPower += s.power;
      // Passive joint losses
      let passive = -j.damping * s.qd - j.friction * Math.tanh(s.qd / 0.05);
      // Soft stop when Rapier limits could not be mapped
      if (!s.hardLimits && j.type === "revolute" && j.limits) {
        const k = 200, c = 2;
        if (s.q < j.limits.lower) passive += k * (j.limits.lower - s.q) - c * Math.min(0, s.qd);
        if (s.q > j.limits.upper) passive += k * (j.limits.upper - s.q) - c * Math.max(0, s.qd);
      }
      const total = tau + passive;
      const axisW = s.axisLocal.clone().applyQuaternion(q4(s.child.rotation()));
      s.child.addTorque(rv(axisW.clone().multiplyScalar(total)), true);
      s.parent.addTorque(rv(axisW.clone().multiplyScalar(-total)), true);
    }
    // Battery
    const P = motorPower + (stalled ? 0 : this.electronicsW);
    this.lastPower = P;
    if (this.battery) {
      const soc = Math.max(0, this.socJ / this.energyJ);
      const ocv = this.battery.minVoltage + (this.battery.voltage * 1.12 - this.battery.minVoltage) * soc;
      const I = P / Math.max(ocv, 1e-3);
      this.lastBatteryCurrent = I;
      this.socJ = Math.max(0, this.socJ - P * this.dt);
    }
  }

  step(n = 1) {
    for (let i = 0; i < n; i++) {
      for (const b of this.bodies.values()) {
        b.resetTorques(true);
        b.resetForces(true);
      }
      if (this.stepCount % this.controlEvery === 0) this.control();
      else this.measure();
      this.actuate();
      // Pushes (scenario: lateral push every 4 s from t = 3 s)
      if (this.scenario === "push" && !this.design.rootFixed && this.time >= this.nextAutoPush) {
        this.push();
        this.nextAutoPush += 4;
      }
      if (this.time < this.pushUntil) this.rootBody.addForce(rv(this.pushForce), true);
      this.rapier.step();
      this.time += this.dt;
      this.stepCount++;
      this.checkFall();
    }
  }

  private checkFall() {
    if (this.design.rootFixed || this.fallen) return;
    const h = this.rootHeight();
    const { roll, pitch } = this.rootAttitude();
    const lim = (60 * Math.PI) / 180;
    if (h < 0.4 * this.initialHeight) {
      this.fallen = true;
      this.fallMessage = `Fell at t=${this.time.toFixed(2)} s: body height ${(h * 1000).toFixed(0)} mm < 40% of initial ${(this.initialHeight * 1000).toFixed(0)} mm`;
    } else if (Math.abs(roll) > lim || Math.abs(pitch) > lim) {
      this.fallen = true;
      this.fallMessage = `Fell at t=${this.time.toFixed(2)} s: body tilted (roll ${((roll * 180) / Math.PI).toFixed(0)}°, pitch ${((pitch * 180) / Math.PI).toFixed(0)}°)`;
    } else {
      const p = this.rootBody.translation();
      if (![p.x, p.y, p.z].every(Number.isFinite)) {
        this.fallen = true;
        this.fallMessage = "Simulation diverged (non-finite state)";
      }
    }
  }

  // ------------------------------------------------------------------ output
  contactForces(): { linkId: string; force_N: number }[] {
    const out: { linkId: string; force_N: number }[] = [];
    for (const [linkId, cols] of this.contactColliders) {
      let impulse = 0;
      for (const c of cols)
        this.rapier.contactPairsWith(c, (other) => {
          this.rapier.contactPair(c, other, (m) => {
            for (let i = 0; i < m.numContacts(); i++) impulse += m.contactImpulse(i);
          });
        });
      out.push({ linkId, force_N: impulse / this.dt });
    }
    return out;
  }

  frame(): SimFrame {
    const links: SimFrame["links"] = {};
    const com = new Vector3();
    let m = 0;
    for (const [id, b] of this.bodies) {
      const p = b.translation(), q = b.rotation();
      links[id] = { p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w] };
      const mp = this.massProps.get(id)!;
      com.addScaledVector(mp.com.clone().applyQuaternion(q4(q)).add(v3(p)), mp.mass);
      m += mp.mass;
    }
    if (m > 0) com.divideScalar(m);
    const joints: Record<string, JointTelemetry> = {};
    const over = new Set<string>();
    for (const s of this.joints) {
      joints[s.joint.id] = {
        q: s.q,
        qd: s.qd,
        target: s.target,
        torque: s.applied,
        torqueLimit: s.limit,
        saturated: s.saturated,
        current_A: s.current,
        power_W: s.power,
        temp_C: s.temp,
        overheated: s.overheated,
      };
      if ((s.saturated || s.overheated) && s.rd) {
        over.add(s.rd.motor.partId);
        for (const st of s.rd.stages) if (st.kind === "gearbox" && st.partId) over.add(st.partId);
      }
    }
    const { roll, pitch } = this.rootAttitude();
    const rp = this.rootBody.translation();
    const soc = this.battery ? Math.max(0, this.socJ / this.energyJ) : 1;
    const ocv = this.battery ? this.battery.minVoltage + (this.battery.voltage * 1.12 - this.battery.minVoltage) * soc : 0;
    const stalled = this.battery !== null && this.socJ <= 0;
    const status: SimFrame["status"] = this.fallen ? "fallen" : stalled ? "stalled" : this.design.rootFixed ? "ok" : "running";
    const saturatedJoints = this.joints.filter((s) => s.saturated).map((s) => s.joint.name);
    let message = this.fallMessage;
    if (!message && stalled) message = "Battery depleted: actuators unpowered";
    if (!message && saturatedJoints.length) message = `Torque-limited: ${saturatedJoints.slice(0, 4).join(", ")}${saturatedJoints.length > 4 ? "…" : ""}`;
    return {
      t: this.time,
      status,
      message,
      links,
      joints,
      power_W: this.lastPower,
      battery: { soc, voltage: this.battery ? ocv - this.lastBatteryCurrent * this.battery.internalResistance : 0, current_A: this.lastBatteryCurrent },
      com: [com.x, com.y, com.z],
      contacts: this.contactForces(),
      base: {
        height: this.rootHeight(),
        roll,
        pitch,
        forwardSpeed: this.rootBody.linvel().x,
        distance: rp.x - this.startX,
      },
      overLimitParts: [...over],
    };
  }

  get mass() {
    return this.totalMass;
  }
}

/** +1 or -1: the axis sign for which neither local hinge axis is (anti)parallel-degenerate; 0 if both are. */
export function hingeSign(originQ: Quaternion, a: Vector3): 1 | -1 | 0 {
  const ok = (s: number) => {
    const c = a.clone().multiplyScalar(s);
    return c.dot(X) > -0.9 && c.clone().applyQuaternion(originQ).dot(X) > -0.9;
  };
  return ok(1) ? 1 : ok(-1) ? -1 : 0;
}

/**
 * Offset between our joint angle (zero = design pose) and the angle Rapier
 * measures for a revolute joint built with revoluteWithAxes(R·a, a).
 * Rapier builds each local frame as the minimal rotation taking +X onto the
 * local axis; the relative frame rotation at q = 0 is a twist about X.
 */
export function revoluteLimitOffset(originQ: Quaternion, axisChild: Vector3): number {
  const a = axisChild.clone().normalize();
  const F1 = frameFromAxis(a.clone().applyQuaternion(originQ));
  const F2 = frameFromAxis(a);
  const M = F1.clone().invert().multiply(originQ).multiply(F2);
  return twistAngle(M, X);
}

function colliderFor(shape: Shape, part: Part): RAPIER.ColliderDesc | null {
  const pq = rpyToQuaternion(part.pose.rpy);
  const pp = part.pose.xyz;
  // Rapier cylinders/capsules run along local Y; rotate onto the shape axis.
  const toAxis = (axis: "x" | "y" | "z") =>
    axis === "z" ? new Quaternion().setFromAxisAngle(X, Math.PI / 2) : axis === "x" ? new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -Math.PI / 2) : new Quaternion();
  let cd: RAPIER.ColliderDesc;
  let extra = new Quaternion();
  switch (shape.type) {
    case "box":
    case "shellBox":
      cd = RAPIER.ColliderDesc.cuboid(shape.size[0] / 2, shape.size[1] / 2, shape.size[2] / 2);
      break;
    case "rectTube": {
      const h = shape.length / 2, w = shape.width / 2, hh = shape.height / 2;
      cd = shape.axis === "x" ? RAPIER.ColliderDesc.cuboid(h, w, hh) : shape.axis === "y" ? RAPIER.ColliderDesc.cuboid(w, h, hh) : RAPIER.ColliderDesc.cuboid(w, hh, h);
      break;
    }
    case "sphere":
      cd = RAPIER.ColliderDesc.ball(shape.radius);
      break;
    case "cylinder":
      cd = RAPIER.ColliderDesc.cylinder(shape.length / 2, shape.radius);
      extra = toAxis(shape.axis);
      break;
    case "tube":
      cd = RAPIER.ColliderDesc.cylinder(shape.length / 2, shape.outerRadius);
      extra = toAxis(shape.axis);
      break;
    case "capsule":
      cd = RAPIER.ColliderDesc.capsule(shape.length / 2, shape.radius);
      extra = toAxis(shape.axis);
      break;
    default:
      return null;
  }
  const q = pq.clone().multiply(extra);
  return cd.setTranslation(pp[0], pp[1], pp[2]).setRotation(rq(q));
}

/** Typical electrical power of non-actuator consumers (compute, sensors, lighting, driver idle). */
export function electronicsTypicalPower(design: RobotDesign, lib: Library): number {
  let p = 0;
  for (const l of design.links)
    for (const part of l.parts) {
      if (part.kind !== "component") continue;
      const c = lib.get(part.componentId);
      if (!c) continue;
      if (c.category === "compute") p += c.specs.typicalPower_W;
      else if (c.category === "sensor") p += c.specs.power_W;
      else if (c.category === "lighting") p += c.specs.power_W * 0.6;
      else if (c.category === "driver") p += c.specs.idlePower_W;
    }
  return p;
}
