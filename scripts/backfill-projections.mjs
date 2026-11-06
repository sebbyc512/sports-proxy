#!/usr/bin/env node
// One-off: build nba_projections/cbb_projections rows for every game that
// backfill-closing-lines.mjs just wrote, using real nbaTeams/cbbTeams docs (season-to-date
// ptsFor/ptsAgainst, and NBA's offRtg/defRtg/pace) and real cbb_game_logs (for CBB
// per-matchup variance). KNOWN LIMITATION, flagged not hidden: uses TODAY's team ratings
// for every game in the range, including ones earlier in the season -- a point-in-time
// historical-ratings rebuild is out of scope for this quick backtest pass. ESPN pickcenter
// gives a spread/total VALUE but not the two-sided vig price, so spread/total edge is
// computed assuming standard -110/-110 (flagged, not a real captured price) -- moneyline
// edge uses the real captured moneylines.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildSidesTotalsProjection, buildNbaTeamGameTotals, buildCbbTeamGameMargins, teamMarginStdDev, combinedMatchupStdDev } from "../jobs/projection-engine-sides-totals.js";

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
const SUPABASE_SECRET_KEY = env.SUPABASE_SECRET_KEY;
const HEADERS = { apikey: SUPABASE_SECRET_KEY, Authorization: `Bearer ${SUPABASE_SECRET_KEY}` };

async function getAll(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function insertRows(table, rows) {
  if (!rows.length) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`insert ${table} failed: HTTP ${res.status} ${await res.text()}`);
}

function teamDocsToMap(rows) {
  const m = new Map();
  for (const r of rows) m.set(r.doc_id, r.data);
  return m;
}

async function main() {
  // Clear any prior run's rows so this script is idempotent to re-run.
  await fetch(`${SUPABASE_URL}/rest/v1/nba_projections?date=gte.2026-10-01`, { method: "DELETE", headers: HEADERS });
  await fetch(`${SUPABASE_URL}/rest/v1/cbb_projections?date=gte.2026-10-01`, { method: "DELETE", headers: HEADERS });

  const nbaTeamDocs = teamDocsToMap(await getAll(`${SUPABASE_URL}/rest/v1/docs?desk_id=eq.main&collection=eq.nbaTeams&select=doc_id,data&limit=1000`));
  const cbbTeamDocs = teamDocsToMap(await getAll(`${SUPABASE_URL}/rest/v1/docs?desk_id=eq.main&collection=eq.cbbTeams&select=doc_id,data&limit=1000`));
  const nbaClosing = await getAll(`${SUPABASE_URL}/rest/v1/nba_closing_lines?select=*&limit=1000`);
  const cbbClosing = await getAll(`${SUPABASE_URL}/rest/v1/cbb_closing_lines?select=*&limit=1000`);
  // Filtered by date, not just `limit` -- PostgREST caps a response at 1000 rows regardless
  // of `limit`, and cbb_game_logs has 1200+ rows across the season; an unfiltered fetch
  // silently drops the most recent dates (confirmed while debugging the backtest join).
  const cbbGameLogs = await getAll(`${SUPABASE_URL}/rest/v1/cbb_game_logs?select=game_id,date,home_team,away_team,home_score,away_score&date=gte.2026-10-01&limit=2000`);
  const cbbMargins = buildCbbTeamGameMargins(cbbGameLogs);
  // nba_player_logs is empty as of this run (daily-data batch hasn't produced rows yet) --
  // buildNbaTeamGameTotals on an empty array just yields [], and teamMarginStdDev then
  // falls back to the fixed league constant for every NBA game (documented behavior, not a
  // bug). Left in place so this script needs no changes once that table fills up.
  const nbaPlayerLogs = await getAll(`${SUPABASE_URL}/rest/v1/nba_player_logs?select=game_id,date,team,opponent,home_away,points&limit=5000`);
  const nbaTotals = buildNbaTeamGameTotals(nbaPlayerLogs);

  function offDefFor(league, teamDoc) {
    if (!teamDoc) return null;
    if (league === "NBA" && teamDoc.offRtg != null && teamDoc.defRtg != null && teamDoc.pace != null) {
      return { offRtg: teamDoc.offRtg, defRtg: teamDoc.defRtg, pace: teamDoc.pace };
    }
    if (teamDoc.ptsFor != null && teamDoc.ptsAgainst != null) {
      return { avgPointsScored: teamDoc.ptsFor, avgPointsAllowed: teamDoc.ptsAgainst };
    }
    return null;
  }

  function run(league, closingRows, teamDocs, gameLogTotals) {
    const rows = [];
    let skippedNoTeamData = 0;
    for (const c of closingRows) {
      const homeDoc = teamDocs.get(c.home_team);
      const awayDoc = teamDocs.get(c.away_team);
      const homeOffDef = offDefFor(league, homeDoc);
      const awayOffDef = offDefFor(league, awayDoc);
      if (!homeOffDef || !awayOffDef) { skippedNoTeamData++; continue; }
      const homeStd = teamMarginStdDev(gameLogTotals, c.home_team);
      const awayStd = teamMarginStdDev(gameLogTotals, c.away_team);
      const stdDevOverride = combinedMatchupStdDev(league, homeStd, awayStd);
      const proj = buildSidesTotalsProjection({
        league,
        homeTeam: c.home_team,
        awayTeam: c.away_team,
        date: c.date,
        homeOffDef,
        awayOffDef,
        homeScheduleCtx: null,
        awayScheduleCtx: null,
        dk: {
          homeSpread: c.home_spread,
          total: c.total,
          mlHome: c.home_moneyline,
          mlAway: c.away_moneyline,
          // ESPN pickcenter doesn't carry a separate spread/total vig price -- assumed
          // standard -110/-110, same assumption the backtest's ROI calc already makes.
          spreadPriceHome: c.home_spread != null ? -110 : null,
          spreadPriceAway: c.home_spread != null ? -110 : null,
          totalOverPrice: c.total != null ? -110 : null,
          totalUnderPrice: c.total != null ? -110 : null,
        },
        stdDevOverride,
      });
      proj.game_id = c.game_id;
      rows.push(proj);
    }
    return { rows, skippedNoTeamData };
  }

  const nba = run("NBA", nbaClosing, nbaTeamDocs, nbaTotals);
  const cbb = run("CBB", cbbClosing, cbbTeamDocs, cbbMargins);

  // margin_stddev_used isn't a column on the live table yet (added to the row shape in the
  // 1.1 model upgrade, after the table SQL was written/run) -- strip it before insert rather
  // than block on another schema migration; it's informational, not needed for the backtest.
  const stripStdDev = (r) => { const { margin_stddev_used, ...rest } = r; return rest; };
  await insertRows("nba_projections", nba.rows.filter((r) => r.projected_margin != null).map(stripStdDev));
  await insertRows("cbb_projections", cbb.rows.filter((r) => r.projected_margin != null).map(stripStdDev));

  console.log("NBA:", { closingLinesIn: nbaClosing.length, projected: nba.rows.filter((r) => r.projected_margin != null).length, skippedNoTeamData: nba.skippedNoTeamData });
  console.log("CBB:", { closingLinesIn: cbbClosing.length, projected: cbb.rows.filter((r) => r.projected_margin != null).length, skippedNoTeamData: cbb.skippedNoTeamData });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
