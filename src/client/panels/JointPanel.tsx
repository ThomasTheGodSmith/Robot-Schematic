import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame } from "@react-three/fiber";
import { DomLabels, type LabelSpec } from "../viewer/DomLabels";
import { Vector3 } from "three";
import type { RobotDesign } from "../../core/schema/design";
import type { ValidationReport } from "../../core/validate/report";
import { buildTopology, forwardKinematics, type JointPositions } from "../../core/math/frames";
import { allLinkMassProps } from "../../core/math/massprops";
import { staticJointLoads } from "../../core/statics";
import { pointOnLink } from "../../core/math/ik";
import { isResolved, motorElectrical, outputTorqueAt, resolveDrivetrain, stageStates, type ResolvedDrivetrain, type ResolvedStage } from "../../core/drivetrain";
import { solveFourBar } from "../../core/math/fourbar";
import { library } from "../library";
import { getState, setJoint, setState, useStore } from "../store";
import { gearGeometry, ringGearGeometry } from "../viewer/geometry";
import { fmt, Bar } from "./Panels";

/** Holding torque at the current pose: gravity plus ground support shared by all contacts. */
function useHoldingTorques(design: RobotDesign, q: JointPositions) {
  const topo = useMemo(() => buildTopology(design), [design]);
  const mp = useMemo(() => allLinkMassProps(design, library), [design]);
  return useMemo(() => {
    if (topo.errors.length) return new Map<string, number>();
    const T = forwardKinematics(topo, q);
    const W = [...mp.values()].reduce((s, m) => s + m.mass, 0) * 9.81;
    const contacts = design.rootFixed ? [] : design.links.filter((l) => l.contact);
    const ext = contacts.map((l) => ({ linkId: l.id, point: pointOnLink(T, l.id, l.contact!.point), force: new Vector3(0, 0, W / contacts.length) }));
    const loads = staticJointLoads(topo, T, mp, ext);
    return new Map([...loads].map(([k, v]) => [k, v.torque]));
  }, [topo, mp, q, design]);
}

export function JointPanel({ design, report }: { design: RobotDesign; report: ValidationReport | null }) {
  const q = useStore((s) => s.q);
  const qd = useStore((s) => s.qd);
  const selected = useStore((s) => s.selectedJoint);
  const play = useStore((s) => s.playBehavior);
  const holding = useHoldingTorques(design, q);
  const resolved = useMemo(() => {
    const m = new Map<string, ResolvedDrivetrain>();
    for (const dt of design.drivetrains) {
      const r = resolveDrivetrain(dt, design, library);
      if (isResolved(r)) m.set(dt.jointId, r);
    }
    return m;
  }, [design]);
  const joints = design.joints.filter((j) => j.type !== "fixed");
  const sel = selected ? design.joints.find((j) => j.id === selected) : null;
  const rd = sel ? resolved.get(sel.id) : undefined;
  const summary = report?.summary.joints.find((j) => j.jointId === sel?.id);

  return (
    <div className="joint-panel">
      <div className="row-buttons">
        <button className={play ? "on" : ""} onClick={() => setState({ playBehavior: !play })}>
          {play ? "■ Stop" : "▶ Play behaviour cycle"}
        </button>
        <button onClick={() => setState({ q: Object.fromEntries(design.joints.map((j) => [j.id, design.behavior.nominalPose[j.id] ?? 0])), qd: {} })}>Reset pose</button>
      </div>
      <div className="sliders">
        {joints.map((j) => {
          const lo = j.limits?.lower ?? -Math.PI, hi = j.limits?.upper ?? Math.PI;
          return (
            <div key={j.id} className={`slider-row ${selected === j.id ? "sel" : ""}`} onClick={() => setState({ selectedJoint: j.id })}>
              <label title={j.name}>{j.name}</label>
              <input type="range" min={lo} max={hi} step={0.005} value={q[j.id] ?? 0} onChange={(e) => setJoint(j.id, Number(e.target.value))} />
              <span className="mono">{fmt(((q[j.id] ?? 0) * 180) / Math.PI, 0)}°</span>
            </div>
          );
        })}
      </div>
      {sel && rd && (
        <div className="drivetrain">
          <h4>{sel.name} — drivetrain</h4>
          <p className="muted small">Motor → output, animated from the joint slider at the real stage ratios.</p>
          <DrivetrainCanvas rd={rd} jointId={sel.id} />
          <LiveStageTable rd={rd} torque={holding.get(sel.id) ?? 0} speed={qd[sel.id] ?? 0} />
          {summary && (
            <div className="kv small">
              <span>Total ratio</span>
              <span>
                {fmt(rd.totalRatio, 2)}:1 at η {fmt(rd.totalEfficiency * 100, 1)}%
              </span>
              <span>Validated peak need</span>
              <span>
                {fmt(summary.requiredPeakTorque_Nm, 2)} N·m of {fmt(summary.availablePeakTorque_Nm, 2)} N·m
              </span>
              <span>Speed need</span>
              <span>
                {fmt(summary.requiredSpeed_rad_s, 2)} of {fmt(summary.noLoadSpeed_rad_s, 2)} rad/s
              </span>
            </div>
          )}
        </div>
      )}
      {!sel && <p className="muted small">Select a joint to see its drivetrain animate with live torque and speed at every stage.</p>}
    </div>
  );
}

