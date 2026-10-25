import type { Library } from "./library";
import type { Drivetrain, Part, RobotDesign, Stage } from "./schema/design";
import type { ComponentOf } from "./schema/library";
import { fourBarRatio, solveFourBar, type FourBar } from "./math/fourbar";

const RPM = (2 * Math.PI) / 60;

/** Normalised motor model at the rotor (servos are split into a rotor + internal gear stage). */
export interface MotorModel {
  partId: string;
  componentId: string;
  name: string;
  kind: "motor" | "servo";
  nominalVoltage_V: number;
  kt: number; // N·m/A at the rotor
  stallTorque: number; // N·m at the rotor (peak)
  continuousTorque: number; // N·m at the rotor
  noLoadSpeed: number; // rad/s at the rotor
  peakCurrent: number;
  continuousCurrent: number;
  resistance: number; // ohm (phase-to-phase / terminal equivalent)
  noLoadCurrent: number;
  rotorInertia: number;
  thermalResistance: number; // C/W
  maxWindingTemp: number;
  motorType: string;
}

export interface ResolvedStage {
  label: string;
  kind: "servo_internal" | "gearbox" | "spur" | "belt" | "linkage";
  ratio: number; // input speed / output speed
  efficiency: number;
  /** Output-side torque ratings for this stage (N·m) */
  ratedTorque?: number;
  peakTorque?: number;
  maxInputSpeed?: number; // rad/s
  backlash_arcmin?: number;
  partId?: string;
  componentId?: string;
  teeth?: { driver: number; driven: number } | { sun: number; planet: number; ring: number };
  gearType?: string;
  linkage?: FourBar & { theta2Nominal: number };
  pitch_m?: number;
  module_m?: number;
  notes?: string;
}

export interface ResolvedDrivetrain {
  id: string;
  jointId: string;
  motor: MotorModel;
  stages: ResolvedStage[];
  totalRatio: number;
  totalEfficiency: number;
  /** Driver current limit, if the driver is resolvable */
  driverPeakCurrent?: number;
  driverContinuousCurrent?: number;
  errors: string[];
}

function findPart(design: RobotDesign, partId: string): Part | undefined {
  for (const l of design.links) for (const p of l.parts) if (p.id === partId) return p;
  return undefined;
}

/** Lewis form factor approximation for 20 deg full-depth involute teeth. */
export function lewisY(teeth: number): number {
  return 0.154 - 0.912 / teeth;
}

export function resolveStage(stage: Stage, design: RobotDesign, lib: Library): { stage?: ResolvedStage; error?: string } {
  switch (stage.kind) {
    case "gearbox": {
      const part = findPart(design, stage.partId);
      if (!part || part.kind !== "component") return { error: `Gearbox stage references unknown component part '${stage.partId}'` };
      const g = lib.getAs(part.componentId, "gearbox");
      if (!g) return { error: `Part '${stage.partId}' is not a gearbox component` };
      const s = g.specs;
      return {
        stage: {
          label: g.name,
          kind: "gearbox",
          gearType: s.gearType,
          ratio: s.ratio,
          efficiency: s.efficiency,
          ratedTorque: s.ratedTorque_Nm,
          peakTorque: s.peakTorque_Nm,
          maxInputSpeed: s.maxInputSpeed_rpm * RPM,
          backlash_arcmin: s.backlash_arcmin,
          partId: part.id,
          componentId: g.id,
          teeth: s.teeth,
        },
      };
    }
    case "spur": {
      const mat = lib.material(stage.material);
      if (!mat) return { error: `Spur stage uses unknown material '${stage.material}'` };
      // Lewis bending: allowable tangential force on the weaker (smaller) gear
      const Y = lewisY(Math.min(stage.driverTeeth, stage.drivenTeeth));
      const sigmaPeak = mat.yieldStrength_MPa * 1e6;
      const FtPeak = sigmaPeak * stage.module_m * stage.faceWidth_m * Y;
      const rDriven = (stage.module_m * stage.drivenTeeth) / 2;
      return {
        stage: {
          label: stage.name ?? `Spur ${stage.driverTeeth}:${stage.drivenTeeth} (m${stage.module_m * 1000})`,
          kind: "spur",
          ratio: stage.drivenTeeth / stage.driverTeeth,
          efficiency: stage.efficiency,
          peakTorque: FtPeak * rDriven,
          ratedTorque: (FtPeak * rDriven) / 2, // fatigue allowance ~ half of static bending limit
          backlash_arcmin: 20,
          teeth: { driver: stage.driverTeeth, driven: stage.drivenTeeth },
          module_m: stage.module_m,
          notes: `Lewis bending, Y=${Y.toFixed(3)}, ${mat.name}`,
        },
      };
    }
    case "belt": {
      const rDriven = (stage.pitch_m * stage.drivenTeeth) / (2 * Math.PI);
      return {
        stage: {
          label: stage.name ?? `Timing belt ${stage.driverTeeth}:${stage.drivenTeeth}`,
          kind: "belt",
          ratio: stage.drivenTeeth / stage.driverTeeth,
          efficiency: stage.efficiency,
          ratedTorque: stage.ratedTension_N * rDriven,
          peakTorque: 2 * stage.ratedTension_N * rDriven,
          backlash_arcmin: 10,
          teeth: { driver: stage.driverTeeth, driven: stage.drivenTeeth },
          pitch_m: stage.pitch_m,
        },
      };
    }
    case "linkage": {
      const fb: FourBar = { crank: stage.crank_m, coupler: stage.coupler_m, rocker: stage.rocker_m, ground: stage.ground_m };
      // Nominal operating point: crank angle with the best transmission angle.
      let best = -1, theta2Nominal = Math.PI / 2;
      for (let i = 0; i < 360; i++) {
        const t = (i / 360) * 2 * Math.PI;
        const s = solveFourBar(fb, t);
        if (s && s.transmissionAngle > best) {
          best = s.transmissionAngle;
          theta2Nominal = t;
        }
      }
      const r = fourBarRatio(fb, theta2Nominal);
      if (r === null || best < 0) return { error: `Linkage stage '${stage.name ?? "linkage"}' cannot assemble (check link lengths)` };
      return {
        stage: {
          label: stage.name ?? "Four-bar linkage",
          kind: "linkage",
          ratio: Math.abs(r),
          efficiency: stage.efficiency,
          linkage: { ...fb, theta2Nominal },
          notes: `Ratio at best transmission angle (${((best * 180) / Math.PI).toFixed(0)} deg); varies with position`,
        },
      };
    }
  }
}

