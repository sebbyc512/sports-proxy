import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPointInTimeRating,
  appendTeamGame,
  gradeWalkForwardGame,
  summarizeWalkForward,
} from "./walkforward-backtest.js";

test("buildPointInTimeRating: NO LEAKAGE -- adding games on/after asOfDate never changes the result", () => {
  const priorGames = [
    { date: "2026-01-01", ptsFor: 100, ptsAgainst: 90 },
    { date: "2026-01-03", ptsFor: 110, ptsAgainst: 95 },
    { date: "2026-01-05", ptsFor: 105, ptsAgainst: 100 },
  ];
  const asOf = "2026-01-10";
  const baseline = buildPointInTimeRating(priorGames, asOf);

  const withFutureGames = [
    ...priorGames,
    { date: "2026-01-10", ptsFor: 999, ptsAgainst: 1 }, // same date as asOf -- must be excluded
    { date: "2026-01-15", ptsFor: 1, ptsAgainst: 999 }, // after asOf -- must be excluded
  ];
  const withFuture = buildPointInTimeRating(withFutureGames, asOf);

  assert.deepEqual(withFuture, baseline, "including same-date or future games changed the rating -- LEAKAGE");
});

test("buildPointInTimeRating: a rating as-of date D is identical regardless of what's fetched after D", () => {
  const allSeasonGames = [
    { date: "2026-01-01", ptsFor: 100, ptsAgainst: 90 },
    { date: "2026-01-03", ptsFor: 110, ptsAgainst: 95 },
    { date: "2026-01-05", ptsFor: 105, ptsAgainst: 100 },
    { date: "2026-02-01", ptsFor: 130, ptsAgainst: 80 },
    { date: "2026-03-01", ptsFor: 60, ptsAgainst: 140 },
  ];
  const asOf = "2026-01-10";
  const ratingFromFullSeason = buildPointInTimeRating(allSeasonGames, asOf);
  const ratingFromOnlyPriorGames = buildPointInTimeRating(
    allSeasonGames.filter((g) => g.date < asOf),
    asOf
  );
  assert.deepEqual(ratingFromFullSeason, ratingFromOnlyPriorGames);
});

test("buildPointInTimeRating: fewer than 3 prior games returns nulls, not a noisy average", () => {
  const r = buildPointInTimeRating([{ date: "2026-01-01", ptsFor: 100, ptsAgainst: 90 }], "2026-01-10");
  assert.equal(r.avgPointsScored, null);
  assert.equal(r.gamesUsed, 1);
});

test("buildPointInTimeRating: averages the trailing n games, most-recent-first", () => {
  const games = [
    { date: "2026-01-01", ptsFor: 100, ptsAgainst: 90 },
    { date: "2026-01-03", ptsFor: 110, ptsAgainst: 95 },
    { date: "2026-01-05", ptsFor: 120, ptsAgainst: 100 },
  ];
  const r = buildPointInTimeRating(games, "2026-01-10");
  assert.equal(r.avgPointsScored, 110);
  assert.equal(r.avgPointsAllowed, 95);
  assert.equal(r.gamesUsed, 3);
});

test("appendTeamGame: caps rolling history at `cap`, dropping the oldest first", () => {
  let rolling = new Map();
  for (let i = 0; i < 5; i++) {
    rolling = appendTeamGame(rolling, "BOS", { date: `2026-01-0${i + 1}`, ptsFor: i, ptsAgainst: i }, 3);
  }
  const list = rolling.get("BOS");
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((g) => g.date), ["2026-01-03", "2026-01-04", "2026-01-05"]);
});

test("gradeWalkForwardGame: ATS hit when model and actual agree on the cover side", () => {
  const g = gradeWalkForwardGame({
    projectedMargin: 6, // model likes home by 6
    projectedTotal: null,
    closingHomeSpread: -4, // home favored by 4
    closingTotal: null,
    closingHomeMl: null,
    closingAwayMl: null,
    actualHomeScore: 100,
    actualAwayScore: 95, // home won by 5, covers -4
  });
  assert.equal(g.atsHit, true);
  assert.equal(g.edgeSpreadPts, 2); // |6 - 4|
  assert.ok(g.roiSpreadUnits > 0);
});

