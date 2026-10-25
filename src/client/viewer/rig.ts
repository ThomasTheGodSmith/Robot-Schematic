import * as THREE from "three";
import type { Library } from "../../core/library";
import type { Part, RobotDesign } from "../../core/schema/design";
import { poseToMatrix } from "../../core/math/frames";
import { componentVisual, gearGeometry, shapeGeometry, axisOfShape, shapeRadius, shapeLength, type MatKey } from "./geometry";

export interface PartNode {
  part: Part;
  linkId: string;
  /** Group placed at the part pose inside the link group */
  group: THREE.Group;
  /** Visual that is rotated for spinning parts (rotor/output) */
  spinner: THREE.Object3D | null;
  spinAxis: THREE.Vector3;
  meshes: THREE.Mesh[];
  lines: THREE.LineSegments[];
  baseLocal: THREE.Matrix4;
  role: string;
}

export interface Appearance {
  xray: boolean;
  hidden: Set<string>;
  isolated: Set<string> | null;
  selected: string | null;
  highlight: Set<string>;
  danger: Set<string>;
  blueprint: boolean;
  clipPlanes: THREE.Plane[];
}

const PALETTE = {
  dark: 0x2b2f36,
  metal: 0xb8bec6,
  pcb: 0x1f6b3a,
  copper: 0xb87333,
  rubber: 0x1b1b1b,
  label: 0x3a78c2,
};

/** Builds and updates the Three.js scene graph for a design. Pure Three, no React. */
export class RobotRig {
  readonly root = new THREE.Group();
  readonly links = new Map<string, THREE.Group>();
  readonly parts = new Map<string, PartNode>();
  private linkWorld = new Map<string, THREE.Matrix4>();
  private explode = 0;
  private linkExplodeDir = new Map<string, THREE.Vector3>();
  private gearTeeth = new Map<string, number>();

  constructor(readonly design: RobotDesign, readonly lib: Library) {
    this.root.name = "robot";
    this.assignGearTeeth();
    for (const l of design.links) {
      const g = new THREE.Group();
      g.name = l.id;
      g.matrixAutoUpdate = false;
      g.userData.linkId = l.id;
      this.root.add(g);
      this.links.set(l.id, g);
      for (const p of l.parts) this.buildPart(p, l.id, g);
    }
  }

  /** Tooth counts for fabricated gear/pulley parts, inferred from the drivetrain that owns them. */
  private assignGearTeeth() {
    const jointOf = new Map(this.design.joints.map((j) => [j.id, j] as const));
    const linkOfPart = new Map<string, string>();
    for (const l of this.design.links) for (const p of l.parts) linkOfPart.set(p.id, l.id);
    for (const dt of this.design.drivetrains) {
      const j = jointOf.get(dt.jointId);
      if (!j) continue;
      const last = dt.stages[dt.stages.length - 1];
      if (!last || (last.kind !== "spur" && last.kind !== "belt")) continue;
      for (const l of this.design.links) {
        if (l.id !== j.parent && l.id !== j.child) continue;
        for (const p of l.parts) {
          if (p.kind !== "fabricated" || p.role !== "gear") continue;
          this.gearTeeth.set(p.id, l.id === j.parent ? last.driverTeeth : last.drivenTeeth);
        }
      }
    }
  }

  private materialFor(part: Part, key: MatKey | "fab"): THREE.MeshStandardMaterial {
    const st = this.design.style;
    const base = { roughness: st.roughness, metalness: st.metalness, side: THREE.FrontSide } as THREE.MeshStandardMaterialParameters;
    if (key === "fab" && part.kind === "fabricated") {
      const mat = this.lib.material(part.material);
      if (part.emissive) return new THREE.MeshStandardMaterial({ ...base, color: st.emissive, emissive: st.emissive, emissiveIntensity: 1.6 });
      switch (part.role) {
        case "shell":
          return new THREE.MeshStandardMaterial({ ...base, color: st.primary, side: THREE.DoubleSide });
        case "cosmetic":
          return new THREE.MeshStandardMaterial({ ...base, color: st.secondary });
        case "gear":
          return new THREE.MeshStandardMaterial({ color: st.accent, roughness: 0.35, metalness: 0.6 });
        case "foot":
          return new THREE.MeshStandardMaterial({ color: PALETTE.rubber, roughness: 0.9, metalness: 0 });
        default: {
          const c = mat?.color ?? "#9aa0a8";
          const metal = mat?.kind === "metal";
          return new THREE.MeshStandardMaterial({ color: c, roughness: metal ? 0.35 : 0.6, metalness: metal ? 0.75 : 0.1 });
        }
      }
    }
    switch (key) {
      case "dark":
        return new THREE.MeshStandardMaterial({ color: PALETTE.dark, roughness: 0.6, metalness: 0.3 });
      case "metal":
        return new THREE.MeshStandardMaterial({ color: PALETTE.metal, roughness: 0.3, metalness: 0.85 });
      case "accent":
        return new THREE.MeshStandardMaterial({ color: st.accent, roughness: 0.4, metalness: 0.3 });
      case "pcb":
        return new THREE.MeshStandardMaterial({ color: PALETTE.pcb, roughness: 0.7, metalness: 0.1 });
      case "copper":
        return new THREE.MeshStandardMaterial({ color: PALETTE.copper, roughness: 0.4, metalness: 0.8 });
      case "rubber":
        return new THREE.MeshStandardMaterial({ color: PALETTE.rubber, roughness: 0.95, metalness: 0 });
      case "glow":
        return new THREE.MeshStandardMaterial({ color: st.emissive, emissive: st.emissive, emissiveIntensity: 1.4 });
      case "label":
        return new THREE.MeshStandardMaterial({ color: PALETTE.label, roughness: 0.5 });
      default:
        return new THREE.MeshStandardMaterial({ color: st.secondary, roughness: 0.5, metalness: 0.2 });
    }
  }

