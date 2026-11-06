import test from "node:test";
import assert from "node:assert/strict";
import { normCdf, probOverFromNormal, devigTwoWay, devigTwoWayFromAmerican } from "./probability.js";

test("normCdf: symmetric around 0, matches known z-table values", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normCdf(-1.96) - 0.025) < 1e-3);
});

test("probOverFromNormal: line equal to mean gives 0.5", () => {
  assert.ok(Math.abs(probOverFromNormal(100, 100, 12) - 0.5) < 1e-6);
});

test("probOverFromNormal: mean well above line gives high probability", () => {
  assert.ok(probOverFromNormal(90, 110, 10) > 0.9);
});

test("probOverFromNormal: zero/invalid stdDev falls back to a step function", () => {
  assert.equal(probOverFromNormal(10, 20, 0), 1);
  assert.equal(probOverFromNormal(20, 10, 0), 0);
  assert.equal(probOverFromNormal(10, 10, 0), 0.5);
});

test("devigTwoWay: normalizes two implied probabilities that sum above 1 (vig removed)", () => {
  const [a, b] = devigTwoWay(0.55, 0.52); // sums to 1.07 -- typical -110/-110 book
  assert.ok(Math.abs(a + b - 1) < 1e-9);
  assert.ok(Math.abs(a - 0.55 / 1.07) < 1e-9);
});

test("devigTwoWay: missing input returns [null, null]", () => {
  assert.deepEqual(devigTwoWay(null, 0.5), [null, null]);
});

test("devigTwoWayFromAmerican: two -110 sides devig to roughly 50/50", () => {
  const [a, b] = devigTwoWayFromAmerican(-110, -110);
  assert.ok(Math.abs(a - 0.5) < 1e-9);
  assert.ok(Math.abs(b - 0.5) < 1e-9);
});