export function motorModel(part: Part, lib: Library): { motor?: MotorModel; internal?: ResolvedStage; error?: string } {
  if (part.kind !== "component") return { error: `Motor part '${part.id}' must be a library component` };
  const c = lib.get(part.componentId);
  if (!c) return { error: `Unknown component '${part.componentId}'` };
  if (c.category === "motor") {
    const s = c.specs;
    return {
      motor: {
        partId: part.id,
        componentId: c.id,
        name: c.name,
        kind: "motor",
        nominalVoltage_V: s.nominalVoltage_V,
        kt: s.kt_Nm_per_A,
        stallTorque: s.stallTorque_Nm,
        continuousTorque: s.continuousTorque_Nm,
        noLoadSpeed: s.noLoadSpeed_rpm * RPM,
        peakCurrent: s.peakCurrent_A,
        continuousCurrent: s.continuousCurrent_A,
        resistance: s.phaseResistance_ohm,
        noLoadCurrent: s.noLoadCurrent_A,
        rotorInertia: s.rotorInertia_kgm2,
        thermalResistance: s.thermalResistance_C_per_W,
        maxWindingTemp: s.maxWindingTemp_C,
        motorType: s.motorType,
      },
    };
  }
  if (c.category === "servo") {
    const s = (c as ComponentOf<"servo">).specs;
    const N = s.internalRatio, eta = s.internalEfficiency;
    const stall = s.stallTorque_Nm / (N * eta);
    return {
      motor: {
        partId: part.id,
        componentId: c.id,
        name: `${c.name} (rotor)`,
        kind: "servo",
        nominalVoltage_V: s.nominalVoltage_V,
        kt: stall / s.stallCurrent_A,
        stallTorque: stall,
        continuousTorque: s.continuousTorque_Nm / (N * eta),
        noLoadSpeed: s.noLoadSpeed_rpm * RPM * N,
        peakCurrent: s.stallCurrent_A,
        continuousCurrent: s.continuousCurrent_A,
        resistance: s.phaseResistance_ohm,
        noLoadCurrent: s.idleCurrent_A,
        rotorInertia: 0,
        thermalResistance: s.thermalResistance_C_per_W,
        maxWindingTemp: s.maxWindingTemp_C,
        motorType: "servo",
      },
      internal: {
        label: `${c.name} internal gear train`,
        kind: "servo_internal",
        ratio: N,
        efficiency: eta,
        peakTorque: s.stallTorque_Nm * 1.05,
        ratedTorque: s.continuousTorque_Nm,
        backlash_arcmin: s.backlash_arcmin,
        partId: part.id,
        componentId: c.id,
      },
    };
  }
  return { error: `Component '${c.id}' (${c.category}) is not a motor or servo` };
}

