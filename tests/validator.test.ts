import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { loadLibrary } from "../src/core/library-node";
import { parseDesign, reportToFeedback, validateDesign } from "../src/core/validate";
import { buildBom, bomToCsv } from "../src/core/bom";
import type { RobotDesign } from "../src/core/schema/design";

const lib = loadLibrary();
const raw = (f: string) => JSON.parse(readFileSync(`examples/${f}`, "utf8"));
const load = (f: string) => parseDesign(raw(f)).design!;
const clone = <T>(x: T): T => structuredClone(x);
const findPart = (d: RobotDesign, id: string) => d.links.flatMap((l) => l.parts).find((p) => p.id === id)!;
const statusOf = (d: RobotDesign, pred: (id: string) => boolean) =>
  validateDesign(d, lib)
    .checks.filter((c) => pred(c.id))
    .map((c) => c.status);

describe("component library", () => {
  it("loads and validates every data file with unique ids", () => {
    expect(lib.components.size).toBeGreaterThanOrEqual(40);
    expect(lib.materials.size).toBeGreaterThanOrEqual(8);
    for (const cat of ["motor", "servo", "gearbox", "bearing", "battery", "driver", "sensor", "fastener", "wire"] as const)
      expect(lib.byCategory(cat).length).toBeGreaterThan(0);
  });

  it("motor constants are self-consistent (Kt = 60 / (2 pi Kv))", () => {
    for (const m of lib.byCategory("motor"))
      if (m.specs.kv_rpm_per_V) expect(m.specs.kt_Nm_per_A).toBeCloseTo(60 / (2 * Math.PI * m.specs.kv_rpm_per_V), 3);
  });
});

describe("example designs", () => {
  const files = readdirSync("examples").filter((f) => f.endsWith(".json"));
  it.each(files)("%s parses and has no failing checks", (f) => {
    const { design, issues } = parseDesign(raw(f));
    expect(issues).toEqual([]);
    const report = validateDesign(design!, lib);
    const fails = report.checks.filter((c) => c.status === "fail");
    expect(fails.map((c) => `${c.title}: ${c.message}`)).toEqual([]);
    expect(report.summary.totalMass_kg).toBeGreaterThan(0);
  });

  it("reports progress stages", () => {
    const stages: string[] = [];
    validateDesign(load("quadruped-trotter.json"), lib, (s) => stages.push(s));
    expect(stages).toContain("Validating torque budget…");
    expect(stages.length).toBeGreaterThan(8);
  });

  it("quadruped knee torque is in the physically expected range", () => {
    const r = validateDesign(load("quadruped-trotter.json"), lib);
    const knee = r.summary.joints.find((j) => j.jointId === "knee_fl")!;
    // two-leg stance, ~13 kg, 1.5 load factor, ~0.13 m lever -> ~10-20 N·m
    expect(knee.requiredPeakTorque_Nm).toBeGreaterThan(8);
    expect(knee.requiredPeakTorque_Nm).toBeLessThan(25);
    expect(knee.totalRatio).toBeCloseTo(12);
  });
});

