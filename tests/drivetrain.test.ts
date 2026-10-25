import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadLibrary } from "../src/core/library-node";
import { parseDesign } from "../src/core/validate";
import {
  isResolved,
  lewisY,
  motorElectrical,
  outputNoLoadSpeed,
  outputTorqueAt,
  resolveDrivetrain,
  stageStates,
  stageTorqueLimit,
} from "../src/core/drivetrain";

const lib = loadLibrary();
const quad = parseDesign(JSON.parse(readFileSync("examples/quadruped-trotter.json", "utf8"))).design!;
const arm = parseDesign(JSON.parse(readFileSync("examples/desk-arm.json", "utf8"))).design!;

const resolve = (design: typeof quad, id: string) => {
  const r = resolveDrivetrain(design.drivetrains.find((d) => d.id === id)!, design, lib);
  if (!isResolved(r)) throw new Error(r.errors.join(";"));
  return r;
};

describe("drivetrain resolution", () => {
  it("multiplies ratios and efficiencies through gearbox and belt", () => {
    const rd = resolve(quad, "dt_knee_fl");
    expect(rd.stages.map((s) => s.kind)).toEqual(["gearbox", "belt"]);
    expect(rd.totalRatio).toBeCloseTo(12, 9);
    expect(rd.totalEfficiency).toBeCloseTo(0.95 * 0.96, 9);
  });

  it("output torque follows the linear torque-speed line", () => {
    const rd = resolve(quad, "dt_hfe_fl");
    const stall = outputTorqueAt(rd, 0, "peak");
    const m = rd.motor;
    expect(stall).toBeCloseTo(m.stallTorque * 6 * 0.95, 6);
    const w0 = outputNoLoadSpeed(rd);
    expect(w0).toBeCloseTo(m.noLoadSpeed / 6, 9);
    expect(outputTorqueAt(rd, w0 / 2, "peak")).toBeCloseTo(stall / 2, 6);
    expect(outputTorqueAt(rd, w0 * 1.1, "peak")).toBe(0);
    // continuous never exceeds the continuous rating
    expect(outputTorqueAt(rd, 0, "continuous")).toBeCloseTo(m.continuousTorque * 6 * 0.95, 6);
  });

  it("caps output torque by the weakest gear stage", () => {
    const rd = resolve(arm, "dt_shoulder");
    const spur = rd.stages.find((s) => s.kind === "spur")!;
    // Lewis: sigma * m * F * Y * r
    const expected = 450e6 * 0.001 * 0.008 * lewisY(20) * 0.03;
    expect(spur.peakTorque).toBeCloseTo(expected, 6);
    const lim = stageTorqueLimit(rd, "peak");
    expect(lim.stage?.kind).toBe("spur");
    expect(outputTorqueAt(rd, 0, "peak")).toBeCloseTo(expected, 6);
  });

  it("splits smart servos into rotor + internal gear train", () => {
    const rd = resolve(arm, "dt_elbow");
    expect(rd.stages[0].kind).toBe("servo_internal");
    // Output stall torque is the datasheet value
    expect(outputTorqueAt(rd, 0, "peak")).toBeCloseTo(4.1, 6);
    expect(outputNoLoadSpeed(rd)).toBeCloseTo((46 * 2 * Math.PI) / 60, 6);
  });

  it("stage states conserve power minus losses", () => {
    const rd = resolve(quad, "dt_knee_fl");
    const st = stageStates(rd, 10, 2);
    expect(st[0].label).toBe("Motor rotor");
    expect(st[st.length - 1]).toMatchObject({ torque: 10, speed: 2 });
    expect(st[0].speed).toBeCloseTo(24, 9);
    const pin = st[0].torque * st[0].speed, pout = 10 * 2;
    expect(pout / pin).toBeCloseTo(rd.totalEfficiency, 9);
  });

  it("linkage stage resolves a ratio from the four-bar geometry", () => {
    const rd = resolve(arm, "dt_jaw");
    const link = rd.stages.find((s) => s.kind === "linkage")!;
    expect(link.ratio).toBeGreaterThan(0.3);
    expect(link.ratio).toBeLessThan(3);
  });

  it("electrical model: holding torque costs only copper loss", () => {
    const rd = resolve(quad, "dt_knee_fl");
    const e = motorElectrical(rd, 6, 0);
    expect(e.mechanicalPower).toBe(0);
    const I = 6 / (12 * rd.totalEfficiency) / rd.motor.kt + rd.motor.noLoadCurrent;
    expect(e.current).toBeCloseTo(I, 9);
    expect(e.electricalPower).toBeCloseTo(I * I * rd.motor.resistance, 9);
  });
});
