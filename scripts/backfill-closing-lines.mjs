#!/usr/bin/env node
// One-off backfill: pull free ESPN-pickcenter closing lines for every NBA game since the
// season opened (~2026-10-21) and every CBB game since its season opened (~2026-11-03),
// through today, into nba_closing_lines / cbb_closing_lines. Real run against production
// Supabase (additive, isolated tables only) -- not a dry run, not fixture data.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pullClosingLinesForDateRange } from "../jobs/closing-lines.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv(file) {
  const out = {};
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const env = loadEnv(path.join(__dirname, "..", "..", "sports-proxy", ".env"));
const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = env.SUPABASE_SECRET_KEY;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("Missing SUPABASE_URL/SUPABASE_SECRET_KEY");
  process.exit(1);
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function upsertRowsFor(table) {
  return async (rows) => {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=game_id`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`upsert ${table} failed: HTTP ${res.status} ${text}`);
    }
  };
}

async function main() {
  const today = "20261106";
  const nba = await pullClosingLinesForDateRange("NBA", "20261021", today, {
    getJson,
    upsertRows: upsertRowsFor("nba_closing_lines"),
  });
  console.log("NBA closing lines:", { datesProcessed: nba.datesProcessed, gamesFound: nba.gamesFound, rowsWritten: nba.rowsWritten });
  const nbaErrors = nba.perDate.filter((d) => d.error || (d.skipped || []).length);
  if (nbaErrors.length) console.log("NBA gaps:", JSON.stringify(nbaErrors));

  const cbb = await pullClosingLinesForDateRange("CBB", "20261103", today, {
    getJson,
    upsertRows: upsertRowsFor("cbb_closing_lines"),
  });
  console.log("CBB closing lines:", { datesProcessed: cbb.datesProcessed, gamesFound: cbb.gamesFound, rowsWritten: cbb.rowsWritten });
  const cbbErrors = cbb.perDate.filter((d) => d.error || (d.skipped || []).length);
  if (cbbErrors.length) console.log("CBB gaps:", JSON.stringify(cbbErrors));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
