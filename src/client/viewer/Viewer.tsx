import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Grid, OrbitControls, GizmoHelper, GizmoViewport } from "@react-three/drei";
import { DomLabels, type LabelSpec } from "./DomLabels";
import type { RobotDesign } from "../../core/schema/design";
import { buildTopology, forwardKinematics, type JointPositions } from "../../core/math/frames";
import { lowestContactZ, sampleBehavior, behaviorPeriod } from "../../core/behavior";
import { buildBom } from "../../core/bom";
import { library } from "../library";
import { RobotRig } from "./rig";
import { Mechanisms } from "./mechanisms";
import type { ClipState } from "../store";

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export interface ViewerProps {
  design: RobotDesign;
  q: JointPositions;
  /** World link poses from the simulator; when set, FK is bypassed */
  linkPoses?: Record<string, { p: number[]; q: number[] }>;
  explode?: number;
  xray?: boolean;
  hidden?: Set<string>;
  isolated?: Set<string> | null;
  selected?: string | null;
  highlight?: Set<string>;
  danger?: Set<string>;
  blueprint?: boolean;
  clip?: ClipState;
  showWires?: boolean;
  playBehavior?: boolean;
  onPick?: (partId: string | null) => void;
  onBackground?: () => void;
  children?: React.ReactNode;
  groundTilt?: number;
  followRoot?: boolean;
}

function useRobotBase(design: RobotDesign) {
  return useMemo(() => {
    const topo = buildTopology(design);
    const base = new THREE.Matrix4();
    if (!design.rootFixed && !topo.errors.length) {
      const z = lowestContactZ(design, topo, Object.fromEntries(design.joints.map((j) => [j.id, design.behavior.nominalPose[j.id] ?? 0])));
      if (Number.isFinite(z)) base.makeTranslation(0, 0, -z);
    }
    return { topo, base };
  }, [design]);
}

function RobotObject(props: ViewerProps & { clipPlanes: THREE.Plane[]; onBox?: (b: THREE.Box3) => void }) {
  const { design } = props;
  const { topo, base } = useRobotBase(design);
  const rig = useMemo(() => new RobotRig(design, library), [design]);
  const mech = useMemo(() => new Mechanisms(design, library, rig), [design, rig]);
  useEffect(() => () => (rig.dispose(), mech.dispose()), [rig, mech]);

  // Behaviour playback (inspection): loop the validated behaviour cycle
  const samples = useMemo(() => (topo.errors.length ? [] : sampleBehavior(design, topo, 96)), [design, topo]);
  const period = useMemo(() => behaviorPeriod(design), [design]);
  const playStart = useRef(0);
  const [playQ, setPlayQ] = useState<JointPositions | null>(null);
  useEffect(() => {
    playStart.current = performance.now();
    if (!props.playBehavior) setPlayQ(null);
  }, [props.playBehavior]);
  useFrame(() => {
    if (!props.playBehavior || samples.length < 2) return;
    const t = ((performance.now() - playStart.current) / 1000) % period;
    const f = (t / period) * samples.length;
    const i = Math.floor(f) % samples.length, k = (i + 1) % samples.length, w = f - Math.floor(f);
    const q: JointPositions = {};
    for (const id of Object.keys(samples[i].q)) q[id] = samples[i].q[id] * (1 - w) + samples[k].q[id] * w;
    setPlayQ(q);
  });
  const q = playQ ?? props.q;

  const explodeTarget = props.explode ?? 0;
  const explodeNow = useRef(0);
  useFrame((_, dt) => {
    const e = explodeNow.current;
    if (Math.abs(e - explodeTarget) > 1e-3) {
      explodeNow.current = e + (explodeTarget - e) * Math.min(1, dt * 6);
      rig.setExplode(explodeNow.current);
      mech.update(q, props.showWires ?? true);
    }
  });

  useLayoutEffect(() => {
    let world: Map<string, THREE.Matrix4>;
    if (props.linkPoses) {
      world = new Map();
      for (const [id, p] of Object.entries(props.linkPoses))
        world.set(id, new THREE.Matrix4().compose(new THREE.Vector3(...(p.p as [number, number, number])), new THREE.Quaternion(...(p.q as [number, number, number, number])), new THREE.Vector3(1, 1, 1)));
    } else world = forwardKinematics(topo, q, base);
    rig.setLinkTransforms(world);
    mech.update(q, props.showWires ?? true);
    if (props.onBox) props.onBox(new THREE.Box3().setFromObject(rig.root));
  }, [rig, mech, topo, base, q, props.linkPoses, props.showWires]);

  useLayoutEffect(() => {
    rig.applyAppearance({
      xray: !!props.xray,
      hidden: props.hidden ?? new Set(),
      isolated: props.isolated ?? null,
      selected: props.selected ?? null,
      highlight: props.highlight ?? new Set(),
      danger: props.danger ?? new Set(),
      blueprint: !!props.blueprint,
      clipPlanes: props.clipPlanes,
    });
    mech.setClipping(props.clipPlanes);
  }, [rig, mech, props.xray, props.hidden, props.isolated, props.selected, props.highlight, props.danger, props.blueprint, props.clipPlanes]);

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    // Ignore drags: only treat as a click when the pointer barely moved
    if (e.delta > 4) return;
    e.stopPropagation();
    let o: THREE.Object3D | null = e.object;
    while (o && !o.userData.partId) o = o.parent;
    props.onPick?.(o?.userData.partId ?? null);
  };

  return (
    <>
      <primitive object={rig.root} onClick={onClick} />
      <primitive object={mech.group} />
      {props.blueprint && <BlueprintOverlay rig={rig} design={design} />}
    </>
  );
}

