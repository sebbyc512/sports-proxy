import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCbbdRating, pullCbbdTeamRatingsForSeason } from "./cbbd-team-ratings.js";

test("normalizeCbbdRating: maps a well-formed rating row", () => {
  const row = normalizeCbbdRating(
    { team: "Duke", conference: "ACC", offensiveRating: 118.2, defensiveRating: 92.1, tempo: 68.4 },
    2025
  );
  assert.deepEqual(row, {
    team: "Duke",
    season: "2025",
    conference: "ACC",
    off_rtg: 118.2,
    def_rtg: 92.1,
    net_rtg: 26.1,
    tempo: 68.4,
    updated_at: row.updated_at,
  });
});

test("normalizeCbbdRating: uses netRating directly when the API provides it", () => {
  const row = normalizeCbbdRating(
    { team: "Duke", offensiveRating: 118.2, defensiveRating: 92.1, netRating: 26.0 },
    2025
  );
  assert.equal(row.net_rtg, 26.0);
});

test("normalizeCbbdRating: null when there's no team name", () => {
  assert.equal(normalizeCbbdRating({ offensiveRating: 100 }, 2025), null);
});

test("pullCbbdTeamRatingsForSeason: happy path writes normalized rows and reports counts", async () => {
  const ratings = [
    { team: "Duke", conference: "ACC", offensiveRating: 118.2, defensiveRating: 92.1, tempo: 68.4 },
    { offensiveRating: 90 }, // missing team -> skipped
  ];
  let written = null;
  const result = await pullCbbdTeamRatingsForSeason(2025, {
    getJson: async () => ratings,
    upsertRows: async (rows) => {
      written = rows;
    },
  });
  assert.equal(result.teamsFound, 2);
  assert.equal(result.rowsWritten, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(written[0].team, "Duke");
});

test("pullCbbdTeamRatingsForSeason: records a fetch error instead of throwing", async () => {
  const result = await pullCbbdTeamRatingsForSeason(2025, {
    getJson: async () => {
      throw new Error("boom");
    },
    upsertRows: async () => {},
  });
  assert.equal(result.error, "boom");
});

test("pullCbbdTeamRatingsForSeason: flags unexpected non-array response", async () => {
  const result = await pullCbbdTeamRatingsForSeason(2025, {
    getJson: async () => ({ not: "an array" }),
    upsertRows: async () => {},
  });
  assert.match(result.error, /unexpected response shape/);
});
