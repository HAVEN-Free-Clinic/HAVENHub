// scripts/gen-gitbook-adaptive-schema.ts
// Regenerate the committed GitBook adaptive-content schema:
//   npx tsx scripts/gen-gitbook-adaptive-schema.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildAdaptiveSchema } from "../src/platform/gitbook/catalog";

const out = resolve(__dirname, "../docs/gitbook/adaptive-schema.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(buildAdaptiveSchema(), null, 2) + "\n");
console.log(`wrote ${out}`);
