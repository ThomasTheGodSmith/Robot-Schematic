import type { Library } from "../library";
import { RobotDesign } from "../schema/design";
import { buildAnalysis, maxAbs, rms, robotComNominal } from "./analysis";
import {
  actuatorChecks,
  bearingFastenerChecks,
  costCheck,
  electricalChecks,
  integrityChecks,
  massChecks,
  powerChecks,
  propulsionChecks,
  rangeOfMotionChecks,
  stabilityChecks,
  structuralChecks,
  thermalChecks,
  wiringChecks,
} from "./checks";
import { worst, type Check, type CheckCategory, type JointSummary, type ValidationReport } from "./report";
import { buildBom } from "../bom";
import { outputNoLoadSpeed, outputTorqueAt } from "../drivetrain";

export * from "./report";

export type ProgressFn = (stage: string) => void;

/** Parse untrusted JSON into a design; returns readable issue strings on failure. */
export function parseDesign(raw: unknown): { design?: RobotDesign; issues: string[] } {
  const r = RobotDesign.safeParse(raw);
  if (r.success) return { design: r.data, issues: [] };
  return { issues: r.error.issues.slice(0, 40).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}

/**
 * Run every engineering check on a design. Checks that depend on a sound
 * kinematic tree are skipped (and reported) when integrity fails.
 */
export function validateDesign(design: RobotDesign, lib: Library, onProgress?: ProgressFn): ValidationReport {
  const checks: Check[] = [];
  const step = (label: string, fn: () => Check[]) => {
    onProgress?.(label);
    try {
      checks.push(...fn());
    } catch (e) {
      checks.push({
        id: `error:${label}`,
        category: "integrity",
        title: `${label} could not run`,
        status: "fail",
        message: `Internal error while checking: ${(e as Error).message}`,
        metrics: [],
        involves: [],
      });
    }
  };
  onProgress?.("Building kinematic tree and mass properties…");
  const a = buildAnalysis(design, lib);
  step("Checking design integrity…", () => integrityChecks(a));
  const fatal = checks.some((c) => c.id === "integrity:references" && c.status === "fail");
  step("Computing mass budget…", () => massChecks(a));
  let power: ReturnType<typeof powerChecks> = { checks: [], avgPower: null, peakPower: null, runtime: null };
  if (!fatal) {
    step("Validating torque budget…", () => actuatorChecks(a));
    step("Checking motor, driver and supply compatibility…", () => electricalChecks(a));
    step("Estimating power draw and runtime…", () => {
      power = powerChecks(a);
      return power.checks;
    });
    step("Checking wire gauges and voltage drop…", () => wiringChecks(a));
    step("Estimating motor winding temperatures…", () => thermalChecks(a));
    step("Checking structural stress on loaded members…", () => structuralChecks(a));
    step("Checking bearings and fasteners…", () => bearingFastenerChecks(a));
    step("Sweeping joint ranges for collisions…", () => rangeOfMotionChecks(a));
    step("Checking centre of mass and stability margins…", () => stabilityChecks(a));
    step("Checking propulsion and traction…", () => propulsionChecks(a));
  }
  const bom = buildBom(design, lib);
  checks.push(costCheck(bom.totalCost, bom.costByCategory));

  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) counts[c.status]++;

  const massBySubsystem: Record<string, number> = {};
  for (const l of design.links) massBySubsystem[l.subsystem] = (massBySubsystem[l.subsystem] ?? 0) + (a.linkMP.get(l.id)?.mass ?? 0);
  const { com } = robotComNominal(a);

  const joints: JointSummary[] = design.joints
    .filter((j) => j.type !== "fixed")
    .map((j) => {
      const o = a.ops.get(j.id) ?? { torquePeak: [], torqueStatic: [], speed: [] };
      const rd = a.drivetrains.get(j.id);
      return {
        jointId: j.id,
        drivetrainId: rd?.id,
        totalRatio: rd?.totalRatio,
        requiredPeakTorque_Nm: maxAbs(o.torquePeak),
        requiredRmsTorque_Nm: rms(o.torqueStatic),
        requiredSpeed_rad_s: Math.max(maxAbs(o.speed), j.limits?.velocity ?? 0),
        availablePeakTorque_Nm: rd ? outputTorqueAt(rd, 0, "peak") : undefined,
        availableContinuousTorque_Nm: rd ? outputTorqueAt(rd, 0, "continuous") : undefined,
        noLoadSpeed_rad_s: rd ? outputNoLoadSpeed(rd) : undefined,
        operatingPoints: o.torquePeak.map((t, i) => ({ torque: t, speed: o.speed[i] })),
      };
    });

  return {
    designId: design.id,
    status: worst(checks.map((c) => c.status)),
    counts,
    checks,
    summary: {
      totalMass_kg: a.totalMass,
      massBySubsystem,
      com_m: [com.x, com.y, com.z],
      busVoltage_V: a.busVoltage,
      batteryEnergy_Wh: a.battery?.energy_Wh ?? null,
      averagePower_W: power.avgPower,
      peakPower_W: power.peakPower,
      runtime_min: power.runtime,
      totalCost_usd: bom.totalCost,
      joints,
    },
    generatedAt: new Date().toISOString(),
  };
}

/** Compact text form of the failures and warnings, for feeding back to the Designer agent. */
export function reportToFeedback(report: ValidationReport, include: ("fail" | "warn")[] = ["fail", "warn"]): string {
  const lines: string[] = [`Validation: ${report.counts.fail} fail, ${report.counts.warn} warn, ${report.counts.pass} pass. Total mass ${report.summary.totalMass_kg.toFixed(2)} kg.`];
  for (const c of report.checks) {
    if (!include.includes(c.status as "fail" | "warn")) continue;
    const metrics = c.metrics.map((m) => `${m.label}=${Number(m.value.toFixed(3))}${m.unit}${m.limit !== undefined ? ` (limit ${m.relation ?? ""}${Number(m.limit.toFixed(3))})` : ""}`).join(", ");
    lines.push(`[${c.status.toUpperCase()}] ${c.category} | ${c.title}: ${c.message}${metrics ? ` {${metrics}}` : ""}${c.involves.length ? ` (involves: ${c.involves.slice(0, 8).join(", ")})` : ""}`);
  }
  return lines.join("\n");
}

export function checksByCategory(report: ValidationReport): Map<CheckCategory, Check[]> {
  const m = new Map<CheckCategory, Check[]>();
  for (const c of report.checks) m.set(c.category, [...(m.get(c.category) ?? []), c]);
  return m;
}
