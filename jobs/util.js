// Shared pure helpers for the daily-data batch (NBA/NHL player logs, schedule-context,
// soccer form, CBB daily). No network/Supabase calls in this file -- keeps it unit-testable
// without fixtures beyond plain objects/strings.

// "2025-26", "2026-27", etc., from a YYYYMMDD string. Mirrors server.js's own
// seasonForDate() (sql/cbb-game-logs-table.sql's convention): basketball/hockey seasons
// run roughly Oct/Nov-Jun, so Aug-Dec dates belong to the season STARTING that year and
// Jan-Jul dates belong to the season ENDING that year.
export function seasonForDate(yyyymmdd) {
  const year = Number(yyyymmdd.slice(0, 4));
  const month = Number(yyyymmdd.slice(4, 6));
  const startYear = month >= 8 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

// "23-65" -> { made: 23, att: 65, pct: 35.4 }. Returns nulls for anything unparseable.
// Same convention as server.js's splitMadeAttempt().
export function splitMadeAttempt(str) {
  const m = /^(\d+)-(\d+)$/.exec(str || "");
  if (!m) return { made: null, att: null, pct: null };
  const made = Number(m[1]);
  const att = Number(m[2]);
  return { made, att, pct: att > 0 ? Number(((made / att) * 100).toFixed(1)) : null };
}

export function yyyymmddToIso(yyyymmdd) {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

export function isoToYyyymmdd(iso) {
  return iso.replaceAll("-", "");
}

export function addDaysYyyymmdd(yyyymmdd, days) {
  const iso = yyyymmddToIso(yyyymmdd);
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoToYyyymmdd(d.toISOString().slice(0, 10));
}

// Great-circle distance in miles between two lat/lon points (arena coordinates). Used for
// schedule-context's travel-miles field.
export function haversineMiles(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => v == null || Number.isNaN(v))) return null;
  const R = 3958.8; // mean Earth radius, miles
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.asin(Math.sqrt(a));
  return Math.round(R * c);
}

// Average of the last N numeric values in an array ordered most-recent-first. Skips
// nulls/undefined. Returns null if there's nothing to average.
export function avgLastN(valuesMostRecentFirst, n) {
  const slice = valuesMostRecentFirst.slice(0, n).filter((v) => v != null && !Number.isNaN(v));
  if (!slice.length) return null;
  return Number((slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(1));
}

// "Trend" = last-5 average minus the average of the 5 games before that (games 6-10).
// Positive -> minutes/role trending up recently; negative -> trending down. Null if there
// isn't a second window to compare against.
export function trendLast5VsPrior5(valuesMostRecentFirst) {
  const last5 = avgLastN(valuesMostRecentFirst, 5);
  const prior5 = avgLastN(valuesMostRecentFirst.slice(5), 5);
  if (last5 == null || prior5 == null) return null;
  return Number((last5 - prior5).toFixed(1));
}
