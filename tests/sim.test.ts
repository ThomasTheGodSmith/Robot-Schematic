import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadLibrary } from "../src/core/library-node";
import { parseDesign } from "../src/core/validate";
import { RobotDesign } from "../src/core/schema/design";
import { initPhysics, RobotSimulator } from "../src/sim/simulator";
import { outputTorqueAt, isResolved, resolveDrivetrain } from "../src/core/drivetrain";

const lib = loadLibrary();
const load = (f: string) => parseDesign(JSON.parse(readFileSync(`examples/${f}`, "utf8"))).design!;

beforeAll(async () => {
  await initPhysics();
});

/** A bolted-down base with one unactuated pendulum link (a 0.3 m arm with a 1 kg bob). */
function pendulum(axis: number[], rpy: number[], limits?: { lower: number; upper: number }, withDrivetrain = false, bob = [0.3, 0, 0]): RobotDesign {
  return RobotDesign.parse({
    schemaVersion: "1.0",
    id: "pendulum",
    name: "pendulum",
    description: "test",
    rootLink: "base",
    rootFixed: true,
    links: [
      {
        id: "base",
        name: "base",
        subsystem: "base",
        parts: [
          { kind: "fabricated", id: "plate", name: "plate", shape: { type: "box", size: [0.1, 0.1, 0.02] }, material: "al6061_t6", collide: false },
          { kind: "component", id: "batt", componentId: "lipo_3s_2200", pose: { xyz: [0, 0, 0.05], rpy: [0, 0, 0] } },
          { kind: "component", id: "hub", componentId: "drv_dxl_hub", pose: { xyz: [0, 0.05, 0.05], rpy: [0, 0, 0] } },
          { kind: "component", id: "servo", componentId: "dxl_xm430_w350", pose: { xyz: [0, 0, 0.5], rpy: [0, 0, 0] } },
        ],
      },
      {
        id: "arm",
        name: "arm",
        subsystem: "arm",
        parts: [{ kind: "fabricated", id: "bob", name: "bob", shape: { type: "sphere", radius: 0.044 }, material: "steel_1045", pose: { xyz: bob, rpy: [0, 0, 0] }, collide: false }],
      },
    ],
    joints: [
      {
        id: "j",
        name: "j",
        type: limits ? "revolute" : "continuous",
        parent: "base",
        child: "arm",
        origin: { xyz: [0, 0, 1], rpy },
        axis,
        limits: limits ? { ...limits, velocity: 10 } : undefined,
        damping: 0.6,
        friction: 0,
      },
    ],
    drivetrains: withDrivetrain ? [{ id: "dt", jointId: "j", motorPartId: "servo", driverPartId: "hub" }] : [],
    power: { batteryPartIds: ["batt"] },
    behavior: { mode: "stand", nominalPose: { j: limits ? (limits.lower + limits.upper) / 2 : 0 }, pid: { default: { kp: 0, kd: 0 } } },
  });
}

function settle(d: RobotDesign, seconds = 4) {
  const sim = new RobotSimulator(d, lib);
  sim.step(Math.round(seconds / sim.dt));
  const q = sim.frame().joints.j.q;
  sim.dispose();
  return q;
}

