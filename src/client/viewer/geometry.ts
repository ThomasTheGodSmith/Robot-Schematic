import * as THREE from "three";
import type { Shape } from "../../core/schema/common";
import type { Component } from "../../core/schema/library";

/**
 * Procedural geometry. Everything the viewer draws is generated from part
 * parameters (shape dimensions, library envelopes, tooth counts) so any
 * design the agents produce can be rendered without hand-made meshes.
 */

const cache = new Map<string, THREE.BufferGeometry>();
function cached(key: string, make: () => THREE.BufferGeometry) {
  let g = cache.get(key);
  if (!g) {
    g = make();
    g.computeVertexNormals();
    cache.set(key, g);
  }
  return g;
}

/** Rotate a geometry built along +Y (three's default) or +Z onto the requested axis. */
function alignY(g: THREE.BufferGeometry, axis: "x" | "y" | "z") {
  if (axis === "z") g.rotateX(Math.PI / 2);
  else if (axis === "x") g.rotateZ(-Math.PI / 2);
  return g;
}
function alignZ(g: THREE.BufferGeometry, axis: "x" | "y" | "z") {
  if (axis === "x") g.rotateY(Math.PI / 2);
  else if (axis === "y") g.rotateX(-Math.PI / 2);
  return g;
}

function ringShape(ro: number, ri: number) {
  const s = new THREE.Shape();
  s.absarc(0, 0, ro, 0, Math.PI * 2, false);
  if (ri > 0) {
    const h = new THREE.Path();
    h.absarc(0, 0, ri, 0, Math.PI * 2, true);
    s.holes.push(h);
  }
  return s;
}

function rectShape(w: number, h: number, wall?: number) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, -h / 2);
  s.lineTo(w / 2, -h / 2);
  s.lineTo(w / 2, h / 2);
  s.lineTo(-w / 2, h / 2);
  s.closePath();
  if (wall && w > 2 * wall && h > 2 * wall) {
    const p = new THREE.Path();
    const wi = w / 2 - wall, hi = h / 2 - wall;
    p.moveTo(-wi, -hi);
    p.lineTo(-wi, hi);
    p.lineTo(wi, hi);
    p.lineTo(wi, -hi);
    p.closePath();
    s.holes.push(p);
  }
  return s;
}

function extrudeCentered(shape: THREE.Shape, depth: number, segments = 32) {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: segments });
  g.translate(0, 0, -depth / 2);
  return g;
}

export function shapeGeometry(s: Shape): THREE.BufferGeometry {
  return cached(JSON.stringify(s), () => {
    switch (s.type) {
      case "box":
        return new THREE.BoxGeometry(s.size[0], s.size[1], s.size[2]);
      case "shellBox":
        return new THREE.BoxGeometry(s.size[0], s.size[1], s.size[2]);
      case "sphere":
        return new THREE.SphereGeometry(s.radius, 24, 16);
      case "cylinder":
        return alignY(new THREE.CylinderGeometry(s.radius, s.radius, s.length, 32), s.axis);
      case "capsule":
        return alignY(new THREE.CapsuleGeometry(s.radius, s.length, 8, 24), s.axis);
      case "tube":
        return alignZ(extrudeCentered(ringShape(s.outerRadius, s.innerRadius), s.length, 40), s.axis);
      case "rectTube": {
        // section: width along the first perpendicular axis, height along the second
        const g = extrudeCentered(rectShape(s.width, s.height, s.wall), s.length, 4);
        if (s.axis === "x") {
          // section in (y,z): local x(width)->y, y(height)->z, z(length)->x
          g.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1));
        } else if (s.axis === "y") {
          // section in (x,z): width->x, height->z, length->y
          g.applyMatrix4(new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1));
        }
        return g;
      }
    }
  });
}

