import type { Shape } from "../schema/common";

/** Geometry helpers for parametric shapes. All in the shape's own frame, centred on its centroid. */

type Ax = "x" | "y" | "z";

function axisOf(s: Shape): Ax {
  return "axis" in s && s.axis ? s.axis : "z";
}

/** Map a canonical (axis = z) diagonal [a, a, c] onto the shape's actual axis. */
function orient(diagZ: [number, number, number], axis: Ax): [number, number, number] {
  const [px, py, pz] = diagZ; // perpendicular, perpendicular, along-axis
  if (axis === "z") return [px, py, pz];
  if (axis === "x") return [pz, px, py];
  return [px, pz, py];
}

export function shapeVolume(s: Shape): number {
  switch (s.type) {
    case "box":
      return s.size[0] * s.size[1] * s.size[2];
    case "cylinder":
      return Math.PI * s.radius ** 2 * s.length;
    case "tube":
      return Math.PI * (s.outerRadius ** 2 - s.innerRadius ** 2) * s.length;
    case "rectTube": {
      const inner = Math.max(0, s.width - 2 * s.wall) * Math.max(0, s.height - 2 * s.wall);
      return (s.width * s.height - inner) * s.length;
    }
    case "sphere":
      return (4 / 3) * Math.PI * s.radius ** 3;
    case "capsule":
      return Math.PI * s.radius ** 2 * s.length + (4 / 3) * Math.PI * s.radius ** 3;
    case "shellBox": {
      const [x, y, z] = s.size;
      const t = s.wall;
      return x * y * z - Math.max(0, x - 2 * t) * Math.max(0, y - 2 * t) * Math.max(0, z - 2 * t);
    }
  }
}

function boxDiag(m: number, x: number, y: number, z: number): [number, number, number] {
  return [(m / 12) * (y * y + z * z), (m / 12) * (x * x + z * z), (m / 12) * (x * x + y * y)];
}

/**
 * Principal moments of inertia [Ixx, Iyy, Izz] about the centroid for a
 * uniform-density solid of mass m. Shape frames are principal frames.
 */
export function shapeInertia(s: Shape, m: number): [number, number, number] {
  const V = shapeVolume(s);
  const rho = V > 0 ? m / V : 0;
  switch (s.type) {
    case "box":
      return boxDiag(m, s.size[0], s.size[1], s.size[2]);
    case "cylinder": {
      const r = s.radius, h = s.length;
      const perp = (m * (3 * r * r + h * h)) / 12;
      return orient([perp, perp, (m * r * r) / 2], axisOf(s));
    }
    case "tube": {
      const ro = s.outerRadius, ri = s.innerRadius, h = s.length;
      const perp = (m * (3 * (ro * ro + ri * ri) + h * h)) / 12;
      return orient([perp, perp, (m * (ro * ro + ri * ri)) / 2], axisOf(s));
    }
    case "rectTube": {
      const L = s.length, w = s.width, h = s.height;
      const wi = Math.max(0, w - 2 * s.wall), hi = Math.max(0, h - 2 * s.wall);
      const mo = rho * w * h * L, mi = rho * wi * hi * L;
      const o = boxDiag(mo, w, h, L), i = boxDiag(mi, wi, hi, L);
      return orient([o[0] - i[0], o[1] - i[1], o[2] - i[2]], axisOf(s));
    }
    case "sphere": {
      const I = 0.4 * m * s.radius ** 2;
      return [I, I, I];
    }
    case "capsule": {
      const r = s.radius, L = s.length;
      const mc = rho * Math.PI * r * r * L;
      const mh = m - mc; // both hemispheres
      const axial = (mc * r * r) / 2 + 0.4 * mh * r * r;
      const perp = (mc * (3 * r * r + L * L)) / 12 + mh * (0.4 * r * r + (L * L) / 4 + (3 * L * r) / 8);
      return orient([perp, perp, axial], axisOf(s));
    }
    case "shellBox": {
      const [x, y, z] = s.size;
      const t = s.wall;
      const xi = Math.max(0, x - 2 * t), yi = Math.max(0, y - 2 * t), zi = Math.max(0, z - 2 * t);
      const mo = rho * x * y * z, mi = rho * xi * yi * zi;
      const o = boxDiag(mo, x, y, z), i = boxDiag(mi, xi, yi, zi);
      return [o[0] - i[0], o[1] - i[1], o[2] - i[2]];
    }
  }
}

