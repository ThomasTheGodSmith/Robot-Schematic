import { z } from "zod";
import { Shape } from "./common";

/**
 * Component library schema. Library entries are plain JSON data files under
 * data/ so the catalogue can grow without code changes. Values are SI.
 */

export const Material = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["metal", "polymer", "composite", "elastomer"]),
  density_kg_m3: z.number().positive(),
  yieldStrength_MPa: z.number().positive(),
  ultimateStrength_MPa: z.number().positive(),
  youngsModulus_GPa: z.number().positive(),
  maxServiceTemp_C: z.number(),
  costPerKg_usd: z.number().nonnegative(),
  processes: z.array(z.enum(["cnc", "3d_print", "laser_cut", "waterjet", "layup", "sheet_metal", "casting", "molding"])),
  color: z.string().optional(),
  notes: z.string().optional(),
});
export type Material = z.infer<typeof Material>;

const base = {
  id: z.string(),
  name: z.string(),
  realWorldEquivalent: z.string().describe("Closest commercially available part this entry is modelled on"),
  manufacturer: z.string().optional(),
  mass_kg: z.number().positive(),
  cost_usd: z.number().nonnegative(),
  envelope: Shape.describe("Bounding solid used for rendering, inertia and clearance checks"),
  datasheetUrl: z.string().optional(),
  notes: z.string().optional(),
};

export const MotorSpecs = z.object({
  motorType: z.enum(["bldc", "brushed_dc", "stepper"]),
  nominalVoltage_V: z.number().positive(),
  kv_rpm_per_V: z.number().positive().optional(),
  kt_Nm_per_A: z.number().positive(),
  noLoadSpeed_rpm: z.number().positive().describe("At nominal voltage"),
  stallTorque_Nm: z.number().positive().describe("Peak (stall or current-limited) torque at the rotor"),
  continuousTorque_Nm: z.number().positive(),
  peakCurrent_A: z.number().positive(),
  continuousCurrent_A: z.number().positive(),
  phaseResistance_ohm: z.number().positive(),
  rotorInertia_kgm2: z.number().nonnegative(),
  thermalResistance_C_per_W: z.number().positive().describe("Winding-to-ambient"),
  maxWindingTemp_C: z.number(),
  noLoadCurrent_A: z.number().nonnegative().default(0.3),
});

export const ServoSpecs = z.object({
  nominalVoltage_V: z.number().positive(),
  voltageRange_V: z.array(z.number()).length(2),
  stallTorque_Nm: z.number().positive().describe("Output-shaft stall torque at nominal voltage"),
  continuousTorque_Nm: z.number().positive().describe("Output-shaft torque sustainable without overheating"),
  noLoadSpeed_rpm: z.number().positive().describe("Output-shaft no-load speed"),
  stallCurrent_A: z.number().positive(),
  continuousCurrent_A: z.number().positive(),
  internalRatio: z.number().positive(),
  internalEfficiency: z.number().min(0.1).max(1),
  phaseResistance_ohm: z.number().positive(),
  thermalResistance_C_per_W: z.number().positive(),
  maxWindingTemp_C: z.number(),
  idleCurrent_A: z.number().nonnegative().default(0.05),
  backlash_arcmin: z.number().nonnegative().default(15),
  bus: z.enum(["ttl", "rs485", "pwm", "can"]),
});

export const GearboxSpecs = z.object({
  gearType: z.enum(["planetary", "harmonic", "cycloidal", "spur", "worm", "belt"]),
  ratio: z.number().positive(),
  efficiency: z.number().min(0.1).max(1),
  backlash_arcmin: z.number().nonnegative(),
  ratedTorque_Nm: z.number().positive().describe("Continuous output torque rating"),
  peakTorque_Nm: z.number().positive(),
  maxInputSpeed_rpm: z.number().positive(),
  stages: z.number().int().positive().default(1),
  teeth: z
    .object({ sun: z.number().int(), planet: z.number().int(), ring: z.number().int() })
    .optional()
    .describe("Planetary tooth counts, used for the animated drivetrain view"),
});

export const BearingSpecs = z.object({
  bearingType: z.enum(["deep_groove", "angular_contact", "crossed_roller", "thrust", "needle", "bushing"]),
  bore_m: z.number().positive(),
  outerDiameter_m: z.number().positive(),
  width_m: z.number().positive(),
  dynamicLoad_N: z.number().positive(),
  staticLoad_N: z.number().positive(),
  maxSpeed_rpm: z.number().positive(),
});