describe("validator catches violations", () => {
  it("rejects schema-invalid input with readable issues", () => {
    const bad = raw("quadruped-trotter.json");
    bad.joints[0].axis = [1, 0];
    delete bad.power;
    const { design, issues } = parseDesign(bad);
    expect(design).toBeUndefined();
    expect(issues.join("\n")).toMatch(/joints\.0\.axis/);
    expect(issues.join("\n")).toMatch(/power/);
  });

  it("undersized actuator fails the torque budget", () => {
    const d = clone(load("quadruped-trotter.json"));
    for (const k of ["fl", "fr", "rl", "rr"]) {
      const m = findPart(d, `knee_motor_${k}`);
      if (m.kind === "component") m.componentId = "bldc_4310_kv170";
    }
    const st = statusOf(d, (id) => id === "torque:peak:knee_fl");
    expect(st).toEqual(["fail"]);
  });

  it("missing drivetrain is flagged (no infinite-torque joints)", () => {
    const d = clone(load("quadruped-trotter.json"));
    d.drivetrains = d.drivetrains.filter((x) => x.jointId !== "knee_fl");
    expect(statusOf(d, (id) => id === "integrity:actuation")).toEqual(["fail"]);
  });

  it("servo on the wrong bus voltage fails electrical compatibility", () => {
    const d = clone(load("desk-arm.json"));
    const b = findPart(d, "battery");
    if (b.kind === "component") b.componentId = "lipo_6s_5000"; // 22.2 V on 12 V servos
    expect(statusOf(d, (id) => id === "electrical:dt_elbow")).toEqual(["fail"]);
  });

  it("thin wire fails ampacity", () => {
    const d = clone(load("quadruped-trotter.json"));
    d.power.wiring.find((w) => w.id === "phase_knee_fl")!.wireComponentId = "wire_awg24";
    expect(statusOf(d, (id) => id === "wiring:phase_knee_fl")).toEqual(["fail"]);
  });

  it("small battery fails runtime", () => {
    const d = clone(load("quadruped-trotter.json"));
    const b = findPart(d, "battery");
    if (b.kind === "component") b.componentId = "lipo_2s_1000";
    const r = validateDesign(d, lib);
    expect(r.checks.find((c) => c.id === "power:runtime")!.status).toBe("fail");
  });

  it("weak member fails structural stress", () => {
    const d = clone(load("quadruped-trotter.json"));
    for (const k of ["fl", "fr", "rl", "rr"]) {
      const p = findPart(d, `shank_tube_${k}`);
      if (p.kind === "fabricated") {
        p.shape = { type: "tube", outerRadius: 0.004, innerRadius: 0.0035, length: 0.18, axis: "z" };
        p.material = "pla";
      }
    }
    expect(statusOf(d, (id) => id === "structure:shank_fl")).toEqual(["fail"]);
  });

  it("overlapping parts fail the nominal self-intersection check", () => {
    const d = clone(load("quadruped-trotter.json"));
    // A torso-mounted bracket that intersects the front-left thigh (non-adjacent links)
    d.links[0].parts.push({ kind: "fabricated", id: "bad_bracket", name: "Bad bracket", shape: { type: "box", size: [0.05, 0.05, 0.05] }, material: "al6061_t6", pose: { xyz: [0.14, 0.195, -0.076], rpy: [0, 0, 0] }, role: "structure", collide: true });
    expect(statusOf(d, (id) => id === "rom:nominal")).toEqual(["fail"]);
  });

  it("raising the COM / narrowing the stance fails a steep slope requirement", () => {
    const d = clone(load("quadruped-trotter.json"));
    d.requirements.maxSlope_deg = 60;
    expect(statusOf(d, (id) => id === "stability:static")).toEqual(["fail"]);
  });

  it("speed beyond the no-load speed fails", () => {
    const d = clone(load("desk-arm.json"));
    d.joints.find((j) => j.id === "shoulder")!.limits!.velocity = 5;
    expect(statusOf(d, (id) => id === "speed:shoulder")).toEqual(["fail"]);
  });

  it("propeller flight on a heavy robot fails thrust-to-weight", () => {
    const d = clone(load("quadruped-trotter.json"));
    d.links[0].parts.push(
      ...[0, 1, 2, 3].map((i) => ({ kind: "component" as const, id: `prop_${i}`, componentId: "prop_5in_2207", pose: { xyz: [0.1 * (i - 1.5), 0, 0.08], rpy: [0, 0, 0] }, collide: false })),
    );
    expect(statusOf(d, (id) => id === "propulsion:thrust")).toEqual(["fail"]);
  });

  it("feedback text lists failures with metrics for the designer agent", () => {
    const d = clone(load("quadruped-trotter.json"));
    d.power.wiring.find((w) => w.id === "phase_knee_fl")!.wireComponentId = "wire_awg24";
    const fb = reportToFeedback(validateDesign(d, lib));
    expect(fb).toMatch(/\[FAIL\] wiring/);
    expect(fb).toMatch(/RMS current=/);
  });
});

describe("bill of materials", () => {
  it("groups identical components and totals mass consistently with the validator", () => {
    const d = load("quadruped-trotter.json");
    const bom = buildBom(d, lib);
    const motors = bom.rows.find((r) => r.source.includes("U8 Lite"))!;
    expect(motors.qty).toBe(12);
    const report = validateDesign(d, lib);
    // BOM excludes the payload and adds wire mass
    const wire = bom.rows.filter((r) => r.type === "wire (m)").reduce((s, r) => s + r.totalMass_kg, 0);
    expect(bom.totalMass - wire).toBeCloseTo(report.summary.totalMass_kg - d.requirements.payload_kg, 6);
    const csv = bomToCsv(bom.rows);
    expect(csv.split("\n")[0]).toMatch(/^Item,Name,Type/);
    expect(csv).toMatch(/TOTAL/);
  });
});
