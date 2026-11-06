// CFB game-level betting lines via CollegeFootballData (CFBD), added 2026-11-06+ at Seb's
// explicit ask: "plus CFB data, isolated in their own tables." No CFB projection model, no
// wiring anywhere -- this is data landing only, same scope boundary as everything else in
// this engine's Phase 1/1.1 work. CFBD is CBBD's sister API, same CFBD_API_KEY auth.
//
// ASSUMPTION, NOT CONFIRMED: no live CFBD_API_KEY in this worktree's local .env, so the
// endpoint path (`/lines?year=YYYY&week=N`) and response shape (array of
// { id, season, week, homeTeam, awayTeam, startDate, lines: [{ provider, spread,
// overUnder, homeMoneyline, awayMoneyline }] }) mirror CBBD's basketball /lines shape per
// CFBD's published docs/general knowledge -- not a live-tested response. Needs a real call
// to confirm before this data is trusted for anything.
//
// Same injected-deps pattern as jobs/cbbd-historical-lines.js (reuses its line-picking
// logic rather than duplicating it -- CFBD and CBBD lines are shaped identically).
import { pickPreferredLine } from "./cbbd-historical-lines.js";

const CFBD_BASE = "https://api.collegefootballdata.com";

export function normalizeCfbdGame(game) {
  const line = pickPreferredLine(game.lines);
  if (!line) return null;
  return {
    game_id: `cfbd-${game.id}`,
    season: game.season != null ? String(game.season) : null,
    week: Number.isFinite(game.week) ? game.week : null,
    date: (game.startDate || "").slice(0, 10) || null,
    home_team: game.homeTeam || null,
    away_team: game.awayTeam || null,
    home_spread: Number.isFinite(line.spread) ? line.spread : null,
    total: Number.isFinite(line.overUnder) ? line.overUnder : null,
    home_moneyline: Number.isFinite(line.homeMoneyline) ? line.homeMoneyline : null,
    away_moneyline: Number.isFinite(line.awayMoneyline) ? line.awayMoneyline : null,
    provider: line.provider || null,
    captured_at: new Date().toISOString(),
  };
}

// `season` required, `week` optional (omit for the whole season, matching CFBD's own
// /lines query contract). `deps.getJson`/`deps.upsertRows` injected as usual.
export async function pullCfbdGameLines(season, week, deps) {
  const result = { season, week: week ?? null, gamesFound: 0, rowsWritten: 0, skipped: [] };
  const qs = week != null ? `year=${season}&week=${week}` : `year=${season}`;
  let games;
  try {
    games = await deps.getJson(`${CFBD_BASE}/lines?${qs}`);
  } catch (err) {
    result.error = err.message;
    return result;
  }
  if (!Array.isArray(games)) {
    result.error = "unexpected response shape (expected an array of games)";
    return result;
  }
  result.gamesFound = games.length;

  const rows = [];
  for (const g of games) {
    const row = normalizeCfbdGame(g);
    if (!row) {
      result.skipped.push({ id: g.id, reason: "no usable line" });
      continue;
    }
    rows.push(row);
  }
  if (rows.length) await deps.upsertRows(rows);
  result.rowsWritten = rows.length;
  return result;
}
