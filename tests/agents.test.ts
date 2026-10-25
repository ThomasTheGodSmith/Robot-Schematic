import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { BetaContentBlock, BetaMessage, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { loadLibrary } from "../src/core/library-node";
import type { DesignBrief } from "../src/core/schema/brief";
import { emitBlock, type ModelCall, type ModelParams } from "../server/agents/llm";
import { runResearcher } from "../server/agents/researcher";
import { runDesigner } from "../server/agents/designer";
import { loadConfig } from "../server/config";
import { sseFrame } from "../server/sse";
import { createApp } from "../server/index";
import type { AgentEvent } from "../server/events";

const lib = loadLibrary();
const config = { ...loadConfig({}), maxDesignIterations: 3 };

function message(content: unknown[], stop_reason: BetaMessage["stop_reason"]): BetaMessage {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: content as BetaContentBlock[],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as BetaMessage;
}
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });

/** Scripted fake: each step sees the request params and returns a message; server-tool blocks are surfaced to hooks. */
function fakeModel(steps: ((p: ModelParams) => BetaMessage)[]) {
  const calls: ModelParams[] = [];
  const call: ModelCall = async (params, hooks) => {
    calls.push(structuredClone(params));
    const step = steps[calls.length - 1];
    if (!step) throw new Error(`unexpected model call #${calls.length}`);
    const m = step(params);
    for (const b of m.content) emitBlock(b, hooks);
    return m;
  };
  return { call, calls };
}
const lastToolResults = (p: ModelParams): BetaToolResultBlockParam[] => {
  const last = p.messages[p.messages.length - 1];
  return (Array.isArray(last.content) ? last.content : []).filter((b): b is BetaToolResultBlockParam => (b as { type: string }).type === "tool_result");
};

const brief: DesignBrief = {
  title: "Trotting quadruped",
  originalPrompt: "(set by server)",
  interpretation: "A small trotting quadruped for indoor research.",
  purpose: "Locomotion research",
  environment: { setting: "indoor", terrain: ["flat", "low steps"] },
  sizeClass: "small",
  targetMass_kg: { min: 8, max: 15 },
  approxDimensions_m: { length: 0.5, width: 0.45, height: 0.4 },
  locomotion: "quadruped",
  payload_kg: 2,
  runtime_min: 20,
  speed_m_s: 0.4,
  behaviours: ["trot", "stand"],
  capabilities: [
    { capability: "Trotting", requested: "walk around", verdict: "achievable", rationale: "QDD actuators" },
    { capability: "Stairs", requested: "climb stairs", verdict: "compromise", rationale: "short legs", compromise: "12 cm steps only" },
    { capability: "Flight", requested: "fly", verdict: "infeasible", rationale: "T/W << 1", compromise: "none" },
  ],
  styling: {
    styleName: "Field",
    silhouette: "boxy",
    proportions: "wide stance",
    panelLines: "few",
    colorScheme: { primary: "#eeeeee", secondary: "#222222", accent: "#ff7700" },
    finish: "matte",
    distinctiveFeatures: ["orange accents"],
  },
  references: [
    { title: "Mini Cheetah", url: "https://example.org/mini-cheetah/", kind: "robot", attribution: "MIT", notes: "actuators" },
    { title: "Made up", url: "https://not-in-results.example/x", kind: "visual", attribution: "?", notes: "unverified" },
  ],
  constraints: ["< 15 kg"],
  openQuestions: [],
};

