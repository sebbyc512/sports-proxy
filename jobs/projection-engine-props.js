// NBA player-prop projection engine, v1 shadow mode (2026-11-06+, Seb's request -- phase 1
// of the analytics-only engine). Pure logic; server.js's hook supplies the real
// nba_player_logs rows, schedule_context rows, DK prop lines, and injury context.
//
// v1 approximations, flagged on purpose:
//  - "Opponent defense vs position" is derived here from nba_player_logs itself (what a
//    team has allowed to players at a given position recently), not from a dedicated
//    defense-vs-position dataset -- there isn't one yet. It's a reasonable first cut, not a
//    finished research model.
//  - No real minutes-redistribution model for injuries. `injuryAdjustmentMultiplier` is a
//    single number the caller passes in (e.g. from reading ESPN's injury report and judging
//    "teammate X is out, bump this player ~10%") -- this module doesn't build or call an
//    injury pipeline itself, it just has a hook for one.
//  - Variance for the over/under probability uses a flat per-market stdDev estimated from
//    the player's own last-10 game-to-game standard deviation, which only works once a
//    player has enough games tracked; falls back to a league-typical default otherwise.
import { avgLastN, trendLast5VsPrior5 } from "./util.js";
import { probOverFromNormal, devigTwoWayFromAmerican } from "./probability.js";

export const STAT_KEYS = ["points", "rebounds", "assists"];
const LEAGUE_TYPICAL_STDDEV = { points: 6, rebounds: 2.5, assists: 2 };

function sampleStdDev(values) {
  const clean = values.filter((v) => v != null && !Number.isNaN(v));
  if (clean.length < 3) return null;
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const variance = clean.reduce((a, b) => a + (b - mean) ** 2, 0) / (clean.length - 1);
  return Math.sqrt(variance);
}

// Weighted blend of last-5 / last-10 / season averages for one stat, from a player's raw
// game rows ordered most-recent-first. Falls back gracefully as fewer games are tracked
// (e.g. a rookie with 4 games just gets a season-only number).
export function weightedStatProjection(rowsMostRecentFirst, statKey, weights = { last5: 0.5, last10: 0.3, season: 0.2 }) {
  const values = rowsMostRecentFirst.map((r) => r[statKey]);
  const last5 = avgLastN(values, 5);
  const last10 = avgLastN(values, 10);
  const season = avgLastN(values, values.length);
  const parts = [];
  if (last5 != null) parts.push([last5, weights.last5]);
  if (last10 != null) parts.push([last10, weights.last10]);
  if (season != null) parts.push([season, weights.season]);
  if (!parts.length) return null;
  const totalW = parts.reduce((s, [, w]) => s + w, 0);
  return Number((parts.reduce((s, [v, w]) => s + v * w, 0) / totalW).toFixed(2));
}

// From a team's own nba_player_logs rows (all players, all games, most-recent-first across
// the whole team), what has this team allowed at a given position over the trailing n
// games? Simple average of opposing-position points conceded per game -- a first cut, not
// a possession-normalized defensive model.
export function opponentAllowedAtPosition(opponentTeamRowsMostRecentFirst, position, statKey, n = 10) {
  const byGame = new Map();
  for (const r of opponentTeamRowsMostRecentFirst) {
    if (r.position !== position) continue;
    if (!byGame.has(r.game_id)) byGame.set(r.game_id, { game_id: r.game_id, date: r.date, total: 0 });
    byGame.get(r.game_id).total += r[statKey] || 0;
  }
  const games = [...byGame.values()].sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0)).slice(0, n);
  return avgLastN(games.map((g) => g.total), games.length);
}

// Multiplier from a league-average-at-position baseline: an opponent allowing above average
// at this position bumps the projection up, below average pulls it down. Capped to +/-15%
// so one small-sample outlier game can't blow the projection up.
export function opponentDefenseMultiplier(opponentAllowed, leagueAvgAtPosition) {
  if (opponentAllowed == null || !leagueAvgAtPosition) return 1;
  const raw = opponentAllowed / leagueAvgAtPosition;
  return Math.max(0.85, Math.min(1.15, raw));
}

// Small rest/b2b multiplier, same spirit as the sides/totals engine's restAdjustmentPoints
// but multiplicative (props are rate stats, not a fixed-point margin).
export function restMultiplier(scheduleContextRow) {
  if (!scheduleContextRow) return 1;
  let m = 1;
  if (scheduleContextRow.back_to_back) m -= 0.04;
  if ((scheduleContextRow.road_trip_length || 0) >= 3) m -= 0.02;
  return m;
}

