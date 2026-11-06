// NBA + CBB sides/totals projection engine (2026-11-06+, Seb's request -- phase 1/1.1 of
// the analytics-only engine). Pure logic; server.js's hook supplies the real
// Supabase/ESPN-backed inputs (team ratings, schedule_context rows, DK lines).
//
// 2026-11-06 upgrade (phase 1.1) over the original v1:
//  - NBA now uses TRUE pace-adjusted efficiency: nbaTeams' offRtg/defRtg (points per 100
//    possessions, Dean-Oliver estimate from refreshNbaTeams()) blended with expected pace
//    ((homePace+awayPace)/2), not raw points-per-game. This is the `paced` branch below.
//  - CBB still has NO possessions estimate anywhere in this codebase -- refreshCbbTeams()
//    tracks ptsFor/ptsAgainst/shooting splits/marchProfile but never persists FGA/OREB/TOV
//    attempts needed for a Dean-Oliver-style possessions estimate. Inventing a league-wide
//    assumed pace to fake a per-100 number would be LESS honest than what v1 already did,
//    not more -- so CBB deliberately stays on the non-paced points-average branch below.
//    ptsFor/ptsAgainst ARE each team's own realized scoring average this season, which
//    already reflects their actual offense/defense quality; marchProfile's defense-allowed
//    splits are highly correlated with ptsAgainst (same underlying games), so blending them
//    in would mostly double-count rather than add real signal. Flagged here, not hidden.
//  - Per-matchup variance: NBA and CBB both now derive a per-matchup stdDev from each
//    team's own recent game-to-game scoring-margin volatility (via
//    teamMarginStdDev/combinedMatchupStdDev below) instead of a single fixed league number.
//    Falls back to the fixed league constant (NBA 12, CBB 11) when either team has fewer
//    than MIN_GAMES_FOR_VARIANCE games of history -- a small sample's stdDev is noise, not
//    signal.
import { avgLastN } from "./util.js";
import { probOverFromNormal, devigTwoWayFromAmerican } from "./probability.js";

export const LEAGUE_MARGIN_STDDEV = { NBA: 12, CBB: 11 };
const MIN_GAMES_FOR_VARIANCE = 5;
// Per-matchup stdDev is clamped to a sane band around the league constant so a tiny,
// noisy sample (5-9 games) can't blow the variance estimate out to something silly.
const STDDEV_CLAMP = { NBA: [8, 18], CBB: [7, 16] };

// Groups raw nba_player_logs rows (one row per player per game) into one row per
// (game_id, team) with the team's total points for that game. Needed because
// nba_player_logs has no team-level score column -- only per-player lines. Also used
// (via the wiring layer) as the source for per-matchup variance -- see teamMarginStdDev.
export function buildNbaTeamGameTotals(playerLogRows) {
  const byGameTeam = new Map();
  for (const r of playerLogRows) {
    const key = `${r.game_id}|${r.team}`;
    if (!byGameTeam.has(key)) {
      byGameTeam.set(key, { game_id: r.game_id, team: r.team, opponent: r.opponent, home_away: r.home_away, date: r.date, points: 0 });
    }
    byGameTeam.get(key).points += r.points || 0;
  }
  return [...byGameTeam.values()];
}

// Average points scored/allowed over a team's trailing `n` games, from
// buildNbaTeamGameTotals' output. Points allowed is looked up as the opponent's own total
// for the same game_id (not stored on the team's own row).
export function nbaTeamOffDefRating(teamGameTotals, team, n = 10) {
  const opponentPointsByGame = new Map(teamGameTotals.map((g) => [`${g.game_id}|${g.team}`, g.points]));
  const teamGames = teamGameTotals
    .filter((g) => g.team === team)
    .sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0)); // most recent first
  const recent = teamGames.slice(0, n);
  const scored = recent.map((g) => g.points);
  const allowed = recent.map((g) => opponentPointsByGame.get(`${g.game_id}|${g.opponent}`) ?? null);
  return {
    team,
    gamesUsed: recent.length,
    avgPointsScored: avgLastN(scored, scored.length),
    avgPointsAllowed: avgLastN(allowed.filter((v) => v != null), allowed.length),
  };
}

// Sample stdDev of a team's own (points scored - points allowed) margin over its trailing
// `n` games. Generic over both leagues: `teamGameTotals` is NBA's buildNbaTeamGameTotals
// output ({ game_id, team, opponent, points }) OR CBB's buildCbbTeamGameMargins output
// ({ game_id, team, opponent, margin }) -- whichever shape is passed, this only reads
// `.margin` if present, else derives it from points via the opponent lookup (NBA shape).
export function teamMarginStdDev(teamGameTotals, team, n = 10) {
  const hasMarginField = teamGameTotals.some((g) => g.margin != null);
  let margins;
  if (hasMarginField) {
    margins = teamGameTotals
      .filter((g) => g.team === team)
      .sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0))
      .slice(0, n)
      .map((g) => g.margin);
  } else {
    const pointsByGameTeam = new Map(teamGameTotals.map((g) => [`${g.game_id}|${g.team}`, g.points]));
    margins = teamGameTotals
      .filter((g) => g.team === team)
      .sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0))
      .slice(0, n)
      .map((g) => {
        const opp = pointsByGameTeam.get(`${g.game_id}|${g.opponent}`);
        return opp != null ? g.points - opp : null;
      });
  }
  margins = margins.filter((v) => v != null);
  if (margins.length < MIN_GAMES_FOR_VARIANCE) return { stdDev: null, gamesUsed: margins.length };
  const mean = margins.reduce((a, b) => a + b, 0) / margins.length;
  const variance = margins.reduce((s, v) => s + (v - mean) ** 2, 0) / (margins.length - 1);
  return { stdDev: Number(Math.sqrt(variance).toFixed(1)), gamesUsed: margins.length };
}

