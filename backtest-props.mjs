// Backtests the player-prop/anytime-TD grader extension (grade-dry-run) against real settled
// legs pulled live from the production desks — same methodology as backtest-grader.mjs for
// ml/spread/total. Requires the server running locally (PROXY_TOKEN env var set) since it
// exercises the real HTTP path end to end, box-score fetches included.
//
// Run: PROXY_TOKEN=... node backtest-props.mjs
//
// Known residual gap, not a bug: a handful of real leg-level statuses disagree with what the
// actual ESPN box score shows (confirmed by hand for several — the box score matches this
// grader, not the recorded leg status). This traces to real, pre-existing production data
// issues (a leg's status not backfilled after a ticket-level grade, or after a low-confidence
// leg swap) rather than a defect here — see handbooks/phase2-log.md Part E for specifics.

import { parseLeg } from "./grader.js";

const B = process.env.SPORTS_PROXY_BASE || "http://localhost:3000";
const T = process.env.PROXY_TOKEN;
if (!T) {
  console.error("Set PROXY_TOKEN before running.");
  process.exit(1);
}

async function fetchSettledLegs() {
  const seen = new Set();
  const out = [];
  for (const desk of ["main", "steve", "lela"]) {
    for (const collection of ["parlays", "pnlEntries"]) {
      const res = await fetch(`${B}/api/${desk}/docs/${collection}?token=${T}`);
      const docs = await res.json();
      for (const doc of docs) {
        const date = doc.data.date;
        if (!date) continue;
        for (const l of doc.data.legs || []) {
          if (!l.status || !["hit", "miss", "push"].includes(l.status)) continue;
          const key = `${date}|${l.text}|${l.type}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ date, text: l.text, type: l.type, status: l.status });
        }
      }
    }
  }
  return out;
}

function normStatus(s) {
  if (s === "won" || s === "hit") return "hit";
  if (s === "lost" || s === "miss") return "miss";
  if (s === "push") return "push";
  return s;
}

async function main() {
  const legs = await fetchSettledLegs();
  let total = 0, correct = 0, wrong = 0, needsReview = 0, pending = 0;
  const wrongDetails = [];
  const nrDetails = [];

  for (const leg of legs) {
    const parsed = parseLeg(leg.text, leg.type);
    if (parsed.category !== "stat" && parsed.category !== "anytimeTd") continue;
    total++;
    const url = `${B}/internal/jobs/grade-dry-run?token=${T}&text=${encodeURIComponent(leg.text)}&type=${encodeURIComponent(leg.type)}&date=${leg.date}`;
    let result;
    try {
      const res = await fetch(url);
      result = await res.json();
    } catch (e) {
      result = { status: "error", reason: String(e) };
    }
    const expected = normStatus(leg.status);
    if (result.status === "needs_review" || result.status === "pending") {
      if (result.status === "pending") pending++; else needsReview++;
      nrDetails.push(`[${leg.date}] "${leg.text}" (${leg.type}) -> ${result.status}: ${result.reason} (real: ${expected})`);
      continue;
    }
    if (result.status === expected) {
      correct++;
    } else {
      wrong++;
      wrongDetails.push(`[${leg.date}] "${leg.text}" (${leg.type}) -> got ${result.status}, real ${expected}`);
    }
  }

  console.log(`Total stat/anytimeTd legs: ${total}`);
  console.log(`Correct: ${correct}`);
  console.log(`WRONG: ${wrong}`);
  console.log(`needs_review: ${needsReview}`);
  console.log(`pending: ${pending}`);
  if (correct + wrong > 0) console.log(`Accuracy on confident calls: ${((correct / (correct + wrong)) * 100).toFixed(1)}%`);
  if (wrongDetails.length) {
    console.log("\n--- WRONG (cross-check these against the real box score before trusting the recorded status) ---");
    wrongDetails.forEach((d) => console.log(d));
  }
  console.log(`\n--- needs_review/pending samples (first 20) ---`);
  nrDetails.slice(0, 20).forEach((d) => console.log(d));
}

main();