export function resolveDrivetrain(dt: Drivetrain, design: RobotDesign, lib: Library): ResolvedDrivetrain | { errors: string[] } {
  const errors: string[] = [];
  const mPart = findPart(design, dt.motorPartId);
  if (!mPart) return { errors: [`Drivetrain '${dt.id}' references unknown motor part '${dt.motorPartId}'`] };
  const mm = motorModel(mPart, lib);
  if (!mm.motor) return { errors: [mm.error!] };
  const stages: ResolvedStage[] = [];
  if (mm.internal) stages.push(mm.internal);
  for (const s of dt.stages) {
    const r = resolveStage(s, design, lib);
    if (r.error) errors.push(r.error);
    if (r.stage) stages.push(r.stage);
  }
  const totalRatio = stages.reduce((p, s) => p * s.ratio, 1);
  const totalEfficiency = stages.reduce((p, s) => p * s.efficiency, 1);
  let driverPeakCurrent: number | undefined, driverContinuousCurrent: number | undefined;
  const dPart = findPart(design, dt.driverPartId);
  if (dPart?.kind === "component") {
    const d = lib.getAs(dPart.componentId, "driver");
    if (d) {
      driverPeakCurrent = d.specs.peakCurrent_A;
      driverContinuousCurrent = d.specs.continuousCurrent_A;
    }
  }
  return { id: dt.id, jointId: dt.jointId, motor: mm.motor, stages, totalRatio, totalEfficiency, driverPeakCurrent, driverContinuousCurrent, errors };
}

export function isResolved(x: ResolvedDrivetrain | { errors: string[] }): x is ResolvedDrivetrain {
  return "motor" in x;
}

/**
 * Multiplier converting a stage's output torque to joint-output torque
 * (product of ratio*efficiency of the stages after it).
 */
function downstreamGain(rd: ResolvedDrivetrain, i: number): number {
  let g = 1;
  for (let k = i + 1; k < rd.stages.length; k++) g *= rd.stages[k].ratio * rd.stages[k].efficiency;
  return g;
}

/** Joint-output torque limit imposed by stage ratings (min over stages). */
export function stageTorqueLimit(rd: ResolvedDrivetrain, which: "peak" | "rated"): { limit: number; stage?: ResolvedStage } {
  let limit = Infinity, stage: ResolvedStage | undefined;
  rd.stages.forEach((s, i) => {
    const r = which === "peak" ? s.peakTorque : s.ratedTorque;
    if (r === undefined) return;
    const l = r * downstreamGain(rd, i);
    if (l < limit) {
      limit = l;
      stage = s;
    }
  });
  return { limit, stage };
}

/** Motor torque available at a rotor speed (rad/s): linear torque-speed line, capped by current limits. */
export function motorTorqueAt(m: MotorModel, rotorSpeed: number, mode: "peak" | "continuous", driverCurrent?: number): number {
  const w = Math.abs(rotorSpeed);
  const line = m.stallTorque * Math.max(0, 1 - w / m.noLoadSpeed);
  let t = mode === "peak" ? line : Math.min(line, m.continuousTorque);
  if (driverCurrent !== undefined) t = Math.min(t, m.kt * driverCurrent);
  return t;
}

/** Joint-output torque available at a joint speed. */
export function outputTorqueAt(rd: ResolvedDrivetrain, jointSpeed: number, mode: "peak" | "continuous"): number {
  const driverI = mode === "peak" ? rd.driverPeakCurrent : rd.driverContinuousCurrent;
  const tm = motorTorqueAt(rd.motor, jointSpeed * rd.totalRatio, mode, driverI);
  const fromMotor = tm * rd.totalRatio * rd.totalEfficiency;
  return Math.min(fromMotor, stageTorqueLimit(rd, mode === "peak" ? "peak" : "rated").limit);
}

export function outputNoLoadSpeed(rd: ResolvedDrivetrain): number {
  return rd.motor.noLoadSpeed / rd.totalRatio;
}

/** Torque and speed at every stage boundary for a given joint torque/speed (for the live drivetrain readout). */
export function stageStates(rd: ResolvedDrivetrain, jointTorque: number, jointSpeed: number) {
  // Walk backwards from the output: input torque = output / (ratio * eff), input speed = output * ratio.
  const states: { label: string; torque: number; speed: number }[] = [];
  let t = jointTorque, w = jointSpeed;
  states.unshift({ label: "Joint output", torque: t, speed: w });
  for (let i = rd.stages.length - 1; i >= 0; i--) {
    const s = rd.stages[i];
    t = t / (s.ratio * s.efficiency);
    w = w * s.ratio;
    states.unshift({ label: i === 0 ? "Motor rotor" : `${rd.stages[i - 1].label} out`, torque: t, speed: w });
  }
  return states;
}

/** Electrical operating point of the motor for a joint torque/speed. */
export function motorElectrical(rd: ResolvedDrivetrain, jointTorque: number, jointSpeed: number) {
  const w = jointSpeed * rd.totalRatio;
  const motoring = jointTorque * jointSpeed >= 0;
  // When motoring, losses add to the torque the rotor must make; when back-driven they subtract.
  const tm = motoring ? jointTorque / (rd.totalRatio * rd.totalEfficiency) : (jointTorque * rd.totalEfficiency) / rd.totalRatio;
  const current = Math.abs(tm) / rd.motor.kt + rd.motor.noLoadCurrent;
  const copperLoss = current * current * rd.motor.resistance;
  const mech = tm * w;
  return { rotorTorque: tm, rotorSpeed: w, current, copperLoss, mechanicalPower: mech, electricalPower: Math.max(copperLoss, mech + copperLoss) };
}
