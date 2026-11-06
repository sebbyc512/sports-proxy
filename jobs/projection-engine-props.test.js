import test from "node:test";
import assert from "node:assert/strict";
import {
  weightedStatProjection,
  opponentAllowedAtPosition,
  opponentDefenseMultiplier,
  restMultiplier,
  minutesTrendMultiplier,
  projectPlayerStat,
  propEdgeVsDk,
  buildPropShadowRow,
} from "./projection-engine-props.js";

function row(points, extra = {}) {
  return { points, rebounds: 5, assists: 3, minutes: 32, position: "G", game_id: `g${Math.random()}`, date: "2026-11-01", ...extra };
}

test("weightedStatProjection: blends last5/last10/season, weighted toward recent form", () => {
  const rows = [row(30), row(28), row(26), row(24), row(22), row(10), row(10), row(10), row(10), row(10)];
  const proj = weightedStatProjection(rows, "points");
  assert.ok(proj > 20 && proj < 26); // pulled up from the stale 10s by recency weighting
});

test("weightedStatProjection: falls back to whatever windows are available for a short sample", () => {
  const rows = [row(20), row(22)];
  const proj = weightedStatProjection(rows, "points");
  assert.ok(proj != null);
});

test("weightedStatProjection: no rows returns null", () => {
  assert.equal(weightedStatProjection([], "points"), null);
});

test("opponentAllowedAtPosition: averages points allowed to a position across the opponent's games", () => {
  const oppRows = [
    { position: "G", points: 20, game_id: "g1", date: "2026-11-01" },
    { position: "G", points: 10, game_id: "g1", date: "2026-11-01" }, // same game, two guards -> summed
    { position: "F", points: 15, game_id: "g1", date: "2026-11-01" }, // different position, excluded
    { position: "G", points: 25, game_id: "g2", date: "2026-11-03" },
  ];
  const allowed = opponentAllowedAtPosition(oppRows, "G", "points");
  assert.equal(allowed, 27.5); // (30 + 25) / 2
});

test("opponentDefenseMultiplier: above-average allowed bumps the projection, capped at 1.15", () => {
  assert.equal(opponentDefenseMultiplier(null, 25), 1);
  assert.ok(opponentDefenseMultiplier(30, 25) > 1);
  assert.equal(opponentDefenseMultiplier(100, 25), 1.15); // capped
  assert.equal(opponentDefenseMultiplier(1, 25), 0.85); // capped low
});

test("restMultiplier: back-to-back and long road trips reduce the multiplier", () => {
  assert.equal(restMultiplier(null), 1);
  assert.ok(restMultiplier({ back_to_back: true }) < 1);
  assert.ok(restMultiplier({ back_to_back: true, road_trip_length: 4 }) < restMultiplier({ back_to_back: true }));
});

test("minutesTrendMultiplier: rising minutes trend increases the multiplier, capped", () => {
  assert.equal(minutesTrendMultiplier(null, 30), 1);
  assert.ok(minutesTrendMultiplier(5, 30) > 1);
  assert.ok(minutesTrendMultiplier(500, 30) <= 1.15);
});

test("projectPlayerStat: composes base projection with defense/rest/trend/blowout/injury multipliers", () => {
  const playerRows = [row(25), row(24), row(26), row(23), row(25), row(20), row(20), row(20), row(20), row(20)];
  const oppRows = [{ position: "G", points: 30, game_id: "g1", date: "2026-11-01" }];
  const result = projectPlayerStat({
    statKey: "points",
    playerRowsMostRecentFirst: playerRows,
    position: "G",
    opponentTeamRowsMostRecentFirst: oppRows,
    leagueAvgAtPosition: 22,
    scheduleContextRow: { back_to_back: true },
    blowoutRiskMultiplier: 0.95,
    injuryAdjustmentMultiplier: 1.1,
  });
  assert.ok(result.projection != null);
  assert.ok(result.stdDev != null);
});

test("projectPlayerStat: no player rows returns a null projection, not a crash", () => {
  const result = projectPlayerStat({ statKey: "points", playerRowsMostRecentFirst: [], position: "G", opponentTeamRowsMostRecentFirst: [], leagueAvgAtPosition: 22 });
  assert.equal(result.projection, null);
});

test("propEdgeVsDk: positive edge when model projects well above DK's devigged implied probability", () => {
  const edge = propEdgeVsDk({ projection: 28, stdDev: 6, dkLine: 23.5, dkOverPrice: -110, dkUnderPrice: -110 });
  assert.ok(edge.modelProbOver > 0.5);
  assert.ok(edge.edgeOver > 0);
});

test("propEdgeVsDk: missing DK prices still returns modelProbOver, nulls for edge", () => {
  const edge = propEdgeVsDk({ projection: 28, stdDev: 6, dkLine: 23.5 });
  assert.ok(edge.modelProbOver != null);
  assert.equal(edge.edgeOver, null);
});

test("buildPropShadowRow: shapes a full log row, actual_result/graded start null/false", () => {
  const projectionResult = { projection: 27, stdDev: 6 };
  const shadowRow = buildPropShadowRow({
    date: "2026-11-06", player: "Test Player", playerId: "123", team: "BOS", opponent: "LAL", market: "points",
    projectionResult, dk: { line: 23.5, overPrice: -115, underPrice: -105 },
  });
  assert.equal(shadowRow.model_projection, 27);
  assert.equal(shadowRow.actual_result, null);
  assert.equal(shadowRow.graded, false);
  assert.ok(shadowRow.edge_over > 0);
});
