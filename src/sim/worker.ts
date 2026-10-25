/// <reference lib="webworker" />
/**
 * Physics worker: owns the Rapier world and steps it in (scaled) real time,
 * posting a SimFrame ~30 times per second. Driven by SimCommand messages.
 */
import { Library } from "../core/library";
import { RobotDesign } from "../core/schema/design";
import { initPhysics, RobotSimulator } from "./simulator";
import type { ScenarioId, SimCommand, SimEvent } from "./types";

const componentFiles = import.meta.glob("/data/components/*.json", { eager: true, import: "default" }) as Record<string, unknown>;
const materials = (import.meta.glob("/data/materials.json", { eager: true, import: "default" }) as Record<string, unknown>)["/data/materials.json"];
const lib = Library.fromRaw(componentFiles, materials);

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (e: SimEvent) => ctx.postMessage(e);

let sim: RobotSimulator | null = null;
let design: RobotDesign | null = null;
let scenario: ScenarioId = "flat";
let playing = false;
let timeScale = 1;
let lastTick = 0;
let lastFrame = 0;
let carry = 0;
const TICK_MS = 8;
const FRAME_MS = 33;
/** Never simulate more than this much time per tick, so a slow machine runs slow instead of spiralling. */
const MAX_SIM_PER_TICK_S = 0.05;

function emitFrame() {
  if (sim) post({ type: "frame", frame: sim.frame() });
}

function create() {
  if (!design) return;
  sim?.dispose();
  sim = new RobotSimulator(design, lib, { scenario });
  carry = 0;
  post({ type: "ready", world: sim.world() });
  emitFrame();
}

setInterval(() => {
  const now = performance.now();
  const elapsed = lastTick ? (now - lastTick) / 1000 : 0;
  lastTick = now;
  if (!sim || !playing) return;
  try {
    carry += Math.min(elapsed * timeScale, MAX_SIM_PER_TICK_S);
    const n = Math.floor(carry / sim.dt);
    if (n > 0) {
      sim.step(n);
      carry -= n * sim.dt;
    }
    if (now - lastFrame >= FRAME_MS) {
      lastFrame = now;
      emitFrame();
    }
  } catch (e) {
    playing = false;
    post({ type: "error", message: `Simulation error: ${(e as Error).message}` });
  }
}, TICK_MS);

ctx.onmessage = async (ev: MessageEvent<SimCommand>) => {
  const cmd = ev.data;
  try {
    switch (cmd.type) {
      case "init": {
        await initPhysics();
        design = RobotDesign.parse(cmd.design);
        scenario = cmd.scenario;
        playing = false;
        create();
        break;
      }
      case "play":
        playing = true;
        lastTick = performance.now();
        break;
      case "pause":
        playing = false;
        emitFrame();
        break;
      case "step":
        sim?.step(cmd.steps ?? Math.max(1, Math.round(1 / 60 / (sim?.dt ?? 1 / 500))));
        emitFrame();
        break;
      case "reset":
        sim?.reset();
        carry = 0;
        if (sim) post({ type: "ready", world: sim.world() });
        emitFrame();
        break;
      case "speed":
        timeScale = Math.min(2, Math.max(0.05, cmd.value));
        break;
      case "push":
        sim?.push(cmd.force);
        break;
      case "scenario":
        scenario = cmd.id;
        create();
        break;
    }
  } catch (e) {
    post({ type: "error", message: (e as Error).message });
  }
};
