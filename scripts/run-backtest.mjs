#!/usr/bin/env node
// One-off: pull real final scores (NBA via ESPN scoreboard, CBB via cbb_game_logs already
// in Supabase) and run jobs/backtest-sides-totals.js for real against the projections +
// closing lines just backfilled. Prints the actual numbers -- this file intentionally does
// not fabricate or pre-bake any result.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { joinProjectionsWithOutcomes, calibrationBuckets, simpleRoiIfAlwaysBetEdgeSide } from "../jobs/backtest-sides-totals.js";
import { addDaysYyyymmdd, yyyymmddToIso } from "../jobs/util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function loadEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}
const env = loadEnv(path.join(__dirname, "..", "..", "sports-proxy", ".env"));
const SUPABASE_URL = env.SUPABASE_URL;
const HEADERS = { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}` };
const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";

async function getAll(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function nbaFinalScores(startYmd, endYmd) {
  const out = [];
  let ymd = startYmd;
  while (ymd <= endYmd) {
    const dateIso = yyyymmddToIso(ymd);
    try {
      const sb = await (await fetch(`${ESPN_BASE}/basketball/nba/scoreboard?dates=${ymd}`)).json();
      for (const ev of sb.events || []) {
        const comp = ev.competitions?.[0];
        if (ev.status?.type?.state !== "post") continue;
        const away = comp?.competitors?.find((c) => c.homeAway === "away");
        const home = comp?.competitors?.find((c) => c.homeAway === "home");
        if (!away?.team?.abbreviation || !home?.team?.abbreviation) continue;
        const homeScore = Number(home.score);
        const awayScore = Number(away.score);
        if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;
        out.push({ date: dateIso, home_team: home.team.abbreviation, away_team: away.team.abbreviation, home_score: homeScore, away_score: awayScore });
      }
    } catch (err) {
      console.log(`NBA final-score fetch failed for ${dateIso}: ${err.message}`);
    }
    ymd = addDaysYyyymmdd(ymd, 1);
  }
  return out;
}

async function main() {
  const nbaProjections = await getAll(`${SUPABASE_URL}/rest/v1/nba_projections?select=*&limit=1000`);
  const cbbProjections = await getAll(`${SUPABASE_URL}/rest/v1/cbb_projections?select=*&limit=1000`);
  const nbaClosing = await getAll(`${SUPABASE_URL}/rest/v1/nba_closing_lines?select=*&limit=1000`);
  const cbbClosing = await getAll(`${SUPABASE_URL}/rest/v1/cbb_closing_lines?select=*&limit=1000`);
  // Filter by date instead of relying on `limit` -- cbb_game_logs has 1200+ rows across the
  // whole season and PostgREST caps a single response at 1000 regardless of `limit`, so an
  // unfiltered fetch silently drops the most recent dates (confirmed: default order excluded
  // 11/3-11/6 entirely). Scoping to the backfill window keeps this well under the cap.
  const cbbGameLogs = await getAll(`${SUPABASE_URL}/rest/v1/cbb_game_logs?select=date,home_team,away_team,home_score,away_score&date=gte.2026-11-03&limit=2000`);

  const nbaScores = await nbaFinalScores("20261021", "20261106");
  const cbbScores = cbbGameLogs
    .filter((g) => g.home_score != null && g.away_score != null)
    .map((g) => ({ date: g.date, home_team: g.home_team, away_team: g.away_team, home_score: g.home_score, away_score: g.away_score }));

  function report(league, projections, closing, scores) {
    const joined = joinProjectionsWithOutcomes(projections, closing, scores);
    const graded = joined.filter((r) => r.actual_margin != null);
    console.log(`\n=== ${league} === projections:${projections.length} closingLines:${closing.length} finalScores:${scores.length} joinedWithOutcome:${graded.length}`);
    if (!graded.length) { console.log("No graded rows -- nothing to report."); return; }

    const buckets = calibrationBuckets(graded).filter((b) => b.games > 0);
    console.log("Calibration buckets (model home-win prob range -> actual home win rate):");
    for (const b of buckets) console.log(`  [${b.rangeLow.toFixed(1)}-${b.rangeHigh.toFixed(1)}) games=${b.games} actualHomeWinRate=${b.actualWinRate}`);

    for (const market of ["ml", "spread", "total"]) {
      const roi = simpleRoiIfAlwaysBetEdgeSide(graded, market);
      console.log(`${market.toUpperCase()}: betsPlaced=${roi.betsPlaced} staked=${roi.unitsStaked} returned=${roi.unitsReturned} ROI=${roi.roi}`);
    }

    for (const market of [{ key: "edge_home_ml", label: "ML (prob edge)" }, { key: "edge_home_spread", label: "spread (prob edge)" }, { key: "edge_total_over", label: "total (prob edge)" }]) {
      for (const minEdge of [0.02, 0.03, 0.05]) {
        const subset = graded.filter((r) => r[market.key] != null && Math.abs(r[market.key]) >= minEdge);
        console.log(`  ${market.label} edge>=${minEdge}: n=${subset.length}`);
      }
    }

    // Seb's actual ask: edge in POINTS (model margin/total vs the DK line), not probability
    // edge -- a different cut. Point-edge = how far the model's number sits from DK's line.
    for (const pointBucket of [2, 3, 5]) {
      const spreadRows = graded.filter((r) => r.projected_margin != null && r.closing_home_spread != null);
      const spreadHits = spreadRows.filter((r) => Math.abs(r.projected_margin - -r.closing_home_spread) >= pointBucket);
      const spreadHitsWon = spreadHits.filter((r) => {
        const betHome = r.projected_margin - -r.closing_home_spread > 0;
        return betHome ? r.actual_margin + r.closing_home_spread > 0 : r.actual_margin + r.closing_home_spread < 0;
      });
      const totalRows = graded.filter((r) => r.projected_total != null && r.closing_total != null);
      const totalHits = totalRows.filter((r) => Math.abs(r.projected_total - r.closing_total) >= pointBucket);
      const totalHitsWon = totalHits.filter((r) => {
        const betOver = r.projected_total - r.closing_total > 0;
        return betOver ? r.actual_total > r.closing_total : r.actual_total < r.closing_total;
      });
      console.log(
        `  point-edge>=${pointBucket}: spread n=${spreadHits.length} ATS%=${spreadHits.length ? (spreadHitsWon.length / spreadHits.length).toFixed(3) : "n/a"} | total n=${totalHits.length} hit%=${totalHits.length ? (totalHitsWon.length / totalHits.length).toFixed(3) : "n/a"}`
      );
    }
  }

  report("NBA", nbaProjections, nbaClosing, nbaScores);
  report("CBB", cbbProjections, cbbClosing, cbbScores);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
