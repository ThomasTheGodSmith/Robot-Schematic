import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageStreamParams,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

export type ModelParams = BetaMessageStreamParams;

export interface StreamHooks {
  onThinking?: (text: string) => void;
  onText?: (text: string) => void;
  onSearch?: (query: string, tool: "web_search" | "web_fetch") => void;
  onSource?: (url: string, title: string) => void;
  signal?: AbortSignal;
}

/** One streamed model turn. Injectable so tests can script responses without the network. */
export type ModelCall = (params: ModelParams, hooks: StreamHooks) => Promise<BetaMessage>;

/** Surface completed server-tool blocks (searches, fetches, results) as hook calls. */
export function emitBlock(block: BetaContentBlock, hooks: StreamHooks) {
  if (block.type === "server_tool_use" && (block.name === "web_search" || block.name === "web_fetch")) {
    const input = block.input as { query?: string; url?: string };
    hooks.onSearch?.(input.query ?? input.url ?? "", block.name);
  } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
    for (const r of block.content) hooks.onSource?.(r.url, r.title);
  } else if (block.type === "web_fetch_tool_result" && block.content.type === "web_fetch_result") {
    hooks.onSource?.(block.content.url, block.content.content.title ?? block.content.url);
  }
}

/** URLs that appeared in web search / fetch results of a message (for reference verification). */
export function collectResultUrls(content: BetaContentBlock[], into: Set<string>) {
  for (const b of content) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) for (const r of b.content) into.add(normalizeUrl(r.url));
    if (b.type === "web_fetch_tool_result" && b.content.type === "web_fetch_result") into.add(normalizeUrl(b.content.url));
  }
}

export function normalizeUrl(u: string): string {
  return u.trim().replace(/#.*$/, "").replace(/\/+$/, "").replace(/^http:\/\//, "https://").toLowerCase();
}

/** Real implementation: streams through the beta Messages API (needed for server-side fallbacks). */
export function anthropicModelCall(client = new Anthropic()): ModelCall {
  return async (params, hooks) => {
    const stream = client.beta.messages.stream(params, { signal: hooks.signal });
    stream.on("thinking", (d) => hooks.onThinking?.(d));
    stream.on("text", (d) => hooks.onText?.(d));
    stream.on("contentBlock", (b) => emitBlock(b, hooks));
    return stream.finalMessage();
  };
}
