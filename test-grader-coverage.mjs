import fs from "fs";
import path from "path";
import { parseLeg } from "./grader.js";

const dirs = [
  "migration/main/pnlEntries/pnlEntries",
  "migration/uat/pnlEntries/pnlEntries",
  "migration/steve/pnlEntries/pnlEntries",
  "migration/lela/pnlEntries/pnlEntries",
  "migration/main/parlays/parlays",
  "migration/uat/parlays/parlays",
  "migration/steve/parlays/parlays",
  "migration/lela/parlays/parlays",
];

const stats = {};
const unsupportedExamples = {};

for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const data = j.data || j;
    for (const leg of data.legs || []) {
      const type = leg.type || "unknown";
      stats[type] = stats[type] || { total: 0, parsed: 0 };
      stats[type].total++;
      const result = parseLeg(leg.text, type);
      if (result.category !== "unsupported") {
        stats[type].parsed++;
      } else if (["ml", "spread", "over", "under"].includes(type)) {
        unsupportedExamples[type] = unsupportedExamples[type] || [];
        if (unsupportedExamples[type].length < 8) unsupportedExamples[type].push(leg.text);
      }
    }
  }
}

console.log("=== Parse coverage by leg type ===");
for (const [type, s] of Object.entries(stats)) {
  const pct = s.total ? ((s.parsed / s.total) * 100).toFixed(1) : "0.0";
  console.log(`${type.padEnd(10)} ${String(s.parsed).padStart(4)}/${String(s.total).padEnd(4)}  ${pct}%`);
}

console.log("\n=== Unparsed examples for targeted types (ml/spread/over/under) ===");
for (const [type, examples] of Object.entries(unsupportedExamples)) {
  console.log(`--- ${type} ---`);
  examples.forEach((e) => console.log("  " + e));
}
