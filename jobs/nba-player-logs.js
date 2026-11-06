// Item 1 of the 2026-11-06 daily-data batch: NBA player game logs.
// Pure extraction/aggregation here; server.js's hook supplies real getJson/upsert/getDoc so
// this file stays unit-testable without network or Supabase.
import { seasonForDate, yyyymmddToIso, splitMadeAttempt, avgLastN, trendLast5VsPrior5 } from "./util.js";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";

// Same ESPN->canonical abbreviation table server.js already uses for NBA (kept in sync
// manually -- see server.js's ESPN_TO_NBA_ABBR). Only the handful of ids that actually
// differ from ESPN's own abbreviation need an entry; everything else passes through.
const ESPN_TO_NBA_ABBR = {
  UTAH: "UTA",
  NO: "NOP",
  GS: "GSW",
  NY: "NYK",
  SA: "SAS",
  WSH: "WAS",
};

export function nbaAbbr(a) {
  return ESPN_TO_NBA_ABBR[a] || a;
}

// Pulls every player's box-score line out of one ESPN game summary's boxscore.players
// array (one block per team: { team: {abbreviation}, statistics: [{ keys: [...], athletes:
// [{ athlete: {id, displayName, position}, starter, stats: [...] }] }] }).
export function extractNbaPlayerLogs(boxscorePlayers, awayAbbr, homeAbbr) {
  const rows = [];
  for (const teamBlock of boxscorePlayers || []) {
    const abbr = nbaAbbr(teamBlock.team?.abbreviation);
    if (!abbr) continue;
    const opponent = abbr === awayAbbr ? homeAbbr : abbr === homeAbbr ? awayAbbr : null;
    const homeAway = abbr === homeAbbr ? "home" : abbr === awayAbbr ? "away" : null;
    const stat = teamBlock.statistics?.[0];
    const keys = stat?.keys || [];
    const idxOf = (k) => keys.indexOf(k);
    const minIdx = idxOf("minutes");
    const ptsIdx = idxOf("points");
    const rebIdx = idxOf("rebounds");
    const astIdx = idxOf("assists");
    const stlIdx = idxOf("steals");
    const blkIdx = idxOf("blocks");
    const tovIdx = idxOf("turnovers");
    const threeIdx = idxOf("threePointFieldGoalsMade-threePointFieldGoalsAttempted");

    for (const a of stat?.athletes || []) {
      if (!a.athlete?.id) continue;
      const s = a.stats || [];
      const minutesRaw = minIdx >= 0 ? s[minIdx] : undefined;
      if (minutesRaw === undefined) continue; // not in this box score at all (inactive, no line)
      const didNotPlay = minutesRaw === "DNP" || minutesRaw === "" || minutesRaw == null;
      const minutes = didNotPlay ? 0 : Number(minutesRaw) || 0;
      const three = threeIdx >= 0 ? splitMadeAttempt(s[threeIdx]).made : null;

      rows.push({
        team: abbr,
        opponent,
        home_away: homeAway,
        player_id: String(a.athlete.id),
        player_name: a.athlete.displayName || null,
        position: a.athlete.position?.abbreviation || null,
        started: !!a.starter,
        did_not_play: didNotPlay,
        minutes,
        points: ptsIdx >= 0 ? Number(s[ptsIdx]) || 0 : 0,
        rebounds: rebIdx >= 0 ? Number(s[rebIdx]) || 0 : 0,
        assists: astIdx >= 0 ? Number(s[astIdx]) || 0 : 0,
        three_pm: three,
        steals: stlIdx >= 0 ? Number(s[stlIdx]) || 0 : 0,
        blocks: blkIdx >= 0 ? Number(s[blkIdx]) || 0 : 0,
        turnovers: tovIdx >= 0 ? Number(s[tovIdx]) || 0 : 0,
      });
    }
  }
  return rows;
}

// Builds the exact rows to upsert into nba_player_logs for one final game.
export function buildNbaPlayerLogRows(gameId, yyyymmdd, boxscorePlayers, awayAbbr, homeAbbr) {
  const dateIso = yyyymmddToIso(yyyymmdd);
  const season = seasonForDate(yyyymmdd);
  const extracted = extractNbaPlayerLogs(boxscorePlayers, awayAbbr, homeAbbr);
  return extracted.map((r) => ({ game_id: String(gameId), date: dateIso, season, ...r }));
}

