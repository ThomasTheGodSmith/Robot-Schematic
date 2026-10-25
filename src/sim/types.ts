import type { RobotDesign } from "../core/schema/design";

/** Contract between the physics worker and the UI. */

export type ScenarioId = "flat" | "slope" | "steps" | "push" | "payload";

export interface WorldDescriptor {
  ground: { slope_deg: number };
  /** Static boxes; size = full extents, p = centre, q = [x, y, z, w] */
  obstacles: { id: string; size: number[]; p: number[]; q: number[] }[];
  scenario: ScenarioId;
  rootFixed: boolean;
  payload?: { linkId: string; mass: number; size: number[]; offset: number[] };
}

export interface JointTelemetry {
  q: number;
  qd: number;
  target: number;
  /** Actuator torque actually applied (after the actuator model clamp) */
  torque: number;
  /** Torque available from the drivetrain at the current speed and temperature */
  torqueLimit: number;
  saturated: boolean;
  current_A: number;
  power_W: number;
  temp_C: number;
  overheated: boolean;
}

export interface SimFrame {
  t: number;
  status: "running" | "fallen" | "stalled" | "ok";
  message?: string;
  /** World pose of each link FRAME (not COM); q = [x, y, z, w] */
  links: Record<string, { p: number[]; q: number[] }>;
  joints: Record<string, JointTelemetry>;
  power_W: number;
  battery: { soc: number; voltage: number; current_A: number };
  com: number[];
  contacts: { linkId: string; force_N: number }[];
  base: { height: number; roll: number; pitch: number; forwardSpeed: number; distance: number };
  /** Part ids to highlight red: motor/gearbox parts of saturated or overheated joints */
  overLimitParts: string[];
}

export type SimCommand =
  | { type: "init"; design: RobotDesign; scenario: ScenarioId }
  | { type: "play" }
  | { type: "pause" }
  | { type: "step"; steps?: number }
  | { type: "reset" }
  | { type: "speed"; value: number }
  | { type: "push"; force?: number[] }
  | { type: "scenario"; id: ScenarioId };

export type SimEvent = { type: "ready"; world: WorldDescriptor } | { type: "frame"; frame: SimFrame } | { type: "error"; message: string };
