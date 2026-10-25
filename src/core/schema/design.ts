import { z } from "zod";
import { HexColor, Pose, Shape, Vec3 } from "./common";

/**
 * Robot Design Document: the contract between the Designer agent, the
 * validator, the 3D viewer and the simulator.
 *
 * Frames follow URDF conventions: every link has its own frame; a joint's
 * `origin` places the child link frame in the parent link frame when the
 * joint is at zero; the joint rotates/translates the child about `axis`
 * expressed in the child frame. Z is up in the world.
 */

const Id = z.string().min(1).regex(/^[A-Za-z0-9_.-]+$/, "ids use letters, digits, _ . -");

export const PartRole = z.enum(["structure", "shell", "cosmetic", "mount", "gear", "foot"]);

export const FabricatedPart = z.object({
  kind: z.literal("fabricated"),
  id: Id,
  name: z.string(),
  shape: Shape,
  material: z.string().describe("Material id from the library"),
  pose: Pose.default({ xyz: [0, 0, 0], rpy: [0, 0, 0] }),
  role: PartRole.default("structure"),
  process: z.string().optional().describe("e.g. cnc, 3d_print, laser_cut"),
  collide: z.boolean().default(true).describe("Include in physics collision geometry"),
  assembly: z.string().optional().describe("Assembly name for the hierarchical breakdown, e.g. 'Knee joint'"),
  emissive: z.boolean().optional().describe("Glowing cosmetic element (LED diffuser etc.)"),
});
export type FabricatedPart = z.infer<typeof FabricatedPart>;

export const ComponentPart = z.object({
  kind: z.literal("component"),
  id: Id,
  componentId: z.string().describe("Component id from the library"),
  name: z.string().optional(),
  pose: Pose.default({ xyz: [0, 0, 0], rpy: [0, 0, 0] }),
  collide: z.boolean().default(false),
  assembly: z.string().optional(),
});
export type ComponentPart = z.infer<typeof ComponentPart>;

export const Part = z.discriminatedUnion("kind", [FabricatedPart, ComponentPart]);
export type Part = z.infer<typeof Part>;

export const Contact = z.object({
  point: Vec3.describe("Contact point in link frame (e.g. foot sole centre)"),
  radius: z.number().positive().default(0.02),
  friction: z.number().positive().default(0.9),
});

export const Link = z.object({
  id: Id,
  name: z.string(),
  subsystem: z.string().describe("Top-level grouping for the breakdown, e.g. 'Torso', 'Front-left leg', 'Power'"),
  parts: z.array(Part),
  contact: Contact.optional().describe("Set on links that touch the ground (feet, wheels)"),
});
export type Link = z.infer<typeof Link>;

export const Joint = z.object({
  id: Id,
  name: z.string(),
  type: z.enum(["revolute", "continuous", "prismatic", "fixed"]),
  parent: z.string(),
  child: z.string(),
  origin: Pose,
  axis: Vec3.default([0, 0, 1]),
  limits: z
    .object({
      lower: z.number(),
      upper: z.number(),
      velocity: z.number().positive().describe("Required max joint speed (rad/s or m/s)"),
    })
    .optional(),
  damping: z.number().nonnegative().default(0.02),
  friction: z.number().nonnegative().default(0.01),
});
export type Joint = z.infer<typeof Joint>;

export const Stage = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("gearbox"),
    partId: z.string().describe("Component part (category gearbox) mounted in some link"),
  }),
  z.object({
    kind: z.literal("spur"),
    name: z.string().optional(),
    driverTeeth: z.number().int().min(8),
    drivenTeeth: z.number().int().min(8),
    module_m: z.number().positive().describe("Gear module in metres (e.g. 0.001 for m1)"),
    faceWidth_m: z.number().positive(),
    material: z.string(),
    efficiency: z.number().min(0.5).max(1).default(0.97),
  }),
  z.object({
    kind: z.literal("belt"),
    name: z.string().optional(),
    driverTeeth: z.number().int().min(10),
    drivenTeeth: z.number().int().min(10),
    pitch_m: z.number().positive().describe("Belt pitch, e.g. 0.003 for GT2-3M"),
    beltWidth_m: z.number().positive(),
    ratedTension_N: z.number().positive().describe("Allowable working tension of the belt"),
    efficiency: z.number().min(0.5).max(1).default(0.95),
  }),
  z.object({
    kind: z.literal("linkage"),
    name: z.string().optional(),
    crank_m: z.number().positive(),
    coupler_m: z.number().positive(),
    rocker_m: z.number().positive(),
    ground_m: z.number().positive(),
    efficiency: z.number().min(0.5).max(1).default(0.95),
  }),
]);
export type Stage = z.infer<typeof Stage>;

export const Drivetrain = z.object({
  id: Id,
  jointId: z.string(),
  name: z.string().optional(),
  motorPartId: z.string().describe("Component part id of a motor or servo"),
  stages: z.array(Stage).default([]).describe("Ordered from motor towards the joint output"),
  driverPartId: z.string().describe("Component part id of the driver channel powering this motor"),
  encoderPartId: z.string().optional(),
  bearingPartIds: z.array(z.string()).default([]),
  fasteners: z
    .object({
      componentId: z.string(),
      count: z.number().int().positive(),
      boltCircleRadius_m: z.number().positive(),
    })
    .optional()
    .describe("Bolts that transmit the output torque across the joint"),
});
export type Drivetrain = z.infer<typeof Drivetrain>;