function LiveStageTable({ rd, torque, speed }: { rd: ResolvedDrivetrain; torque: number; speed: number }) {
  const states = stageStates(rd, torque, speed);
  const e = motorElectrical(rd, torque, speed);
  const avail = outputTorqueAt(rd, speed, "peak");
  // Rating of the stage whose output is at boundary i (i >= 1)
  const ratingAt = (i: number): ResolvedStage | undefined => (i >= 1 ? rd.stages[i - 1] : undefined);
  return (
    <>
      <table className="stage-table">
        <thead>
          <tr>
            <th>Shaft</th>
            <th>Torque N·m</th>
            <th>Speed rad/s</th>
            <th>rpm</th>
          </tr>
        </thead>
        <tbody>
          {states.map((s, i) => {
            const st = ratingAt(i);
            const lim = st?.peakTorque;
            return (
              <tr key={i}>
                <td>
                  {i === 0 ? `Motor rotor (${rd.motor.name})` : i === states.length - 1 ? "Joint output" : `after ${rd.stages[i - 1].label}`}
                  {st && <div className="muted small">{st.label} · {fmt(st.ratio, 2)}:1 · η {fmt(st.efficiency * 100, 0)}%</div>}
                </td>
                <td>
                  {lim !== undefined && <Bar ratio={Math.abs(s.torque) / lim} />}
                  {fmt(s.torque, 3)}
                  {lim !== undefined && <span className="muted"> / {fmt(lim, 1)}</span>}
                </td>
                <td>{fmt(s.speed, 2)}</td>
                <td>{fmt((s.speed * 60) / (2 * Math.PI), 0)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="kv small">
        <span>Holding torque here</span>
        <span>
          {fmt(torque, 2)} N·m (available {fmt(avail, 2)} N·m at this speed)
        </span>
        <span>Motor current</span>
        <span>
          {fmt(e.current, 2)} A → {fmt(e.electricalPower, 1)} W
        </span>
      </div>
      <p className="muted small">Torque is the static holding torque at the current pose (gravity + ground support); speed is how fast you are moving the slider.</p>
    </>
  );
}

/** Schematic, animated gear train for one drivetrain, driven by the joint slider. */
function DrivetrainCanvas({ rd, jointId }: { rd: ResolvedDrivetrain; jointId: string }) {
  const elements = useMemo(() => layoutStages(rd), [rd]);
  const width = elements.reduce((s, e) => s + e.width, 0) + 0.04;
  return (
    <div className="dt-canvas">
      <Canvas orthographic camera={{ position: [0, 0, 1], zoom: 1, near: 0.01, far: 10, up: [0, 1, 0] }} gl={{ antialias: true }}>
        <FitOrtho width={width} height={0.13} />
        <ambientLight intensity={0.8} />
        <directionalLight position={[0.3, 0.5, 1]} intensity={1.2} />
        <group position={[-width / 2 + 0.02, 0, 0]}>
          <GearTrain rd={rd} jointId={jointId} elements={elements} ox={-width / 2 + 0.02} />
        </group>
      </Canvas>
    </div>
  );
}

function FitOrtho({ width, height }: { width: number; height: number }) {
  useFrame(({ camera, size }) => {
    const cam = camera as THREE.OrthographicCamera;
    const z = Math.min(size.width / width, size.height / height);
    if (Math.abs(cam.zoom - z) > 1e-3) {
      cam.zoom = z;
      cam.updateProjectionMatrix();
    }
  });
  return null;
}

interface Elem {
  kind: "motor" | ResolvedStage["kind"];
  stage?: ResolvedStage;
  width: number;
  index: number;
}

function layoutStages(rd: ResolvedDrivetrain): Elem[] {
  const els: Elem[] = [{ kind: "motor", width: 0.07, index: -1 }];
  rd.stages.forEach((s, i) => {
    const w = s.kind === "belt" ? 0.13 : s.kind === "linkage" ? 0.12 : s.kind === "gearbox" ? 0.1 : 0.11;
    els.push({ kind: s.kind, stage: s, width: w, index: i });
  });
  return els;
}

const MAT = {
  motor: new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.8, roughness: 0.3 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x30343b, metalness: 0.4, roughness: 0.6 }),
  sun: new THREE.MeshStandardMaterial({ color: 0xff7a1a, metalness: 0.4, roughness: 0.4 }),
  planet: new THREE.MeshStandardMaterial({ color: 0xffc06a, metalness: 0.4, roughness: 0.4 }),
  ring: new THREE.MeshStandardMaterial({ color: 0x7a838e, metalness: 0.7, roughness: 0.4 }),
  carrier: new THREE.MeshStandardMaterial({ color: 0x3e63dd, metalness: 0.3, roughness: 0.5 }),
  belt: new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 }),
  link: new THREE.MeshStandardMaterial({ color: 0xe0e0e0, metalness: 0.5, roughness: 0.4 }),
  mark: new THREE.MeshStandardMaterial({ color: 0xff2d55 }),
};

function GearTrain({ rd, jointId, elements, ox }: { rd: ResolvedDrivetrain; jointId: string; elements: Elem[]; ox: number }) {
  const labels: LabelSpec[] = [];
  // Labels are placed in world space: group offset + element offset + local offset
  const Label = ({ text, x = 0, y, at }: { text: string; x?: number; y: number; at: number }) => {
    // Alternate labels above/below so neighbouring stages don't overlap
    const key = `${at.toFixed(4)}:${text}`;
    if (labels.some((l) => l.key === key)) return null; // StrictMode renders children twice
    const k = labels.length;
    const yy = y < 0 && k % 2 === 1 ? -y : y;
    labels.push({ key, position: [ox + at + x, yy, 0], text, className: "dt-label" });
    return null;
  };
  const refs = useRef<Record<string, THREE.Object3D | null>>({});
  const set = (k: string) => (o: THREE.Object3D | null) => {
    refs.current[k] = o;
  };
  const beltTeeth = useRef<THREE.InstancedMesh | null>(null);

  useFrame(() => {
    const q = getState().q[jointId] ?? 0;
    // angle at each stage boundary: inAngle[i] = input to stage i, outAngle[i] = output of stage i
    const outAngle: number[] = [];
    let a = q;
    for (let i = rd.stages.length - 1; i >= 0; i--) {
      outAngle[i] = a;
      a *= rd.stages[i].ratio;
    }
    const motor = a;
    const inAngle = (i: number) => (i === 0 ? motor : outAngle[i - 1]);
    const R = (k: string, ang: number) => {
      const o = refs.current[k];
      if (o) o.rotation.z = ang;
    };
    R("motor", motor);
    rd.stages.forEach((s, i) => {
      const ain = inAngle(i), aout = outAngle[i];
      if (s.kind === "gearbox" && s.gearType === "planetary") {
        const t = (s.teeth as { sun: number; planet: number; ring: number } | undefined) ?? { sun: 12, planet: 18, ring: 48 };
        R(`sun${i}`, ain);
        R(`carrier${i}`, aout);
        for (let k = 0; k < 3; k++) {
          const ang = aout + (k * 2 * Math.PI) / 3;
          const o = refs.current[`planet${i}_${k}`];
          if (o) {
            const rc = ((t.sun + t.planet) / 2) * 0.0009;
            o.position.set(Math.cos(ang) * rc, Math.sin(ang) * rc, 0);
            o.rotation.z = aout - ((ain - aout) * t.sun) / t.planet;
          }
        }
      } else if (s.kind === "gearbox" || s.kind === "servo_internal") {
        R(`in${i}`, ain);
        R(`out${i}`, s.kind === "servo_internal" ? -aout : aout);
      } else if (s.kind === "spur") {
        R(`in${i}`, ain);
        R(`out${i}`, -aout);
      } else if (s.kind === "belt") {
        R(`in${i}`, ain);
        R(`out${i}`, aout);
        const t = (s.teeth as { driver: number; driven: number }) ?? { driver: 20, driven: 40 };
        const r1 = 0.012, r2 = r1 * (t.driven / t.driver);
        const inst = beltTeeth.current;
        if (inst) {
          const d = 0.065;
          const pts = beltPath(r1 + 0.001, r2 + 0.001, d);
          const L = pathLength(pts);
          const n = inst.count;
          const m = new THREE.Matrix4();
          for (let k = 0; k < n; k++) {
            const sTravel = ((((k / n) * L + ain * r1) % L) + L) % L;
            const p = pointAt(pts, sTravel);
            m.makeTranslation(p.x, p.y, 0.004);
            inst.setMatrixAt(k, m);
          }
          inst.instanceMatrix.needsUpdate = true;
        }
      }
    });
  });

  let x = 0;
  const nodes: React.ReactNode[] = [];
  for (const e of elements) {
    const cx = x + e.width / 2;
    x += e.width;
    const i = e.index;
    if (e.kind === "motor") {
      nodes.push(
        <group key="motor" position={[cx, 0, 0]}>
          <mesh rotation={[Math.PI / 2, 0, 0]} material={MAT.dark}>
            <cylinderGeometry args={[0.026, 0.026, 0.02, 32]} />
          </mesh>
          <group ref={set("motor")}>
            <mesh position={[0, 0, 0.012]} rotation={[Math.PI / 2, 0, 0]} material={MAT.motor}>
              <cylinderGeometry args={[0.022, 0.022, 0.006, 32]} />
            </mesh>
            <mesh position={[0.015, 0, 0.016]} material={MAT.mark}>
              <boxGeometry args={[0.008, 0.004, 0.002]} />
            </mesh>
          </group>
          <Label at={cx} y={-0.042} text={`Motor · ${fmt((rd.motor.noLoadSpeed * 60) / (2 * Math.PI), 0)} rpm max`} />
        </group>,
      );
      continue;
    }
    const s = e.stage!;
    if (s.kind === "gearbox" && s.gearType === "planetary") {
      const t = (s.teeth as { sun: number; planet: number; ring: number } | undefined) ?? { sun: 12, planet: 18, ring: 48 };
      const m = 0.0009;
      nodes.push(
        <group key={`st${i}`} position={[cx, 0, 0]}>
          <mesh geometry={ringGearGeometry(t.ring, (t.ring * m) / 2, 0.006, (t.ring * m) / 2 + 0.006)} material={MAT.ring} />
          <group ref={set(`sun${i}`)}>
            <mesh geometry={gearGeometry(t.sun, (t.sun * m) / 2, 0.007, 0.002)} material={MAT.sun} />
          </group>
          {[0, 1, 2].map((k) => (
            <group key={k} ref={set(`planet${i}_${k}`)}>
              <mesh geometry={gearGeometry(t.planet, (t.planet * m) / 2, 0.0065, 0.0015)} material={MAT.planet} />
            </group>
          ))}
          <group ref={set(`carrier${i}`)}>
            <mesh position={[0, 0, -0.006]} material={MAT.carrier}>
              <boxGeometry args={[((t.sun + t.planet) / 2) * m * 2 + 0.004, 0.004, 0.002]} />
            </mesh>
          </group>
          <Label at={cx} y={-0.045} text={`${s.label} · ${fmt(s.ratio, 2)}:1`} />
        </group>,
      );
    } else if (s.kind === "gearbox" || s.kind === "servo_internal") {
      const big = s.kind === "servo_internal" ? 40 : 36;
      const small = Math.max(8, Math.round(big / Math.min(s.ratio, 6)));
      const m = 0.0009;
      const rs = (small * m) / 2, rb = (big * m) / 2;
      nodes.push(
        <group key={`st${i}`} position={[cx, 0, 0]}>
          <group position={[-rb * 0.8, 0, 0]} ref={set(`in${i}`)}>
            <mesh geometry={gearGeometry(small, rs, 0.006, 0.0015)} material={MAT.sun} />
          </group>
          <group position={[-rb * 0.8 + rs + rb, 0, 0]} ref={set(`out${i}`)}>
            <mesh geometry={gearGeometry(big, rb, 0.006, 0.002)} material={MAT.ring} />
            <mesh position={[rb * 0.6, 0, 0.004]} material={MAT.mark}>
              <boxGeometry args={[0.006, 0.003, 0.002]} />
            </mesh>
          </group>
          <Label at={cx} y={-0.045} text={`${s.label} · ${fmt(s.ratio, 1)}:1 (schematic)`} />
        </group>,
      );
    } else if (s.kind === "spur") {
      const t = s.teeth as { driver: number; driven: number };
      const m = Math.min(0.0012, 0.07 / (t.driver + t.driven));
      const r1 = (t.driver * m) / 2, r2 = (t.driven * m) / 2;
      nodes.push(
        <group key={`st${i}`} position={[cx - (r1 + r2) / 2 + r1 / 2, 0, 0]}>
          <group ref={set(`in${i}`)}>
            <mesh geometry={gearGeometry(t.driver, r1, 0.006, 0.0015)} material={MAT.sun} />
          </group>
          <group position={[r1 + r2, 0, 0]} ref={set(`out${i}`)}>
            <mesh geometry={gearGeometry(t.driven, r2, 0.006, 0.002)} material={MAT.ring} />
            <mesh position={[r2 * 0.6, 0, 0.004]} material={MAT.mark}>
              <boxGeometry args={[0.006, 0.003, 0.002]} />
            </mesh>
          </group>
          <Label at={cx - (r1 + r2) / 2 + r1 / 2} y={-0.045} x={(r1 + r2) / 2} text={`${s.label} · ${t.driver}T:${t.driven}T`} />
        </group>,
      );
    } else if (s.kind === "belt") {
      const t = (s.teeth as { driver: number; driven: number }) ?? { driver: 20, driven: 40 };
      const r1 = 0.012, r2 = r1 * (t.driven / t.driver), d = 0.065;
      const pts = beltPath(r1 + 0.001, r2 + 0.001, d);
      const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p.x, p.y, 0.002)), true);
      nodes.push(
        <group key={`st${i}`} position={[cx - d / 2, 0, 0]}>
          <group ref={set(`in${i}`)}>
            <mesh geometry={gearGeometry(t.driver, r1, 0.006, 0.002)} material={MAT.sun} />
          </group>
          <group position={[d, 0, 0]} ref={set(`out${i}`)}>
            <mesh geometry={gearGeometry(t.driven, r2, 0.006, 0.003)} material={MAT.ring} />
            <mesh position={[r2 * 0.6, 0, 0.004]} material={MAT.mark}>
              <boxGeometry args={[0.006, 0.003, 0.002]} />
            </mesh>
          </group>
          <mesh material={MAT.belt}>
            <tubeGeometry args={[curve, 160, 0.0008, 4, true]} />
          </mesh>
          <instancedMesh ref={beltTeeth} args={[undefined as any, MAT.mark, 24]}>
            <boxGeometry args={[0.002, 0.002, 0.002]} />
          </instancedMesh>
          <Label at={cx - d / 2} y={-0.045} x={d / 2} text={`${s.label}`} />
        </group>,
      );
    } else if (s.kind === "linkage" && s.linkage) {
      nodes.push(<LinkageSchematic key={`st${i}`} cx={cx} stage={s} jointId={jointId} rd={rd} index={i} />);
      labels.push({ key: `lk${i}`, position: [ox + cx, -0.045, 0], text: `${s.label} · four-bar (exact)`, className: "dt-label" });
    }
  }
  return (
    <group>
      {nodes}
      <DomLabels labels={labels} />
    </group>
  );
}

