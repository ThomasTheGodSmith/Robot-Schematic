import { z } from "zod";

/**
 * Shared primitives. All quantities are SI: metres, kilograms, seconds,
 * radians, newtons, volts, amps, watts. Colours are #rrggbb hex strings.
 */

export const Vec3 = z
  .array(z.number())
  .length(3)
  .describe("[x, y, z] vector in metres (or unitless for axes)");
export type Vec3 = number[];

export const Pose = z
  .object({
    xyz: Vec3.default([0, 0, 0]).describe("Translation in metres, in the parent frame"),
    rpy: Vec3.default([0, 0, 0]).describe(
      "Fixed-axis roll/pitch/yaw in radians (rotation applied X then Y then Z, URDF convention)",
    ),
  })
  .describe("Rigid transform relative to the owning frame");
export type Pose = z.infer<typeof Pose>;

export const Axis = z.enum(["x", "y", "z"]);
export type Axis = z.infer<typeof Axis>;

export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected #rrggbb");

const pos = () => z.number().positive();

/**
 * Parametric solid shapes. Every fabricated part and every library component
 * envelope is one of these so that mass, inertia, collision and rendering can
 * all be derived procedurally.
 */
export const Shape = z.discriminatedUnion("type", [
  z.object({ type: z.literal("box"), size: Vec3.describe("Full extents x,y,z in metres") }),
  z.object({
    type: z.literal("cylinder"),
    radius: pos(),
    length: pos(),
    axis: Axis.default("z"),
  }),
  z.object({
    type: z.literal("tube"),
    outerRadius: pos(),
    innerRadius: z.number().nonnegative(),
    length: pos(),
    axis: Axis.default("z"),
  }),
  z.object({
    type: z.literal("rectTube"),
    width: pos().describe("Section extent across the first perpendicular axis"),
    height: pos().describe("Section extent across the second perpendicular axis"),
    wall: pos(),
    length: pos(),
    axis: Axis.default("z"),
  }),
  z.object({ type: z.literal("sphere"), radius: pos() }),
  z.object({
    type: z.literal("capsule"),
    radius: pos(),
    length: pos().describe("Length of the cylindrical section, excluding the hemispherical caps"),
    axis: Axis.default("z"),
  }),
  z.object({
    type: z.literal("shellBox"),
    size: Vec3.describe("Outer extents in metres"),
    wall: pos(),
  }),
]);
export type Shape = z.infer<typeof Shape>;
