import { describe, expect, it } from "vitest";
import { Matrix4, Quaternion, Vector3 } from "three";
import { shapeInertia, shapeVolume, sectionProperties, shapeHalfExtents } from "../src/core/math/shapes";
import { combine, parallelAxis, rotateDiagInertia, symmetricEigen, eigenFrameQuaternion } from "../src/core/math/massprops";
import { buildTopology, forwardKinematics, jointTransform } from "../src/core/math/frames";
import { solveChainIK, pointOnLink } from "../src/core/math/ik";
import { fourBarRatio, isGrashof, solveFourBar, crankForRocker } from "../src/core/math/fourbar";
import { staticJointLoads } from "../src/core/statics";
import { makeOBB, obbOverlap } from "../src/core/math/obb";
import { footOffset } from "../src/core/behavior";
import type { Joint, Link } from "../src/core/schema/design";

const close = (a: number, b: number, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(b)));

describe("shapes", () => {
  it("box volume and inertia match closed forms", () => {
    const s = { type: "box" as const, size: [0.2, 0.1, 0.05] };
    close(shapeVolume(s), 0.001);
    const [ixx, iyy, izz] = shapeInertia(s, 2);
    close(ixx, (2 / 12) * (0.1 ** 2 + 0.05 ** 2));
    close(iyy, (2 / 12) * (0.2 ** 2 + 0.05 ** 2));
    close(izz, (2 / 12) * (0.2 ** 2 + 0.1 ** 2));
  });

  it("cylinder inertia follows its axis", () => {
    const z = shapeInertia({ type: "cylinder", radius: 0.1, length: 0.4, axis: "z" }, 3);
    const x = shapeInertia({ type: "cylinder", radius: 0.1, length: 0.4, axis: "x" }, 3);
    close(z[2], 0.5 * 3 * 0.01);
    close(z[0], (3 * (3 * 0.01 + 0.16)) / 12);
    close(x[0], z[2]);
    close(x[1], z[0]);
    expect(shapeHalfExtents({ type: "cylinder", radius: 0.1, length: 0.4, axis: "y" })).toEqual([0.1, 0.2, 0.1]);
  });

  it("thin tube approaches m r^2 about its axis", () => {
    const [, , izz] = shapeInertia({ type: "tube", outerRadius: 0.1, innerRadius: 0.0999, length: 1, axis: "z" }, 1);
    close(izz, 0.01, 1e-3);
  });

  it("hollow rect tube = outer minus inner", () => {
    const s = { type: "rectTube" as const, width: 0.04, height: 0.02, wall: 0.002, length: 0.5, axis: "z" as const };
    close(shapeVolume(s), (0.04 * 0.02 - 0.036 * 0.016) * 0.5);
  });

  it("capsule with zero cylinder length behaves like a sphere", () => {
    const c = shapeInertia({ type: "capsule", radius: 0.05, length: 1e-9, axis: "z" }, 1);
    close(c[0], 0.4 * 0.0025, 1e-6);
    close(c[2], 0.4 * 0.0025, 1e-6);
  });

  it("section modulus of a solid round bar is pi r^3 / 4", () => {
    const p = sectionProperties({ type: "cylinder", radius: 0.01, length: 0.3, axis: "z" })!;
    close(p.sectionModulus, (Math.PI * 1e-6) / 4);
    const b = sectionProperties({ type: "box", size: [0.3, 0.02, 0.01] })!;
    expect(b.axis).toBe("x");
    close(b.sectionModulus, (0.02 * 0.01 ** 2) / 6); // weak axis governs
  });
});

