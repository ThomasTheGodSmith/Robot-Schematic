/**
 * Planar four-bar linkage. Ground pivot O2 at the origin, ground pivot O4 at
 * (ground, 0). Crank (length `crank`) rotates about O2 by theta2; coupler joins
 * the crank tip A to the rocker tip B; rocker (length `rocker`) rotates about O4.
 */
export interface FourBar {
  crank: number;
  coupler: number;
  rocker: number;
  ground: number;
}

export interface FourBarState {
  theta4: number;
  A: [number, number];
  B: [number, number];
  /** Transmission angle between coupler and rocker (rad); near 90 deg is ideal */
  transmissionAngle: number;
}

export function isGrashof(fb: FourBar): boolean {
  const l = [fb.crank, fb.coupler, fb.rocker, fb.ground].sort((a, b) => a - b);
  return l[0] + l[3] <= l[1] + l[2];
}

/** Solve the rocker angle for a crank angle. Returns null if the linkage cannot assemble at that angle. */
export function solveFourBar(fb: FourBar, theta2: number, branch: 1 | -1 = 1): FourBarState | null {
  const A: [number, number] = [fb.crank * Math.cos(theta2), fb.crank * Math.sin(theta2)];
  const O4: [number, number] = [fb.ground, 0];
  const dx = O4[0] - A[0], dy = O4[1] - A[1];
  const d = Math.hypot(dx, dy);
  const r0 = fb.coupler, r1 = fb.rocker;
  if (d > r0 + r1 || d < Math.abs(r0 - r1) || d === 0) return null;
  const a = (r0 * r0 - r1 * r1 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r0 * r0 - a * a));
  const mx = A[0] + (a * dx) / d, my = A[1] + (a * dy) / d;
  const B: [number, number] = [mx - (branch * h * dy) / d, my + (branch * h * dx) / d];
  const theta4 = Math.atan2(B[1] - O4[1], B[0] - O4[0]);
  const cu = [B[0] - A[0], B[1] - A[1]], ro = [B[0] - O4[0], B[1] - O4[1]];
  const cosMu = (cu[0] * ro[0] + cu[1] * ro[1]) / (fb.coupler * fb.rocker);
  let mu = Math.acos(Math.max(-1, Math.min(1, cosMu)));
  if (mu > Math.PI / 2) mu = Math.PI - mu;
  return { theta4, A, B, transmissionAngle: mu };
}

/** Velocity ratio d(theta2)/d(theta4) (input/output speed ratio) at a crank angle, by central difference. */
export function fourBarRatio(fb: FourBar, theta2: number, branch: 1 | -1 = 1): number | null {
  const h = 1e-5;
  const a = solveFourBar(fb, theta2 - h, branch), b = solveFourBar(fb, theta2 + h, branch);
  if (!a || !b) return null;
  let d4 = b.theta4 - a.theta4;
  if (d4 > Math.PI) d4 -= 2 * Math.PI;
  if (d4 < -Math.PI) d4 += 2 * Math.PI;
  if (Math.abs(d4) < 1e-12) return null;
  return (2 * h) / d4;
}

/** Invert: find the crank angle that gives rocker angle theta4 (bisection over the assemblable range near a guess). */
export function crankForRocker(fb: FourBar, theta4: number, guess = Math.PI / 2, branch: 1 | -1 = 1): number | null {
  let x = guess;
  for (let i = 0; i < 40; i++) {
    const s = solveFourBar(fb, x, branch);
    const r = fourBarRatio(fb, x, branch);
    if (!s || r === null) return null;
    let err = theta4 - s.theta4;
    if (err > Math.PI) err -= 2 * Math.PI;
    if (err < -Math.PI) err += 2 * Math.PI;
    if (Math.abs(err) < 1e-9) return x;
    x += err * r;
  }
  return x;
}