test("gradeWalkForwardGame: ATS miss when actual disagrees with the model's side", () => {
  const g = gradeWalkForwardGame({
    projectedMargin: 6,
    projectedTotal: null,
    closingHomeSpread: -4,
    closingTotal: null,
    closingHomeMl: null,
    closingAwayMl: null,
    actualHomeScore: 95,
    actualAwayScore: 93, // home won by 2, does NOT cover -4
  });
  assert.equal(g.atsHit, false);
  assert.equal(g.roiSpreadUnits, -1);
});

test("gradeWalkForwardGame: exact push is excluded (null), not counted as a loss", () => {
  const g = gradeWalkForwardGame({
    projectedMargin: 6,
    projectedTotal: null,
    closingHomeSpread: -4,
    closingTotal: null,
    closingHomeMl: null,
    closingAwayMl: null,
    actualHomeScore: 100,
    actualAwayScore: 96, // home by 4 == push
  });
  assert.equal(g.atsHit, null);
  assert.equal(g.roiSpreadUnits, null);
});

test("gradeWalkForwardGame: totals hit/miss and edge in points", () => {
  const over = gradeWalkForwardGame({
    projectedMargin: null, closingHomeSpread: null, closingHomeMl: null, closingAwayMl: null,
    projectedTotal: 230, closingTotal: 225,
    actualHomeScore: 120, actualAwayScore: 112, // actual total 232, over 225
  });
  assert.equal(over.totalHit, true);
  assert.equal(over.edgeTotalPts, 5);
});

test("gradeWalkForwardGame: ML hit uses the real historical moneyline price for ROI (favorite wins)", () => {
  const g = gradeWalkForwardGame({
    projectedMargin: 5, projectedTotal: null, closingHomeSpread: null, closingTotal: null,
    closingHomeMl: -200, closingAwayMl: 170,
    actualHomeScore: 100, actualAwayScore: 90,
  });
  assert.equal(g.mlPick, "home");
  assert.equal(g.mlHit, true);
  assert.equal(g.roiMlUnits, 0.5); // -200 favorite win pays 100/200
});

test("gradeWalkForwardGame: ML miss loses a flat unit regardless of price", () => {
  const g = gradeWalkForwardGame({
    projectedMargin: 5, projectedTotal: null, closingHomeSpread: null, closingTotal: null,
    closingHomeMl: -200, closingAwayMl: 170,
    actualHomeScore: 90, actualAwayScore: 100, // model picked home, home lost
  });
  assert.equal(g.mlHit, false);
  assert.equal(g.roiMlUnits, -1);
});

test("gradeWalkForwardGame: missing actual score returns all-null instead of throwing", () => {
  const g = gradeWalkForwardGame({ projectedMargin: 5, actualHomeScore: null, actualAwayScore: null });
  assert.equal(g.atsHit, null);
  assert.equal(g.mlHit, null);
});

test("summarizeWalkForward: overall + edge-bucket hit%/ROI%, excludes pushes from the denominator", () => {
  const rows = [
    { atsHit: true, edgeSpreadPts: 1, roiSpreadUnits: 100 / 110, totalHit: null, edgeTotalPts: null, roiTotalUnits: null, mlHit: null },
    { atsHit: true, edgeSpreadPts: 3, roiSpreadUnits: 100 / 110, totalHit: null, edgeTotalPts: null, roiTotalUnits: null, mlHit: null },
    { atsHit: false, edgeSpreadPts: 4, roiSpreadUnits: -1, totalHit: null, edgeTotalPts: null, roiTotalUnits: null, mlHit: null },
    { atsHit: null, edgeSpreadPts: null, roiSpreadUnits: null, totalHit: null, edgeTotalPts: null, roiTotalUnits: null, mlHit: null }, // push
  ];
  const summary = summarizeWalkForward(rows);
  assert.equal(summary.gamesTotal, 4);
  assert.equal(summary.spread.all.n, 3, "push excluded from denominator");
  assert.equal(summary.spread.all.hitPct, 66.7);
  assert.equal(summary.spread.edgeGte3.n, 2); // the two rows with edge 3 and 4
  assert.equal(summary.spread.edgeGte5.n, 0);
});