describe("joint angle measurement vs Rapier limits", () => {
  const cases: { axis: number[]; rpy: number[] }[] = [
    { axis: [0, 1, 0], rpy: [0, 0, 0] },
    { axis: [0, 1, 0], rpy: [0.3, 0.5, 0.2] },
    { axis: [1, 0, 1], rpy: [0, 0, 0.7] },
    { axis: [-1, 0, 0], rpy: [0.4, -0.2, 0] },
    { axis: [-1, 0, 0], rpy: [0, 0, 0] },
    { axis: [1, 0, 0], rpy: [0, 0, Math.PI] },
    { axis: [0, -1, 0], rpy: [1.2, 0.1, -0.5] },
  ];
  it.each(cases)("limit is enforced at the measured angle (axis $axis, rpy $rpy)", ({ axis, rpy }) => {
    // Bob placed off every test axis so gravity always produces a torque about the hinge
    const bob = [0.05, 0.25, 0.15];
    const free = settle(pendulum(axis, rpy, undefined, false, bob), 8);
    // Choose a 0.4 rad window that excludes the free hanging angle, then check the bob rests on the nearer limit.
    const wrapDiff = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));
    let tested = 0;
    // Windows entirely on one side of the hanging angle, kept inside (-pi, pi) where joint angles are defined.
    const lo = free + 0.6, hi = free + 1.0;
    if (hi < Math.PI - 0.05) {
      const q = settle(pendulum(axis, rpy, { lower: lo, upper: hi }, false, bob), 4);
      expect(Math.abs(wrapDiff(q - lo))).toBeLessThan(0.03);
      tested++;
    }
    const lo2 = free - 1.0, hi2 = free - 0.6;
    if (lo2 > -Math.PI + 0.05) {
      const q2 = settle(pendulum(axis, rpy, { lower: lo2, upper: hi2 }, false, bob), 4);
      expect(Math.abs(wrapDiff(q2 - hi2))).toBeLessThan(0.03);
      tested++;
    }
    expect(tested).toBeGreaterThan(0);
  });

  it("measured angle of a free pendulum matches the gravity-down angle", () => {
    // Axis y with no origin rotation: the bob at +x hangs straight down at q = +pi/2.
    const q = settle(pendulum([0, 1, 0], [0, 0, 0]), 8);
    expect(q).toBeCloseTo(Math.PI / 2, 1);
  });
});

describe("actuator model", () => {
  it("never applies more torque than the drivetrain can deliver", () => {
    const d = pendulum([0, 1, 0], [0, 0, 0], { lower: -3, upper: 3 }, true);
    d.behavior.pid.default = { kp: 1e5, kd: 50, ki: 0 };
    d.behavior.nominalPose = { j: -1.5 }; // lift the bob against gravity: needs ~2.9 N·m of the servo's 4.1 N·m
    const sim = new RobotSimulator(d, lib);
    const rd = resolveDrivetrain(d.drivetrains[0], d, lib);
    if (!isResolved(rd)) throw new Error("unresolved");
    let maxRatio = 0, sawSaturation = false;
    for (let i = 0; i < 400; i++) {
      sim.step(5);
      const j = sim.frame().joints.j;
      const avail = Math.max(outputTorqueAt(rd, j.qd, "peak"), outputTorqueAt(rd, 0, "peak"));
      maxRatio = Math.max(maxRatio, Math.abs(j.torque) / avail);
      sawSaturation ||= j.saturated;
      expect(Math.abs(j.torque)).toBeLessThanOrEqual(j.torqueLimit + 1e-9);
    }
    expect(maxRatio).toBeLessThanOrEqual(1 + 1e-9);
    expect(sawSaturation).toBe(true);
    sim.dispose();
  });

  it("a load beyond stall torque cannot be lifted (no infinite-torque joints)", () => {
    const d = pendulum([0, 1, 0], [0, 0, 0], { lower: -3, upper: 3 }, true);
    // 1 kg bob at 0.3 m needs 2.9 N·m; swap in a weaker servo (1.5 N·m stall).
    (d.links[0].parts[3] as { componentId: string }).componentId = "dxl_xl430_w250";
    d.behavior.pid.default = { kp: 200, kd: 2, ki: 0 };
    d.behavior.nominalPose = { j: 0 }; // hold horizontal
    const sim = new RobotSimulator(d, lib);
    sim.step(1500);
    const j = sim.frame().joints.j;
    expect(j.saturated).toBe(true);
    expect(j.q).toBeGreaterThan(0.5); // sagged towards hanging
    expect(sim.frame().overLimitParts).toContain("servo");
    sim.dispose();
  });
});

