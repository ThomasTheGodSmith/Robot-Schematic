import type { ServerResponse } from "node:http";
import type { AgentEvent } from "./events";

/** Format one SSE frame. */
export function sseFrame(e: AgentEvent): string {
  return `data: ${JSON.stringify(e)}\n\n`;
}

export interface SseWriter {
  send(e: AgentEvent): void;
  close(): void;
  /** Aborted when the client disconnects. */
  signal: AbortSignal;
  closed(): boolean;
}

/** Open an SSE stream on a response; aborts `signal` when the client goes away. */
export function openSse(res: ServerResponse): SseWriter {
  const ctrl = new AbortController();
  let done = false;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": stream open\n\n");
  const heartbeat = setInterval(() => !done && res.write(": ping\n\n"), 15000);
  res.on("close", () => {
    clearInterval(heartbeat);
    if (!done) {
      done = true;
      ctrl.abort();
    }
  });
  return {
    signal: ctrl.signal,
    closed: () => done,
    send(e) {
      if (!done) res.write(sseFrame(e));
    },
    close() {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      res.end();
    },
  };
}