/** Dimension lines and numbered BOM callouts drawn over the model. */
function BlueprintOverlay({ rig, design }: { rig: RobotRig; design: RobotDesign }) {
  const [box, setBox] = useState<THREE.Box3 | null>(null);
  useFrame(() => {
    const b = new THREE.Box3().setFromObject(rig.root);
    if (!box || b.min.distanceTo(box.min) > 1e-3 || b.max.distanceTo(box.max) > 1e-3) setBox(b);
  });
  const bom = useMemo(() => buildBom(design, library), [design]);
  if (!box || box.isEmpty()) return null;
  const { min, max } = box;
  const pad = 0.04;
  const lines: { a: THREE.Vector3; b: THREE.Vector3; label: string }[] = [
    { a: new THREE.Vector3(min.x, min.y - pad, min.z), b: new THREE.Vector3(max.x, min.y - pad, min.z), label: `${((max.x - min.x) * 1000).toFixed(0)} mm` },
    { a: new THREE.Vector3(max.x + pad, min.y, min.z), b: new THREE.Vector3(max.x + pad, max.y, min.z), label: `${((max.y - min.y) * 1000).toFixed(0)} mm` },
    { a: new THREE.Vector3(max.x + pad, min.y - pad, min.z), b: new THREE.Vector3(max.x + pad, min.y - pad, max.z), label: `${((max.z - min.z) * 1000).toFixed(0)} mm` },
  ];
  const callouts = bom.rows
    .filter((r) => !r.type.startsWith("wire"))
    .slice(0, 40)
    .map((r) => {
      const m = rig.partWorld(r.partIds[0]);
      return m ? { item: r.item, name: r.name, p: new THREE.Vector3().setFromMatrixPosition(m) } : null;
    })
    .filter(Boolean) as { item: number; name: string; p: THREE.Vector3 }[];
  const labels: LabelSpec[] = [
    ...lines.map((l, i) => ({ key: `dim${i}`, position: l.a.clone().add(l.b).multiplyScalar(0.5), text: l.label, className: "dim-label" })),
    ...callouts.map((c) => ({ key: `c${c.item}`, position: c.p, text: String(c.item), className: "callout", title: c.name })),
  ];
  return (
    <group>
      {lines.map((l, i) => (
        <DimensionLine key={i} a={l.a} b={l.b} />
      ))}
      <DomLabels labels={labels} />
    </group>
  );
}

