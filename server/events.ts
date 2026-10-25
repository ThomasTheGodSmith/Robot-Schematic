import type { DesignBrief } from "../src/core/schema/brief";
import type { RobotDesign } from "../src/core/schema/design";
import type { Check, ValidationReport } from "../src/core/validate";

export type AgentName = "researcher" | "designer" | "validator";

/** Server-sent events emitted by /api/research and /api/design. The client UI depends on these shapes. */
export type AgentEvent =
  | { type: "status"; agent: AgentName; message: string }
  | { type: "thinking"; agent: AgentName; text: string }
  | { type: "text"; agent: AgentName; text: string }
  | { type: "search"; agent: AgentName; query: string }
  | { type: "source"; agent: AgentName; url: string; title: string }
  | { type: "brief"; brief: DesignBrief; feasibility: { achievable: number; compromise: number; infeasible: number } }
  | { type: "design"; iteration: number; design: RobotDesign }
  | { type: "validation"; iteration: number; report: ValidationReport }
  | { type: "result"; design: RobotDesign; report: ValidationReport; iterations: number; unresolved: Check[] }
  | { type: "error"; message: string }
  | { type: "done" };

export type Emit = (e: AgentEvent) => void;
