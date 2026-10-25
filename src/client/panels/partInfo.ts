import type { Library } from "../../core/library";
import type { Part, RobotDesign } from "../../core/schema/design";
import type { Check, ValidationReport } from "../../core/validate/report";
import { partMass } from "../../core/math/massprops";
import type { Shape } from "../../core/schema/common";

export interface PartInfo {
  id: string;
  name: string;
  kind: "component" | "fabricated";
  category: string;
  realWorldEquivalent: string;
  material?: string;
  process?: string;
  mass_kg: number;
  cost_usd?: number;
  dimensions: string;
  specs: [string, string][];
  linkId: string;
  linkName: string;
  subsystem: string;
  assembly: string;
  datasheetUrl?: string;
  notes?: string;
  /** Joint ids whose drivetrain uses this part */
  joints: string[];
}

const mm = (m: number) => `${(m * 1000).toFixed(m < 0.01 ? 1 : 0)}`;

export function describeShape(s: Shape): string {
  switch (s.type) {
    case "box":
      return `${mm(s.size[0])} × ${mm(s.size[1])} × ${mm(s.size[2])} mm box`;
    case "shellBox":
      return `${mm(s.size[0])} × ${mm(s.size[1])} × ${mm(s.size[2])} mm shell, ${mm(s.wall)} mm wall`;
    case "cylinder":
      return `Ø${mm(s.radius * 2)} × ${mm(s.length)} mm cylinder (${s.axis})`;
    case "tube":
      return `Ø${mm(s.outerRadius * 2)}/Ø${mm(s.innerRadius * 2)} × ${mm(s.length)} mm tube (${s.axis})`;
    case "rectTube":
      return `${mm(s.width)} × ${mm(s.height)} × ${mm(s.wall)} mm section, ${mm(s.length)} mm long (${s.axis})`;
    case "sphere":
      return `Ø${mm(s.radius * 2)} mm sphere`;
    case "capsule":
      return `Ø${mm(s.radius * 2)} × ${mm(s.length + 2 * s.radius)} mm capsule (${s.axis})`;
  }
}

function prettyKey(k: string) {
  return k
    .replace(/_([A-Za-z]+)$/, " ($1)")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\(Nm\)/, "(N·m)")
    .replace(/\(C per W\)/, "(°C/W)");
}

export function findPart(design: RobotDesign, id: string): { part: Part; linkId: string } | null {
  for (const l of design.links) for (const p of l.parts) if (p.id === id) return { part: p, linkId: l.id };
  return null;
}

export function partInfo(design: RobotDesign, lib: Library, id: string): PartInfo | null {
  const f = findPart(design, id);
  if (!f) return null;
  const { part, linkId } = f;
  const link = design.links.find((l) => l.id === linkId)!;
  const joints = design.drivetrains
    .filter((d) => d.motorPartId === id || d.driverPartId === id || d.encoderPartId === id || d.bearingPartIds.includes(id) || d.stages.some((s) => s.kind === "gearbox" && s.partId === id))
    .map((d) => d.jointId);
  const mass = partMass(part, lib).mass;
  if (part.kind === "component") {
    const c = lib.get(part.componentId);
    return {
      id,
      name: part.name ?? c?.name ?? part.componentId,
      kind: "component",
      category: c?.category ?? "unknown",
      realWorldEquivalent: c ? `${c.realWorldEquivalent}${c.manufacturer ? ` — ${c.manufacturer}` : ""}` : "Unknown component",
      mass_kg: mass,
      cost_usd: c?.cost_usd,
      dimensions: c ? describeShape(c.envelope) : "",
      specs: c ? Object.entries(c.specs).map(([k, v]) => [prettyKey(k), Array.isArray(v) ? v.join(" – ") : typeof v === "object" ? JSON.stringify(v) : String(v)]) : [],
      linkId,
      linkName: link.name,
      subsystem: link.subsystem,
      assembly: part.assembly ?? link.name,
      datasheetUrl: c?.datasheetUrl,
      notes: c?.notes,
      joints,
    };
  }
  const m = lib.material(part.material);
  return {
    id,
    name: part.name,
    kind: "fabricated",
    category: `fabricated ${part.role}`,
    realWorldEquivalent: `Custom part — ${part.process ?? m?.processes[0] ?? "fabricated"} from ${m?.name ?? part.material}`,
    material: m?.name ?? part.material,
    process: part.process,
    mass_kg: mass,
    dimensions: describeShape(part.shape),
    specs: m
      ? [
          ["Density", `${m.density_kg_m3} kg/m³`],
          ["Yield strength", `${m.yieldStrength_MPa} MPa`],
          ["Young's modulus", `${m.youngsModulus_GPa} GPa`],
          ["Max service temp", `${m.maxServiceTemp_C} °C`],
        ]
      : [],
    linkId,
    linkName: link.name,
    subsystem: link.subsystem,
    assembly: part.assembly ?? link.name,
    notes: m?.notes,
    joints,
  };
}

export function checksForPart(report: ValidationReport | null, info: PartInfo, design: RobotDesign): Check[] {
  if (!report) return [];
  const ids = new Set<string>([info.id, ...info.joints, ...design.drivetrains.filter((d) => info.joints.includes(d.jointId)).map((d) => d.id)]);
  return report.checks.filter((c) => c.involves.some((x) => ids.has(x)) || (c.involves.includes(info.linkId) && c.category === "structure"));
}