describe("researcher agent", () => {
  it("streams searches, retries an invalid brief, then verifies references against search results", async () => {
    const events: AgentEvent[] = [];
    const { call, calls } = fakeModel([
      () =>
        message(
          [
            { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "mini cheetah actuator" } },
            { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", url: "https://example.org/mini-cheetah", title: "Mini Cheetah", encrypted_content: "x", page_age: null }] },
            toolUse("tu_1", "submit_design_brief", { ...brief, sizeClass: "gigantic" }),
          ],
          "tool_use",
        ),
      (p) => {
        const r = lastToolResults(p);
        expect(r[0].is_error).toBe(true);
        expect(String(r[0].content)).toMatch(/sizeClass/);
        return message([toolUse("tu_2", "submit_design_brief", brief)], "tool_use");
      },
    ]);
    const out = await runResearcher({ prompt: "a quadruped that trots" }, { call, config, emit: (e) => events.push(e) });
    expect(calls).toHaveLength(2);
    expect(out.originalPrompt).toBe("a quadruped that trots");
    expect(out.references.map((r) => r.verified)).toEqual([true, false]);
    expect(events).toContainEqual({ type: "search", agent: "researcher", query: "mini cheetah actuator" });
    expect(events).toContainEqual({ type: "source", agent: "researcher", url: "https://example.org/mini-cheetah", title: "Mini Cheetah" });
    // request shape: server tools + client tool with auto choice, adaptive summarized thinking
    const p = calls[0];
    expect(p.tool_choice).toEqual({ type: "auto" });
    expect(p.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(p.tools!.map((t) => ("type" in t && t.type ? t.type : t.name))).toEqual(["web_search_20260209", "web_fetch_20260209", "submit_design_brief"]);
    expect((p as { fallbacks?: unknown }).fallbacks).toBe("default");
  });

  it("continues after pause_turn and nudges once when no tool is called", async () => {
    const { call, calls } = fakeModel([
      () => message([{ type: "text", text: "searching…" }], "pause_turn"),
      () => message([{ type: "text", text: "Here is my brief in prose." }], "end_turn"),
      (p) => {
        const last = p.messages[p.messages.length - 1];
        expect(last.role).toBe("user");
        expect(String(last.content)).toMatch(/submit_design_brief/);
        return message([toolUse("tu", "submit_design_brief", brief)], "tool_use");
      },
    ]);
    const out = await runResearcher({ prompt: "p" }, { call, config, emit: () => {} });
    expect(out.title).toBe(brief.title);
    expect(calls).toHaveLength(3);
  });

  it("surfaces refusals as errors", async () => {
    const { call } = fakeModel([() => message([], "refusal")]);
    await expect(runResearcher({ prompt: "p" }, { call, config, emit: () => {} })).rejects.toThrow(/declined/);
  });
});

const fixture = () => JSON.parse(readFileSync("examples/quadruped-trotter.json", "utf8"));
function undersized() {
  const d = fixture();
  for (const l of d.links) for (const p of l.parts) if (/^knee_motor_/.test(p.id)) p.componentId = "bldc_4310_kv170";
  return d;
}

describe("designer agent", () => {
  it("feeds validator failures back and accepts the corrected design", async () => {
    const events: AgentEvent[] = [];
    const { call, calls } = fakeModel([
      () => message([toolUse("d1", "submit_robot_design", undersized())], "tool_use"),
      (p) => {
        const r = lastToolResults(p);
        expect(r).toHaveLength(1);
        expect(r[0].is_error).toBe(true);
        expect(String(r[0].content)).toMatch(/\[FAIL\] torque/);
        return message([toolUse("d2", "submit_robot_design", fixture())], "tool_use");
      },
    ]);
    const out = await runDesigner(brief, { call, config, lib, emit: (e) => events.push(e) });
    expect(calls).toHaveLength(2);
    expect(out.iterations).toBe(2);
    expect(out.report.counts.fail).toBe(0);
    expect(out.design.provenance).toMatchObject({ source: "designer_agent", iteration: 2, briefTitle: brief.title });
    expect(events.filter((e) => e.type === "design")).toHaveLength(2);
    expect(events.filter((e) => e.type === "validation")).toHaveLength(2);
    expect(events).toContainEqual({ type: "status", agent: "validator", message: "Validating torque budget…" });
    // system prompt carries the catalogue and a cached example
    const sys = calls[0].system as { text: string; cache_control?: unknown }[];
    expect(sys.some((b) => b.text.includes("bldc_8318_kv100"))).toBe(true);
    expect(sys[sys.length - 1].cache_control).toEqual({ type: "ephemeral" });
    expect((calls[0].tools![0] as { eager_input_streaming?: boolean }).eager_input_streaming).toBe(true);
  });

  it("schema-invalid submissions get the issues back", async () => {
    const bad = fixture();
    delete bad.power;
    const { call } = fakeModel([
      () => message([toolUse("d1", "submit_robot_design", bad)], "tool_use"),
      (p) => {
        expect(String(lastToolResults(p)[0].content)).toMatch(/Schema validation failed[\s\S]*power/);
        return message([toolUse("d2", "submit_robot_design", fixture())], "tool_use");
      },
    ]);
    const out = await runDesigner(brief, { call, config, lib, emit: () => {} });
    expect(out.iterations).toBe(2);
  });

  it("stops at the iteration cap and returns the best design with unresolved checks", async () => {
    const worse = undersized();
    for (const w of worse.power.wiring) if (w.id === "phase_knee_fl") w.wireComponentId = "wire_awg24";
    const { call, calls } = fakeModel([
      () => message([toolUse("a", "submit_robot_design", worse)], "tool_use"),
      () => message([toolUse("b", "submit_robot_design", undersized())], "tool_use"),
      () => message([toolUse("c", "submit_robot_design", worse)], "tool_use"),
    ]);
    const out = await runDesigner(brief, { call, config, lib, emit: () => {} });
    expect(calls).toHaveLength(3);
    expect(out.iterations).toBe(3);
    expect(out.design.provenance?.iteration).toBe(2); // fewest failures
    expect(out.unresolved.some((c) => c.status === "fail" && c.category === "torque")).toBe(true);
    expect(out.unresolved.every((c) => c.status !== "pass")).toBe(true);
  });

  it("asks for a compact resubmission when the output was truncated", async () => {
    const { call } = fakeModel([
      () => message([toolUse("t", "submit_robot_design", { schemaVersion: "1.0" })], "max_tokens"),
      (p) => {
        expect(String(lastToolResults(p)[0].content)).toMatch(/compact/);
        return message([toolUse("d", "submit_robot_design", fixture())], "tool_use");
      },
    ]);
    const out = await runDesigner(brief, { call, config, lib, emit: () => {} });
    expect(out.iterations).toBe(2);
    expect(out.report.counts.fail).toBe(0);
  });
});

describe("SSE and HTTP", () => {
  it("formats SSE frames as JSON data lines", () => {
    expect(sseFrame({ type: "done" })).toBe('data: {"type":"done"}\n\n');
  });

  it("serves health, validate, and streams a research run end to end", async () => {
    const { call } = fakeModel([() => message([toolUse("tu", "submit_design_brief", brief)], "tool_use")]);
    const app = createApp({ config, lib, call });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const health = await (await fetch(`${base}/api/health`)).json();
      expect(health).toMatchObject({ ok: true, models: { researcher: "claude-sonnet-5-5", designer: "claude-opus-5-5" }, maxIterations: 3 });
      expect(JSON.stringify(health)).not.toMatch(/sk-ant/);
      const v = await (await fetch(`${base}/api/validate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ design: fixture() }) })).json();
      expect(v.report.counts.fail).toBe(0);
      const bad = await fetch(`${base}/api/validate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ design: { id: 1 } }) });
      expect(bad.status).toBe(422);
      const text = await (await fetch(`${base}/api/research`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "a trotting quadruped" }) })).text();
      const events = text
        .split("\n\n")
        .filter((f) => f.startsWith("data: "))
        .map((f) => JSON.parse(f.slice(6)) as AgentEvent);
      const b = events.find((e) => e.type === "brief");
      expect(b && b.type === "brief" && b.feasibility).toEqual({ achievable: 1, compromise: 1, infeasible: 1 });
      expect(events).toContainEqual({ type: "status", agent: "researcher", message: "Feasibility: 1 achievable, 1 compromised, 1 infeasible" });
      expect(events[events.length - 1]).toEqual({ type: "done" });
    } finally {
      server.close();
    }
  });

  it("reports a missing API key as an error event", async () => {
    const app = createApp({ config: { ...config, hasApiKey: false }, lib });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const text = await (await fetch(`${base}/api/research`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "x" }) })).text();
      expect(text).toMatch(/"type":"error","message":"No ANTHROPIC_API_KEY/);
      expect(text).toMatch(/"type":"done"/);
    } finally {
      server.close();
    }
  });
});
