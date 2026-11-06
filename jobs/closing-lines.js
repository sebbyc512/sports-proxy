// Season-wide NBA + CBB closing lines for backtesting the sides/totals projection engine
// (2026-11-06+, Seb's request, phase 1 of the analytics-only engine). Deliberately separate
// from the existing clv_legs/CLV-capture pipeline -- that one only captures a line for legs
// Seb actually bet; this pulls EVERY game so the backtest has a full-season sample, not just
// the subset that happened to get bet on.
//
// Reuses the free ESPN-pickcenter-as-closing-line trick server.js's extractCbbClosingLine
// already uses for CLV capture (2026-11-02, Seb's request, instead of the-odds-api's paid
// historical endpoint). The extraction logic is duplicated here (not imported from
// server.js) on purpose: this module has to stay independently testable/isolated for
// Phase 1, and server.js doesn't export its internals. Keep in sync by hand if the
// upstream one's field names ever change.
import { yyyymmddToIso, addDaysYyyymmdd } from "./util.js";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";
const LEAGUE_PATHS = { NBA: "basketball/nba", CBB: "basketball/mens-college-basketball" };

export function extractClosingLineFromSummary(summary) {
  const books = summary?.pickcenter || [];
  if (!books.length) return { provider: null, homeSpread: null, total: null, homeMoneyline: null, awayMoneyline: null };
  const dk = books.find((b) => /draftkings/i.test(b.provider?.name || ""));
  const best = dk || books.slice().sort((a, b) => (a.provider?.priority ?? 99) - (b.provider?.priority ?? 99))[0];
  return {
    provider: best.provider?.name || null,
    homeSpread: Number.isFinite(best.spread) ? best.spread : null,
    total: Number.isFinite(best.overUnder) ? best.overUnder : null,
    homeMoneyline: Number.isFinite(best.homeTeamOdds?.moneyLine) ? best.homeTeamOdds.moneyLine : null,
    awayMoneyline: Number.isFinite(best.awayTeamOdds?.moneyLine) ? best.awayTeamOdds.moneyLine : null,
  };
}

// Only FINAL games count as a "closing" line -- ESPN's pickcenter array is frozen at
// whatever the book last quoted once the game goes final, so this is a true close, not a
// snapshot of a still-moving line.
export function extractFinalGamesFromScoreboard(scoreboard, dateIso) {
  const out = [];
  for (const ev of scoreboard.events || []) {
    const comp = ev.competitions?.[0];
    const away = comp?.competitors?.find((c) => c.homeAway === "away");
    const home = comp?.competitors?.find((c) => c.homeAway === "home");
    if (!away?.team?.abbreviation || !home?.team?.abbreviation) continue;
    if (ev.status?.type?.state !== "post") continue;
    out.push({ id: String(ev.id), date: dateIso, homeTeam: home.team.abbreviation, awayTeam: away.team.abbreviation });
  }
  return out;
}

// One calendar date, one league. `deps.getJson`/`deps.upsertRows` injected for testability,
// same pattern as jobs/schedule-context.js and jobs/nba-player-logs.js.
export async function pullClosingLinesForDate(league, yyyymmdd, deps) {
  const path = LEAGUE_PATHS[league];
  if (!path) throw new Error(`unknown league ${league}`);
  const dateIso = yyyymmddToIso(yyyymmdd);
  const result = { league, date: dateIso, gamesFound: 0, rowsWritten: 0, skipped: [] };

  let scoreboard;
  try {
    scoreboard = await deps.getJson(`${ESPN_BASE}/${path}/scoreboard?dates=${yyyymmdd}`);
  } catch (err) {
    result.error = err.message;
    return result;
  }
  const games = extractFinalGamesFromScoreboard(scoreboard, dateIso);
  result.gamesFound = games.length;

  const rows = [];
  for (const g of games) {
    try {
      const summary = await deps.getJson(`${ESPN_BASE}/${path}/summary?event=${g.id}`);
      const line = extractClosingLineFromSummary(summary);
      if (line.provider == null) {
        result.skipped.push({ id: g.id, reason: "no pickcenter data" });
        continue;
      }
      rows.push({
        game_id: g.id,
        league,
        date: dateIso,
        home_team: g.homeTeam,
        away_team: g.awayTeam,
        home_spread: line.homeSpread,
        total: line.total,
        home_moneyline: line.homeMoneyline,
        away_moneyline: line.awayMoneyline,
        provider: line.provider,
        captured_at: new Date().toISOString(),
      });
    } catch (err) {
      result.skipped.push({ id: g.id, reason: err.message });
    }
  }
  if (rows.length) await deps.upsertRows(rows);
  result.rowsWritten = rows.length;
  return result;
}

// Season-wide backfill: inclusive date range, one pullClosingLinesForDate call per date.
// A single bad date (ESPN hiccup) is recorded in `perDate` and doesn't stop the rest of the
// range -- same tolerance as schedule-context's per-date try/catch.
export async function pullClosingLinesForDateRange(league, startYmd, endYmd, deps) {
  const perDate = [];
  let ymd = startYmd;
  let guard = 0;
  while (ymd <= endYmd && guard < 400) {
    perDate.push(await pullClosingLinesForDate(league, ymd, deps));
    ymd = addDaysYyyymmdd(ymd, 1);
    guard++;
  }
  return {
    league,
    startDate: yyyymmddToIso(startYmd),
    endDate: yyyymmddToIso(endYmd),
    datesProcessed: perDate.length,
    gamesFound: perDate.reduce((s, d) => s + (d.gamesFound || 0), 0),
    rowsWritten: perDate.reduce((s, d) => s + (d.rowsWritten || 0), 0),
    perDate,
  };
}
