import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNbaTeamGameTotals,
  nbaTeamOffDefRating,
  teamMarginStdDev,
  buildCbbTeamGameMargins,
  combinedMatchupStdDev,
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

test("projectGameMargin: NBA paced branch uses pace-adjusted per-100 ratings, not raw points", () => {
  // Same offRtg/defRtg for both teams but a much faster pace than the non-paced branch
  // would ever see -- if pace is genuinely driving the score, the total should be well
  // above a typical ~220 NBA total.
  const proj = projectGameMargin({
    homeOffDef: { offRtg: 115, defRtg: 110, pace: 105 },
    awayOffDef: { offRtg: 112, defRtg: 108, pace: 105 },
  });
  assert.ok(proj.projectedTotal > 220);
  assert.ok(proj.projectedMargin > 0); // home has the better net rating + home court
});

test("projectGameMargin: falls back to the points branch when pace is missing, even if offRtg/defRtg are present", () => {
  const proj = projectGameMargin({
    homeOffDef: { offRtg: 115, defRtg: 110 }, // no pace -> treated as points-branch inputs via the ?? fallback
    awayOffDef: { avgPointsScored: 112, avgPointsAllowed: 108 },
  });
  assert.ok(proj.projectedMargin != null);
  // Points branch treats offRtg/defRtg values as if they were raw points when pace is absent --
  // home (115/110) vs away (112/108) should still favor home slightly plus home court.
  assert.ok(proj.projectedMargin > 0);
});

test("teamMarginStdDev: needs at least 5 games, else returns null stdDev", () => {
  const totals = [
    { game_id: "1", team: "BOS", opponent: "LAL", date: "2026-11-01", points: 110 },
    { game_id: "1", team: "LAL", opponent: "BOS", date: "2026-11-01", points: 100 },
  ];
  const r = teamMarginStdDev(totals, "BOS", 10);
  assert.equal(r.stdDev, null);
  assert.equal(r.gamesUsed, 1);
});

test("teamMarginStdDev: computes sample stdDev of a team's own scoring margin over recent games", () => {
  const dates = ["2026-10-20", "2026-10-22", "2026-10-24", "2026-10-26", "2026-10-28"];
  const margins = [10, -5, 20, 0, 15]; // BOS margin each game
  const totals = [];
  dates.forEach((date, i) => {
    totals.push({ game_id: String(i), team: "BOS", opponent: "OPP", date, points: 110 + margins[i] });
    totals.push({ game_id: String(i), team: "OPP", opponent: "BOS", date, points: 110 });
  });
  const r = teamMarginStdDev(totals, "BOS", 10);
  assert.equal(r.gamesUsed, 5);
  assert.ok(r.stdDev > 0);
});

test("buildCbbTeamGameMargins: splits each game log row into both teams' own margins", () => {
  const rows = [{ date: "2026-11-01", home_team: "DUKE", away_team: "UNC", home_score: 80, away_score: 70 }];
  const margins = buildCbbTeamGameMargins(rows);
  assert.equal(margins.length, 2);
  assert.equal(margins.find((m) => m.team === "DUKE").margin, 10);
  assert.equal(margins.find((m) => m.team === "UNC").margin, -10);
});

test("combinedMatchupStdDev: falls back to the league constant when either side lacks enough games", () => {
  assert.equal(combinedMatchupStdDev("NBA", { stdDev: null, gamesUsed: 2 }, { stdDev: 10, gamesUsed: 10 }), 12);
});

test("combinedMatchupStdDev: blends both teams' volatility and clamps to the sane band", () => {
  const v = combinedMatchupStdDev("NBA", { stdDev: 20, gamesUsed: 10 }, { stdDev: 20, gamesUsed: 10 });
  assert.ok(v <= 18 && v >= 8);
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