// Processes one ET calendar date (default: yesterday) end-to-end. `deps.getJson(url)` and
// `deps.upsertRows(rows)` are injected so this can be unit-tested with fakes and reused
// unchanged once server.js wires in the real network/Supabase calls.
export async function trackNbaPlayerLogsForDate(yyyymmdd, deps) {
  const result = { date: yyyymmdd, gamesFound: 0, gamesRecorded: 0, skipped: [] };
  let scoreboard;
  try {
    scoreboard = await deps.getJson(`${ESPN_BASE}/basketball/nba/scoreboard?dates=${yyyymmdd}`);
  } catch (err) {
    result.error = err.message;
    return result;
  }
  const events = (scoreboard.events || []).filter((ev) => ev.status?.type?.state === "post");
  result.gamesFound = events.length;

  for (const ev of events) {
    try {
      const comp = ev.competitions?.[0];
      const away = comp?.competitors?.find((c) => c.homeAway === "away");
      const home = comp?.competitors?.find((c) => c.homeAway === "home");
      if (!away || !home) {
        result.skipped.push({ id: ev.id, reason: "missing competitors" });
        continue;
      }
      const awayAbbr = nbaAbbr(away.team?.abbreviation);
      const homeAbbr = nbaAbbr(home.team?.abbreviation);
      const summary = await deps.getJson(`${ESPN_BASE}/basketball/nba/summary?event=${ev.id}`);
      const rows = buildNbaPlayerLogRows(ev.id, yyyymmdd, summary.boxscore?.players, awayAbbr, homeAbbr);
      if (!rows.length) {
        result.skipped.push({ id: ev.id, reason: "no player boxscore" });
        continue;
      }
      await deps.upsertRows(rows);
      result.gamesRecorded++;
    } catch (err) {
      result.skipped.push({ id: ev.id, reason: err.message });
    }
  }
  return result;
}

// Per-player last-5/last-10 averages + minutes trend for one team, from raw log rows
// ordered most-recent-first (deps.getTeamRows(team, limit) returns that order already --
// server.js's hook will pull `nba_player_logs?team=eq.<ABBR>&order=date.desc&limit=400`).
// Grouped client-side (same style as server.js's existing refreshCbbTeams()), not in SQL.
export function aggregateNbaPlayerForm(rowsMostRecentFirst) {
  const byPlayer = new Map();
  for (const r of rowsMostRecentFirst) {
    if (!byPlayer.has(r.player_id)) byPlayer.set(r.player_id, []);
    byPlayer.get(r.player_id).push(r);
  }
  const players = [];
  for (const [playerId, games] of byPlayer) {
    const minutes = games.map((g) => g.minutes);
    players.push({
      player_id: playerId,
      player_name: games[0].player_name,
      position: games[0].position,
      gamesTracked: games.length,
      last5: {
        minutes: avgLastN(minutes, 5),
        points: avgLastN(games.map((g) => g.points), 5),
        rebounds: avgLastN(games.map((g) => g.rebounds), 5),
        assists: avgLastN(games.map((g) => g.assists), 5),
        threePm: avgLastN(games.map((g) => g.three_pm), 5),
        steals: avgLastN(games.map((g) => g.steals), 5),
        blocks: avgLastN(games.map((g) => g.blocks), 5),
        turnovers: avgLastN(games.map((g) => g.turnovers), 5),
      },
      last10: {
        minutes: avgLastN(minutes, 10),
        points: avgLastN(games.map((g) => g.points), 10),
        rebounds: avgLastN(games.map((g) => g.rebounds), 10),
        assists: avgLastN(games.map((g) => g.assists), 10),
        threePm: avgLastN(games.map((g) => g.three_pm), 10),
        steals: avgLastN(games.map((g) => g.steals), 10),
        blocks: avgLastN(games.map((g) => g.blocks), 10),
        turnovers: avgLastN(games.map((g) => g.turnovers), 10),
      },
      minutesTrend: trendLast5VsPrior5(minutes),
    });
  }
  return players;
}
