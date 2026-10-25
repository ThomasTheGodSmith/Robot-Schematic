import * as THREE from "three";
import type { Library } from "../../core/library";
import type { RobotDesign, Part } from "../../core/schema/design";
import { axisVector, type JointPositions } from "../../core/math/frames";
import { isResolved, resolveDrivetrain, type ResolvedDrivetrain } from "../../core/drivetrain";
import { crankForRocker, solveFourBar, type FourBar } from "../../core/math/fourbar";
import type { RobotRig } from "./rig";
import { shapeRadius } from "./geometry";

interface BeltSpec {
  jointId: string;
  driver: string;
  driven: string;
  pitch: number;
  ratio: number;
}

interface LinkageSpec {
  jointId: string;
  crankPart: string;
  fb: FourBar;
  theta2Nominal: number;
  qNominal: number;
}

const WIRE_COLORS: Record<string, number> = { power: 0xd23b3b, phase: 0xf0a020, signal: 0x3b82f6 };

/**
 * Drives the moving mechanism visuals for a set of joint positions:
 * rotor / gear spin at the correct ratios, timing belts that wrap their
 * pulleys and advance their teeth, four-bar linkages solved exactly, and
 * cables that follow the links they are attached to.
 */
export class Mechanisms {
  readonly group = new THREE.Group();
  private resolved = new Map<string, ResolvedDrivetrain>();
  private belts: BeltSpec[] = [];
  private linkages: LinkageSpec[] = [];
  private beltObjs = new Map<string, { tube: THREE.Mesh; teeth: THREE.InstancedMesh }>();
  private linkObjs = new Map<string, THREE.Group>();
  private wireObjs = new Map<string, THREE.Mesh>();
  private partLink = new Map<string, string>();
  private parts = new Map<string, Part>();
  private crankGuess = new Map<string, number>();
  private clip: THREE.Plane[] = [];

  constructor(private design: RobotDesign, private lib: Library, private rig: RobotRig) {
    this.group.name = "mechanisms";
    for (const l of design.links)
      for (const p of l.parts) {
        this.partLink.set(p.id, l.id);
        this.parts.set(p.id, p);
      }
    const joints = new Map(design.joints.map((j) => [j.id, j] as const));
    for (const dt of design.drivetrains) {
      const r = resolveDrivetrain(dt, design, lib);
      if (!isResolved(r)) continue;
      this.resolved.set(dt.jointId, r);
      const j = joints.get(dt.jointId);
      if (!j) continue;
      const gearsIn = (linkId: string) => design.links.find((l) => l.id === linkId)?.parts.filter((p) => p.kind === "fabricated" && p.role === "gear") ?? [];
      const last = dt.stages[dt.stages.length - 1];
      if (last?.kind === "belt") {
        const driver = gearsIn(j.parent)[0], driven = gearsIn(j.child)[0];
        if (driver && driven) this.belts.push({ jointId: j.id, driver: driver.id, driven: driven.id, pitch: last.pitch_m, ratio: last.drivenTeeth / last.driverTeeth });
      }
      const link = dt.stages.find((s) => s.kind === "linkage");
      const rl = r.stages.find((s) => s.kind === "linkage");
      if (link && link.kind === "linkage" && rl?.linkage) {
        const crank = gearsIn(j.parent)[0];
        if (crank)
          this.linkages.push({
            jointId: j.id,
            crankPart: crank.id,
            fb: { crank: link.crank_m, coupler: link.coupler_m, rocker: link.rocker_m, ground: link.ground_m },
            theta2Nominal: rl.linkage.theta2Nominal,
            qNominal: design.behavior.nominalPose[j.id] ?? 0,
          });
      }
    }
  }

  /** Angle at the output of each stage: index i -> angle after stage i (last = joint). */
  private stageAngles(rd: ResolvedDrivetrain, q: number) {
    const out: number[] = new Array(rd.stages.length).fill(0);
    let a = q;
    for (let i = rd.stages.length - 1; i >= 0; i--) {
      out[i] = a;
      a *= rd.stages[i].ratio;
    }
    return { motor: a, stageOut: out };
  }

