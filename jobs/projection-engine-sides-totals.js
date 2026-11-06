// NBA + CBB sides/totals projection engine, v1 (2026-11-06+, Seb's request -- phase 1 of
// the analytics-only engine). Pure logic; server.js's hook supplies the real
// Supabase/ESPN-backed inputs (team ratings, schedule_context rows, DK lines).
//
// v1 approximations, flagged on purpose rather than hidden:
//  - NBA team "offensive/defensive rating" here is just average points scored/allowed per
//    game, NOT pace-adjusted efficiency (points per 100 possessions) -- nba_player_logs
//    doesn't carry team-level FGA/TOV totals yet, only per-player box lines, so there's no
//    possessions estimate to normalize by. CBB uses cbbTeams' existing marchProfile
//    offRtg/defRtg, which IS pace-adjusted (and already labeled "approximate" there).
//    Mixing a non-pace-adjusted NBA number with a pace-adjusted CBB number is fine since
//    they're never compared to each other, only within their own league.
//  - Margin/total -> win/cover/over probability assumes a normal distribution with a fixed
//    league-typical standard deviation (NBA ~12 pts, CBB ~11 pts), not a per-matchup
//    variance estimate. Good enough for a v1 edge signal, not a finished research model.
import { avgLastN } from "./util.js";
import { probOverFromNormal, devigTwoWayFromAmerican } from "./probability.js";

export const LEAGUE_MARGIN_STDDEV = { NBA: 12, CBB: 11 };

// Groups raw nba_player_logs rows (one row per player per game) into one row per
// (game_id, team) with the team's total points for that game. Needed because
// nba_player_logs has no team-level score column -- only per-player lines.
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

// Core margin/total projection. offDef inputs are { avgPointsScored, avgPointsAllowed }
// (NBA) or { offRtg, defRtg } treated the same way for CBB (both are "points this team
// produces/allows on an average night" on their own league's scale). `homeCourtEdge` is in
// total points (split evenly between the two expected scores).
export function projectGameMargin({ homeOffDef, awayOffDef, homeCourtEdge = 2.5, restAdjHome = 0, restAdjAway = 0 }) {
  const homeOff = homeOffDef.avgPointsScored ?? homeOffDef.offRtg;
  const homeDef = homeOffDef.avgPointsAllowed ?? homeOffDef.defRtg;
  const awayOff = awayOffDef.avgPointsScored ?? awayOffDef.offRtg;
  const awayDef = awayOffDef.avgPointsAllowed ?? awayOffDef.defRtg;
  if ([homeOff, homeDef, awayOff, awayDef].some((v) => v == null)) {
    return { projectedHomeScore: null, projectedAwayScore: null, projectedMargin: null, projectedTotal: null };
  }
  const projectedHomeScore = (homeOff + awayDef) / 2 + homeCourtEdge / 2 + restAdjHome;
  const projectedAwayScore = (awayOff + homeDef) / 2 - homeCourtEdge / 2 + restAdjAway;
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
export function buildSidesTotalsProjection({ league, homeTeam, awayTeam, date, homeOffDef, awayOffDef, homeScheduleCtx, awayScheduleCtx, dk = {} }) {
  const stdDev = LEAGUE_MARGIN_STDDEV[league] ?? 12;
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
