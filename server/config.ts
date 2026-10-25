import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal .env loader (KEY=VALUE lines, optional quotes). Existing env vars win. */
function loadDotEnv(file = join(ROOT_DIR, ".env")) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv();

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const effort = (v: string | undefined, d: Effort): Effort =>
  (["low", "medium", "high", "xhigh", "max"] as const).includes(v as Effort) ? (v as Effort) : d;

export interface ServerConfig {
  hasApiKey: boolean;
  designerModel: string;
  researcherModel: string;
  designerEffort: Effort;
  researcherEffort: Effort;
  maxDesignIterations: number;
  port: number;
  /** Server-side refusal fallbacks (`fallbacks: "default"`); off via ROBOT_ENGINE_FALLBACKS=off */
  fallbacks: boolean;
  production: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    // The key itself stays in process.env for the SDK; only its presence is exposed.
    hasApiKey: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
    designerModel: env.DESIGNER_MODEL || "claude-opus-5-5",
    researcherModel: env.RESEARCHER_MODEL || "claude-sonnet-5-5",
    designerEffort: effort(env.DESIGNER_EFFORT, "high"),
    researcherEffort: effort(env.RESEARCHER_EFFORT, "medium"),
    maxDesignIterations: Math.max(1, Number(env.MAX_DESIGN_ITERATIONS) || 3),
    port: Number(env.PORT) || 8787,
    fallbacks: (env.ROBOT_ENGINE_FALLBACKS ?? "default") !== "off",
    production: env.NODE_ENV === "production",
  };
}
