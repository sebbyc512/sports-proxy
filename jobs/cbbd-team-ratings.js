// CBB team adjusted efficiency/tempo ratings via CollegeBasketballData (CBBD), added
// 2026-11-06+ at Seb's request alongside jobs/cbbd-historical-lines.js. Purpose: the
// projection engine's CBB margin model (jobs/projection-engine-sides-totals.js) currently
// stays on a plain points-average fallback because cbbTeams has no possessions data to
// derive a real per-100 rating from. This job lands CBBD's own adjusted ratings in their own
// table so that upgrade can happen later as a separate, reviewed step -- NOT wired into the
// projection engine yet, by design (see that file's top comment).
//
// ASSUMPTION, NOT CONFIRMED: no live CFBD_API_KEY in this worktree's local .env, so the
// endpoint path (`/ratings/adjusted?season=YYYY`) and response shape (array of
// { team, conference, season, offensiveRating, defensiveRating, netRating, tempo }) are
// built from CBBD's published docs/general knowledge, not a live-tested response. Field
// names need confirming against a real call before this data is trusted for anything.
//
// Same injected-deps pattern as the rest of this engine's jobs/*.js files.

const CBBD_BASE = "https://api.collegebasketballdata.com";

export function normalizeCbbdRating(r, season) {
  if (!r?.team) return null;
  return {
    team: r.team,
    season: String(season),
    conference: r.conference || null,
    off_rtg: Number.isFinite(r.offensiveRating) ? r.offensiveRating : null,
    def_rtg: Number.isFinite(r.defensiveRating) ? r.defensiveRating : null,
    net_rtg: Number.isFinite(r.netRating)
      ? r.netRating
      : Number.isFinite(r.offensiveRating) && Number.isFinite(r.defensiveRating)
        ? Number((r.offensiveRating - r.defensiveRating).toFixed(1))
        : null,
    tempo: Number.isFinite(r.tempo) ? r.tempo : null,
    updated_at: new Date().toISOString(),
  };
}

export async function pullCbbdTeamRatingsForSeason(season, deps) {
  const result = { season, teamsFound: 0, rowsWritten: 0, skipped: [] };
  let ratings;
  try {
    ratings = await deps.getJson(`${CBBD_BASE}/ratings/adjusted?season=${season}`);
  } catch (err) {
    result.error = err.message;
    return result;
  }
  if (!Array.isArray(ratings)) {
    result.error = "unexpected response shape (expected an array of team ratings)";
    return result;
  }
  result.teamsFound = ratings.length;

  const rows = [];
  for (const r of ratings) {
    const row = normalizeCbbdRating(r, season);
    if (!row) {
      result.skipped.push({ team: r?.team ?? null, reason: "missing team name" });
      continue;
    }
    rows.push(row);
  }
  if (rows.length) await deps.upsertRows(rows);
  result.rowsWritten = rows.length;
  return result;
}
