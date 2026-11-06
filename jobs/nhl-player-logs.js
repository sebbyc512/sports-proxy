// Item 3 of the 2026-11-06 daily-data batch: NHL player game logs (skaters only -- goalie
// GSAx is covered separately by item 8/MoneyPuck once that's fixed). Pure extraction/
// aggregation here; server.js's hook supplies real getJson/upsert so this stays unit-
// testable without network/Supabase. Mirrors jobs/nba-player-logs.js's shape.
import { seasonForDate, yyyymmddToIso, avgLastN, trendLast5VsPrior5 } from "./util.js";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";

// NHL hockey seasons run Oct-Jun -- same "which calendar year does this date's season
// start in" question as seasonForDate() answers for basketball, so it's reused unchanged
// (both use an Aug cutover, well clear of either sport's actual season boundary).

// Pulls every skater's box-score line out of one ESPN game summary's boxscore.players
// array (one block per team: { team: {abbreviation}, statistics: [{name, keys, athletes}]
// } -- the "skaters" group covers the full roster without double-counting forwards+
// defensemen, which ESPN also lists as separate groups).
export function extractNhlPlayerLogs(boxscorePlayers, awayAbbr, homeAbbr) {
  const rows = [];
  for (const teamBlock of boxscorePlayers || []) {
    const abbr = teamBlock.team?.abbreviation;
    if (!abbr) continue;
    const opponent = abbr === awayAbbr ? homeAbbr : abbr === homeAbbr ? awayAbbr : null;
    const homeAway = abbr === homeAbbr ? "home" : abbr === awayAbbr ? "away" : null;
    const skaters = (teamBlock.statistics || []).find((s) => s.name === "skaters");
    if (!skaters) continue;
    const keys = skaters.keys || [];
    const idxOf = (k) => keys.indexOf(k);
    const toiIdx = idxOf("timeOnIce");
    const goalsIdx = idxOf("goals");
    const assistsIdx = idxOf("assists");
    const shotsIdx = idxOf("shotsTotal");
    const hitsIdx = idxOf("hits");
    const blockedIdx = idxOf("blockedShots");
    const giveawaysIdx = idxOf("giveaways");
    const takeawaysIdx = idxOf("takeaways");

    for (const a of skaters.athletes || []) {
      if (!a.athlete?.id) continue;
      const s = a.stats || [];
      const goals = goalsIdx >= 0 ? Number(s[goalsIdx]) || 0 : 0;
      const assists = assistsIdx >= 0 ? Number(s[assistsIdx]) || 0 : 0;
      rows.push({
        team: abbr,
        opponent,
        home_away: homeAway,
        player_id: String(a.athlete.id),
        player_name: a.athlete.displayName || null,
        position: a.athlete.position?.abbreviation || null,
        toi_seconds: toiIdx >= 0 ? toiToSeconds(s[toiIdx]) : null,
        goals,
        assists,
        points: goals + assists,
        shots: shotsIdx >= 0 ? Number(s[shotsIdx]) || 0 : 0,
        hits: hitsIdx >= 0 ? Number(s[hitsIdx]) || 0 : 0,
        blocked_shots: blockedIdx >= 0 ? Number(s[blockedIdx]) || 0 : 0,
        giveaways: giveawaysIdx >= 0 ? Number(s[giveawaysIdx]) || 0 : 0,
        takeaways: takeawaysIdx >= 0 ? Number(s[takeawaysIdx]) || 0 : 0,
      });
    }
  }
  return rows;
}

// "14:32" -> 872. Returns null for anything unparseable (e.g. a missing/blank value).
function toiToSeconds(v) {
  const m = /^(\d+):(\d{2})$/.exec(v || "");
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function buildNhlPlayerLogRows(gameId, yyyymmdd, boxscorePlayers, awayAbbr, homeAbbr) {
  const dateIso = yyyymmddToIso(yyyymmdd);
  const season = seasonForDate(yyyymmdd);
  const extracted = extractNhlPlayerLogs(boxscorePlayers, awayAbbr, homeAbbr);
  return extracted.map((r) => ({ game_id: String(gameId), date: dateIso, season, ...r }));
}

export async function trackNhlPlayerLogsForDate(yyyymmdd, deps) {
  const result = { date: yyyymmdd, gamesFound: 0, gamesRecorded: 0, skipped: [] };
  let scoreboard;
  try {
    scoreboard = await deps.getJson(`${ESPN_BASE}/hockey/nhl/scoreboard?dates=${yyyymmdd}`);
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
      if (!away?.team?.abbreviation || !home?.team?.abbreviation) {
        result.skipped.push({ id: ev.id, reason: "missing competitors" });
        continue;
      }
      const awayAbbr = away.team.abbreviation;
      const homeAbbr = home.team.abbreviation;
      const summary = await deps.getJson(`${ESPN_BASE}/hockey/nhl/summary?event=${ev.id}`);
      const rows = buildNhlPlayerLogRows(ev.id, yyyymmdd, summary.boxscore?.players, awayAbbr, homeAbbr);
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

// Per-player last-5/last-10 averages + a TOI trend, mirrors aggregateNbaPlayerForm().
export function aggregateNhlPlayerForm(rowsMostRecentFirst) {
  const byPlayer = new Map();
  for (const r of rowsMostRecentFirst) {
    if (!byPlayer.has(r.player_id)) byPlayer.set(r.player_id, []);
    byPlayer.get(r.player_id).push(r);
  }
  const players = [];
  for (const [playerId, games] of byPlayer) {
    const toi = games.map((g) => g.toi_seconds);
    players.push({
      player_id: playerId,
      player_name: games[0].player_name,
      position: games[0].position,
      gamesTracked: games.length,
      last5: {
        toiSeconds: avgLastN(toi, 5),
        goals: avgLastN(games.map((g) => g.goals), 5),
        assists: avgLastN(games.map((g) => g.assists), 5),
        points: avgLastN(games.map((g) => g.points), 5),
        shots: avgLastN(games.map((g) => g.shots), 5),
      },
      last10: {
        toiSeconds: avgLastN(toi, 10),
        goals: avgLastN(games.map((g) => g.goals), 10),
        assists: avgLastN(games.map((g) => g.assists), 10),
        points: avgLastN(games.map((g) => g.points), 10),
        shots: avgLastN(games.map((g) => g.shots), 10),
      },
      toiTrend: trendLast5VsPrior5(toi),
    });
  }
  return players;
}
