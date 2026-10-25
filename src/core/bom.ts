import { Vector3 } from "three";
import type { Library } from "./library";
import type { RobotDesign } from "./schema/design";
import { shapeVolume } from "./math/shapes";
import { buildTopology, defaultJointPositions, forwardKinematics, poseToMatrix } from "./math/frames";

export interface BomRow {
  item: number;
  name: string;
  type: string;
  source: string;
  qty: number;
  unitMass_kg: number;
  totalMass_kg: number;
  unitCost_usd: number;
  totalCost_usd: number;
  partIds: string[];
}

/** Rough cost multiplier over raw material cost for each fabrication process. */
const PROCESS_FACTOR: Record<string, number> = { cnc: 6, "3d_print": 1.8, laser_cut: 2.5, waterjet: 3, layup: 4, sheet_metal: 3, casting: 3, molding: 1.5 };

export function buildBom(design: RobotDesign, lib: Library): { rows: BomRow[]; totalMass: number; totalCost: number; costByCategory: Record<string, number> } {
  const groups = new Map<string, BomRow>();
  const add = (key: string, row: Omit<BomRow, "item" | "qty" | "totalMass_kg" | "totalCost_usd" | "partIds">, partId: string, qty = 1) => {
    const g = groups.get(key);
    if (g) {
      g.qty += qty;
      g.partIds.push(partId);
    } else groups.set(key, { ...row, item: 0, qty, totalMass_kg: 0, totalCost_usd: 0, partIds: [partId] });
  };
  for (const l of design.links)
    for (const p of l.parts) {
      if (p.kind === "component") {
        const c = lib.get(p.componentId);
        if (!c) continue;
        add(`c:${c.id}`, { name: c.name, type: c.category, source: c.realWorldEquivalent, unitMass_kg: c.mass_kg, unitCost_usd: c.cost_usd }, p.id);
      } else {
        const m = lib.material(p.material);
        if (!m) continue;
        const mass = shapeVolume(p.shape) * m.density_kg_m3;
        const proc = p.process ?? m.processes[0];
        const cost = Math.max(2, mass * m.costPerKg_usd * (PROCESS_FACTOR[proc] ?? 3) + (proc === "cnc" ? 25 : 3));
        const key = `f:${p.name}:${p.material}:${JSON.stringify(p.shape)}`;
        add(key, { name: p.name, type: `fabricated (${proc})`, source: m.name, unitMass_kg: mass, unitCost_usd: cost }, p.id);
      }
    }
  // Wiring by length
  const topo = buildTopology(design);
  const T = topo.errors.length ? null : forwardKinematics(topo, defaultJointPositions(design));
  const partPos = new Map<string, Vector3>();
  if (T)
    for (const l of design.links)
      for (const p of l.parts) partPos.set(p.id, new Vector3().setFromMatrixPosition(T.get(l.id)!.clone().multiply(poseToMatrix(p.pose))));
  for (const w of design.power.wiring) {
    const wc = lib.getAs(w.wireComponentId, "wire");
    if (!wc) continue;
    const a = partPos.get(w.from), b = partPos.get(w.to);
    const len = w.length_m ?? (a && b ? Math.max(0.05, a.distanceTo(b) * 1.3) : 0.3);
    const key = `w:${wc.id}`;
    const g = groups.get(key);
    if (g) {
      g.qty = +(g.qty + len).toFixed(3);
      g.partIds.push(w.id);
    } else
      groups.set(key, { item: 0, name: wc.name, type: "wire (m)", source: wc.realWorldEquivalent, qty: +len.toFixed(3), unitMass_kg: wc.specs.mass_kg_per_m, unitCost_usd: wc.cost_usd, totalMass_kg: 0, totalCost_usd: 0, partIds: [w.id] });
  }
  const rows = [...groups.values()];
  const costByCategory: Record<string, number> = {};
  rows.forEach((r, i) => {
    r.item = i + 1;
    r.totalMass_kg = r.unitMass_kg * r.qty;
    r.totalCost_usd = r.unitCost_usd * r.qty;
    const cat = r.type.startsWith("fabricated") ? "fabricated" : r.type;
    costByCategory[cat] = (costByCategory[cat] ?? 0) + r.totalCost_usd;
  });
  return {
    rows,
    totalMass: rows.reduce((s, r) => s + r.totalMass_kg, 0),
    totalCost: rows.reduce((s, r) => s + r.totalCost_usd, 0),
    costByCategory,
  };
}

const csvCell = (v: string | number) => {
  const s = typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : v;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function bomToCsv(rows: BomRow[]): string {
  const header = ["Item", "Name", "Type", "Source / material", "Qty", "Unit mass (kg)", "Total mass (kg)", "Unit cost (USD)", "Total cost (USD)", "Part ids"];
  const lines = [header.join(",")];
  for (const r of rows)
    lines.push([r.item, r.name, r.type, r.source, r.qty, r.unitMass_kg, r.totalMass_kg, r.unitCost_usd, r.totalCost_usd, r.partIds.join(" ")].map(csvCell).join(","));
  const tm = rows.reduce((s, r) => s + r.totalMass_kg, 0), tc = rows.reduce((s, r) => s + r.totalCost_usd, 0);
  lines.push(["", "TOTAL", "", "", "", "", tm, "", tc, ""].map(csvCell).join(","));
  return lines.join("\n") + "\n";
}
