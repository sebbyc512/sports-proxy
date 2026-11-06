// Historical NBA player-props puller (2026-11-06+, Seb's explicit approval: 3 markets
// (points, rebounds, assists), US region, one closing snapshot per game, ~4,500 credits
// estimated, stay above 8,000 remaining for the month). Pulls ONE DATE per call -- the
// caller (server.js route, fired manually by the parent session, never a cron) loops over
// dates and checks quota between calls for credit safety.
//
// Uses The Odds API's historical endpoint (same auth/shape as the live endpoint, just under
// /historical/ and with a `date` snapshot param) -- one call per NBA event that day, each
// call itself costing real credits (10x the regular per-market-per-region rate, confirmed by
// Seb's own quota-estimate math before approving this). ESPN<->Odds-API game identity uses
// the already-fixed jobs/team-aliases.js matcher -- no `events[0]` guessing here either.
//
// Hard stop, mid-batch if needed: the moment any single call reports requestsRemaining below
// MIN_CREDITS_FLOOR, processing stops immediately (partial rows already written are kept,
// `stoppedEarly: true` is returned) -- this function never "finishes the day" past the floor.
import { matchOddsEvent } from "./team-aliases.js";

export const PROP_MARKETS = { points: "player_points", rebounds: "player_rebounds", assists: "player_assists" };
export const MIN_CREDITS_FLOOR = 8000;

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";

// Builds the rows for one Odds API historical-odds response (one event, one snapshot) across
// however many of the 3 markets it returned. `market` here is this module's own key
// (points/rebounds/assists), mapped from PROP_MARKETS internally by the caller loop.
function rowsFromHistoricalOddsResponse(data, { date, snapshotAt, homeTeam, awayTeam, marketKeyToOurKey }) {
  const rows = [];
  const dkBook = (data?.bookmakers || []).find((b) => /draftkings/i.test(b.key || b.title || ""));
  if (!dkBook) return rows;
  for (const mkt of dkBook.markets || []) {
    const ourKey = marketKeyToOurKey[mkt.key];
    if (!ourKey) continue;
    // Player-prop markets list one outcome per (player, Over/Under) -- pair them by description.
    const byPlayer = new Map();
    for (const o of mkt.outcomes || []) {
      const player = o.description || o.name;
      if (!byPlayer.has(player)) byPlayer.set(player, {});
      const side = byPlayer.get(player);
      if (/^over$/i.test(o.name)) { side.overPrice = o.price; side.line = o.point; }
      else if (/^under$/i.test(o.name)) { side.underPrice = o.price; side.line = side.line ?? o.point; }
    }
    for (const [player, side] of byPlayer) {
      if (side.line == null) continue;
      rows.push({
        date,
        player,
        home_team: homeTeam,
        away_team: awayTeam,
        market: ourKey,
        dk_line: side.line,
        dk_over_price: side.overPrice ?? null,
        dk_under_price: side.underPrice ?? null,
        snapshot_at: snapshotAt,
      });
    }
  }
  return rows;
}

// One calendar date (YYYYMMDD). `deps.getEspnJson(url)` for the day's ESPN scoreboard (final
// games only -- no point pulling props for a game that hasn't happened/been played at the
// snapshot time); `deps.getOddsEvents(dateIso)` -> the historical /events list for that date
// (array of {id, home_team, away_team, commence_time}); `deps.getHistoricalOdds(eventId,
// snapshotIso)` -> { data, requestsRemaining } for one event's historical odds at that
// snapshot; `deps.upsertRows(rows)` writes to nba_prop_historical_lines.
export async function pullHistoricalPropsForDate(yyyymmdd, deps) {
  const dateIso = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  const result = { date: dateIso, eventsProcessed: 0, rowsWritten: 0, creditsUsedThisCall: 0, creditsRemainingAfter: null, stoppedEarly: false, skipped: [] };

  const scoreboard = await deps.getEspnJson(`${ESPN_BASE}/scoreboard?dates=${yyyymmdd}`);
  const games = [];
  for (const ev of scoreboard.events || []) {
    const comp = ev.competitions?.[0];
    const away = comp?.competitors?.find((c) => c.homeAway === "away");
    const home = comp?.competitors?.find((c) => c.homeAway === "home");
    if (ev.status?.type?.state !== "post") continue; // only grade/pull props for games that actually happened
    if (!away?.team?.displayName || !home?.team?.displayName) continue;
    games.push({ id: String(ev.id), homeTeam: home.team.displayName, awayTeam: away.team.displayName, tipoff: comp.date });
  }
  if (!games.length) return result;

  const oddsEvents = await deps.getOddsEvents(dateIso);
  const allRows = [];
  let creditsRemaining = null;

  for (const g of games) {
    const { event, reason } = matchOddsEvent(oddsEvents, g.homeTeam, g.awayTeam, "NBA");
    if (!event) {
      result.skipped.push({ game: `${g.awayTeam} @ ${g.homeTeam}`, reason });
      continue;
    }
    // Snapshot close to tip-off -- The Odds API's historical endpoint returns the odds AS OF
    // this timestamp, which is what "closing line" means here (last price before the game).
    // ESPN's own `comp.date` sometimes omits seconds (e.g. "2026-10-21T23:00Z"), which The
    // Odds API's historical endpoint rejects outright (422 INVALID_HISTORICAL_TIMESTAMP) --
    // round-tripping through Date gives a full timestamp, but the API rejects milliseconds
    // too (still 422s) -- it wants exactly YYYY-MM-DDTHH:MM:SSZ, so strip the ".sss" part.
    const rawSnapshot = g.tipoff || event.commence_time;
    const snapshotAt = new Date(rawSnapshot).toISOString().replace(/\.\d{3}Z$/, "Z");
    let call;
    try {
      call = await deps.getHistoricalOdds(event.id, snapshotAt);
    } catch (err) {
      result.skipped.push({ game: `${g.awayTeam} @ ${g.homeTeam}`, reason: err.message });
      continue;
    }
    result.eventsProcessed++;
    result.creditsUsedThisCall += call.creditsUsedThisCall ?? 0;
    if (call.requestsRemaining != null) creditsRemaining = call.requestsRemaining;

    const rows = rowsFromHistoricalOddsResponse(call.data, {
      date: dateIso, snapshotAt, homeTeam: g.homeTeam, awayTeam: g.awayTeam, marketKeyToOurKey: invertMarkets(),
    });
    allRows.push(...rows);

    if (creditsRemaining != null && creditsRemaining < MIN_CREDITS_FLOOR) {
      result.stoppedEarly = true;
      break; // hard stop: do not process the next event, even mid-day
    }
  }

  if (allRows.length) await deps.upsertRows(allRows);
  result.rowsWritten = allRows.length;
  result.creditsRemainingAfter = creditsRemaining;
  return result;
}

function invertMarkets() {
  const inv = {};
  for (const [ourKey, apiKey] of Object.entries(PROP_MARKETS)) inv[apiKey] = ourKey;
  return inv;
}
