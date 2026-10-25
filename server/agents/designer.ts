import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BetaMessageParam,
  BetaTextBlockParam,
  BetaToolResultBlockParam,
  BetaToolUnion,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { DesignBrief } from "../../src/core/schema/brief";
import { RobotDesign } from "../../src/core/schema/design";
import type { Library } from "../../src/core/library";
import { EXAMPLES_DIR } from "../../src/core/library-node";
import { parseDesign, reportToFeedback, validateDesign, type Check, type ValidationReport } from "../../src/core/validate";
import type { ServerConfig } from "../config";
import type { Emit } from "../events";
import type { ModelCall, StreamHooks } from "./llm";
import { AgentError, assistantTurn, baseParams, refusalMessage, toolSchema } from "./common";
import { DESIGNER_CONVENTIONS, TRUNCATED_HINT, designerUserMessage } from "./prompts";

const SUBMIT = "submit_robot_design";
const MAX_TURNS = 16;

export interface DesignResult {
  design: RobotDesign;
  report: ValidationReport;
  iterations: number;
  unresolved: Check[];
}

export function designerTools(): BetaToolUnion[] {
  return [
    {
      name: SUBMIT,
      description:
        "Submit the complete Robot Design Document. It is schema-checked and then run through the engineering validator; failures come back as the tool result for you to fix and resubmit.",
      input_schema: toolSchema(RobotDesign),
      eager_input_streaming: true,
    },
  ];
}

/** Pick a format reference: the arm fixture for stationary arms, otherwise the quadruped. */
export function exampleFor(brief: Pick<DesignBrief, "locomotion">): { id: string; json: string } {
  const id = brief.locomotion === "stationary_arm" ? "desk-arm" : "quadruped-trotter";
  const raw = JSON.parse(readFileSync(join(EXAMPLES_DIR, `${id}.json`), "utf8"));
  return { id, json: JSON.stringify(raw) };
}

export function designerSystem(lib: Library, brief: DesignBrief): BetaTextBlockParam[] {
  const ex = exampleFor(brief);
  return [
    { type: "text", text: DESIGNER_CONVENTIONS },
    { type: "text", text: `# Component catalogue (the only parts you may reference)\n${lib.catalogueText()}` },
    {
      type: "text",
      text: `# Format reference: a complete, validated design (${ex.id})\nUse it to see the exact JSON shape and level of detail. Do NOT copy it blindly — derive geometry, components and gains from the brief.\n${ex.json}`,
      cache_control: { type: "ephemeral" },
    },
  ];
}

const score = (r: ValidationReport) => r.counts.fail * 1000 + r.counts.warn;

/** Agent 2: produce a design, validate it, feed failures back, iterate up to the configured cap. */
export async function runDesigner(
  brief: DesignBrief,
  deps: { call: ModelCall; config: ServerConfig; lib: Library; emit: Emit; signal?: AbortSignal },
): Promise<DesignResult> {
  const { call, config, lib, emit, signal } = deps;
  const agent = "designer" as const;
  const hooks: StreamHooks = {
    signal,
    onThinking: (text) => emit({ type: "thinking", agent, text }),
    onText: (text) => emit({ type: "text", agent, text }),
  };
  const system = designerSystem(lib, brief);
  const tools = designerTools();
  const messages: BetaMessageParam[] = [{ role: "user", content: designerUserMessage(JSON.stringify(brief, null, 1)) }];
  const cap = config.maxDesignIterations;
  let iteration = 0;
  let best: { design: RobotDesign; report: ValidationReport; iteration: number } | null = null;
  let nudged = false;

  emit({ type: "status", agent, message: `Designing from brief "${brief.title}"…` });
  for (let turn = 0; turn < MAX_TURNS && iteration < cap; turn++) {
    let msg;
    try {
      msg = await call(
        { ...baseParams(config.designerModel, config.designerEffort, config, 64000), system, tools, tool_choice: { type: "auto" }, messages },
        hooks,
      );
    } catch (e) {
      // With eager input streaming a tool input that is not valid JSON makes the stream reject.
      // Re-issue the same turn (append-only history) and count it against the iteration cap.
      if (!(e instanceof Anthropic.APIError) && !signal?.aborted) {
        iteration++;
        emit({ type: "status", agent, message: `Design ${iteration} was not parseable JSON; retrying…` });
        continue;
      }
      throw e;
    }
    if (msg.stop_reason === "refusal") throw new AgentError(refusalMessage(msg));
    messages.push(assistantTurn(msg));
    if (msg.stop_reason === "pause_turn") continue;

    const uses = msg.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
    if (!uses.length) {
      if (nudged) break;
      nudged = true;
      messages.push({ role: "user", content: `Call ${SUBMIT} with the complete design now.` });
      continue;
    }
    const results: BetaToolResultBlockParam[] = [];
    let done = false;
    for (const u of uses) {
      if (u.name !== SUBMIT || done) {
        results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: u.name !== SUBMIT ? `Unknown tool '${u.name}'.` : "Only one submission per turn is evaluated." });
        continue;
      }
      iteration++;
      if (msg.stop_reason === "max_tokens") {
        emit({ type: "status", agent, message: `Design ${iteration} was truncated at the output limit; asking for a compact resubmission…` });
        results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: TRUNCATED_HINT });
        continue;
      }
      const { design, issues } = parseDesign(u.input);
      if (!design) {
        emit({ type: "status", agent, message: `Design ${iteration} failed schema validation (${issues.length} issues); asking for a fix…` });
        results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: `Schema validation failed. Fix these and resubmit the complete design:\n${issues.join("\n")}` });
        continue;
      }
      design.provenance = { source: "designer_agent", model: config.designerModel, iteration, briefTitle: brief.title };
      emit({ type: "design", iteration, design });
      emit({ type: "status", agent: "validator", message: `Validating design ${iteration}…` });
      const report = validateDesign(design, lib, (stage) => emit({ type: "status", agent: "validator", message: stage }));
      emit({ type: "validation", iteration, report });
      emit({ type: "status", agent: "validator", message: `Design ${iteration}: ${report.counts.fail} fail, ${report.counts.warn} warn, ${report.counts.pass} pass` });
      if (!best || score(report) < score(best.report)) best = { design, report, iteration };
      if (report.counts.fail === 0) {
        done = true;
        results.push({ type: "tool_result", tool_use_id: u.id, content: "Design accepted: no failing checks." });
      } else {
        const remaining = cap - iteration;
        results.push({
          type: "tool_result",
          tool_use_id: u.id,
          is_error: true,
          content: `${reportToFeedback(report)}\n\n${remaining > 0 ? `Revise the design to fix every FAIL (and cheap WARNs), then resubmit the COMPLETE design. ${remaining} submission(s) left.` : "No submissions left."}`,
        });
      }
    }
    if (done) break;
    if (iteration >= cap) break;
    messages.push({ role: "user", content: results });
  }
  if (!best) throw new AgentError(`The designer produced no schema-valid design in ${iteration} submission(s).`);
  const unresolved = best.report.checks.filter((c) => c.status !== "pass");
  if (best.report.counts.fail > 0) emit({ type: "status", agent, message: `Stopped after ${iteration} submission(s); returning the best design (iteration ${best.iteration}) with ${best.report.counts.fail} unresolved failure(s).` });
  return { design: best.design, report: best.report, iterations: iteration, unresolved };
}
