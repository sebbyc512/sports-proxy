// Item 9 of the 2026-11-06 daily-data batch (Seb's explicit ask): nflverse NFL data.
// ONLY the published release files at github.com/nflverse/nflverse-data/releases
// (CC-BY-4.0, credit "nflverse"). Seb's priority: injuries, snap counts, and team EPA
// before Sunday's games -- those three are what this file builds. Schedules-with-lines,
// weekly player stats, and depth charts are deliberately NOT included here: depth_charts
// is a 68MB CSV (checked live, 2026-11-06) and downloading/parsing a file that size in one
// request risks exactly the OOM crash item 8 (MoneyPuck) caused -- that one needs a
// streaming approach before it's safe to add, so it's deferred rather than rushed.
import { parseCsv } from "./csv.js";

export const NFLVERSE_FILES = {
  injuries: "https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_2026.csv",
  snapCounts: "https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_2026.csv",
  teamStatsWeek: "https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_2026.csv",
};

function num(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function buildInjuryRows(csvRows) {
  return csvRows.map((r) => ({
    season: r.season,
    week: num(r.week),
    team: r.team,
    gsis_id: r.gsis_id,
    player_name: r.full_name,
    position: r.position,
    report_status: r.report_status || null,
    report_primary_injury: r.report_primary_injury || null,
    report_secondary_injury: r.report_secondary_injury || null,
    practice_status: r.practice_status || null,
  }));
}

export function buildSnapCountRows(csvRows) {
  return csvRows.map((r) => ({
    game_id: r.game_id,
    season: r.season,
    week: num(r.week),
    team: r.team,
    opponent: r.opponent,
    player_name: r.player,
    pfr_player_id: r.pfr_player_id,
    position: r.position,
    offense_snaps: num(r.offense_snaps),
    offense_pct: num(r.offense_pct),
    defense_snaps: num(r.defense_snaps),
    defense_pct: num(r.defense_pct),
    st_snaps: num(r.st_snaps),
    st_pct: num(r.st_pct),
  }));
}

// Team-level EPA/play per (season, week, team), offense from that team's own row and
// defense from the OPPONENT's offensive EPA in the same game_id (what a defense "allows"
// is what the other offense produced) -- same pairing idea as MoneyPuck's team xGA.
// Offense EPA/play = (passing_epa + rushing_epa) / (attempts + carries); receiving_epa is
// deliberately excluded -- it's the receiver's-eye view of the SAME pass plays
// passing_epa already counts, so adding it would double-count every completed pass.
export function buildTeamEpaRows(statsTeamWeekRows) {
  const byGame = new Map();
  for (const r of statsTeamWeekRows) {
    if (!byGame.has(r.game_id)) byGame.set(r.game_id, []);
    byGame.get(r.game_id).push(r);
  }
  const offenseByGameTeam = new Map(); // `${game_id}:${team}` -> { epaPerPlay, plays }
  for (const [gameId, rows] of byGame) {
    for (const r of rows) {
      const passEpa = num(r.passing_epa) || 0;
      const rushEpa = num(r.rushing_epa) || 0;
      const plays = (num(r.attempts) || 0) + (num(r.carries) || 0);
      const epaPerPlay = plays > 0 ? Number(((passEpa + rushEpa) / plays).toFixed(4)) : null;
      offenseByGameTeam.set(`${gameId}:${r.team}`, { epaPerPlay, plays });
    }
  }
  const out = [];
  for (const [gameId, rows] of byGame) {
    for (const r of rows) {
      const own = offenseByGameTeam.get(`${gameId}:${r.team}`);
      const opp = offenseByGameTeam.get(`${gameId}:${r.opponent_team}`);
      out.push({
        season: r.season,
        week: num(r.week),
        game_id: gameId,
        team: r.team,
        opponent: r.opponent_team,
        offense_epa_per_play: own?.epaPerPlay ?? null,
        offense_plays: own?.plays ?? null,
        defense_epa_per_play: opp?.epaPerPlay ?? null, // what the opponent's offense produced
        defense_plays: opp?.plays ?? null,
      });
    }
  }
  return out;
}

// Season-to-date and last-4-weeks averages per team, from buildTeamEpaRows' output
// (one row per team per week already built above). Mirrors the last-N averaging style
// used elsewhere in this batch (jobs/util.js's avgLastN), but keyed by week number rather
// than "most recent N games", since NFL teams play at most once a week.
export function aggregateTeamEpaForm(teamEpaRows) {
  const byTeam = new Map();
  for (const r of teamEpaRows) {
    if (!byTeam.has(r.team)) byTeam.set(r.team, []);
    byTeam.get(r.team).push(r);
  }
  const out = [];
  for (const [team, rows] of byTeam) {
    const sorted = [...rows].sort((a, b) => b.week - a.week); // most recent week first
    const avg = (vals) => {
      const clean = vals.filter((v) => v != null);
      return clean.length ? Number((clean.reduce((a, b) => a + b, 0) / clean.length).toFixed(4)) : null;
    };
    const last4 = sorted.slice(0, 4);
    out.push({
      team,
      weeksTracked: sorted.length,
      season: {
        offenseEpaPerPlay: avg(sorted.map((r) => r.offense_epa_per_play)),
        defenseEpaPerPlay: avg(sorted.map((r) => r.defense_epa_per_play)),
      },
      last4Weeks: {
        offenseEpaPerPlay: avg(last4.map((r) => r.offense_epa_per_play)),
        defenseEpaPerPlay: avg(last4.map((r) => r.defense_epa_per_play)),
      },
    });
  }
  return out;
}

// Full run: downloads the three files (deps.fetchText(url) -> string), parses, maps, and
// hands each entity type's rows to deps.upsertRows(entityType, rows). Each file stays
// independent -- one failing shouldn't block the other two.
export async function runNflverseJob(deps) {
  const result = { injuries: 0, snapCounts: 0, teamEpa: 0, errors: [] };

  try {
    const text = await deps.fetchText(NFLVERSE_FILES.injuries);
    const rows = buildInjuryRows(parseCsv(text));
    if (rows.length) await deps.upsertRows("injuries", rows);
    result.injuries = rows.length;
  } catch (err) {
    result.errors.push({ file: "injuries", error: err.message });
  }

  try {
    const text = await deps.fetchText(NFLVERSE_FILES.snapCounts);
    const rows = buildSnapCountRows(parseCsv(text));
    if (rows.length) await deps.upsertRows("snapCounts", rows);
    result.snapCounts = rows.length;
  } catch (err) {
    result.errors.push({ file: "snapCounts", error: err.message });
  }

  try {
    const text = await deps.fetchText(NFLVERSE_FILES.teamStatsWeek);
    const rows = buildTeamEpaRows(parseCsv(text));
    if (rows.length) await deps.upsertRows("teamEpa", rows);
    result.teamEpa = rows.length;
  } catch (err) {
    result.errors.push({ file: "teamEpa", error: err.message });
  }

  return result;
}
