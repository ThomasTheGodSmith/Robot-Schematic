import { Library } from "../core/library";

/** The component library and example designs, bundled from the same JSON data files the server uses. */
const componentFiles = import.meta.glob("/data/components/*.json", { eager: true, import: "default" }) as Record<string, unknown>;
const materials = import.meta.glob("/data/materials.json", { eager: true, import: "default" }) as Record<string, unknown>;
const exampleFiles = import.meta.glob("/examples/*.json", { eager: true, import: "default" }) as Record<string, unknown>;

export const library: Library = Library.fromRaw(componentFiles, Object.values(materials)[0]);

export const examples: { id: string; raw: unknown }[] = Object.entries(exampleFiles).map(([path, raw]) => ({
  id: path.split("/").pop()!.replace(/\.json$/, ""),
  raw,
}));
