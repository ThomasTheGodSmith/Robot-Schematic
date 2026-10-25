/** CLI: validate a design JSON file against the component library and print the report. */
import { readFileSync } from "node:fs";
import { loadLibrary } from "../src/core/library-node";
import { parseDesign, validateDesign } from "../src/core/validate";

const file = process.argv[2];
if (!file) {
  console.error("usage: tsx scripts/validate.ts <design.json> [--all]");
  process.exit(2);
}
const { design, issues } = parseDesign(JSON.parse(readFileSync(file, "utf8")));
if (!design) {
  console.error("Schema errors:\n" + issues.join("\n"));
  process.exit(1);
}
const t0 = performance.now();
const report = validateDesign(design, loadLibrary());
const all = process.argv.includes("--all");
for (const c of report.checks) if (all || c.status !== "pass") console.log(`[${c.status.toUpperCase()}] ${c.category} | ${c.title}: ${c.message}`);
const s = report.summary;
console.log(`\n${report.status.toUpperCase()}  pass ${report.counts.pass}  warn ${report.counts.warn}  fail ${report.counts.fail}  (${(performance.now() - t0).toFixed(0)} ms)`);
console.log(`mass ${s.totalMass_kg.toFixed(2)} kg, avg ${s.averagePower_W?.toFixed(1)} W, runtime ${s.runtime_min?.toFixed(0)} min, cost $${s.totalCost_usd.toFixed(0)}`);
for (const j of s.joints) console.log(`  ${j.jointId.padEnd(10)} peak ${j.requiredPeakTorque_Nm.toFixed(2)} / ${j.availablePeakTorque_Nm?.toFixed(1)}  rms ${j.requiredRmsTorque_Nm.toFixed(2)} / ${j.availableContinuousTorque_Nm?.toFixed(1)}  speed ${j.requiredSpeed_rad_s.toFixed(1)} / ${j.noLoadSpeed_rad_s?.toFixed(1)}`);
process.exit(report.status === "fail" ? 1 : 0);
