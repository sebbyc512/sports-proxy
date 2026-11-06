// Point-in-time WALK-FORWARD backtest (2026-11-06+, Seb's explicit request after flagging
// look-ahead bias in the first backtest -- that one computed team ratings from the WHOLE
// season and applied them retroactively to earlier games in that same season, which is
// circular, not predictive).
//
// The discipline here is non-negotiable: a game on date D may only use each team's rating
// built from games that team played STRICTLY BEFORE D. buildPointInTimeRating() enforces
// this itself (filters by date, doesn't trust the caller to have pre-filtered), so even a
// caller bug that passes future games can't leak them into the rating.
//
// Simplification, stated plainly: both leagues use the points-average rating shape
// ({avgPointsScored, avgPointsAllowed}), NOT NBA's pace-adjusted offRtg/defRtg branch in
// jobs/projection-engine-sides-totals.js -- nbaTeams' offRtg/defRtg/pace are maintained only
// for the CURRENT season and aren't available historically, and reconstructing a real
// per-100-possessions estimate for 2025-26 would need pace/possessions data this project
// doesn't have. Scores (for ptsFor/ptsAgainst) and pickcenter closing lines (spread/total/ML)
// are both available historically from ESPN -- confirmed live, see this module's caller
// script's header comment -- so that part of the pipeline is real, not reconstructed.
//
// Grading uses POINT edges (projected margin/total vs the closing line, in points), not a
// priced probability edge: ESPN's pickcenter gives moneyline prices (both sides) but not
// spread/total juice, so spread/total ROI below assumes standard -110/-110 (a stated
// simplification); ML ROI uses the real historical moneyline price.

const MIN_GAMES_FOR_RATING = 3;

// `games`: array of {date (ISO yyyy-mm-dd string), ptsFor, ptsAgainst} for ONE team, in any
// order, not required to be pre-filtered. `asOfDateIso`: the date of the game being
// projected. Only games with date < asOfDateIso are used -- enforced here, not by the
// caller, so this function's own "no leakage" property can be unit-tested directly: feeding
// it extra games on/after asOfDateIso must never change the result for a fixed asOfDateIso.
export function buildPointInTimeRating(games, asOfDateIso, n = 10) {
  const prior = (games || [])
    .filter((g) => g.date < asOfDateIso)
    .sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0)) // most recent first
    .slice(0, n);
  if (prior.length < MIN_GAMES_FOR_RATING) {
    return { avgPointsScored: null, avgPointsAllowed: null, gamesUsed: prior.length };
  }
  const scored = prior.map((g) => g.ptsFor).filter((v) => v != null);
  const allowed = prior.map((g) => g.ptsAgainst).filter((v) => v != null);
  const avg = (arr) => (arr.length ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)) : null);
  return { avgPointsScored: avg(scored), avgPointsAllowed: avg(allowed), gamesUsed: prior.length };
}

// Rolling per-team game list, capped to `cap` most-recent entries so memory stays bounded
// across a long walk-forward run (the orchestration script only ever needs the trailing
// window a rating uses, never full season history in memory at once).
export function appendTeamGame(rollingGames, team, entry, cap = 15) {
  const list = rollingGames.get(team) || [];
  list.push(entry);
  if (list.length > cap) list.shift();
  rollingGames.set(team, list);
  return rollingGames;
}

