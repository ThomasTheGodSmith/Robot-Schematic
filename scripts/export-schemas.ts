/** Write the JSON Schemas for the agent contract (Design Brief, Robot Design Document) to schemas/. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DesignBrief } from "../src/core/schema/brief";
import { RobotDesign } from "../src/core/schema/design";
import { ROOT_DIR } from "../server/config";

const out = join(ROOT_DIR, "schemas");
mkdirSync(out, { recursive: true });
for (const [file, schema, title] of [
  ["design-brief.schema.json", DesignBrief, "Design Brief"],
  ["robot-design.schema.json", RobotDesign, "Robot Design Document"],
] as const) {
  const js = { title, ...(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as object) };
  writeFileSync(join(out, file), JSON.stringify(js, null, 2) + "\n");
  console.log(`wrote schemas/${file}`);
}