function LinkageSchematic({ cx, stage, jointId, rd, index }: { cx: number; stage: ResolvedStage; jointId: string; rd: ResolvedDrivetrain; index: number }) {
  const lk = stage.linkage!;
  const scale = 0.06 / Math.max(lk.ground, lk.coupler + lk.crank);
  const grp = useRef<THREE.Group>(null);
  useFrame(() => {
    const g = grp.current;
    if (!g) return;
    // Input crank angle relative to nominal follows the upstream stage output
    let a = getState().q[jointId] ?? 0;
    for (let i = rd.stages.length - 1; i > index; i--) a *= rd.stages[i].ratio;
    const st = solveFourBar(lk, lk.theta2Nominal + a * stage.ratio);
    if (!st) return;
    const pts = [
      [0, 0],
      st.A,
      st.B,
      [lk.ground, 0],
    ].map(([x, y]) => new THREE.Vector3(x * scale, y * scale, 0));
    g.children.forEach((c, k) => {
      if (k >= 3) return;
      const p0 = k === 2 ? pts[3] : pts[k], p1 = k === 2 ? pts[2] : pts[k + 1];
      c.position.copy(p0).add(p1).multiplyScalar(0.5);
      c.scale.set(1, p0.distanceTo(p1), 1);
      c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p1.clone().sub(p0).normalize());
    });
  });
  return (
    <group position={[cx - (lk.ground * scale) / 2, -0.01, 0]}>
      <group ref={grp}>
        {[MAT.sun, MAT.link, MAT.ring].map((m, k) => (
          <mesh key={k} material={m}>
            <cylinderGeometry args={[0.0015, 0.0015, 1, 8]} />
          </mesh>
        ))}
      </group>
      <mesh material={MAT.dark} position={[(lk.ground * scale) / 2, 0, -0.002]}>
        <boxGeometry args={[lk.ground * scale, 0.002, 0.001]} />
      </mesh>
    </group>
  );
}