/** Spur-gear outline with trapezoidal teeth (visual approximation of an involute profile). */
export function gearGeometry(teeth: number, pitchRadius: number, width: number, boreRadius = 0): THREE.BufferGeometry {
  const key = `gear:${teeth}:${pitchRadius.toFixed(5)}:${width.toFixed(5)}:${boreRadius.toFixed(5)}`;
  return cached(key, () => {
    const m = (2 * pitchRadius) / teeth;
    const ra = pitchRadius + m, rf = Math.max(pitchRadius - 1.25 * m, pitchRadius * 0.5);
    const s = new THREE.Shape();
    const step = (Math.PI * 2) / teeth;
    for (let i = 0; i < teeth; i++) {
      const a = i * step;
      const pts: [number, number][] = [
        [rf, a],
        [rf, a + step * 0.15],
        [ra, a + step * 0.32],
        [ra, a + step * 0.52],
        [rf, a + step * 0.69],
      ];
      pts.forEach(([r, t], k) => {
        const x = r * Math.cos(t), y = r * Math.sin(t);
        if (i === 0 && k === 0) s.moveTo(x, y);
        else s.lineTo(x, y);
      });
    }
    s.closePath();
    if (boreRadius > 0) {
      const h = new THREE.Path();
      h.absarc(0, 0, boreRadius, 0, Math.PI * 2, true);
      s.holes.push(h);
    }
    return extrudeCentered(s, width, 6);
  });
}

/** Internal (ring) gear: teeth pointing inwards. */
export function ringGearGeometry(teeth: number, pitchRadius: number, width: number, outerRadius: number): THREE.BufferGeometry {
  const key = `ring:${teeth}:${pitchRadius.toFixed(5)}:${width.toFixed(5)}:${outerRadius.toFixed(5)}`;
  return cached(key, () => {
    const m = (2 * pitchRadius) / teeth;
    const ri = pitchRadius - m, rr = pitchRadius + 1.25 * m;
    const s = new THREE.Shape();
    s.absarc(0, 0, outerRadius, 0, Math.PI * 2, false);
    const h = new THREE.Path();
    const step = (Math.PI * 2) / teeth;
    for (let i = teeth - 1; i >= 0; i--) {
      const a = i * step;
      const pts: [number, number][] = [
        [rr, a + step * 0.69],
        [ri, a + step * 0.52],
        [ri, a + step * 0.32],
        [rr, a + step * 0.15],
        [rr, a],
      ];
      pts.forEach(([r, t], k) => {
        const x = r * Math.cos(t), y = r * Math.sin(t);
        if (i === teeth - 1 && k === 0) h.moveTo(x, y);
        else h.lineTo(x, y);
      });
    }
    h.closePath();
    s.holes.push(h);
    return extrudeCentered(s, width, 6);
  });
}

export function axisOfShape(s: Shape): THREE.Vector3 {
  const a = "axis" in s && s.axis ? s.axis : "z";
  return a === "x" ? new THREE.Vector3(1, 0, 0) : a === "y" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
}

export function shapeRadius(s: Shape): number {
  switch (s.type) {
    case "cylinder":
    case "capsule":
    case "sphere":
      return s.radius;
    case "tube":
      return s.outerRadius;
    default:
      return 0.01;
  }
}

export function shapeLength(s: Shape): number {
  switch (s.type) {
    case "cylinder":
    case "capsule":
    case "tube":
    case "rectTube":
      return s.length;
    case "sphere":
      return s.radius * 2;
    default:
      return Math.min(...s.size);
  }
}

export interface ComponentVisual {
  group: THREE.Group;
  /** Sub-object that spins with the motor rotor / output (rotated about `spinAxis`) */
  spinner?: THREE.Object3D;
  spinAxis: THREE.Vector3;
}

export type MatKey = "body" | "dark" | "metal" | "accent" | "pcb" | "copper" | "rubber" | "glow" | "label";

/**
 * Category-specific procedural model of a library component inside its envelope.
 * `mat` supplies shared-looking materials (callers clone per part for highlighting).
 */