export const BatterySpecs = z.object({
  chemistry: z.enum(["LiPo", "Li-ion", "LiFePO4", "NiMH"]),
  cellsSeries: z.number().int().positive(),
  cellsParallel: z.number().int().positive(),
  nominalVoltage_V: z.number().positive(),
  maxVoltage_V: z.number().positive(),
  minVoltage_V: z.number().positive(),
  capacity_Ah: z.number().positive(),
  maxContinuousDischarge_C: z.number().positive(),
  peakDischarge_C: z.number().positive(),
  internalResistance_ohm: z.number().positive(),
});

export const DriverSpecs = z.object({
  driverType: z.enum(["foc_bldc", "brushed_hbridge", "stepper", "servo_bus", "esc"]),
  voltageRange_V: z.array(z.number()).length(2),
  continuousCurrent_A: z.number().positive(),
  peakCurrent_A: z.number().positive(),
  channels: z.number().int().positive(),
  idlePower_W: z.number().nonnegative(),
  supports: z.array(z.enum(["bldc", "brushed_dc", "stepper", "servo"])),
});

export const ComputeSpecs = z.object({
  computeType: z.enum(["sbc", "mcu", "gpu_module"]),
  voltageRange_V: z.array(z.number()).length(2),
  typicalPower_W: z.number().positive(),
  peakPower_W: z.number().positive(),
});

export const SensorSpecs = z.object({
  sensorType: z.enum(["imu", "encoder", "lidar", "camera", "depth_camera", "force_torque", "contact", "ultrasonic", "current"]),
  voltage_V: z.number().positive(),
  power_W: z.number().nonnegative(),
  rate_Hz: z.number().positive().optional(),
  range_m: z.number().positive().optional(),
  resolution: z.string().optional(),
});

export const RegulatorSpecs = z.object({
  inputRange_V: z.array(z.number()).length(2),
  output_V: z.number().positive(),
  maxCurrent_A: z.number().positive(),
  efficiency: z.number().min(0.1).max(1),
});

export const FastenerSpecs = z.object({
  fastenerType: z.enum(["socket_head_bolt", "button_head_bolt", "nut", "heat_set_insert", "dowel_pin", "shoulder_bolt"]),
  thread: z.string(),
  length_m: z.number().positive(),
  grade: z.string(),
  tensileCapacity_N: z.number().positive(),
  shearCapacity_N: z.number().positive(),
});

export const WireSpecs = z.object({
  awg: z.number().int(),
  maxCurrent_A: z.number().positive().describe("Continuous ampacity for chassis wiring in a bundle"),
  resistance_ohm_per_m: z.number().positive(),
  mass_kg_per_m: z.number().positive(),
  insulationRating_C: z.number(),
  conductors: z.number().int().positive().default(2),
});

export const PropulsionSpecs = z.object({
  propulsionType: z.enum(["wheel", "track", "propeller", "ducted_fan"]),
  radius_m: z.number().positive(),
  maxLoad_N: z.number().positive().optional(),
  friction: z.number().positive().optional(),
  maxThrust_N: z.number().positive().optional(),
  powerAtMaxThrust_W: z.number().positive().optional(),
});

export const LightingSpecs = z.object({
  voltage_V: z.number().positive(),
  power_W: z.number().positive(),
  lumens: z.number().nonnegative(),
  color: z.string().optional(),
});

export const Component = z.discriminatedUnion("category", [
  z.object({ ...base, category: z.literal("motor"), specs: MotorSpecs }),
  z.object({ ...base, category: z.literal("servo"), specs: ServoSpecs }),
  z.object({ ...base, category: z.literal("gearbox"), specs: GearboxSpecs }),
  z.object({ ...base, category: z.literal("bearing"), specs: BearingSpecs }),
  z.object({ ...base, category: z.literal("battery"), specs: BatterySpecs }),
  z.object({ ...base, category: z.literal("driver"), specs: DriverSpecs }),
  z.object({ ...base, category: z.literal("compute"), specs: ComputeSpecs }),
  z.object({ ...base, category: z.literal("sensor"), specs: SensorSpecs }),
  z.object({ ...base, category: z.literal("regulator"), specs: RegulatorSpecs }),
  z.object({ ...base, category: z.literal("fastener"), specs: FastenerSpecs }),
  z.object({ ...base, category: z.literal("wire"), specs: WireSpecs }),
  z.object({ ...base, category: z.literal("propulsion"), specs: PropulsionSpecs }),
  z.object({ ...base, category: z.literal("lighting"), specs: LightingSpecs }),
]);
export type Component = z.infer<typeof Component>;
export type ComponentCategory = Component["category"];
export type ComponentOf<C extends ComponentCategory> = Extract<Component, { category: C }>;

export const ComponentFile = z.array(Component);
export const MaterialFile = z.array(Material);
