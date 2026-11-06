// Shared probability/devig math for the NBA+CBB analytics-only projection engine
// (2026-11-06+, Seb's request). Pure, no network/Supabase calls -- same convention as
// util.js. `americanToImpliedProb` is re-exported from ticket-gate.js instead of
// duplicated, since it's already reviewed/tested there.
import { americanToImpliedProb } from "../ticket-gate.js";

export { americanToImpliedProb };

// Abramowitz-Stegun 7.1.26 approximation (~1e-7 max error) -- good enough for a v1
// projection engine; swap for a proper stats library if calibration work later needs
// tighter precision.
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

export function normCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// Probability that a normally-distributed outcome (mean, stdDev) exceeds `line`.
export function probOverFromNormal(line, mean, stdDev) {
  if (!Number.isFinite(stdDev) || stdDev <= 0) return mean > line ? 1 : mean < line ? 0 : 0.5;
  const z = (line - mean) / stdDev;
  return 1 - normCdf(z);
}

// Removes the vig from a two-way market (e.g. over/under, or a spread's two sides) by
// normalizing the raw implied probabilities so they sum to 1. Returns [null, null] if
// either input is missing/non-finite.
export function devigTwoWay(probA, probB) {
  if (!Number.isFinite(probA) || !Number.isFinite(probB)) return [null, null];
  const sum = probA + probB;
  if (sum <= 0) return [null, null];
  return [probA / sum, probB / sum];
}

// Convenience: devig straight from two American prices.
export function devigTwoWayFromAmerican(americanA, americanB) {
  return devigTwoWay(americanToImpliedProb(americanA), americanToImpliedProb(americanB));
}
