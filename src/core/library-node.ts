import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Library } from "./library";

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../data");
export const EXAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../examples");

/** Load the component library from data/ (Node only). */
export function loadLibrary(dataDir = DATA_DIR): Library {
  const files: Record<string, unknown> = {};
  for (const f of readdirSync(join(dataDir, "components")).filter((f) => f.endsWith(".json")).sort())
    files[f] = JSON.parse(readFileSync(join(dataDir, "components", f), "utf8"));
  const materials = JSON.parse(readFileSync(join(dataDir, "materials.json"), "utf8"));
  return Library.fromRaw(files, materials);
}

export function loadExamples(dir = EXAMPLES_DIR): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) out[f.replace(/\.json$/, "")] = JSON.parse(readFileSync(join(dir, f), "utf8"));
  return out;
}
