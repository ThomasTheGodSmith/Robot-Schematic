import { z } from "zod";
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaTool,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Effort, ServerConfig } from "../config";
import type { ModelParams } from "./llm";

/** JSON Schema for a tool input from a Zod schema (input side, so defaulted fields are optional). */
export function toolSchema(schema: z.ZodType): BetaTool.InputSchema {
  const js = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete js.$schema;
  return js as BetaTool.InputSchema;
}

/** Common request fields: adaptive thinking with summaries, effort, and optional server-side refusal fallbacks. */
export function baseParams(model: string, effort: Effort, cfg: Pick<ServerConfig, "fallbacks">, maxTokens: number): Omit<ModelParams, "messages"> {
  return {
    model,
    max_tokens: maxTokens,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort },
    ...(cfg.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
  };
}

/** Append an assistant turn exactly as returned (thinking/server-tool blocks must be passed back unchanged). */
export function assistantTurn(msg: BetaMessage): BetaMessageParam {
  return { role: "assistant", content: msg.content as unknown as BetaContentBlockParam[] };
}

export class AgentError extends Error {}

export function refusalMessage(msg: BetaMessage): string {
  const d = msg.stop_details as { category?: string | null; explanation?: string | null } | null | undefined;
  return `The model declined this request${d?.category ? ` (${d.category})` : ""}${d?.explanation ? `: ${d.explanation}` : "."}`;
}