// Groups cbb_game_logs rows (one row per game, both teams' scores already on it) into one
// row per (game_id, team) with that team's own scoring margin for the game -- the CBB
// analog of buildNbaTeamGameTotals, used only for teamMarginStdDev (CBB has no per-player
// logs to sum, so there's no separate "off/def rating" builder needed here).
export function buildCbbTeamGameMargins(gameLogRows) {
  const rows = [];
  for (const g of gameLogRows) {
    if (g.home_score == null || g.away_score == null) continue;
    rows.push({ game_id: `${g.date}|${g.home_team}|${g.away_team}`, team: g.home_team, opponent: g.away_team, date: g.date, margin: g.home_score - g.away_score });
    rows.push({ game_id: `${g.date}|${g.home_team}|${g.away_team}`, team: g.away_team, opponent: g.home_team, date: g.date, margin: g.away_score - g.home_score });
  }
  return rows;
}

// Blends both teams' own margin volatility into one per-matchup stdDev (variance of a
// difference of two independent variables = sum of variances), clamped to a sane band and
// falling back to the league constant when either side lacks enough games.
export function combinedMatchupStdDev(league, homeStdDevInfo, awayStdDevInfo) {
  const fallback = LEAGUE_MARGIN_STDDEV[league] ?? 12;
  if (homeStdDevInfo?.stdDev == null || awayStdDevInfo?.stdDev == null) return fallback;
  const combined = Math.sqrt(homeStdDevInfo.stdDev ** 2 + awayStdDevInfo.stdDev ** 2) / Math.SQRT2;
  const [lo, hi] = STDDEV_CLAMP[league] ?? [8, 18];
  return Number(Math.min(hi, Math.max(lo, combined)).toFixed(1));
}

// Point adjustment from a schedule_context row: back-to-back and a long road trip cost a
// little, extra rest helps a little. Deliberately small, additive, and easy to retune once
// the backtest has data -- not meant to be the last word on rest effects.
export function restAdjustmentPoints(scheduleContextRow) {
  if (!scheduleContextRow) return 0;
  let adj = 0;
  if (scheduleContextRow.back_to_back) adj -= 1.5;
  if (scheduleContextRow.days_of_rest != null && scheduleContextRow.days_of_rest >= 2) adj += 0.5;
  if ((scheduleContextRow.road_trip_length || 0) >= 3) adj -= 1;
  return adj;
}

// Core margin/total projection. Two input shapes for offDef, used for two genuinely
// different models (see file header):
//  - NBA (paced branch): { offRtg, defRtg, pace } -- true per-100-possession ratings blended
//    with expected pace (average of both teams' own pace).
//  - CBB / fallback (points branch): { avgPointsScored, avgPointsAllowed } -- raw per-game
//    scoring averages, same as v1. Also used for NBA if pace/offRtg/defRtg aren't supplied
//    (e.g. early season, team doc not yet refreshed).
// `homeCourtEdge` is in total points (split evenly between the two expected scores).
export function projectGameMargin({ homeOffDef, awayOffDef, homeCourtEdge = 2.5, restAdjHome = 0, restAdjAway = 0 }) {
  const paced =
    homeOffDef.pace != null && awayOffDef.pace != null &&
    homeOffDef.offRtg != null && homeOffDef.defRtg != null &&
    awayOffDef.offRtg != null && awayOffDef.defRtg != null;

  let projectedHomeScore, projectedAwayScore;
  if (paced) {
    const expectedPace = (homeOffDef.pace + awayOffDef.pace) / 2;
    const homePer100 = (homeOffDef.offRtg + awayOffDef.defRtg) / 2;
    const awayPer100 = (awayOffDef.offRtg + homeOffDef.defRtg) / 2;
    projectedHomeScore = (homePer100 / 100) * expectedPace + homeCourtEdge / 2 + restAdjHome;
    projectedAwayScore = (awayPer100 / 100) * expectedPace - homeCourtEdge / 2 + restAdjAway;
  } else {
    const homeOff = homeOffDef.avgPointsScored ?? homeOffDef.offRtg;
    const homeDef = homeOffDef.avgPointsAllowed ?? homeOffDef.defRtg;
    const awayOff = awayOffDef.avgPointsScored ?? awayOffDef.offRtg;
    const awayDef = awayOffDef.avgPointsAllowed ?? awayOffDef.defRtg;
    if ([homeOff, homeDef, awayOff, awayDef].some((v) => v == null)) {
      return { projectedHomeScore: null, projectedAwayScore: null, projectedMargin: null, projectedTotal: null };
    }
    projectedHomeScore = (homeOff + awayDef) / 2 + homeCourtEdge / 2 + restAdjHome;
    projectedAwayScore = (awayOff + homeDef) / 2 - homeCourtEdge / 2 + restAdjAway;
  }
  if (projectedHomeScore == null || projectedAwayScore == null || Number.isNaN(projectedHomeScore) || Number.isNaN(projectedAwayScore)) {
    return { projectedHomeScore: null, projectedAwayScore: null, projectedMargin: null, projectedTotal: null };
  }
  return {
    projectedHomeScore: Number(projectedHomeScore.toFixed(1)),
    projectedAwayScore: Number(projectedAwayScore.toFixed(1)),
    projectedMargin: Number((projectedHomeScore - projectedAwayScore).toFixed(1)), // positive = home favored
    projectedTotal: Number((projectedHomeScore + projectedAwayScore).toFixed(1)),
  };
}

