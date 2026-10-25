import express, { type Request, type Response } from "express";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { DATA_DIR, loadExamples, loadLibrary } from "../src/core/library-node";
import { DesignBrief, feasibilitySummary } from "../src/core/schema/brief";
import { parseDesign, validateDesign } from "../src/core/validate";
import { ROOT_DIR, loadConfig, type ServerConfig } from "./config";
import { openSse } from "./sse";
import { anthropicModelCall, type ModelCall } from "./agents/llm";
import { feasibilityStatus, runResearcher, type ReferenceImage } from "./agents/researcher";
import { runDesigner } from "./agents/designer";
import type { Library } from "../src/core/library";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function errorMessage(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "Anthropic API authentication failed — check ANTHROPIC_API_KEY on the server.";
  if (e instanceof Anthropic.RateLimitError) return "Anthropic API rate limit reached; try again shortly.";
  if (e instanceof Anthropic.NotFoundError) return `Model or endpoint not found: ${e.message}`;
  if (e instanceof Anthropic.APIError) return `Anthropic API error${e.status ? ` (${e.status})` : ""}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

export function createApp(opts: { config?: ServerConfig; lib?: Library; call?: ModelCall } = {}) {
  const config = opts.config ?? loadConfig();
  const lib = opts.lib ?? loadLibrary();
  let call = opts.call;
  const getCall = () => (call ??= anthropicModelCall(new Anthropic()));
  const app = express();
  app.use(express.json({ limit: "25mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, hasApiKey: config.hasApiKey, models: { researcher: config.researcherModel, designer: config.designerModel }, maxIterations: config.maxDesignIterations });
  });

  app.get("/api/library", (_req, res) => {
    const components = readdirSync(join(DATA_DIR, "components"))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .flatMap((f) => JSON.parse(readFileSync(join(DATA_DIR, "components", f), "utf8")));
    res.json({ components, materials: JSON.parse(readFileSync(join(DATA_DIR, "materials.json"), "utf8")) });
  });

  app.get("/api/examples", (_req, res) => res.json(loadExamples()));

  app.post("/api/validate", (req, res) => {
    const { design, issues } = parseDesign(req.body?.design);
    if (!design) return void res.status(422).json({ issues });
    res.json({ report: validateDesign(design, lib) });
  });

  const needsKey = (sse: ReturnType<typeof openSse>) => {
    if (config.hasApiKey || opts.call) return false;
    sse.send({ type: "error", message: "No ANTHROPIC_API_KEY configured on the server. Set it in the environment or a .env file and restart; the viewer, validator and simulator still work with the example designs." });
    sse.send({ type: "done" });
    sse.close();
    return true;
  };

  app.post("/api/research", async (req: Request, res: Response) => {
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    if (!prompt) return void res.status(400).json({ error: "prompt is required" });
    const images: ReferenceImage[] = Array.isArray(req.body?.images)
      ? req.body.images
          .filter((i: { mediaType?: string; data?: string }) => i && IMAGE_TYPES.has(String(i.mediaType)) && typeof i.data === "string")
          .slice(0, 6)
          .map((i: ReferenceImage) => ({ mediaType: i.mediaType, data: i.data.replace(/^data:[^,]+,/, "") }))
      : [];
    const sse = openSse(res);
    if (needsKey(sse)) return;
    try {
      const brief = await runResearcher({ prompt, images }, { call: getCall(), config, emit: sse.send, signal: sse.signal });
      sse.send({ type: "brief", brief, feasibility: feasibilitySummary(brief) });
      sse.send({ type: "status", agent: "researcher", message: feasibilityStatus(brief) });
    } catch (e) {
      if (!sse.closed()) sse.send({ type: "error", message: errorMessage(e) });
    }
    sse.send({ type: "done" });
    sse.close();
  });

  app.post("/api/design", async (req: Request, res: Response) => {
    const parsed = DesignBrief.safeParse(req.body?.brief);
    if (!parsed.success)
      return void res.status(422).json({ issues: parsed.error.issues.slice(0, 30).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) });
    const sse = openSse(res);
    if (needsKey(sse)) return;
    try {
      const r = await runDesigner(parsed.data, { call: getCall(), config, lib, emit: sse.send, signal: sse.signal });
      sse.send({ type: "result", design: r.design, report: r.report, iterations: r.iterations, unresolved: r.unresolved });
    } catch (e) {
      if (!sse.closed()) sse.send({ type: "error", message: errorMessage(e) });
    }
    sse.send({ type: "done" });
    sse.close();
  });

  if (config.production) {
    const dist = join(ROOT_DIR, "dist");
    if (existsSync(dist)) {
      app.use(express.static(dist));
      app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(dist, "index.html")));
    }
  }
  return app;
}

const isMain = process.argv[1] && /server[\\/]index\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const config = loadConfig();
  createApp({ config }).listen(config.port, () => {
    console.log(`Robot design engine API on http://localhost:${config.port}`);
    console.log(`  researcher: ${config.researcherModel} (${config.researcherEffort}), designer: ${config.designerModel} (${config.designerEffort}), fallbacks: ${config.fallbacks ? "default" : "off"}`);
    if (!config.hasApiKey) console.log("  ANTHROPIC_API_KEY not set: agent endpoints will report an error; viewer/validator/sim still work.");
  });
}