export function componentVisual(c: Component, mat: (k: MatKey) => THREE.Material): ComponentVisual {
  const g = new THREE.Group();
  const env = c.envelope;
  const spinAxis = axisOfShape(env);
  const add = (geo: THREE.BufferGeometry, k: MatKey, parent: THREE.Object3D = g) => {
    const m = new THREE.Mesh(geo, mat(k));
    parent.add(m);
    return m;
  };
  const along = (axisLetter: "x" | "y" | "z", t: number) => (axisLetter === "x" ? new THREE.Vector3(t, 0, 0) : axisLetter === "y" ? new THREE.Vector3(0, t, 0) : new THREE.Vector3(0, 0, t));
  const ax = ("axis" in env && env.axis ? env.axis : "z") as "x" | "y" | "z";

  if ((c.category === "motor" || c.category === "propulsion") && (env.type === "cylinder" || env.type === "tube")) {
    const r = env.type === "cylinder" ? env.radius : env.outerRadius;
    const L = env.length;
    if (c.category === "propulsion" && c.specs.propulsionType === "wheel") {
      add(alignY(new THREE.TorusGeometry(r * 0.78, r * 0.22, 12, 40).rotateX(Math.PI / 2), ax).scale(1, 1, 1), "rubber");
      const spinner = new THREE.Group();
      g.add(spinner);
      add(alignY(new THREE.CylinderGeometry(r * 0.6, r * 0.6, L * 0.9, 6), ax), "metal", spinner);
      return { group: g, spinner, spinAxis };
    }
    if (c.category === "propulsion") {
      const spinner = new THREE.Group();
      g.add(spinner);
      const blade = new THREE.BoxGeometry(r * 2, r * 0.12, 0.004);
      const b = add(alignZ(blade.clone(), ax), "dark", spinner);
      const b2 = add(alignZ(blade.clone().rotateZ(Math.PI / 2), ax), "dark", spinner);
      void b;
      void b2;
      add(alignY(new THREE.CylinderGeometry(r * 0.12, r * 0.12, L, 16), ax), "metal");
      return { group: g, spinner, spinAxis };
    }
    // Outrunner/inrunner motor: stator can + spinning bell with index marks + shaft
    const stator = add(alignY(new THREE.CylinderGeometry(r * 0.96, r * 0.96, L * 0.45, 36), ax), "dark");
    stator.position.copy(along(ax, -L * 0.27));
    const spinner = new THREE.Group();
    g.add(spinner);
    const bell = add(alignY(new THREE.CylinderGeometry(r, r, L * 0.55, 36), ax), "metal", spinner);
    bell.position.copy(along(ax, L * 0.22));
    // index marks on the bell face so rotation is visible
    for (let i = 0; i < 3; i++) {
      const ang = (i * 2 * Math.PI) / 3;
      const c0 = Math.cos(ang) * r * 0.7, s0 = Math.sin(ang) * r * 0.7;
      const radial = ax === "z" ? new THREE.Vector3(c0, s0, 0) : ax === "y" ? new THREE.Vector3(c0, 0, s0) : new THREE.Vector3(0, c0, s0);
      const mark = add(new THREE.BoxGeometry(r * 0.28, r * 0.28, r * 0.28), "accent", spinner);
      mark.position.copy(along(ax, L * 0.5).add(radial));
    }
    const shaft = add(alignY(new THREE.CylinderGeometry(r * 0.12, r * 0.12, L * 1.3, 12), ax), "metal", spinner);
    shaft.position.copy(along(ax, 0));
    return { group: g, spinner, spinAxis };
  }

  if (c.category === "gearbox" && (env.type === "cylinder" || env.type === "tube")) {
    const r = env.type === "cylinder" ? env.radius : env.outerRadius;
    const L = env.length;
    add(alignZ(ringGearGeometry(48, r * 0.8, L * 0.7, r), ax), "metal");
    const spinner = new THREE.Group();
    g.add(spinner);
    const flange = add(alignY(new THREE.CylinderGeometry(r * 0.7, r * 0.7, L * 0.3, 32), ax), "dark", spinner);
    flange.position.copy(along(ax, L * 0.38));
    for (let i = 0; i < 6; i++) {
      const ang = (i * Math.PI) / 3;
      const bolt = add(alignY(new THREE.CylinderGeometry(r * 0.06, r * 0.06, L * 0.34, 8), ax), "metal", spinner);
      const rad = r * 0.5;
      const p = along(ax, L * 0.4);
      if (ax === "z") p.add(new THREE.Vector3(Math.cos(ang) * rad, Math.sin(ang) * rad, 0));
      else if (ax === "y") p.add(new THREE.Vector3(Math.cos(ang) * rad, 0, Math.sin(ang) * rad));
      else p.add(new THREE.Vector3(0, Math.cos(ang) * rad, Math.sin(ang) * rad));
      bolt.position.copy(p);
    }
    return { group: g, spinner, spinAxis };
  }

  if (c.category === "servo" && env.type === "box") {
    const [x, y, z] = env.size;
    add(new THREE.BoxGeometry(x, y, z), "dark");
    // horn on +y face (output), spins about y
    const spinner = new THREE.Group();
    spinner.position.set(0, y / 2 + 0.002, z * 0.25);
    g.add(spinner);
    const horn = add(new THREE.CylinderGeometry(x * 0.4, x * 0.4, 0.004, 24), "metal", spinner);
    void horn;
    add(new THREE.BoxGeometry(x * 0.15, 0.0045, x * 0.7), "accent", spinner);
    return { group: g, spinner, spinAxis: new THREE.Vector3(0, 1, 0) };
  }
  if (c.category === "servo") {
    // cylindrical integrated actuator (Unitree / CubeMars)
    const r = shapeRadius(env), L = shapeLength(env);
    add(alignY(new THREE.CylinderGeometry(r, r, L * 0.7, 36), ax), "dark").position.copy(along(ax, -L * 0.15));
    const spinner = new THREE.Group();
    g.add(spinner);
    add(alignY(new THREE.CylinderGeometry(r * 0.75, r * 0.75, L * 0.3, 36), ax), "metal", spinner).position.copy(along(ax, L * 0.35));
    add(new THREE.BoxGeometry(r * 0.2, r * 0.2, r * 0.2), "accent", spinner).position.copy(along(ax, L * 0.5).add(new THREE.Vector3(r * 0.5, 0, 0)));
    return { group: g, spinner, spinAxis };
  }

  if (c.category === "bearing" && env.type === "tube") {
    add(alignZ(extrudeCentered(ringShape(env.outerRadius, env.outerRadius * 0.85), env.length, 40), ax), "metal");
    add(alignZ(extrudeCentered(ringShape(env.innerRadius * 1.25, env.innerRadius), env.length, 40), ax), "metal");
    add(alignZ(extrudeCentered(ringShape(env.outerRadius * 0.85, env.innerRadius * 1.25), env.length * 0.6, 40), ax), "dark");
    return { group: g, spinAxis };
  }

  if (c.category === "battery" && env.type === "box") {
    const [x, y, z] = env.size;
    add(new THREE.BoxGeometry(x, y, z), "dark");
    add(new THREE.BoxGeometry(x * 1.002, y * 1.002, z * 0.35), "label");
    return { group: g, spinAxis };
  }

  const isBoard = c.category === "electrical" && (c.specs.electricalType === "power_distribution" || c.specs.electricalType === "bus_interface");
  if ((c.category === "driver" || c.category === "compute" || c.category === "regulator" || isBoard) && env.type === "box") {
    const [x, y, z] = env.size;
    add(new THREE.BoxGeometry(x, y, z * 0.25), "pcb").position.set(0, 0, -z * 0.375);
    add(new THREE.BoxGeometry(x * 0.35, y * 0.35, z * 0.6), "dark").position.set(x * 0.15, 0, 0);
    add(new THREE.BoxGeometry(x * 0.18, y * 0.5, z * 0.5), "metal").position.set(-x * 0.32, 0, -z * 0.1);
    return { group: g, spinAxis };
  }

  if (c.category === "electrical" && c.specs.electricalType === "estop" && env.type === "cylinder") {
    // body below the panel, mushroom cap on top
    const r = env.radius, L = env.length;
    add(alignY(new THREE.CylinderGeometry(r * 0.75, r * 0.75, L * 0.6, 24), ax), "dark").position.copy(along(ax, -L * 0.2));
    add(alignY(new THREE.CylinderGeometry(r * 1.3, r * 1.3, L * 0.4, 24), ax), "accent").position.copy(along(ax, L * 0.3));
    return { group: g, spinAxis };
  }

  if (c.category === "lighting") {
    add(shapeGeometry(env), "glow");
    return { group: g, spinAxis };
  }

  if (c.category === "sensor" && c.specs.sensorType === "lidar") {
    const r = shapeRadius(env), L = shapeLength(env);
    add(alignY(new THREE.CylinderGeometry(r, r, L * 0.5, 32), ax), "dark").position.copy(along(ax, -L * 0.25));
    const spinner = new THREE.Group();
    g.add(spinner);
    add(alignY(new THREE.CylinderGeometry(r * 0.9, r * 0.9, L * 0.5, 32), ax), "glow", spinner).position.copy(along(ax, L * 0.25));
    return { group: g, spinner, spinAxis };
  }

  // Generic: envelope solid in the category colour
  add(shapeGeometry(env), c.category === "fastener" ? "metal" : c.category === "sensor" ? "dark" : "body");
  return { group: g, spinAxis };
}