describe("mass properties", () => {
  it("parallel axis theorem for two point masses", () => {
    const mp = combine([
      { mass: 1, com: new Vector3(-1, 0, 0), inertia: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] },
      { mass: 1, com: new Vector3(1, 0, 0), inertia: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] },
    ]);
    close(mp.mass, 2);
    close(mp.com.x, 0);
    close(mp.inertia[1][1], 2);
    close(mp.inertia[2][2], 2);
    close(mp.inertia[0][0], 0);
    close(parallelAxis(2, new Vector3(0, 0, 1))[0][0], 2);
  });

  it("eigen decomposition recovers a rotated diagonal inertia", () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 0.7);
    const I = rotateDiagInertia([1, 2, 3], q);
    const { values, vectors } = symmetricEigen(I);
    expect([...values].sort()).toEqual(expect.arrayContaining([expect.closeTo(1, 9), expect.closeTo(2, 9), expect.closeTo(3, 9)]));
    // reconstruct
    const R = eigenFrameQuaternion(vectors);
    const back = rotateDiagInertia(values, R);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) close(back[i][j], I[i][j], 1e-8);
  });
});

/** Planar two-link arm in the x-z plane, rotating about y. */
function twoLink(l1 = 0.3, l2 = 0.2) {
  const part = (id: string, len: number) => ({
    kind: "fabricated" as const,
    id,
    name: id,
    shape: { type: "box" as const, size: [0.01, 0.01, len] },
    material: "al6061_t6",
    pose: { xyz: [0, 0, len / 2], rpy: [0, 0, 0] },
    role: "structure" as const,
    collide: true,
  });
  const links: Link[] = [
    { id: "base", name: "base", subsystem: "b", parts: [] },
    { id: "a", name: "a", subsystem: "arm", parts: [part("pa", l1)] },
    { id: "b", name: "b", subsystem: "arm", parts: [part("pb", l2)] },
  ];
  const joints: Joint[] = [
    { id: "j1", name: "j1", type: "revolute", parent: "base", child: "a", origin: { xyz: [0, 0, 0], rpy: [0, 0, 0] }, axis: [0, 1, 0], limits: { lower: -3, upper: 3, velocity: 1 }, damping: 0, friction: 0 },
    { id: "j2", name: "j2", type: "revolute", parent: "a", child: "b", origin: { xyz: [0, 0, l1], rpy: [0, 0, 0] }, axis: [0, 1, 0], limits: { lower: -3, upper: 3, velocity: 1 }, damping: 0, friction: 0 },
  ];
  return { links, joints, rootLink: "base" };
}

describe("kinematics", () => {
  it("forward kinematics of a planar 2-link arm", () => {
    const d = twoLink();
    const topo = buildTopology(d);
    expect(topo.errors).toEqual([]);
    const T = forwardKinematics(topo, { j1: Math.PI / 2, j2: -Math.PI / 2 });
    const tip = pointOnLink(T, "b", [0, 0, 0.2]);
    // j1 = +90deg about y tips the arm to +x; j2 = -90deg turns it back to +z
    close(tip.x, 0.3, 1e-9);
    close(tip.z, 0.2, 1e-9);
  });

  it("rpy follows URDF fixed-axis convention", () => {
    const j: Joint = { id: "j", name: "j", type: "fixed", parent: "a", child: "b", origin: { xyz: [0, 0, 0], rpy: [0, 0, Math.PI / 2] }, axis: [0, 0, 1], damping: 0, friction: 0 };
    const v = new Vector3(1, 0, 0).applyMatrix4(jointTransform(j, 0));
    close(v.y, 1, 1e-12);
  });

  it("detects topology errors", () => {
    const d = twoLink();
    d.joints.push({ ...d.joints[1], id: "j3", child: "b" });
    expect(buildTopology(d).errors.join(" ")).toMatch(/more than one parent/);
  });

  it("damped least squares IK reaches a reachable target", () => {
    const d = twoLink();
    const topo = buildTopology(d);
    const target = new Vector3(0.25, 0, 0.2);
    const r = solveChainIK(topo, ["j1", "j2"], "b", [0, 0, 0.2], target, { j1: 0.3, j2: 0.3 }, { iterations: 200 });
    expect(r.error).toBeLessThan(1e-4);
    const tip = pointOnLink(forwardKinematics(topo, r.q), "b", [0, 0, 0.2]);
    expect(tip.distanceTo(target)).toBeLessThan(1e-4);
  });
});

