// Point-in-time WALK-FORWARD backtest for NBA player props (2026-11-06+, Seb's explicit
// request, same discipline as jobs/walkforward-backtest.js for sides/totals): a prop graded
// for a game on date D may only use that player's own nba_player_logs rows, and his
// opponent's roster rows (for defense-vs-position), from STRICTLY BEFORE date D. Enforced
// here via date filtering, not trusted from the caller -- buildPointInTimeInputs' own
// no-leakage property is unit-tested directly.
//
// Grading uses the real nba_prop_historical_lines (pulled separately, real DK prices) and
// the real actual result from nba_player_logs (the player's real box-score stat for that
// game -- not simulated). Edge is a PROBABILITY edge (model prob over vs DK's devigged
// implied prob), in probability points (pp) -- a different unit than the sides/totals
// walk-forward's point-edge buckets, called out explicitly in summarizePropsBacktest.
import { projectPlayerStat, propEdgeVsDk } from "./projection-engine-props.js";

const LEAGUE_AVG_AT_POSITION_DEFAULT = { points: 11, rebounds: 5, assists: 2.5 };

// `allPlayerLogsForPlayer`/`allLogsForOpponentTeam`: every nba_player_logs row available for
// that player / that opposing team, in ANY order, not pre-filtered -- this function filters
// to date < asOfDateIso itself so a caller bug (e.g. accidentally including the target game
// or later games) can never leak into the projection. This is the exact property the
// "no leakage" test below checks: feeding extra on/after-date rows must not change the result.
export function buildPointInTimeInputs(allPlayerLogsForPlayer, allLogsForOpponentTeam, asOfDateIso) {
  const priorPlayerRows = (allPlayerLogsForPlayer || [])
    .filter((r) => r.date < asOfDateIso)
    .sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0)); // most-recent-first
  const priorOpponentRows = (allLogsForOpponentTeam || []).filter((r) => r.date < asOfDateIso);
  return { priorPlayerRows, priorOpponentRows };
}

// Grades one (player, game, market): projects from point-in-time inputs only, computes the
// probability edge vs the real pulled DK line, grades against the real actual stat.
export function gradeWalkForwardProp({
  statKey,
  priorPlayerRows,
  position,
  priorOpponentRows,
  scheduleContextRow,
  leagueAvgAtPosition = LEAGUE_AVG_AT_POSITION_DEFAULT[statKey],
  blowoutRiskMultiplier = 1,
  injuryAdjustmentMultiplier = 1,
  dkLine,
  dkOverPrice,
  dkUnderPrice,
  actualResult,
}) {
  const projectionResult = projectPlayerStat({
    statKey, playerRowsMostRecentFirst: priorPlayerRows, position,
    opponentTeamRowsMostRecentFirst: priorOpponentRows, leagueAvgAtPosition,
    scheduleContextRow, blowoutRiskMultiplier, injuryAdjustmentMultiplier,
  });
  const edge = propEdgeVsDk({ projection: projectionResult.projection, stdDev: projectionResult.stdDev, dkLine, dkOverPrice, dkUnderPrice });
  const out = {
    market: statKey, projection: projectionResult.projection, modelProbOver: edge.modelProbOver,
    edgeOver: edge.edgeOver, edgeUnder: edge.edgeUnder,
    pick: null, hit: null, roiUnits: null, edgeAbsPp: null, actualResult: actualResult ?? null,
  };
  if (actualResult == null || dkLine == null || edge.modelProbOver == null || edge.edgeOver == null) return out;

  out.pick = edge.edgeOver >= edge.edgeUnder ? "over" : "under";
  const actualOver = actualResult > dkLine;
  const push = actualResult === dkLine;
  if (push) return out; // no hit/miss on a push, same convention as the sides/totals module
  out.hit = out.pick === "over" ? actualOver : !actualOver;
  const price = out.pick === "over" ? dkOverPrice : dkUnderPrice;
  if (price == null) return out;
  out.roiUnits = out.hit ? (price > 0 ? price / 100 : 100 / Math.abs(price)) : -1;
  out.edgeAbsPp = Number((Math.abs(out.pick === "over" ? edge.edgeOver : edge.edgeUnder) * 100).toFixed(1));
  return out;
}

function pct(hits, total) { return total ? Number(((hits / total) * 100).toFixed(1)) : null; }
function roiPct(units, bets) { return bets ? Number(((units / bets) * 100).toFixed(1)) : null; }

// Aggregates graded rows into hit%/ROI overall, by probability-edge bucket (>=5/10/15pp --
// NOTE: probability points, not the sides/totals module's point-margin buckets, a different
// unit, called out here on purpose so the two backtests are never compared apples-to-apples
// by accident), and by stat market (points/rebounds/assists).
export function summarizePropsBacktest(rows) {
  const gradable = rows.filter((r) => r.hit != null);
  const buckets = [0, 5, 10, 15];
  const byBucket = {};
  for (const minPp of buckets) {
    const key = minPp === 0 ? "all" : `edgeGte${minPp}pp`;
    const bRows = gradable.filter((r) => minPp === 0 || (r.edgeAbsPp ?? 0) >= minPp);
    byBucket[key] = { n: bRows.length, hitPct: pct(bRows.filter((r) => r.hit).length, bRows.length), roiPct: roiPct(bRows.reduce((s, r) => s + (r.roiUnits ?? 0), 0), bRows.length) };
  }
  const byMarket = {};
  for (const market of ["points", "rebounds", "assists"]) {
    const mRows = gradable.filter((r) => r.market === market);
    byMarket[market] = { n: mRows.length, hitPct: pct(mRows.filter((r) => r.hit).length, mRows.length), roiPct: roiPct(mRows.reduce((s, r) => s + (r.roiUnits ?? 0), 0), mRows.length) };
  }
  return { propsTotal: rows.length, gradable: gradable.length, byEdgeBucket: byBucket, byMarket };
}
