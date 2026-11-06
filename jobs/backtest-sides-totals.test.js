import test from "node:test";
import assert from "node:assert/strict";
import { joinProjectionsWithOutcomes, calibrationBuckets, simpleRoiIfAlwaysBetEdgeSide } from "./backtest-sides-totals.js";

const projections = [
  {
    date: "2026-11-06", home_team: "BOS", away_team: "LAL",
    model_prob_home_ml: 0.65, edge_home_ml: 0.08,
    model_prob_home_spread: 0.55, edge_home_spread: 0.04,
    model_prob_total_over: 0.58, edge_total_over: 0.03,
  },
  {
    date: "2026-11-06", home_team: "GSW", away_team: "MIA",
    model_prob_home_ml: 0.40, edge_home_ml: -0.05,
    model_prob_home_spread: null, edge_home_spread: null,
    model_prob_total_over: 0.45, edge_total_over: -0.02,
  },
];
const closingLines = [
  { date: "2026-11-06", home_team: "BOS", away_team: "LAL", home_spread: -4, total: 222.5, home_moneyline: -170, away_moneyline: 145 },
  { date: "2026-11-06", home_team: "GSW", away_team: "MIA", home_spread: 2.5, total: 230.5, home_moneyline: 110, away_moneyline: -130 },
];
const finalScores = [
  { date: "2026-11-06", home_team: "BOS", away_team: "LAL", home_score: 118, away_score: 105 }, // BOS wins by 13, covers -4, total 223 (over 222.5)
  { date: "2026-11-06", home_team: "GSW", away_team: "MIA", home_score: 100, away_score: 108 }, // GSW loses, total 208 (under 230.5)
];

test("joinProjectionsWithOutcomes: matches on date+home+away, fills in closing line and actual result fields", () => {
  const joined = joinProjectionsWithOutcomes(projections, closingLines, finalScores);
  assert.equal(joined.length, 2);
  const bos = joined.find((r) => r.home_team === "BOS");
  assert.equal(bos.actual_margin, 13);
  assert.equal(bos.actual_total, 223);
  assert.equal(bos.closing_home_spread, -4);
});

test("joinProjectionsWithOutcomes: a projection with neither a closing line nor a final score is dropped", () => {
  const joined = joinProjectionsWithOutcomes(
    [{ date: "2026-12-01", home_team: "NYK", away_team: "PHI" }],
    closingLines,
    finalScores
  );
  assert.equal(joined.length, 0);
});

test("calibrationBuckets: buckets games by model_prob_home_ml decile, computes actual home win rate", () => {
  const joined = joinProjectionsWithOutcomes(projections, closingLines, finalScores);
  const buckets = calibrationBuckets(joined);
  const bosBucket = buckets.find((b) => 0.65 >= b.rangeLow && 0.65 < b.rangeHigh);
  assert.equal(bosBucket.games, 1);
  assert.equal(bosBucket.homeWins, 1);
  assert.equal(bosBucket.actualWinRate, 1);
});

test("simpleRoiIfAlwaysBetEdgeSide: ml market -- BOS's positive home edge won at -170, GSW's negative edge (bet away) lost", () => {
  const joined = joinProjectionsWithOutcomes(projections, closingLines, finalScores);
  const roi = simpleRoiIfAlwaysBetEdgeSide(joined, "ml");
  assert.equal(roi.betsPlaced, 2);
  // BOS: bet home at -170, won -> returns 1 + 100/170 = 1.588
  // GSW: edge negative -> bet away (MIA) at -130, MIA won in reality (home lost) -> wins too
  assert.ok(roi.unitsReturned > roi.unitsStaked); // both edge-side bets actually won in this fixture
});

test("simpleRoiIfAlwaysBetEdgeSide: total market -- BOS's positive over edge won (223 > 222.5), GSW's negative edge means betting under, which also won (208 < 230.5)", () => {
  const joined = joinProjectionsWithOutcomes(projections, closingLines, finalScores);
  const roi = simpleRoiIfAlwaysBetEdgeSide(joined, "total");
  assert.equal(roi.betsPlaced, 2);
  assert.equal(roi.unitsReturned, Number((2 * (1 + 100 / 110)).toFixed(2)));
});

test("simpleRoiIfAlwaysBetEdgeSide: rows missing the needed closing price are skipped, not thrown", () => {
  const joined = joinProjectionsWithOutcomes(projections, closingLines, finalScores);
  const roi = simpleRoiIfAlwaysBetEdgeSide(joined, "spread"); // GSW has no spread edge at all
  assert.equal(roi.betsPlaced, 1);
});