// Minutes-trend multiplier: a player trending up in minutes recently gets a small bump
// proportional to the trend relative to their own last-10 minutes baseline (capped).
export function minutesTrendMultiplier(minutesTrend, last10Minutes) {
  if (minutesTrend == null || !last10Minutes) return 1;
  const raw = 1 + minutesTrend / last10Minutes;
  return Math.max(0.85, Math.min(1.15, raw));
}

// Composes one player/game/stat projection. `playerRowsMostRecentFirst` is that player's
// own raw nba_player_logs rows; `opponentTeamRowsMostRecentFirst` is the opposing team's
// full roster rows (for the defense-vs-position lookup); `leagueAvgAtPosition` and
// `blowoutRiskMultiplier`/`injuryAdjustmentMultiplier` are passed in by the caller (no
// hidden network calls in this module).
export function projectPlayerStat({
  statKey,
  playerRowsMostRecentFirst,
  position,
  opponentTeamRowsMostRecentFirst,
  leagueAvgAtPosition,
  scheduleContextRow,
  blowoutRiskMultiplier = 1,
  injuryAdjustmentMultiplier = 1,
}) {
  const base = weightedStatProjection(playerRowsMostRecentFirst, statKey);
  if (base == null) return { projection: null, stdDev: null };

  const minutesValues = playerRowsMostRecentFirst.map((r) => r.minutes);
  const minutesTrend = trendLast5VsPrior5(minutesValues);
  const last10Minutes = avgLastN(minutesValues, 10);

  const oppAllowed = opponentAllowedAtPosition(opponentTeamRowsMostRecentFirst, position, statKey);
  const defMult = opponentDefenseMultiplier(oppAllowed, leagueAvgAtPosition);
  const restMult = restMultiplier(scheduleContextRow);
  const trendMult = minutesTrendMultiplier(minutesTrend, last10Minutes);

  const projection = Number((base * defMult * restMult * trendMult * blowoutRiskMultiplier * injuryAdjustmentMultiplier).toFixed(2));
  const statValues = playerRowsMostRecentFirst.slice(0, 10).map((r) => r[statKey]);
  const stdDev = sampleStdDev(statValues) ?? LEAGUE_TYPICAL_STDDEV[statKey] ?? 5;
  return { projection, stdDev, inputs: { base, defMult, restMult, trendMult, minutesTrend } };
}

// Given a projection + stdDev and a DK prop line/prices, compute model probability of the
// over and the edge vs DK's devigged implied probability. Same devig pattern as the
// sides/totals engine.
export function propEdgeVsDk({ projection, stdDev, dkLine, dkOverPrice, dkUnderPrice }) {
  if (projection == null || dkLine == null) return { modelProbOver: null, edgeOver: null, edgeUnder: null };
  const modelProbOver = Number(probOverFromNormal(dkLine, projection, stdDev).toFixed(3));
  if (dkOverPrice == null || dkUnderPrice == null) return { modelProbOver, edgeOver: null, edgeUnder: null };
  const [impliedOver, impliedUnder] = devigTwoWayFromAmerican(dkOverPrice, dkUnderPrice);
  if (impliedOver == null) return { modelProbOver, edgeOver: null, edgeUnder: null };
  return {
    modelProbOver,
    edgeOver: Number((modelProbOver - impliedOver).toFixed(3)),
    edgeUnder: Number((1 - modelProbOver - impliedUnder).toFixed(3)),
  };
}

// Full row for the nba_prop_shadow_log table, log-only -- nothing in this module calls a
// live odds endpoint; server.js's route wiring does that and passes the result in as `dk`.
export function buildPropShadowRow({ date, player, playerId, team, opponent, market, projectionResult, dk = {} }) {
  const edge = propEdgeVsDk({ projection: projectionResult.projection, stdDev: projectionResult.stdDev, dkLine: dk.line, dkOverPrice: dk.overPrice, dkUnderPrice: dk.underPrice });
  return {
    date,
    player,
    player_id: playerId,
    team,
    opponent,
    market,
    model_projection: projectionResult.projection,
    model_prob_over: edge.modelProbOver,
    dk_line: dk.line ?? null,
    dk_over_price: dk.overPrice ?? null,
    dk_under_price: dk.underPrice ?? null,
    edge_over: edge.edgeOver,
    edge_under: edge.edgeUnder,
    actual_result: null,
    graded: false,
    created_at: new Date().toISOString(),
  };
}
