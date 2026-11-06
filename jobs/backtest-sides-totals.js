// Backtest harness for the sides/totals projection engine (2026-11-06+, Seb's request --
// phase 2 of the analytics-only engine). Pure join/aggregation logic; server.js's hook
// supplies the real Supabase reads for nba_projections/cbb_projections,
// nba_closing_lines/cbb_closing_lines, and final scores.
//
// IMPORTANT: this is a harness, not a result. It only produces a meaningful report once
// jobs/closing-lines.js and the projection engine have actually been run and backfilled for
// a real date range -- there is no fabricated/sample backtest data anywhere in this repo.
// Don't report numbers from this to Seb until it's been run against real rows.
import { americanToImpliedProb } from "./probability.js";

// Joins one league's stored projections against closing lines and final scores, all keyed
// by (date, home_team, away_team) since game_id formats can differ between the projection
// write path and the closing-line write path. `finalScores`: [{ date, home_team, away_team,
// home_score, away_score }]. Rows with no matching closing line AND no matching final score
// are dropped (nothing to grade); rows missing just one of the two keep whatever matched.
export function joinProjectionsWithOutcomes(projections, closingLines, finalScores) {
  const key = (r) => `${r.date}|${r.home_team}|${r.away_team}`;
  const closingByKey = new Map(closingLines.map((r) => [key(r), r]));
  const scoreByKey = new Map(finalScores.map((r) => [key(r), r]));
  const joined = [];
  for (const p of projections) {
    const closing = closingByKey.get(key(p));
    const score = scoreByKey.get(key(p));
    if (!closing && !score) continue;
    joined.push({
      ...p,
      closing_home_spread: closing?.home_spread ?? null,
      closing_total: closing?.total ?? null,
      closing_home_moneyline: closing?.home_moneyline ?? null,
      closing_away_moneyline: closing?.away_moneyline ?? null,
      actual_home_score: score?.home_score ?? null,
      actual_away_score: score?.away_score ?? null,
      actual_margin: score ? score.home_score - score.away_score : null,
      actual_total: score ? score.home_score + score.away_score : null,
    });
  }
  return joined;
}

// Calibration check: among games the model gave a projected home-win probability in each
// decile bucket, what fraction of home teams actually won? A well-calibrated model's
// buckets should track their own label (the 60-70% bucket should see home teams win
// roughly 60-70% of the time). Only rows with both a model probability and a known
// actual_margin are counted.
export function calibrationBuckets(joined, nBuckets = 10) {
  const buckets = Array.from({ length: nBuckets }, (_, i) => ({
    rangeLow: i / nBuckets,
    rangeHigh: (i + 1) / nBuckets,
    games: 0,
    homeWins: 0,
  }));
  for (const row of joined) {
    if (row.model_prob_home_ml == null || row.actual_margin == null) continue;
    const idx = Math.min(nBuckets - 1, Math.floor(row.model_prob_home_ml * nBuckets));
    buckets[idx].games++;
    if (row.actual_margin > 0) buckets[idx].homeWins++;
  }
  return buckets.map((b) => ({ ...b, actualWinRate: b.games ? Number((b.homeWins / b.games).toFixed(3)) : null }));
}

// If every game where the model showed a positive edge on a given market had been bet 1
// unit at the CLOSING price for that market (the price actually available at tip-off, not
// whatever price the model saw earlier), what would the ROI have been? `market` is one of
// "ml" | "spread" | "total". This is a simple flat-stake sanity check, not a staking-plan
// recommendation.
export function simpleRoiIfAlwaysBetEdgeSide(joined, market, { stakeUnits = 1 } = {}) {
  let staked = 0;
  let returned = 0;
  let betsPlaced = 0;
  for (const row of joined) {
    if (row.actual_margin == null && row.actual_total == null) continue;

    let edge, modelProbSide, price, won;
    if (market === "ml") {
      edge = row.edge_home_ml;
      if (edge == null || row.closing_home_moneyline == null || row.closing_away_moneyline == null) continue;
      const betHome = edge > 0;
      price = betHome ? row.closing_home_moneyline : row.closing_away_moneyline;
      won = betHome ? row.actual_margin > 0 : row.actual_margin < 0;
      edge = Math.abs(edge);
    } else if (market === "spread") {
      edge = row.edge_home_spread;
      if (edge == null || row.closing_home_spread == null || row.actual_margin == null) continue;
      const betHome = edge > 0;
      price = -110; // spread prices at closing aren't captured per-side; assume standard vig
      won = betHome ? row.actual_margin + row.closing_home_spread > 0 : row.actual_margin + row.closing_home_spread < 0;
      edge = Math.abs(edge);
    } else if (market === "total") {
      edge = row.edge_total_over;
      if (edge == null || row.closing_total == null || row.actual_total == null) continue;
      const betOver = edge > 0;
      price = -110;
      won = betOver ? row.actual_total > row.closing_total : row.actual_total < row.closing_total;
      edge = Math.abs(edge);
    } else {
      throw new Error(`unknown market ${market}`);
    }
    if (edge <= 0) continue; // no edge -> no bet in this simple harness

    betsPlaced++;
    staked += stakeUnits;
    if (won) {
      const impliedWinProb = americanToImpliedProb(price);
      const payoutMultiple = impliedWinProb > 0 ? 1 / impliedWinProb - 1 : 0; // decimal profit per unit, from the American price
      returned += stakeUnits * (1 + payoutMultiple);
    }
  }
  return {
    market,
    betsPlaced,
    unitsStaked: staked,
    unitsReturned: Number(returned.toFixed(2)),
    roi: staked ? Number(((returned - staked) / staked).toFixed(4)) : null,
  };
}