describe("quadruped integration", () => {
  it("stands, carries its weight on its feet, then trots honestly", () => {
    const d = load("quadruped-trotter.json");
    const sim = new RobotSimulator(d, lib, { scenario: "flat" });
    const h0 = sim.frame().base.height;
    sim.step(Math.round(0.9 / sim.dt));
    const f = sim.frame();
    expect(f.status).toBe("running");
    expect(Math.abs(f.base.height - h0) / h0).toBeLessThan(0.25);
    const support = f.contacts.reduce((s, c) => s + c.force_N, 0);
    expect(support / (sim.mass * 9.81)).toBeGreaterThan(0.8);
    expect(support / (sim.mass * 9.81)).toBeLessThan(1.2);

    const socs: number[] = [];
    for (let k = 0; k < 16; k++) {
      sim.step(Math.round(0.25 / sim.dt));
      const fr = sim.frame();
      socs.push(fr.battery.soc);
      for (const l of Object.values(fr.links)) expect([...l.p, ...l.q].every(Number.isFinite)).toBe(true);
      // Status must reflect the actual body state
      const tilt = Math.max(Math.abs(fr.base.roll), Math.abs(fr.base.pitch));
      if (fr.status === "running") expect(tilt).toBeLessThan((60 * Math.PI) / 180);
    }
    const end = sim.frame();
    console.log(`quadruped trot: t=${end.t.toFixed(1)} s status=${end.status} distance=${end.base.distance.toFixed(3)} m speed=${end.base.forwardSpeed.toFixed(2)} m/s height=${end.base.height.toFixed(3)} m power=${end.power_W.toFixed(0)} W`);
    // battery drains monotonically
    for (let i = 1; i < socs.length; i++) expect(socs[i]).toBeLessThan(socs[i - 1]);
    sim.dispose();
  });

  it("reports a fall honestly when the actuators are far too weak", () => {
    const d = structuredClone(load("quadruped-trotter.json"));
    for (const l of d.links) for (const p of l.parts) if (p.kind === "component" && p.componentId === "bldc_8318_kv100") p.componentId = "dc_25d_12v_hp";
    const sim = new RobotSimulator(d, lib);
    sim.step(Math.round(3 / sim.dt));
    const f = sim.frame();
    expect(f.status).toBe("fallen");
    expect(f.message).toMatch(/Fell/);
    sim.dispose();
  });

  it.each(["slope", "steps", "push", "payload"] as const)("runs the %s scenario without numerical blow-up", (scenario) => {
    const sim = new RobotSimulator(load("quadruped-trotter.json"), lib, { scenario });
    const w = sim.world();
    expect(w.scenario).toBe(scenario);
    if (scenario === "slope") expect(w.ground.slope_deg).toBeGreaterThan(0);
    if (scenario === "steps") expect(w.obstacles.length).toBeGreaterThan(0);
    if (scenario === "payload") expect(w.payload!.mass).toBeGreaterThan(0);
    sim.step(Math.round(4 / sim.dt));
    const f = sim.frame();
    for (const l of Object.values(f.links)) expect([...l.p, ...l.q].every(Number.isFinite)).toBe(true);
    expect(["running", "fallen"]).toContain(f.status);
    console.log(`scenario ${scenario}: status=${f.status} distance=${f.base.distance.toFixed(2)} m ${f.message ?? ""}`);
    sim.dispose();
  });
});

describe("desk arm integration", () => {
  it("tracks the pick-and-place waypoints within torque limits", () => {
    const d = load("desk-arm.json");
    const sim = new RobotSimulator(d, lib);
    let worstErr = 0;
    for (let k = 0; k < 30; k++) {
      sim.step(Math.round(0.1 / sim.dt));
      const f = sim.frame();
      expect(f.status).toBe("ok");
      for (const [id, j] of Object.entries(f.joints)) {
        expect(Math.abs(j.torque)).toBeLessThanOrEqual(j.torqueLimit + 1e-9);
        if (id !== "jaw" && f.t > 0.5) worstErr = Math.max(worstErr, Math.abs(j.target - j.q));
      }
    }
    console.log(`desk arm worst tracking error ${worstErr.toFixed(3)} rad`);
    expect(worstErr).toBeLessThan(0.15);
    sim.dispose();
  });
});