// Grades one game: model's point edge vs the closing line (spread/total, in points) and
// ML pick vs the real historical moneyline price. `closingHomeSpread` is home-signed
// (negative = home favored), matching jobs/closing-lines.js's extractClosingLineFromSummary.
export function gradeWalkForwardGame({
  projectedMargin,
  projectedTotal,
  closingHomeSpread,
  closingTotal,
  closingHomeMl,
  closingAwayMl,
  actualHomeScore,
  actualAwayScore,
}) {
  const out = {
    atsHit: null, edgeSpreadPts: null, roiSpreadUnits: null,
    totalHit: null, edgeTotalPts: null, roiTotalUnits: null,
    mlHit: null, mlPick: null, roiMlUnits: null,
  };
  if (actualHomeScore == null || actualAwayScore == null) return out;
  const actualMargin = actualHomeScore - actualAwayScore; // positive = home won by this much
  const actualTotal = actualHomeScore + actualAwayScore;

  if (projectedMargin != null && closingHomeSpread != null) {
    const modelFavorsHomeCover = projectedMargin > -closingHomeSpread;
    const homeCovered = actualMargin > -closingHomeSpread;
    const push = actualMargin === -closingHomeSpread;
    out.edgeSpreadPts = Number(Math.abs(projectedMargin - -closingHomeSpread).toFixed(1));
    out.atsHit = push ? null : modelFavorsHomeCover === homeCovered;
    if (out.atsHit != null) out.roiSpreadUnits = out.atsHit ? 100 / 110 : -1; // flat -110 both sides
  }
  if (projectedTotal != null && closingTotal != null) {
    const modelOver = projectedTotal > closingTotal;
    const actualOver = actualTotal > closingTotal;
    const push = actualTotal === closingTotal;
    out.edgeTotalPts = Number(Math.abs(projectedTotal - closingTotal).toFixed(1));
    out.totalHit = push ? null : modelOver === actualOver;
    if (out.totalHit != null) out.roiTotalUnits = out.totalHit ? 100 / 110 : -1;
  }
  if (projectedMargin != null && closingHomeMl != null && closingAwayMl != null) {
    out.mlPick = projectedMargin > 0 ? "home" : "away";
    const homeWon = actualMargin > 0;
    out.mlHit = out.mlPick === "home" ? homeWon : !homeWon;
    const price = out.mlPick === "home" ? closingHomeMl : closingAwayMl;
    if (out.mlHit) out.roiMlUnits = price > 0 ? price / 100 : 100 / Math.abs(price);
    else out.roiMlUnits = -1;
  }
  return out;
}

function pct(hits, total) {
  return total ? Number(((hits / total) * 100).toFixed(1)) : null;
}
function roiPct(units, bets) {
  return bets ? Number(((units / bets) * 100).toFixed(1)) : null;
}

// Aggregates graded rows (same shape gradeWalkForwardGame returns, plus whatever edge
// bucketing is needed) into the summary Seb asked for: overall ATS/totals/ML + ROI, and the
// same split by point-edge bucket (>=2/3/5 pts). Rows with a null hit (push, or that market
// wasn't gradable) are excluded from that market's denominator.
export function summarizeWalkForward(rows) {
  const buckets = [0, 2, 3, 5];
  const summary = { gamesTotal: rows.length, spread: {}, total: {}, ml: {} };

  const spreadRows = rows.filter((r) => r.atsHit != null);
  const totalRows = rows.filter((r) => r.totalHit != null);
  const mlRows = rows.filter((r) => r.mlHit != null);

  for (const minEdge of buckets) {
    const key = minEdge === 0 ? "all" : `edgeGte${minEdge}`;
    const sRows = spreadRows.filter((r) => minEdge === 0 || (r.edgeSpreadPts ?? 0) >= minEdge);
    const tRows = totalRows.filter((r) => minEdge === 0 || (r.edgeTotalPts ?? 0) >= minEdge);
    summary.spread[key] = {
      n: sRows.length,
      hitPct: pct(sRows.filter((r) => r.atsHit).length, sRows.length),
      roiPct: roiPct(sRows.reduce((s, r) => s + (r.roiSpreadUnits ?? 0), 0), sRows.length),
    };
    summary.total[key] = {
      n: tRows.length,
      hitPct: pct(tRows.filter((r) => r.totalHit).length, tRows.length),
      roiPct: roiPct(tRows.reduce((s, r) => s + (r.roiTotalUnits ?? 0), 0), tRows.length),
    };
  }
  summary.ml = {
    n: mlRows.length,
    hitPct: pct(mlRows.filter((r) => r.mlHit).length, mlRows.length),
    roiPct: roiPct(mlRows.reduce((s, r) => s + (r.roiMlUnits ?? 0), 0), mlRows.length),
  };
  return summary;
}
