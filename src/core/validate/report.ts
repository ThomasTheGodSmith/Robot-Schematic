export type Status = "pass" | "warn" | "fail";

export type CheckCategory =
  | "integrity"
  | "mass"
  | "torque"
  | "speed"
  | "gearing"
  | "electrical"
  | "power"
  | "wiring"
  | "thermal"
  | "structure"
  | "bearings"
  | "fasteners"
  | "range_of_motion"
  | "stability"
  | "propulsion"
  | "cost";

export const CATEGORY_LABELS: Record<CheckCategory, string> = {
  integrity: "Design integrity",
  mass: "Mass budget",
  torque: "Joint torque budget",
  speed: "Joint speed",
  gearing: "Gear stage ratings",
  electrical: "Electrical compatibility",
  power: "Power & runtime",
  wiring: "Wiring",
  thermal: "Thermal",
  structure: "Structural stress",
  bearings: "Bearings",
  fasteners: "Fasteners",
  range_of_motion: "Range of motion",
  stability: "Stability",
  propulsion: "Propulsion",
  cost: "Cost",
};

export interface Metric {
  label: string;
  value: number;
  unit: string;
  /** The limit the value is compared against, if any */
  limit?: number;
  /** How the comparison reads, e.g. "≤" */
  relation?: "≤" | "≥" | "<" | ">" | "=";
}

export interface Check {
  id: string;
  category: CheckCategory;
  title: string;
  status: Status;
  message: string;
  metrics: Metric[];
  /** Part, link, joint or drivetrain ids this check concerns (for cross-linking in the UI) */
  involves: string[];
}

export interface ValidationReport {
  designId: string;
  status: Status;
  counts: Record<Status, number>;
  checks: Check[];
  summary: DerivedSummary;
  generatedAt: string;
}

export interface DerivedSummary {
  totalMass_kg: number;
  massBySubsystem: Record<string, number>;
  com_m: number[];
  busVoltage_V: number | null;
  batteryEnergy_Wh: number | null;
  averagePower_W: number | null;
  peakPower_W: number | null;
  runtime_min: number | null;
  totalCost_usd: number;
  joints: JointSummary[];
}

export interface JointSummary {
  jointId: string;
  drivetrainId?: string;
  totalRatio?: number;
  requiredPeakTorque_Nm: number;
  requiredRmsTorque_Nm: number;
  requiredSpeed_rad_s: number;
  availablePeakTorque_Nm?: number;
  availableContinuousTorque_Nm?: number;
  noLoadSpeed_rad_s?: number;
  /** Operating points over one behaviour cycle (peak-load torque, speed) */
  operatingPoints: { torque: number; speed: number }[];
}

export function worst(statuses: Status[]): Status {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("warn")) return "warn";
  return "pass";
}

/** Status from a ratio of demand to capacity with a warning band. */
export function grade(demand: number, capacity: number, warnAbove = 0.85): Status {
  if (!(capacity > 0)) return "fail";
  const r = demand / capacity;
  if (r > 1) return "fail";
  if (r > warnAbove) return "warn";
  return "pass";
}

export const fmt = (v: number, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)).toString() : String(v));