  private buildPart(p: Part, linkId: string, linkGroup: THREE.Group) {
    const group = new THREE.Group();
    const local = poseToMatrix(p.pose);
    local.decompose(group.position, group.quaternion, group.scale);
    group.userData.partId = p.id;
    linkGroup.add(group);
    let spinner: THREE.Object3D | null = null;
    let spinAxis = new THREE.Vector3(0, 0, 1);
    if (p.kind === "fabricated") {
      let geo: THREE.BufferGeometry;
      const isRound = p.shape.type === "cylinder" || p.shape.type === "tube";
      if (p.role === "gear" && isRound) {
        const r = shapeRadius(p.shape);
        const teeth = this.gearTeeth.get(p.id) ?? Math.max(12, Math.round((2 * Math.PI * r) / 0.004));
        const bore = p.shape.type === "tube" ? p.shape.innerRadius : r * 0.2;
        geo = gearGeometry(teeth, r, shapeLength(p.shape), bore).clone();
        const ax = axisOfShape(p.shape);
        if (ax.x) geo.rotateY(Math.PI / 2);
        else if (ax.y) geo.rotateX(-Math.PI / 2);
        spinAxis = ax;
      } else {
        geo = shapeGeometry(p.shape);
        spinAxis = axisOfShape(p.shape);
      }
      const mesh = new THREE.Mesh(geo, this.materialFor(p, "fab"));
      mesh.userData.partId = p.id;
      const holder = new THREE.Group();
      holder.add(mesh);
      group.add(holder);
      spinner = p.role === "gear" ? holder : null;
      if (p.role === "shell" && this.design.style.panelLines) {
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), new THREE.LineBasicMaterial({ color: this.design.style.secondary, transparent: true, opacity: 0.55 }));
        edges.userData.partId = p.id;
        holder.add(edges);
      }
    } else {
      const c = this.lib.get(p.componentId);
      if (c) {
        const v = componentVisual(c, (k) => this.materialFor(p, k));
        group.add(v.group);
        spinner = v.spinner ?? null;
        spinAxis = v.spinAxis;
      }
    }
    const meshes: THREE.Mesh[] = [];
    const lines: THREE.LineSegments[] = [];
    group.traverse((o) => {
      o.userData.partId = p.id;
      if ((o as THREE.Mesh).isMesh) {
        const m = o as THREE.Mesh;
        m.castShadow = true;
        m.receiveShadow = true;
        const mat = m.material as THREE.MeshStandardMaterial;
        mat.userData.base = { color: mat.color.clone(), emissive: mat.emissive.clone(), emissiveIntensity: mat.emissiveIntensity, opacity: mat.opacity };
        meshes.push(m);
      } else if ((o as THREE.LineSegments).isLineSegments) lines.push(o as THREE.LineSegments);
    });
    this.parts.set(p.id, { part: p, linkId, group, spinner, spinAxis, meshes, lines, baseLocal: local, role: p.kind === "fabricated" ? p.role : "component" });
  }

  /** Set world transforms of every link frame. */
  setLinkTransforms(world: Map<string, THREE.Matrix4>) {
    this.linkWorld = world;
    // Explode directions from the robot centre of the link frames
    const centre = new THREE.Vector3();
    let n = 0;
    for (const m of world.values()) centre.add(new THREE.Vector3().setFromMatrixPosition(m)), n++;
    if (n) centre.divideScalar(n);
    for (const [id, m] of world) {
      const p = new THREE.Vector3().setFromMatrixPosition(m);
      const box = new THREE.Box3();
      const g = this.links.get(id);
      if (g) for (const pn of this.parts.values()) if (pn.linkId === id) box.expandByPoint(new THREE.Vector3().setFromMatrixPosition(pn.baseLocal).applyMatrix4(m));
      const c = box.isEmpty() ? p : box.getCenter(new THREE.Vector3());
      this.linkExplodeDir.set(id, c.sub(centre));
    }
    this.applyTransforms();
  }

  setExplode(f: number) {
    this.explode = f;
    this.applyTransforms();
  }

  private applyTransforms() {
    for (const [id, g] of this.links) {
      const m = this.linkWorld.get(id);
      if (!m) continue;
      const out = m.clone();
      if (this.explode > 0) {
        const d = this.linkExplodeDir.get(id) ?? new THREE.Vector3();
        const off = d.clone().multiplyScalar(this.explode * 1.1);
        out.premultiply(new THREE.Matrix4().makeTranslation(off.x, off.y, off.z));
      }
      g.matrix.copy(out);
      g.matrixWorldNeedsUpdate = true;
    }
    // Spread parts inside each link
    for (const pn of this.parts.values()) {
      const t = new THREE.Vector3().setFromMatrixPosition(pn.baseLocal);
      const pos = t.clone().multiplyScalar(1 + this.explode * 0.9);
      pn.group.position.copy(pos);
    }
  }

  /** Rotate spinning visuals (rotors, gear outputs) by an angle about their own axis. */
  setSpin(angles: Map<string, number>) {
    for (const [id, a] of angles) {
      const pn = this.parts.get(id);
      if (!pn?.spinner) continue;
      pn.spinner.quaternion.setFromAxisAngle(pn.spinAxis, a);
    }
  }

  /** Rotate a whole part about a local axis (used for linkage cranks that are not gears). */
  setPartRotation(id: string, axisLocal: THREE.Vector3, angle: number) {
    const pn = this.parts.get(id);
    if (!pn) return;
    const base = new THREE.Quaternion().setFromRotationMatrix(pn.baseLocal);
    pn.group.quaternion.copy(base.multiply(new THREE.Quaternion().setFromAxisAngle(axisLocal, angle)));
  }

  /** World matrix of a part (accounting for explode). */
  partWorld(id: string): THREE.Matrix4 | null {
    const pn = this.parts.get(id);
    if (!pn) return null;
    pn.group.updateWorldMatrix(true, false);
    return pn.group.matrixWorld.clone();
  }

  linkMatrix(id: string): THREE.Matrix4 | null {
    const g = this.links.get(id);
    return g ? g.matrix.clone() : null;
  }

  applyAppearance(a: Appearance) {
    for (const [id, pn] of this.parts) {
      const subsystem = this.design.links.find((l) => l.id === pn.linkId)?.subsystem ?? "";
      const hidden = a.hidden.has(id) || a.hidden.has(pn.linkId) || a.hidden.has(`sub:${subsystem}`) || (a.isolated !== null && !a.isolated.has(id));
      pn.group.visible = !hidden;
      const isShell = pn.role === "shell" || pn.role === "cosmetic";
      for (const m of pn.meshes) {
        const mat = m.material as THREE.MeshStandardMaterial;
        const b = mat.userData.base as { color: THREE.Color; emissive: THREE.Color; emissiveIntensity: number; opacity: number };
        mat.clippingPlanes = a.clipPlanes;
        mat.clipShadows = true;
        let opacity = b.opacity;
        if (a.xray && isShell) opacity = 0.12;
        if (a.blueprint) opacity = Math.min(opacity, isShell ? 0.1 : 0.85);
        mat.transparent = opacity < 1;
        mat.opacity = opacity;
        mat.depthWrite = opacity >= 1;
        mat.color.copy(a.blueprint ? new THREE.Color(0xdbe9ff) : b.color);
        mat.emissive.copy(b.emissive);
        mat.emissiveIntensity = b.emissiveIntensity;
        if (a.highlight.has(id)) {
          mat.emissive.set(0xffb000);
          mat.emissiveIntensity = 0.6;
        }
        if (a.danger.has(id)) {
          mat.color.set(0xff2020);
          mat.emissive.set(0xff0000);
          mat.emissiveIntensity = 0.8;
        }
        if (a.selected === id) {
          mat.emissive.set(0x2a8cff);
          mat.emissiveIntensity = 0.9;
        }
        mat.needsUpdate = true;
      }
      for (const l of pn.lines) {
        const lm = l.material as THREE.LineBasicMaterial;
        lm.clippingPlanes = a.clipPlanes;
        lm.opacity = a.xray ? 0.2 : 0.55;
      }
    }
  }

  dispose() {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
    });
  }
}
