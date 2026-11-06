// Item 2 of the 2026-11-06 daily-data batch: rest & schedule context for NBA, NHL, CBB.
// Pure computation here (restMetricsForTeam); server.js's hook supplies the real
// getJson/ESPN scoreboard pulls and the upsert into the "schedule_context" docs collection.
import { haversineMiles, yyyymmddToIso } from "./util.js";
import { NBA_ARENAS, NHL_ARENAS } from "./arenas.js";

function daysBetweenIso(a, b) {
  const da = new Date(`${a}T00:00:00Z`);
  const db = new Date(`${b}T00:00:00Z`);
  return Math.round((db - da) / 86400000);
}

// `games`: one team's games, ascending by date, each { date: "YYYY-MM-DD", homeAway:
// "home"|"away", opponent, venueLat, venueLon }. `idx` is the index of the game to compute
// rest/travel metrics FOR (its own date is the target date -- "today or tomorrow").
// venueLat/lon may be null (CBB -- no arena table); travelMiles is then null too.
export function restMetricsForTeam(games, idx) {
  const target = games[idx];
  const prev = games[idx - 1];
  if (!prev) {
    return {
      daysOfRest: null,
      backToBack: false,
      threeInFour: false,
      roadTripLength: target.homeAway === "away" ? 1 : 0,
      travelMiles: null,
    };
  }
  const gap = daysBetweenIso(prev.date, target.date);
  const daysOfRest = gap - 1; // 0 = played the immediately preceding day (back-to-back)
  const backToBack = daysOfRest === 0;

  const windowStartIso = (() => {
    const d = new Date(`${target.date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 3);
    return d.toISOString().slice(0, 10);
  })();
  const gamesInWindow = games.slice(0, idx + 1).filter((g) => g.date >= windowStartIso && g.date <= target.date).length;
  const threeInFour = gamesInWindow >= 3;

  let roadTripLength = 0;
  if (target.homeAway === "away") {
    for (let i = idx; i >= 0 && games[i].homeAway === "away"; i--) roadTripLength++;
  }

  const travelMiles =
    prev.venueLat != null && target.venueLat != null
      ? haversineMiles(prev.venueLat, prev.venueLon, target.venueLat, target.venueLon)
      : null;

  return { daysOfRest, backToBack, threeInFour, roadTripLength, travelMiles };
}

// Builds the ascending game list for one team from a flat list of league games (each {
// date, homeTeam, awayTeam, isTarget? }), tagging venue coordinates from the arena table
// for the HOME team of each game (away team travels to the home team's arena). `isTarget`
// (whether this game is one of the "today or tomorrow" games we need a row for) carries
// through unchanged onto each output entry.
export function buildTeamGameList(leagueGames, team, arenaTable) {
  return leagueGames
    .filter((g) => g.homeTeam === team || g.awayTeam === team)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((g) => {
      const homeAway = g.homeTeam === team ? "home" : "away";
      const opponent = g.homeTeam === team ? g.awayTeam : g.homeTeam;
      const arena = arenaTable?.[g.homeTeam];
      return {
        date: g.date,
        homeAway,
        opponent,
        venueLat: arena?.lat ?? null,
        venueLon: arena?.lon ?? null,
        isTarget: !!g.isTarget,
      };
    });
}

// Full per-league run: `leagueGames` covers a trailing window (recent history) PLUS
// today/tomorrow, each tagged `isTarget: true` if it's one of today/tomorrow's games;
// `targetTeams` is the set of teams playing today or tomorrow (the only ones we need a row
// for). Returns one row per (team, target game date) -- a team playing both today AND
// tomorrow gets two rows.
export function buildScheduleContextRows(league, leagueGames, targetTeams, arenaTable) {
  const rows = [];
  for (const team of targetTeams) {
    const games = buildTeamGameList(leagueGames, team, arenaTable);
    for (let i = 0; i < games.length; i++) {
      if (!games[i].isTarget) continue;
      const metrics = restMetricsForTeam(games, i);
      rows.push({ league, team, date: games[i].date, opponent: games[i].opponent, home_away: games[i].homeAway, ...metrics });
    }
  }
  return rows;
}

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";
const LEAGUE_PATHS = {
  NBA: "basketball/nba",
  NHL: "hockey/nhl",
  CBB: "basketball/mens-college-basketball",
};
const ARENA_TABLES = { NBA: NBA_ARENAS, NHL: NHL_ARENAS, CBB: null };

function extractGamesFromScoreboard(scoreboard, dateIso) {
  const out = [];
  for (const ev of scoreboard.events || []) {
    const comp = ev.competitions?.[0];
    const away = comp?.competitors?.find((c) => c.homeAway === "away");
    const home = comp?.competitors?.find((c) => c.homeAway === "home");
    if (!away?.team?.abbreviation || !home?.team?.abbreviation) continue;
    out.push({ date: dateIso, homeTeam: home.team.abbreviation, awayTeam: away.team.abbreviation });
  }
  return out;
}

// Pulls a trailing-10-day history window plus today+tomorrow for one league, builds every
// target team's schedule_context row, and hands them to deps.upsertRows(). `deps.getJson`
// is injected for testability; `deps.datesToFetch(todayYmd)` lets tests control the exact
// date list instead of depending on wall-clock "today".
export async function buildScheduleContextForLeague(league, todayYmd, deps) {
  const path = LEAGUE_PATHS[league];
  if (!path) throw new Error(`unknown league ${league}`);
  const arenaTable = ARENA_TABLES[league];

  const dates = deps.datesToFetch(todayYmd); // ascending YYYYMMDD strings, last two are today/tomorrow
  const todayIso = yyyymmddToIso(todayYmd);
  const tomorrowYmd = dates[dates.length - 1];
  const tomorrowIso = yyyymmddToIso(tomorrowYmd);

  const leagueGames = [];
  const targetTeams = new Set();
  for (const ymd of dates) {
    const dateIso = yyyymmddToIso(ymd);
    let scoreboard;
    try {
      scoreboard = await deps.getJson(`${ESPN_BASE}/${path}/scoreboard?dates=${ymd}`);
    } catch {
      continue; // one bad date shouldn't kill the whole league's run
    }
    const games = extractGamesFromScoreboard(scoreboard, dateIso);
    const isTarget = dateIso === todayIso || dateIso === tomorrowIso;
    for (const g of games) {
      leagueGames.push({ ...g, isTarget });
      if (isTarget) {
        targetTeams.add(g.homeTeam);
        targetTeams.add(g.awayTeam);
      }
    }
  }

  const rows = buildScheduleContextRows(league, leagueGames, targetTeams, arenaTable);
  if (rows.length) await deps.upsertRows(rows);
  return { league, teamsFound: targetTeams.size, rowsWritten: rows.length };
}