describe("statics", () => {
  it("holding torque of a horizontal arm with a tip load is m g L", () => {
    const d = twoLink(0.3, 0.2);
    const topo = buildTopology(d);
    const T = forwardKinematics(topo, { j1: Math.PI / 2, j2: 0 }); // arm horizontal along +x
    const zeroI = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const mp = new Map([
      ["base", { mass: 0, com: new Vector3(), inertia: zeroI }],
      ["a", { mass: 1, com: new Vector3(0, 0, 0.15), inertia: zeroI }],
      ["b", { mass: 0.5, com: new Vector3(0, 0, 0.1), inertia: zeroI }],
    ]);
    const tip = pointOnLink(T, "b", [0, 0, 0.2]);
    const loads = staticJointLoads(topo, T, mp, [{ linkId: "b", point: tip, force: new Vector3(0, 0, -2) }]);
    const g = 9.81;
    const expectJ1 = 1 * g * 0.15 + 0.5 * g * 0.4 + 2 * 0.5;
    const expectJ2 = 0.5 * g * 0.1 + 2 * 0.2;
    close(Math.abs(loads.get("j1")!.torque), expectJ1, 1e-9);
    close(Math.abs(loads.get("j2")!.torque), expectJ2, 1e-9);
    // Actuator must lift: gravity pulls the +x arm down which is +y rotation, so actuator torque is negative.
    expect(loads.get("j1")!.torque).toBeLessThan(0);
    close(loads.get("j1")!.reaction.z, 1.5 * g + 2, 1e-9);
  });
});

describe("four-bar linkage", () => {
  it("parallelogram has unit velocity ratio and rocker tracks crank", () => {
    const fb = { crank: 0.05, coupler: 0.1, rocker: 0.05, ground: 0.1 };
    expect(isGrashof(fb)).toBe(true);
    const s = solveFourBar(fb, 0.8, 1)!;
    close(s.theta4, 0.8, 1e-9);
    close(Math.abs(fourBarRatio(fb, 0.8)!), 1, 1e-6);
  });

  it("loop closure holds and the inverse recovers the crank angle", () => {
    const fb = { crank: 0.012, coupler: 0.03, rocker: 0.02, ground: 0.028 };
    const s = solveFourBar(fb, 1.2)!;
    close(Math.hypot(s.B[0] - s.A[0], s.B[1] - s.A[1]), fb.coupler, 1e-12);
    close(Math.hypot(s.B[0] - fb.ground, s.B[1]), fb.rocker, 1e-12);
    const back = crankForRocker(fb, s.theta4, 1.0)!;
    close(back, 1.2, 1e-6);
  });

  it("returns null when it cannot assemble", () => {
    expect(solveFourBar({ crank: 0.1, coupler: 0.01, rocker: 0.01, ground: 0.5 }, 0)).toBeNull();
  });
});

describe("collision boxes", () => {
  it("SAT detects overlap and separation including rotated boxes", () => {
    const a = makeOBB(new Matrix4(), [0.5, 0.5, 0.5]);
    const b = makeOBB(new Matrix4().makeTranslation(0.9, 0, 0), [0.5, 0.5, 0.5]);
    const c = makeOBB(new Matrix4().makeTranslation(1.1, 0, 0), [0.5, 0.5, 0.5]);
    expect(obbOverlap(a, b)).toBe(true);
    expect(obbOverlap(a, c)).toBe(false);
    // A 45deg-rotated box reaches further along x
    const r = new Matrix4().makeRotationZ(Math.PI / 4).setPosition(1.15, 0, 0);
    expect(obbOverlap(a, makeOBB(r, [0.5, 0.5, 0.5]))).toBe(true);
  });
});

describe("gait trajectory", () => {
  it("stance sweeps the stride backwards, swing lifts the foot", () => {
    const g = { dutyFactor: 0.5, strideLength_m: 0.1, stepHeight_m: 0.05 };
    expect(footOffset(0, g)).toMatchObject({ dx: 0.05, dz: 0, stance: true });
    close(footOffset(0.4999999, g).dx, -0.05, 1e-5);
    const mid = footOffset(0.75, g);
    expect(mid.stance).toBe(false);
    close(mid.dz, 0.05, 1e-9);
    close(mid.dx, 0, 1e-9);
  });
});
