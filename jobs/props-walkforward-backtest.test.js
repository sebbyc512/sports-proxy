import test from "node:test";
import assert from "node:assert/strict";
import { buildPointInTimeInputs, gradeWalkForwardProp, summarizePropsBacktest } from "./props-walkforward-backtest.js";

function row(date, points, overrides = {}) {
  return { date, points, rebounds: 6, assists: 4, minutes: 32, position: "SF", ...overrides };
}

test("buildPointInTimeInputs: NO LEAKAGE -- result for a fixed asOfDate is identical whether or not same-date/future rows are included", () => {
  const priorOnly = [row("2026-01-01", 20), row("2026-01-03", 22), row("2026-01-05", 25)];
  const withFutureLeakedIn = [...priorOnly, row("2026-01-08", 99), row("2026-01-08", 1)]; // same asOfDate + later
  const a = buildPointInTimeInputs(priorOnly, [], "2026-01-08");
  const b = buildPointInTimeInputs(withFutureLeakedIn, [], "2026-01-08");
  assert.deepEqual(a.priorPlayerRows, b.priorPlayerRows);
  assert.equal(a.priorPlayerRows.length, 3);
  assert.ok(a.priorPlayerRows.every((r) => r.date < "2026-01-08"));
});

test("buildPointInTimeInputs: sorts prior rows most-recent-first", () => {
  const rows = [row("2026-01-01", 10), row("2026-01-05", 30), row("2026-01-03", 20)];
  const { priorPlayerRows } = buildPointInTimeInputs(rows, [], "2026-02-01");
  assert.deepEqual(priorPlayerRows.map((r) => r.date), ["2026-01-05", "2026-01-03", "2026-01-01"]);
});

test("gradeWalkForwardProp: grades a hit on the over with real ROI", () => {
  const priorPlayerRows = [row("2026-01-01", 28), row("2026-01-03", 30), row("2026-01-05", 29)];
  const result = gradeWalkForwardProp({
    statKey: "points", priorPlayerRows, position: "SF", priorOpponentRows: [],
    dkLine: 22.5, dkOverPrice: -110, dkUnderPrice: -110, actualResult: 31,
  });
  assert.equal(result.market, "points");
  assert.ok(result.projection > 22.5); // model should project well above a line this low given recent 28-30pt games
  assert.equal(result.pick, "over");
  assert.equal(result.hit, true);
  assert.ok(result.roiUnits > 0);
});

test("gradeWalkForwardProp: a push (actual == line) has no hit/miss", () => {
  const priorPlayerRows = [row("2026-01-01", 20), row("2026-01-03", 20), row("2026-01-05", 20)];
  const result = gradeWalkForwardProp({
    statKey: "points", priorPlayerRows, position: "SF", priorOpponentRows: [],
    dkLine: 20, dkOverPrice: -110, dkUnderPrice: -110, actualResult: 20,
  });
  assert.equal(result.hit, null);
});

test("gradeWalkForwardProp: missing DK line returns nulls, not a crash", () => {
  const result = gradeWalkForwardProp({ statKey: "points", priorPlayerRows: [row("2026-01-01", 20)], position: "SF", priorOpponentRows: [], dkLine: null, actualResult: 25 });
  assert.equal(result.hit, null);
  assert.equal(result.pick, null);
});

test("gradeWalkForwardProp: too few prior games returns a null projection, no throw", () => {
  const result = gradeWalkForwardProp({ statKey: "points", priorPlayerRows: [], position: "SF", priorOpponentRows: [], dkLine: 20, dkOverPrice: -110, dkUnderPrice: -110, actualResult: 25 });
  assert.equal(result.projection, null);
  assert.equal(result.hit, null);
});

test("summarizePropsBacktest: overall + edge-bucket + by-market breakdown, excludes ungradable rows", () => {
  const rows = [
    { market: "points", hit: true, roiUnits: 100 / 110, edgeAbsPp: 12 },
    { market: "points", hit: false, roiUnits: -1, edgeAbsPp: 3 },
    { market: "rebounds", hit: true, roiUnits: 100 / 110, edgeAbsPp: 20 },
    { market: "assists", hit: null, roiUnits: null, edgeAbsPp: null }, // push/ungradable -- excluded
  ];
  const summary = summarizePropsBacktest(rows);
  assert.equal(summary.propsTotal, 4);
  assert.equal(summary.gradable, 3);
  assert.equal(summary.byEdgeBucket.all.n, 3);
  assert.equal(summary.byEdgeBucket.edgeGte10pp.n, 2); // the 12pp and 20pp rows
  assert.equal(summary.byMarket.points.n, 2);
  assert.equal(summary.byMarket.rebounds.n, 1);
  assert.equal(summary.byMarket.assists.n, 0);
});
