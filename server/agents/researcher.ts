import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUnion,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { DesignBrief, feasibilitySummary } from "../../src/core/schema/brief";
import type { ServerConfig } from "../config";
import type { Emit } from "../events";
import { collectResultUrls, normalizeUrl, type ModelCall, type StreamHooks } from "./llm";
import { AgentError, assistantTurn, baseParams, refusalMessage, toolSchema } from "./common";
import { RESEARCHER_SYSTEM, researcherUserMessage } from "./prompts";

export interface ReferenceImage {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  /** base64, no data: prefix */
  data: string;
}

export interface ResearchInput {
  prompt: string;
  images?: ReferenceImage[];
}

const SUBMIT = "submit_design_brief";
const MAX_TURNS = 12;
const MAX_INVALID = 3;

export function researcherTools(): BetaToolUnion[] {
  return [
    { type: "web_search_20260209", name: "web_search", max_uses: 6 },
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: 4 },
    {
      name: SUBMIT,
      description:
        "Submit the final structured Design Brief. Call exactly once, after research and the feasibility filter. The input must satisfy the schema; on validation errors you will receive the issues and must resubmit.",
      input_schema: toolSchema(DesignBrief),
      eager_input_streaming: true,
    },
  ];
}

/** Agent 1: interpret the prompt, research references, run the feasibility filter, return a validated brief. */
export async function runResearcher(input: ResearchInput, deps: { call: ModelCall; config: ServerConfig; emit: Emit; signal?: AbortSignal }): Promise<DesignBrief> {
  const { call, config, emit, signal } = deps;
  const agent = "researcher" as const;
  const hooks: StreamHooks = {
    signal,
    onThinking: (text) => emit({ type: "thinking", agent, text }),
    onText: (text) => emit({ type: "text", agent, text }),
    onSearch: (query, tool) => emit({ type: "search", agent, query: tool === "web_fetch" ? `fetch ${query}` : query }),
    onSource: (url, title) => emit({ type: "source", agent, url, title }),
  };
  const images: BetaContentBlockParam[] = (input.images ?? []).map((im) => ({ type: "image", source: { type: "base64", media_type: im.mediaType, data: im.data } }));
  const messages: BetaMessageParam[] = [{ role: "user", content: [...images, { type: "text", text: researcherUserMessage(input.prompt, images.length) }] }];
  const seenUrls = new Set<string>();
  const tools = researcherTools();
  let invalid = 0;
  let nudged = false;

  emit({ type: "status", agent, message: "Interpreting the request…" });
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (turn === 0) emit({ type: "status", agent, message: "Researching references…" });
    const msg = await call(
      { ...baseParams(config.researcherModel, config.researcherEffort, config, 32000), system: RESEARCHER_SYSTEM, tools, tool_choice: { type: "auto" }, messages },
      hooks,
    );
    collectResultUrls(msg.content, seenUrls);
    if (msg.stop_reason === "refusal") throw new AgentError(refusalMessage(msg));
    messages.push(assistantTurn(msg));
    if (msg.stop_reason === "pause_turn") continue;

    const uses = msg.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
    if (!uses.length) {
      if (nudged) throw new AgentError("The researcher finished without submitting a Design Brief.");
      nudged = true;
      messages.push({ role: "user", content: `Now call the ${SUBMIT} tool with the complete brief.` });
      continue;
    }
    const results: BetaToolResultBlockParam[] = [];
    let accepted: DesignBrief | null = null;
    for (const u of uses) {
      if (u.name !== SUBMIT) {
        results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: `Unknown tool '${u.name}'.` });
        continue;
      }
      if (msg.stop_reason === "max_tokens") {
        results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: "The brief was truncated at the output limit. Resubmit it more concisely." });
        continue;
      }
      const r = DesignBrief.safeParse(u.input);
      if (r.success && !accepted) {
        accepted = r.data;
        results.push({ type: "tool_result", tool_use_id: u.id, content: "Brief accepted." });
      } else if (!r.success) {
        const issues = r.error.issues.slice(0, 30).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
        results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: `The brief does not match the schema. Fix these and call ${SUBMIT} again:\n${issues.join("\n")}` });
      } else results.push({ type: "tool_result", tool_use_id: u.id, content: "Duplicate submission ignored." });
    }
    if (accepted) return finalizeBrief(accepted, input.prompt, seenUrls);
    if (++invalid > MAX_INVALID) throw new AgentError("The researcher could not produce a schema-valid Design Brief.");
    emit({ type: "status", agent, message: `Brief failed schema validation; asking for a correction (${invalid}/${MAX_INVALID})…` });
    messages.push({ role: "user", content: results });
  }
  throw new AgentError("The researcher ran out of turns before submitting a brief.");
}

/** Keep the user's prompt verbatim and mark references whose URLs came from this session's search/fetch results. */
export function finalizeBrief(brief: DesignBrief, prompt: string, seenUrls: Set<string>): DesignBrief {
  return {
    ...brief,
    originalPrompt: prompt,
    references: brief.references.map((r) => ({
      ...r,
      verified: seenUrls.has(normalizeUrl(r.url)) || (r.imageUrl ? seenUrls.has(normalizeUrl(r.imageUrl)) : false),
    })),
  };
}

export function feasibilityStatus(brief: DesignBrief): string {
  const f = feasibilitySummary(brief);
  return `Feasibility: ${f.achievable} achievable, ${f.compromise} compromised, ${f.infeasible} infeasible`;
}