  setClipping(planes: THREE.Plane[]) {
    this.clip = planes;
    this.group.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) m.clippingPlanes = planes;
    });
  }

  update(q: JointPositions, showWires: boolean) {
    const spins = new Map<string, number>();
    const joints = new Map(this.design.joints.map((j) => [j.id, j] as const));
    for (const dt of this.design.drivetrains) {
      const rd = this.resolved.get(dt.jointId);
      const j = joints.get(dt.jointId);
      if (!rd || !j) continue;
      const qj = q[dt.jointId] ?? 0;
      const { motor, stageOut } = this.stageAngles(rd, qj);
      const motorComp = this.lib.get((this.parts.get(dt.motorPartId) as Extract<Part, { kind: "component" }>)?.componentId ?? "");
      // Servo horns show the servo's output (after its internal train); bare motors show the rotor.
      spins.set(dt.motorPartId, motorComp?.category === "servo" ? stageOut[0] : motor);
      rd.stages.forEach((s, i) => {
        if (s.kind === "gearbox" && s.partId) spins.set(s.partId, stageOut[i]);
      });
      // Gear/pulley parts carried by the parent link turn at the last stage's input speed.
      const last = rd.stages[rd.stages.length - 1];
      if (last && (last.kind === "spur" || last.kind === "belt")) {
        const parent = this.design.links.find((l) => l.id === j.parent);
        for (const p of parent?.parts ?? [])
          if (p.kind === "fabricated" && p.role === "gear") {
            const sign = this.axisSign(p.id, j.child, j.axis);
            spins.set(p.id, (last.kind === "spur" ? -1 : 1) * sign * qj * last.ratio);
          }
      }
    }
    this.rig.setSpin(spins);
    this.updateBelts(q);
    this.updateLinkages(q);
    this.updateWires(showWires);
  }

  /** +1 if a part's spin axis is aligned with the joint axis (both in world), else -1. */
  private axisSign(partId: string, childLink: string, jointAxis: number[]) {
    const pn = this.rig.parts.get(partId);
    const pw = this.rig.partWorld(partId);
    const cm = this.rig.linkMatrix(childLink);
    if (!pn || !pw || !cm) return 1;
    const a = pn.spinAxis.clone().transformDirection(pw);
    const b = axisVector(jointAxis).transformDirection(cm);
    return a.dot(b) >= 0 ? 1 : -1;
  }

  private material(color: number) {
    return new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1, clippingPlanes: this.clip });
  }

  private updateBelts(q: JointPositions) {
    for (const b of this.belts) {
      const w1 = this.rig.partWorld(b.driver), w2 = this.rig.partWorld(b.driven);
      const p1 = this.parts.get(b.driver), p2 = this.parts.get(b.driven);
      if (!w1 || !w2 || p1?.kind !== "fabricated" || p2?.kind !== "fabricated") continue;
      const pn = this.rig.parts.get(b.driver)!;
      const n = pn.spinAxis.clone().transformDirection(w1).normalize();
      const c1 = new THREE.Vector3().setFromMatrixPosition(w1);
      let c2 = new THREE.Vector3().setFromMatrixPosition(w2);
      c2 = c2.sub(n.clone().multiplyScalar(c2.clone().sub(c1).dot(n))); // project into the driver's plane
      const r1 = shapeRadius(p1.shape) + 0.0015, r2 = shapeRadius(p2.shape) + 0.0015;
      const d = c2.distanceTo(c1);
      if (d <= Math.abs(r1 - r2) + 1e-4) continue;
      const u = c2.clone().sub(c1).divideScalar(d);
      const v = n.clone().cross(u).normalize();
      const k = (r1 - r2) / d;
      const s = Math.sqrt(Math.max(0, 1 - k * k));
      const mPlus = u.clone().multiplyScalar(k).add(v.clone().multiplyScalar(s));
      const mMinus = u.clone().multiplyScalar(k).sub(v.clone().multiplyScalar(s));
      const ang = (m: THREE.Vector3) => Math.atan2(m.dot(v), m.dot(u));
      const pts: THREE.Vector3[] = [];
      const arc = (c: THREE.Vector3, r: number, a0: number, a1: number) => {
        const N = 24;
        for (let i = 0; i <= N; i++) {
          const a = a0 + ((a1 - a0) * i) / N;
          pts.push(c.clone().add(u.clone().multiplyScalar(Math.cos(a) * r)).add(v.clone().multiplyScalar(Math.sin(a) * r)));
        }
      };
      // Wrap: around driven pulley from m+ to m- through its far side, then around driver back to m+.
      const a2p = ang(mPlus), a2m = ang(mMinus);
      arc(c2, r2, a2p, a2m < a2p ? a2m : a2m - 2 * Math.PI);
      arc(c1, r1, a2m, a2p > a2m ? a2p : a2p + 2 * Math.PI);
      const curve = new THREE.CatmullRomCurve3(pts, true, "centripetal");
      let obj = this.beltObjs.get(b.jointId);
      if (!obj) {
        const tube = new THREE.Mesh(new THREE.BufferGeometry(), this.material(0x202020));
        const teeth = new THREE.InstancedMesh(new THREE.BoxGeometry(0.0025, 0.0025, 0.012), this.material(0x555555), 400);
        this.group.add(tube, teeth);
        obj = { tube, teeth };
        this.beltObjs.set(b.jointId, obj);
      }
      obj.tube.geometry.dispose();
      obj.tube.geometry = new THREE.TubeGeometry(curve, 200, 0.0012, 4, true);
      // Teeth advance with the belt: travel = driven pulley rotation × radius
      const L = curve.getLength();
      const travel = (q[b.jointId] ?? 0) * r2;
      const count = Math.min(400, Math.floor(L / b.pitch));
      const m = new THREE.Matrix4();
      const quat = new THREE.Quaternion();
      for (let i = 0; i < count; i++) {
        let t = ((i * b.pitch + travel) / L) % 1;
        if (t < 0) t += 1;
        const p = curve.getPointAt(t);
        const tan = curve.getTangentAt(t);
        quat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
        const lookX = tan.clone().applyQuaternion(quat.clone().invert());
        void lookX;
        const basis = new THREE.Matrix4().makeBasis(tan, n.clone().cross(tan).normalize(), n);
        m.copy(basis).setPosition(p);
        obj.teeth.setMatrixAt(i, m);
      }
      obj.teeth.count = count;
      obj.teeth.instanceMatrix.needsUpdate = true;
    }
  }

  private updateLinkages(q: JointPositions) {
    for (const lk of this.linkages) {
      const j = this.design.joints.find((x) => x.id === lk.jointId)!;
      const cw = this.rig.partWorld(lk.crankPart);
      const childT = this.rig.linkMatrix(j.child);
      if (!cw || !childT) continue;
      const n = axisVector(j.axis).transformDirection(childT).normalize();
      const O2 = new THREE.Vector3().setFromMatrixPosition(cw);
      const O4 = new THREE.Vector3().setFromMatrixPosition(childT);
      const g = O4.clone().sub(O2);
      g.sub(n.clone().multiplyScalar(g.dot(n)));
      const gLen = g.length();
      if (gLen < 1e-5) continue;
      const e1 = g.clone().divideScalar(gLen), e2 = n.clone().cross(e1);
      const scale = gLen / lk.fb.ground;
      const nom = solveFourBar(lk.fb, lk.theta2Nominal);
      if (!nom) continue;
      const theta4 = nom.theta4 + ((q[lk.jointId] ?? 0) - lk.qNominal);
      const theta2 = crankForRocker(lk.fb, theta4, this.crankGuess.get(lk.jointId) ?? lk.theta2Nominal);
      if (theta2 === null) continue;
      this.crankGuess.set(lk.jointId, theta2);
      const st = solveFourBar(lk.fb, theta2);
      if (!st) continue;
      const P = (x: number, y: number, o: THREE.Vector3) => o.clone().add(e1.clone().multiplyScalar(x * scale)).add(e2.clone().multiplyScalar(y * scale));
      const A = P(st.A[0], st.A[1], O2);
      const B = P(st.B[0] - lk.fb.ground, st.B[1], O4);
      // Rotate the crank part about the joint-parallel axis
      const pn = this.rig.parts.get(lk.crankPart);
      if (pn) {
        const parentT = this.rig.linkMatrix(j.parent)!;
        const localAxis = n.clone().transformDirection(parentT.clone().multiply(pn.baseLocal).invert());
        pn.spinAxis.copy(localAxis);
        this.rig.setSpin(new Map([[lk.crankPart, theta2 - lk.theta2Nominal]]));
      }
      let grp = this.linkObjs.get(lk.jointId);
      if (!grp) {
        grp = new THREE.Group();
        this.group.add(grp);
        this.linkObjs.set(lk.jointId, grp);
      }
      grp.clear();
      const rod = (a: THREE.Vector3, b: THREE.Vector3, color: number) => {
        const len = a.distanceTo(b);
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.0018, 0.0018, len, 8), this.material(color));
        m.position.copy(a).add(b).multiplyScalar(0.5);
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
        grp!.add(m);
      };
      rod(O2, A, 0xff7a1a);
      rod(A, B, 0xe0e0e0);
      rod(O4, B, 0xff7a1a);
      for (const p of [O2, A, B, O4]) {
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.0028, 10, 8), this.material(0x333333));
        s.position.copy(p);
        grp.add(s);
      }
    }
  }

  private updateWires(show: boolean) {
    for (const w of this.design.power.wiring) {
      let mesh = this.wireObjs.get(w.id);
      if (!show) {
        if (mesh) mesh.visible = false;
        continue;
      }
      const a = this.rig.partWorld(w.from), b = this.rig.partWorld(w.to);
      if (!a || !b) continue;
      const pa = new THREE.Vector3().setFromMatrixPosition(a), pb = new THREE.Vector3().setFromMatrixPosition(b);
      const mid = pa.clone().add(pb).multiplyScalar(0.5);
      const sag = Math.min(0.06, pa.distanceTo(pb) * 0.15);
      mid.z -= sag;
      const curve = new THREE.CatmullRomCurve3([pa, pa.clone().lerp(mid, 0.5).setZ(pa.z - sag * 0.6), mid, mid.clone().lerp(pb, 0.5).setZ(pb.z - sag * 0.6), pb]);
      const wc = this.lib.getAs(w.wireComponentId, "wire");
      const radius = wc ? Math.max(0.0008, 0.0035 - wc.specs.awg * 0.00012) : 0.0012;
      if (!mesh) {
        mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material(WIRE_COLORS[w.kind] ?? 0x999999));
        mesh.userData.wireId = w.id;
        this.group.add(mesh);
        this.wireObjs.set(w.id, mesh);
      }
      mesh.visible = true;
      mesh.geometry.dispose();
      mesh.geometry = new THREE.TubeGeometry(curve, 24, radius, 6, false);
    }
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
    });
  }
}
