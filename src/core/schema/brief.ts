import { z } from "zod";
import { HexColor } from "./common";

/** Design Brief: output of the Researcher agent, input to the Designer. */

export const Verdict = z.enum(["achievable", "compromise", "infeasible"]);

export const Capability = z.object({
  capability: z.string().describe("Short name, e.g. 'Repulsor flight'"),
  requested: z.string().describe("What the user asked for, in their terms"),
  verdict: Verdict,
  rationale: z.string().describe("Engineering reasoning with numbers where possible"),
  compromise: z.string().optional().describe("Required when verdict is 'compromise' or 'infeasible': what will be built instead"),
});
export type Capability = z.infer<typeof Capability>;

export const Reference = z.object({
  title: z.string(),
  url: z.string(),
  kind: z.enum(["visual", "robot", "mechanism", "component", "paper"]),
  attribution: z.string().describe("Publisher / rights holder"),
  imageUrl: z.string().optional(),
  notes: z.string().describe("What this reference contributes to the design"),
  verified: z
    .boolean()
    .optional()
    .describe("Set by the server: true when the URL appeared in this session's web search/fetch results"),
});
export type Reference = z.infer<typeof Reference>;

export const DesignBrief = z.object({
  title: z.string(),
  originalPrompt: z.string(),
  interpretation: z.string().describe("One-paragraph restatement of the intent"),
  purpose: z.string(),
  environment: z.object({
    setting: z.enum(["indoor", "outdoor", "mixed"]),
    terrain: z.array(z.string()),
    notes: z.string().optional(),
  }),
  sizeClass: z.enum(["desktop", "small", "medium", "large", "human_scale"]),
  targetMass_kg: z.object({ min: z.number().nonnegative(), max: z.number().positive() }),
  approxDimensions_m: z.object({ length: z.number().positive(), width: z.number().positive(), height: z.number().positive() }),
  locomotion: z.enum(["quadruped", "biped", "hexapod", "wheeled", "tracked", "stationary_arm", "mobile_manipulator", "other"]),
  payload_kg: z.number().nonnegative(),
  runtime_min: z.number().nonnegative(),
  speed_m_s: z.number().nonnegative().optional(),
  maxSlope_deg: z.number().nonnegative().optional(),
  stepHeight_m: z.number().nonnegative().optional(),
  behaviours: z.array(z.string()),
  capabilities: z.array(Capability).min(1),
  styling: z.object({
    styleName: z.string(),
    silhouette: z.string(),
    proportions: z.string(),
    panelLines: z.string(),
    colorScheme: z.object({ primary: HexColor, secondary: HexColor, accent: HexColor, emissive: HexColor.optional() }),
    finish: z.string(),
    distinctiveFeatures: z.array(z.string()),
  }),
  references: z.array(Reference),
  constraints: z.array(z.string()).describe("Hard engineering constraints the Designer must respect"),
  openQuestions: z.array(z.string()).default([]),
});
export type DesignBrief = z.infer<typeof DesignBrief>;

export function feasibilitySummary(brief: Pick<DesignBrief, "capabilities">) {
  const counts = { achievable: 0, compromise: 0, infeasible: 0 };
  for (const c of brief.capabilities) counts[c.verdict]++;
  return counts;
}
