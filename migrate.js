#!/usr/bin/env node
// One-time migration: ArtifactData JSON dumps (./migration/<desk>/<collection>/<collection>/*.json)
// -> Supabase "docs" table (desk_id, collection, doc_id, data, version, created_at, updated_at).
// Reads SUPABASE_URL / SUPABASE_SECRET_KEY from .env at runtime — never printed, never logged.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

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

const env = loadEnv(path.join(__dirname, ".env"));
const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = env.SUPABASE_SECRET_KEY;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY in .env");
  process.exit(1);
}

const DESKS = {
  main: "13ByUyrQpNzsVNx6ugcBw7",
  steve: "7KLb6UitC4HNG24L6h8Pb6",
  lela: "4PT1LHqpQGPRYQpRdg8ku6",
  uat: "5E8Q4EYbRajn3MaW4TGkk6",
};

const MIGRATION_ROOT = path.join(__dirname, "migration");

function collectRows() {
  const rows = [];
  for (const [deskKey, deskId] of Object.entries(DESKS)) {
    const deskDir = path.join(MIGRATION_ROOT, deskKey);
    if (!fs.existsSync(deskDir)) continue;
    for (const collection of fs.readdirSync(deskDir)) {
      // out_dir wrote files under <deskDir>/<collection>/<collection>/*.json
      const nested = path.join(deskDir, collection, collection);
      const dir = fs.existsSync(nested) ? nested : path.join(deskDir, collection);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".json")) continue;
        const docId = file.slice(0, -5);
        const raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
        const data = raw.data !== undefined ? raw.data : raw;
        const version = raw.version || data.version || 1;
        const now = new Date().toISOString();
        const createdAt = data.createdAt || data.created_at || data.updatedAt || data.updated_at || now;
        const updatedAt = data.updatedAt || data.updated_at || createdAt;
        rows.push({
          desk_id: deskKey,
          collection,
          doc_id: docId,
          data,
          version,
          created_at: createdAt,
          updated_at: updatedAt,
        });
      }
    }
  }
  return rows;
}

async function upsertBatch(rows) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/docs?on_conflict=desk_id,collection,doc_id`,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Batch failed: HTTP ${res.status} ${text}`);
  }
}

async function main() {
  const rows = collectRows();
  console.log(`Collected ${rows.length} documents to migrate.`);

  const byDesk = {};
  for (const r of rows) byDesk[r.desk_id] = (byDesk[r.desk_id] || 0) + 1;
  console.log("Per desk:", byDesk);

  const BATCH = 200;
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await upsertBatch(batch);
    done += batch.length;
    console.log(`Upserted ${done}/${rows.length}`);
  }
  console.log("Migration complete.");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
