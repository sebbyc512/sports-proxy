import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNbaTeamGameTotals,
  nbaTeamOffDefRating,
  restAdjustmentPoints,
  projectGameMargin,
  homeWinProb,
  homeCoverProb,
  totalOverProb,
  buildSidesTotalsProjection,
} from "./projection-engine-sides-totals.js";

test("buildNbaTeamGameTotals: sums player points into one row per (game, team)", () => {
  const rows = [
    { game_id: "1", team: "BOS", opponent: "LAL", home_away: "home", date: "2026-11-01", points: 20 },
    { game_id: "1", team: "BOS", opponent: "LAL", home_away: "home", date: "2026-11-01", points: 15 },
    { game_id: "1", team: "LAL", opponent: "BOS", home_away: "away", date: "2026-11-01", points: 30 },
  ];
  const totals = buildNbaTeamGameTotals(rows);
  assert.equal(totals.length, 2);
  assert.equal(totals.find((t) => t.team === "BOS").points, 35);
  assert.equal(totals.find((t) => t.team === "LAL").points, 30);
});

test("nbaTeamOffDefRating: averages scored/allowed over trailing n games, most-recent-first", () => {
  const totals = [
    { game_id: "1", team: "BOS", opponent: "LAL", date: "2026-11-01", points: 110 },
    { game_id: "1", team: "LAL", opponent: "BOS", date: "2026-11-01", points: 100 },
    { game_id: "2", team: "BOS", opponent: "MIA", date: "2026-11-03", points: 120 },
    { game_id: "2", team: "MIA", opponent: "BOS", date: "2026-11-03", points: 95 },
  ];
  const rating = nbaTeamOffDefRating(totals, "BOS", 10);
  assert.equal(rating.gamesUsed, 2);
  assert.equal(rating.avgPointsScored, 115); // (110+120)/2
  assert.equal(rating.avgPointsAllowed, 97.5); // (100+95)/2
});

test("restAdjustmentPoints: back-to-back costs points, rest and a long road trip apply too", () => {
  assert.equal(restAdjustmentPoints(null), 0);
  assert.equal(restAdjustmentPoints({ back_to_back: true }), -1.5);
  assert.equal(restAdjustmentPoints({ days_of_rest: 3 }), 0.5);
  assert.equal(restAdjustmentPoints({ back_to_back: true, road_trip_length: 4 }), -2.5);
});

test("projectGameMargin: evenly-matched teams at a neutral site project to a pick'em-ish margin plus home court", () => {
  const proj = projectGameMargin({
    homeOffDef: { avgPointsScored: 112, avgPointsAllowed: 108 },
    awayOffDef: { avgPointsScored: 112, avgPointsAllowed: 108 },
  });
  assert.ok(proj.projectedMargin > 0); // home court edge should favor the home team
  // home/away scores and the total are each rounded independently, so allow a 0.1 slack
  assert.ok(Math.abs(proj.projectedTotal - (proj.projectedHomeScore + proj.projectedAwayScore)) <= 0.1);
});

test("projectGameMargin: missing inputs return nulls instead of NaN", () => {
  const proj = projectGameMargin({ homeOffDef: { avgPointsScored: null }, awayOffDef: { avgPointsScored: 110, avgPointsAllowed: 105 } });
  assert.equal(proj.projectedMargin, null);
});

test("homeWinProb/homeCoverProb/totalOverProb: sane monotonic behavior", () => {
  assert.ok(Math.abs(homeWinProb(0, 12) - 0.5) < 1e-6);
  assert.ok(homeWinProb(10, 12) > 0.5);
  assert.ok(homeCoverProb(5, -3, 11) > 0.5); // favored by more than the spread demands
  assert.ok(totalOverProb(230, 220, 11) > 0.5);
});

test("buildSidesTotalsProjection: full happy path produces edges for ML, spread, and total", () => {
  const row = buildSidesTotalsProjection({
    league: "NBA",
    homeTeam: "BOS",
    awayTeam: "LAL",
    date: "2026-11-06",
    homeOffDef: { avgPointsScored: 118, avgPointsAllowed: 108 },
    awayOffDef: { avgPointsScored: 110, avgPointsAllowed: 112 },
    homeScheduleCtx: { days_of_rest: 2 },
    awayScheduleCtx: { back_to_back: true },
    dk: { homeSpread: -3, total: 224.5, mlHome: -150, mlAway: 130, spreadPriceHome: -110, spreadPriceAway: -110, totalOverPrice: -110, totalUnderPrice: -110 },
  });
  assert.ok(row.projected_margin > 0);
  assert.ok(row.model_prob_home_ml != null);
  assert.ok(row.model_prob_home_spread != null);
  assert.ok(row.model_prob_total_over != null);
  assert.ok(typeof row.edge_home_ml === "number");
});

test("buildSidesTotalsProjection: a DK market that's entirely missing leaves that market's fields null, doesn't throw", () => {
  const row = buildSidesTotalsProjection({
    league: "CBB",
    homeTeam: "DUKE",
    awayTeam: "UNC",
    date: "2026-11-06",
    homeOffDef: { offRtg: 112, defRtg: 95 },
    awayOffDef: { offRtg: 108, defRtg: 98 },
    dk: { total: 150.5, totalOverPrice: -110, totalUnderPrice: -110 }, // no spread/ML posted
  });
  assert.equal(row.model_prob_home_ml, null);
  assert.ok(row.model_prob_total_over != null);
});