function beltPath(r1: number, r2: number, d: number) {
  // Open belt around two pulleys at (0,0) and (d,0)
  const k = (r1 - r2) / d;
  const s = Math.sqrt(Math.max(0, 1 - k * k));
  const a = Math.atan2(s, k); // tangent normal angle from +x
  const pts: THREE.Vector2[] = [];
  const N = 30;
  for (let i = 0; i <= N; i++) {
    const t = -a + ((2 * a) * i) / N; // around driven (right) pulley, near side → far side
    pts.push(new THREE.Vector2(d + r2 * Math.cos(t), r2 * Math.sin(t)));
  }
  for (let i = 0; i <= N; i++) {
    const t = a + ((2 * Math.PI - 2 * a) * i) / N;
    pts.push(new THREE.Vector2(r1 * Math.cos(t), r1 * Math.sin(t)));
  }
  return pts;
}

function pathLength(p: THREE.Vector2[]) {
  let L = 0;
  for (let i = 0; i < p.length; i++) L += p[i].distanceTo(p[(i + 1) % p.length]);
  return L;
}

function pointAt(p: THREE.Vector2[], s: number) {
  let acc = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    const l = a.distanceTo(b);
    if (acc + l >= s) return a.clone().lerp(b, (s - acc) / Math.max(l, 1e-9));
    acc += l;
  }
  return p[0].clone();
}