// Home-side moneyline/spread win probability from the projected margin. `dkHomeSpread` is
// HOME-signed (ESPN/DK convention: negative = home favored by that many points), matching
// jobs/closing-lines.js's extractClosingLineFromSummary.
export function homeWinProb(projectedMargin, stdDev) {
  if (projectedMargin == null) return null;
  return probOverFromNormal(0, projectedMargin, stdDev);
}
export function homeCoverProb(projectedMargin, dkHomeSpread, stdDev) {
  if (projectedMargin == null || dkHomeSpread == null) return null;
  return probOverFromNormal(-dkHomeSpread, projectedMargin, stdDev);
}
export function totalOverProb(projectedTotal, dkTotalLine, stdDev) {
  if (projectedTotal == null || dkTotalLine == null) return null;
  return probOverFromNormal(dkTotalLine, projectedTotal, stdDev);
}

// Full per-game projection: margin/total + edge vs DK's devigged implied probability for
// moneyline, spread, and total, in the shape the nba_projections/cbb_projections tables
// expect. Any DK price omitted from `dk` simply leaves that market's edge fields null
// instead of throwing -- a game with only a total posted still gets scored on the total.
// `stdDevOverride`, when supplied by the wiring layer (see combinedMatchupStdDev), replaces
// the fixed LEAGUE_MARGIN_STDDEV default with a per-matchup estimate.
export function buildSidesTotalsProjection({ league, homeTeam, awayTeam, date, homeOffDef, awayOffDef, homeScheduleCtx, awayScheduleCtx, dk = {}, stdDevOverride = null }) {
  const stdDev = stdDevOverride ?? LEAGUE_MARGIN_STDDEV[league] ?? 12;
  const restAdjHome = restAdjustmentPoints(homeScheduleCtx);
  const restAdjAway = restAdjustmentPoints(awayScheduleCtx);
  const proj = projectGameMargin({ homeOffDef, awayOffDef, restAdjHome, restAdjAway });

  const row = {
    league,
    home_team: homeTeam,
    away_team: awayTeam,
    date,
    projected_margin: proj.projectedMargin,
    projected_total: proj.projectedTotal,
    margin_stddev_used: stdDev,
    dk_spread: dk.homeSpread ?? null,
    dk_total: dk.total ?? null,
    dk_ml_home: dk.mlHome ?? null,
    dk_ml_away: dk.mlAway ?? null,
    model_prob_home_ml: null,
    edge_home_ml: null,
    model_prob_home_spread: null,
    edge_home_spread: null,
    model_prob_total_over: null,
    edge_total_over: null,
    created_at: new Date().toISOString(),
  };
  if (proj.projectedMargin == null) return row;

  if (dk.mlHome != null && dk.mlAway != null) {
    const [impliedHome] = devigTwoWayFromAmerican(dk.mlHome, dk.mlAway);
    row.model_prob_home_ml = Number(homeWinProb(proj.projectedMargin, stdDev).toFixed(3));
    if (impliedHome != null) row.edge_home_ml = Number((row.model_prob_home_ml - impliedHome).toFixed(3));
  }
  if (dk.homeSpread != null && dk.spreadPriceHome != null && dk.spreadPriceAway != null) {
    const [impliedHomeCover] = devigTwoWayFromAmerican(dk.spreadPriceHome, dk.spreadPriceAway);
    row.model_prob_home_spread = Number(homeCoverProb(proj.projectedMargin, dk.homeSpread, stdDev).toFixed(3));
    if (impliedHomeCover != null) row.edge_home_spread = Number((row.model_prob_home_spread - impliedHomeCover).toFixed(3));
  }
  if (dk.total != null && dk.totalOverPrice != null && dk.totalUnderPrice != null) {
    const [impliedOver] = devigTwoWayFromAmerican(dk.totalOverPrice, dk.totalUnderPrice);
    row.model_prob_total_over = Number(totalOverProb(proj.projectedTotal, dk.total, stdDev).toFixed(3));
    if (impliedOver != null) row.edge_total_over = Number((row.model_prob_total_over - impliedOver).toFixed(3));
  }
  return row;
}
