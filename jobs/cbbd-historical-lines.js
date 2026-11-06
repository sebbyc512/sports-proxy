// Multi-season CBB historical betting lines via CollegeBasketballData (CBBD), added
// 2026-11-06+ at Seb's request once he set CFBD_API_KEY on Render (same key covers both
// collegefootballdata.com and collegebasketballdata.com -- sister APIs, same auth header).
// Purpose: jobs/closing-lines.js's cbb_closing_lines only has free ESPN-pickcenter lines
// going forward from when that job started running -- it can't backfill PAST seasons. CBBD
// exposes a real historical `/lines` endpoint (one row per game, one entry per provider in
// its `lines` array) going back multiple seasons, which is what a real full-history backtest
// needs. Kept in its own table (`cbbd_historical_lines`, `source: 'cbbd'`) rather than merged
// into cbb_closing_lines, so the two sources are never confused with each other.
//
// ASSUMPTION, NOT CONFIRMED: this worktree has no live CFBD_API_KEY (Render-only right now),
// so the endpoint path/response shape below (`/lines?season=YYYY`, response items shaped
// { id, homeTeam, awayTeam, startDate, lines: [{ provider, spread, overUnder, homeMoneyline,
// awayMoneyline }] }) is built from CBBD's published API docs/general knowledge, NOT a live
// response. The field names (especially moneyline casing and whether spread is home-signed)
// need a real first call to confirm before anyone trusts this data for a backtest.
//
// Same injected-deps pattern as jobs/closing-lines.js / jobs/schedule-context.js: deps.getJson
// does the HTTP call (with the real Authorization header, which only server.js can supply),
// deps.upsertRows writes to Supabase. Pure logic here, fully testable with fixtures.

const CBBD_BASE = "https://api.collegebasketballdata.com";

// DraftKings preferred (matches the rest of this engine's book preference); falls back to
// whatever provider CBBD returns first if DK isn't present for that game.
export function pickPreferredLine(lines) {
  if (!Array.isArray(lines) || !lines.length) return null;
  const dk = lines.find((l) => /draftkings/i.test(l.provider || ""));
  return dk || lines[0];
}

export function normalizeCbbdGame(game) {
  const line = pickPreferredLine(game.lines);
  if (!line) return null;
  return {
    game_id: `cbbd-${game.id}`,
    source: "cbbd",
    season: game.season != null ? String(game.season) : null,
    date: (game.startDate || "").slice(0, 10) || null,
    home_team: game.homeTeam || null,
    away_team: game.awayTeam || null,
    // ASSUMPTION: CBBD's `spread` is home-signed like ESPN's pickcenter (negative = home
    // favored). Needs confirming against a real response.
    home_spread: Number.isFinite(line.spread) ? line.spread : null,
    total: Number.isFinite(line.overUnder) ? line.overUnder : null,
    home_moneyline: Number.isFinite(line.homeMoneyline) ? line.homeMoneyline : null,
    away_moneyline: Number.isFinite(line.awayMoneyline) ? line.awayMoneyline : null,
    provider: line.provider || null,
    captured_at: new Date().toISOString(),
  };
}

// One season at a time. `deps.getJson(url)` / `deps.upsertRows(rows)` injected, same as
// jobs/closing-lines.js. `season` is CBBD's convention: the year the season STARTS (e.g.
// 2025 for the 2025-26 season) -- matches this repo's seasonForDate() start-year convention
// in jobs/util.js.
export async function pullCbbdHistoricalLinesForSeason(season, deps) {
  const result = { season, gamesFound: 0, rowsWritten: 0, skipped: [] };
  let games;
  try {
    games = await deps.getJson(`${CBBD_BASE}/lines?season=${season}`);
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
    const row = normalizeCbbdGame(g);
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