export const Wire = z.object({
  id: Id,
  name: z.string().optional(),
  from: z.string().describe("Part id"),
  to: z.string().describe("Part id"),
  wireComponentId: z.string(),
  length_m: z.number().positive().optional().describe("Defaults to 1.3x the straight-line distance"),
  kind: z.enum(["power", "signal", "phase"]).default("power"),
  loadPartIds: z
    .array(z.string())
    .default([])
    .describe("Consumers whose supply current flows through this wire (motors, drivers, compute, sensors)"),
});
export type Wire = z.infer<typeof Wire>;

export const PowerSystem = z.object({
  batteryPartIds: z.array(z.string()).min(1),
  batteryConfig: z.enum(["single", "series", "parallel"]).default("single"),
  regulators: z
    .array(z.object({ partId: z.string(), loadPartIds: z.array(z.string()) }))
    .default([]),
  wiring: z.array(Wire).default([]),
});
export type PowerSystem = z.infer<typeof PowerSystem>;

export const ShellStyle = z.object({
  styleName: z.string().default("Utility"),
  primary: HexColor.default("#d8dde3"),
  secondary: HexColor.default("#2b2f36"),
  accent: HexColor.default("#ff7a1a"),
  emissive: HexColor.default("#7fe7ff"),
  metalness: z.number().min(0).max(1).default(0.3),
  roughness: z.number().min(0).max(1).default(0.5),
  panelLines: z.boolean().default(true),
});

const Gains = z.object({ kp: z.number().nonnegative(), kd: z.number().nonnegative(), ki: z.number().nonnegative().default(0) });

export const Behavior = z.object({
  mode: z.enum(["legged_gait", "wheeled", "manipulator", "stand"]),
  description: z.string().optional(),
  nominalPose: z.record(z.string(), z.number()).default({}).describe("Joint id -> standing/home position"),
  pid: z.object({ default: Gains, overrides: z.record(z.string(), Gains).default({}) }),
  gait: z
    .object({
      legs: z.array(
        z.object({
          name: z.string(),
          jointIds: z.array(z.string()).min(2).describe("Joints from body to foot, in chain order"),
          footLinkId: z.string(),
          phase: z.number().min(0).max(1),
        }),
      ),
      frequency_Hz: z.number().positive(),
      stepHeight_m: z.number().nonnegative(),
      strideLength_m: z.number().nonnegative(),
      dutyFactor: z.number().min(0.3).max(0.95).default(0.6),
      balanceGain: z.number().nonnegative().default(0.5),
    })
    .optional(),
  wheels: z
    .object({
      left: z.array(z.string()),
      right: z.array(z.string()),
      wheelRadius_m: z.number().positive(),
      targetSpeed_m_s: z.number().nonnegative(),
      turnRate_rad_s: z.number().default(0),
    })
    .optional(),
  manipulator: z
    .object({
      waypoints: z.array(z.object({ t: z.number().nonnegative(), pose: z.record(z.string(), z.number()) })).min(2),
      loop: z.boolean().default(true),
      payloadLinkId: z.string().optional(),
    })
    .optional(),
});
export type Behavior = z.infer<typeof Behavior>;

export const Requirements = z.object({
  payload_kg: z.number().nonnegative().default(0),
  payloadLinkId: z.string().optional().describe("Link that carries the payload; defaults to the root link"),
  payloadOffset: Vec3.default([0, 0, 0]),
  minRuntime_min: z.number().nonnegative().default(0),
  maxSlope_deg: z.number().nonnegative().default(0),
  safetyFactor: z.number().min(1).default(1.5),
  dynamicLoadFactor: z.number().min(1).default(1.5).describe("Multiplier on static loads for gait impacts / accelerations"),
  ambientTemp_C: z.number().default(25),
  targetSpeed_m_s: z.number().nonnegative().optional(),
  maxMass_kg: z.number().positive().optional(),
  dutyCycle: z.number().min(0).max(1).default(0.6).describe("Fraction of time actuators are under load, for runtime/thermal"),
});
export type Requirements = z.infer<typeof Requirements>;

export const RobotDesign = z.object({
  schemaVersion: z.literal("1.0"),
  id: Id,
  name: z.string(),
  description: z.string(),
  rootLink: z.string(),
  rootFixed: z.boolean().default(false).describe("True for robots bolted to the world (arms)"),
  links: z.array(Link).min(1),
  joints: z.array(Joint),
  drivetrains: z.array(Drivetrain).default([]),
  power: PowerSystem,
  style: ShellStyle.default(ShellStyle.parse({})),
  behavior: Behavior,
  requirements: Requirements.default(Requirements.parse({})),
  assumptions: z.array(z.string()).default([]),
  provenance: z
    .object({
      source: z.enum(["hand_written", "designer_agent"]),
      model: z.string().optional(),
      iteration: z.number().int().optional(),
      briefTitle: z.string().optional(),
    })
    .optional(),
});
export type RobotDesign = z.infer<typeof RobotDesign>;
/** The un-defaulted input shape (what authors/agents write). */
export type RobotDesignInput = z.input<typeof RobotDesign>;