/** Half extents of the axis-aligned bounding box in the shape frame. */
export function shapeHalfExtents(s: Shape): [number, number, number] {
  switch (s.type) {
    case "box":
    case "shellBox":
      return [s.size[0] / 2, s.size[1] / 2, s.size[2] / 2];
    case "sphere":
      return [s.radius, s.radius, s.radius];
    case "cylinder":
      return orient([s.radius, s.radius, s.length / 2], axisOf(s));
    case "tube":
      return orient([s.outerRadius, s.outerRadius, s.length / 2], axisOf(s));
    case "rectTube":
      return orient([s.width / 2, s.height / 2, s.length / 2], axisOf(s));
    case "capsule":
      return orient([s.radius, s.radius, s.length / 2 + s.radius], axisOf(s));
  }
}

export interface SectionProps {
  /** Member length along its long axis (m) */
  length: number;
  /** Cross-section area (m^2) */
  area: number;
  /** Minimum elastic section modulus (m^3) */
  sectionModulus: number;
  /** Polar section modulus for torsion (m^3), approximate for non-circular sections */
  torsionModulus: number;
  axis: Ax;
}

/**
 * Cross-section properties treating the part as a beam along its long axis.
 * Used by the simplified structural stress check.
 */
export function sectionProperties(s: Shape): SectionProps | null {
  const rectSolid = (b: number, h: number) => {
    const lo = Math.min(b, h), hi = Math.max(b, h);
    return { area: b * h, Z: (hi * lo * lo) / 6, Zt: 0.208 * hi * lo * lo };
  };
  const rectHollow = (b: number, h: number, t: number) => {
    const bi = Math.max(0, b - 2 * t), hi = Math.max(0, h - 2 * t);
    const Ib = (b * h ** 3 - bi * hi ** 3) / 12; // bending about axis parallel to b
    const Ih = (h * b ** 3 - hi * bi ** 3) / 12;
    const Z = Math.min(Ib / (h / 2), Ih / (b / 2));
    // Bredt-Batho thin wall torsion: Zt = 2 * A_m * t
    const Zt = 2 * (b - t) * (h - t) * t;
    return { area: b * h - bi * hi, Z, Zt };
  };
  switch (s.type) {
    case "box":
    case "shellBox": {
      const dims = [...s.size] as number[];
      const i = dims.indexOf(Math.max(...dims));
      const axis = (["x", "y", "z"] as Ax[])[i];
      const [b, h] = dims.filter((_, k) => k !== i);
      const r = s.type === "box" ? rectSolid(b, h) : rectHollow(b, h, s.wall);
      return { length: dims[i], area: r.area, sectionModulus: r.Z, torsionModulus: r.Zt, axis };
    }
    case "cylinder":
    case "capsule": {
      const r = s.radius;
      return { length: s.length, area: Math.PI * r * r, sectionModulus: (Math.PI * r ** 3) / 4, torsionModulus: (Math.PI * r ** 3) / 2, axis: axisOf(s) };
    }
    case "tube": {
      const ro = s.outerRadius, ri = s.innerRadius;
      const Z = (Math.PI * (ro ** 4 - ri ** 4)) / (4 * ro);
      return { length: s.length, area: Math.PI * (ro * ro - ri * ri), sectionModulus: Z, torsionModulus: 2 * Z, axis: axisOf(s) };
    }
    case "rectTube": {
      const r = rectHollow(s.width, s.height, s.wall);
      return { length: s.length, area: r.area, sectionModulus: r.Z, torsionModulus: r.Zt, axis: axisOf(s) };
    }
    case "sphere":
      return null;
  }
}
