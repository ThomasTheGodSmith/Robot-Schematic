import { Component, ComponentFile, Material, MaterialFile, type ComponentCategory, type ComponentOf } from "./schema/library";

/** In-memory, validated view over the component + material data files. */
export class Library {
  readonly components = new Map<string, Component>();
  readonly materials = new Map<string, Material>();

  constructor(components: Component[], materials: Material[]) {
    for (const c of components) {
      if (this.components.has(c.id)) throw new Error(`Duplicate component id '${c.id}'`);
      this.components.set(c.id, c);
    }
    for (const m of materials) {
      if (this.materials.has(m.id)) throw new Error(`Duplicate material id '${m.id}'`);
      this.materials.set(m.id, m);
    }
  }

  /** Build from raw parsed JSON (one array per data file). Throws with file context on invalid data. */
  static fromRaw(componentFiles: Record<string, unknown>, materialsRaw: unknown): Library {
    const comps: Component[] = [];
    for (const [file, raw] of Object.entries(componentFiles)) {
      const r = ComponentFile.safeParse(raw);
      if (!r.success) throw new Error(`Invalid component data in ${file}: ${r.error.message}`);
      comps.push(...r.data);
    }
    const m = MaterialFile.safeParse(materialsRaw);
    if (!m.success) throw new Error(`Invalid materials data: ${m.error.message}`);
    return new Library(comps, m.data);
  }

  get(id: string): Component | undefined {
    return this.components.get(id);
  }

  getAs<C extends ComponentCategory>(id: string, category: C): ComponentOf<C> | undefined {
    const c = this.components.get(id);
    return c && c.category === category ? (c as ComponentOf<C>) : undefined;
  }

  material(id: string): Material | undefined {
    return this.materials.get(id);
  }

  byCategory<C extends ComponentCategory>(category: C): ComponentOf<C>[] {
    return [...this.components.values()].filter((c): c is ComponentOf<C> => c.category === category);
  }

  /** Compact catalogue for prompting the Designer agent: one line per entry with the specs that matter. */
  catalogueText(): string {
    const lines: string[] = ["# Materials (id | name | density kg/m3 | yield MPa | E GPa | max temp C | processes)"];
    for (const m of this.materials.values())
      lines.push(`${m.id} | ${m.name} | ${m.density_kg_m3} | ${m.yieldStrength_MPa} | ${m.youngsModulus_GPa} | ${m.maxServiceTemp_C} | ${m.processes.join(",")}`);
    const cats = new Map<string, Component[]>();
    for (const c of this.components.values()) cats.set(c.category, [...(cats.get(c.category) ?? []), c]);
    for (const [cat, list] of cats) {
      lines.push("", `# ${cat} (id | name | mass kg | cost USD | envelope | specs)`);
      for (const c of list) lines.push(`${c.id} | ${c.name} | ${c.mass_kg} | ${c.cost_usd} | ${JSON.stringify(c.envelope)} | ${JSON.stringify(c.specs)}`);
    }
    return lines.join("\n");
  }
}
