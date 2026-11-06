// Item 8 of the 2026-11-06 daily-data batch: MoneyPuck NHL data (Seb's explicit ask,
// 2026-11-06). ONLY these four files, listed on https://moneypuck.com/data.htm -- never
// scrape anything else on the site, per Seb's rule. One download per file per night.
// Credit "MoneyPuck.com" wherever this data is shown (free for non-commercial use).
import { unzipEntries } from "./zip.js";
import { parseCsv } from "./csv.js";

export const MONEYPUCK_SEASON = "2026"; // 2026-2027 NHL season, matches the files' own naming
export const MONEYPUCK_FILES = {
  teamsAllSeasons: "https://moneypuck.com/moneypuck/playerData/careers/gameByGame/all_teams.csv",
  skaters: `https://peter-tanner.com/moneypuck/downloads/seasonPlayersSummary/skaters/${MONEYPUCK_SEASON}.zip`,
  goalies: `https://peter-tanner.com/moneypuck/downloads/seasonPlayersSummary/goalies/${MONEYPUCK_SEASON}.zip`,
  shots: `https://peter-tanner.com/moneypuck/downloads/shots_${MONEYPUCK_SEASON}.zip`,
};

function num(v) {
  if (v === "" || v == null) return null; // Number("") is 0, not NaN -- would silently become a real 0
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Rows for the teams file: one row per (team, game, situation) -- "all" situation is the
// full-game total, which is what we want for a nightly team xGF/xGA/high-danger snapshot.
// xGA for a team isn't its own column (every column in this file is "...For"); it's the
// OPPOSING team's xGoalsFor in the same game, so this needs the full game's two rows
// together -- hence `teamRows` is grouped by gameId first.
export function buildMoneypuckTeamRows(teamsCsvRows, season) {
  const bySeason = teamsCsvRows.filter((r) => r.season === season && r.situation === "all" && r.position === "Team Level");
  const byGame = new Map();
  for (const r of bySeason) {
    if (!byGame.has(r.gameId)) byGame.set(r.gameId, []);
    byGame.get(r.gameId).push(r);
  }
  const rows = [];
  for (const [gameId, pair] of byGame) {
    for (const r of pair) {
      const opp = pair.find((o) => o !== r);
      rows.push({
        game_id: gameId,
        date: ymdToIso(r.gameDate),
        season,
        team: r.team,
        opponent: r.opposingTeam,
        home_away: (r.home_or_away || "").toLowerCase(),
        xgf: num(r.xGoalsFor),
        xga: opp ? num(opp.xGoalsFor) : null,
        high_danger_shots_for: num(r.highDangerShotsFor),
        high_danger_shots_against: opp ? num(opp.highDangerShotsFor) : null,
        shots_for: num(r.shotsOnGoalFor),
        goals_for: num(r.goalsFor),
      });
    }
  }
  return rows;
}

export function buildMoneypuckGoalieRows(goalieCsvRows, season) {
  return goalieCsvRows
    .filter((r) => r.season === season && r.situation === "all")
    .map((r) => ({
      game_id: r.gameId,
      date: ymdToIso(r.gameDate),
      season,
      team: r.playerTeam,
      opponent: r.opposingTeam,
      home_away: (r.home_or_away || "").toLowerCase(),
      player_id: r.playerId,
      player_name: r.name,
      icetime: num(r.icetime),
      x_goals_against: num(r.xGoals),
      goals_against: num(r.goals),
      gsax: num(r.xGoals) != null && num(r.goals) != null ? Number((num(r.xGoals) - num(r.goals)).toFixed(3)) : null,
      high_danger_shots_faced: num(r.highDangerShots),
      high_danger_goals_allowed: num(r.highDangerGoals),
    }));
}

export function buildMoneypuckSkaterRows(skaterCsvRows, season) {
  return skaterCsvRows
    .filter((r) => r.season === season && r.situation === "all")
    .map((r) => ({
      game_id: r.gameId,
      date: ymdToIso(r.gameDate),
      season,
      team: r.playerTeam,
      opponent: r.opposingTeam,
      home_away: (r.home_or_away || "").toLowerCase(),
      player_id: r.playerId,
      player_name: r.name,
      position: r.position,
      icetime: num(r.icetime),
      xg: num(r.I_F_xGoals),
      goals: num(r.I_F_goals),
      shots_on_goal: num(r.I_F_shotsOnGoal),
      shot_attempts: num(r.I_F_shotAttempts),
    }));
}

// Shot data has 124 columns -- this keeps only what a builder plausibly needs (location,
// shooter, shot type, xGoal, whether it went in/on net), not every on-ice-time-on-ice
// column MoneyPuck tracks for its own model internals.
export function buildMoneypuckShotRows(shotCsvRows, season) {
  return shotCsvRows
    .filter((r) => r.season === season)
    .map((r) => ({
      shot_id: r.shotID,
      game_id: r.game_id,
      season,
      event: r.event,
      period: num(r.period),
      time: num(r.time),
      team: r.isHomeTeam === "1" || r.isHomeTeam === "true" ? r.homeTeamCode : r.awayTeamCode,
      shooter_player_id: r.shooterPlayerId,
      shooter_name: r.shooterName,
      shot_type: r.shotType,
      x_cord: num(r.xCord),
      y_cord: num(r.yCord),
      distance: num(r.arenaAdjustedShotDistance),
      x_goal: num(r.xGoal),
      goal: r.goal === "1" || r.goal === "true",
      on_goal: r.shotWasOnGoal === "1" || r.shotWasOnGoal === "true",
    }));
}

function ymdToIso(ymd) {
  const s = String(ymd);
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}

// Full run: downloads the four files (deps.fetchBinary(url) -> Buffer), unzips/parses
// them, filters to the current season, and hands each entity type's rows to
// deps.upsertRows(entityType, rows). One file per entity type stays independent -- a
// failure on one (e.g. shots_2026.zip) shouldn't block the other three from writing.
export async function runMoneypuckJob(deps) {
  const result = { season: MONEYPUCK_SEASON, teams: 0, goalies: 0, skaters: 0, shots: 0, errors: [] };

  async function downloadCsv(url, { isZip }) {
    const buf = await deps.fetchBinary(url);
    const text = isZip ? unzipEntries(buf)[0].data.toString("utf8") : buf.toString("utf8");
    return parseCsv(text);
  }

  try {
    const teamsCsv = await downloadCsv(MONEYPUCK_FILES.teamsAllSeasons, { isZip: false });
    const rows = buildMoneypuckTeamRows(teamsCsv, MONEYPUCK_SEASON);
    if (rows.length) await deps.upsertRows("team", rows);
    result.teams = rows.length;
  } catch (err) {
    result.errors.push({ file: "teams", error: err.message });
  }

  try {
    const goalieCsv = await downloadCsv(MONEYPUCK_FILES.goalies, { isZip: true });
    const rows = buildMoneypuckGoalieRows(goalieCsv, MONEYPUCK_SEASON);
    if (rows.length) await deps.upsertRows("goalie", rows);
    result.goalies = rows.length;
  } catch (err) {
    result.errors.push({ file: "goalies", error: err.message });
  }

  try {
    const skaterCsv = await downloadCsv(MONEYPUCK_FILES.skaters, { isZip: true });
    const rows = buildMoneypuckSkaterRows(skaterCsv, MONEYPUCK_SEASON);
    if (rows.length) await deps.upsertRows("skater", rows);
    result.skaters = rows.length;
  } catch (err) {
    result.errors.push({ file: "skaters", error: err.message });
  }

  try {
    const shotCsv = await downloadCsv(MONEYPUCK_FILES.shots, { isZip: true });
    const rows = buildMoneypuckShotRows(shotCsv, MONEYPUCK_SEASON);
    if (rows.length) await deps.upsertRows("shot", rows);
    result.shots = rows.length;
  } catch (err) {
    result.errors.push({ file: "shots", error: err.message });
  }

  return result;
}