function DimensionLine({ a, b }: { a: THREE.Vector3; b: THREE.Vector3 }) {
  const geo = useMemo(() => {
    const dir = b.clone().sub(a).normalize();
    const perp = Math.abs(dir.z) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    const tick = perp.multiplyScalar(0.012);
    const pts = [a, b, a.clone().add(tick), a.clone().sub(tick), b.clone().add(tick), b.clone().sub(tick)];
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, [a, b]);
  return (
    <lineSegments geometry={geo}>
      <lineBasicMaterial color="#ffffff" />
    </lineSegments>
  );
}

function ClippingSetup() {
  const { gl } = useThree();
  useEffect(() => {
    gl.localClippingEnabled = true;
  }, [gl]);
  return null;
}

function CameraRig({ box, follow }: { box: THREE.Box3 | null; follow?: boolean }) {
  const controls = useRef<any>(null);
  const { camera } = useThree();
  const framed = useRef(false);
  useEffect(() => {
    if (!box || box.isEmpty() || !controls.current) return;
    const c = box.getCenter(new THREE.Vector3());
    if (!framed.current) {
      const size = box.getSize(new THREE.Vector3()).length();
      camera.position.set(c.x + size * 0.9, c.y - size * 1.1, c.z + size * 0.6);
      camera.near = size / 200;
      camera.far = size * 200;
      camera.updateProjectionMatrix();
      framed.current = true;
      controls.current.target.copy(c);
      controls.current.update();
    } else if (follow) {
      const delta = c.clone().sub(controls.current.target);
      delta.z = 0;
      controls.current.target.add(delta);
      camera.position.add(delta);
      controls.current.update();
    }
  }, [box, camera, follow]);
  return <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.12} />;
}

export function Viewer(props: ViewerProps) {
  const [box, setBox] = useState<THREE.Box3 | null>(null);
  const boxRef = useRef<THREE.Box3 | null>(null);
  const onBox = (b: THREE.Box3) => {
    // Only re-frame when the design changes size noticeably (avoid render loops)
    const prev = boxRef.current;
    if (!prev || prev.min.distanceTo(b.min) > 0.02 || prev.max.distanceTo(b.max) > 0.02) {
      boxRef.current = b.clone();
      setBox(b.clone());
    }
  };
  const clipPlanes = useMemo(() => {
    const c = props.clip;
    if (!c?.enabled || !box) return [];
    const i = { x: 0, y: 1, z: 2 }[c.axis];
    const min = box.min.getComponent(i), max = box.max.getComponent(i);
    const pos = (min + max) / 2 + (c.offset * (max - min)) / 2;
    const n = new THREE.Vector3().setComponent(i, c.flip ? 1 : -1);
    return [new THREE.Plane(n, c.flip ? -pos : pos)];
  }, [props.clip, box]);

  return (
    <Canvas
      shadows="percentage"
      camera={{ fov: 40, position: [1, -1.2, 0.8], up: [0, 0, 1] }}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      onPointerMissed={() => props.onBackground?.()}
      style={{ background: props.blueprint ? "#0b2a55" : "radial-gradient(circle at 50% 35%, #2a3140, #12151b)" }}
    >
      <ClippingSetup />
      <ambientLight intensity={props.blueprint ? 1.2 : 0.45} />
      <hemisphereLight args={["#dfe8ff", "#2a2a2a", 0.6]} />
      <directionalLight position={[2, -2, 4]} intensity={1.6} castShadow shadow-mapSize={[2048, 2048]} shadow-camera-left={-4} shadow-camera-right={4} shadow-camera-top={4} shadow-camera-bottom={-4} shadow-bias={-0.0004} shadow-normalBias={0.02} />
      <directionalLight position={[-3, 2, 2]} intensity={0.5} />
      <group rotation={[0, -(props.groundTilt ?? 0), 0]}>
        <Grid
          rotation={[Math.PI / 2, 0, 0]}
          args={[20, 20]}
          cellSize={0.05}
          sectionSize={0.5}
          cellColor={props.blueprint ? "#2d5da0" : "#3a404c"}
          sectionColor={props.blueprint ? "#5b8ad0" : "#59606e"}
          fadeDistance={8}
          infiniteGrid
        />
        {!props.blueprint && (
          <mesh receiveShadow position={[0, 0, -0.001]}>
            <planeGeometry args={[40, 40]} />
            <shadowMaterial opacity={0.35} />
          </mesh>
        )}
      </group>
      <RobotObject {...props} clipPlanes={clipPlanes} onBox={onBox} />
      {props.children}
      <CameraRig box={box} follow={props.followRoot} />
      <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
        <GizmoViewport axisColors={["#e5484d", "#30a46c", "#3e63dd"]} labelColor="white" />
      </GizmoHelper>
    </Canvas>
  );
}
