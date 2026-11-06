import test from "node:test";
import assert from "node:assert/strict";
import { pickPreferredLine, normalizeCbbdGame, pullCbbdHistoricalLinesForSeason } from "./cbbd-historical-lines.js";

test("pickPreferredLine: prefers DraftKings over other providers", () => {
  const lines = [
    { provider: "consensus", spread: -3 },
    { provider: "DraftKings", spread: -2.5 },
  ];
  assert.equal(pickPreferredLine(lines).provider, "DraftKings");
});

test("pickPreferredLine: falls back to first entry when DK is absent", () => {
  const lines = [{ provider: "consensus", spread: -3 }];
  assert.equal(pickPreferredLine(lines).provider, "consensus");
});

test("pickPreferredLine: null for empty/missing lines", () => {
  assert.equal(pickPreferredLine([]), null);
  assert.equal(pickPreferredLine(undefined), null);
});

test("normalizeCbbdGame: maps a well-formed game to a row", () => {
  const game = {
    id: 12345,
    season: 2025,
    startDate: "2025-11-10T20:00:00.000Z",
    homeTeam: "Duke",
    awayTeam: "Kansas",
    lines: [{ provider: "DraftKings", spread: -4.5, overUnder: 145.5, homeMoneyline: -200, awayMoneyline: 170 }],
  };
  const row = normalizeCbbdGame(game);
  assert.deepEqual(row, {
    game_id: "cbbd-12345",
    source: "cbbd",
    season: "2025",
    date: "2025-11-10",
    home_team: "Duke",
    away_team: "Kansas",
    home_spread: -4.5,
    total: 145.5,
    home_moneyline: -200,
    away_moneyline: 170,
    provider: "DraftKings",
    captured_at: row.captured_at,
  });
});

test("normalizeCbbdGame: null when there are no lines at all", () => {
  assert.equal(normalizeCbbdGame({ id: 1, lines: [] }), null);
});

test("pullCbbdHistoricalLinesForSeason: happy path writes normalized rows and reports counts", async () => {
  const games = [
    {
      id: 1,
      season: 2025,
      startDate: "2025-11-10",
      homeTeam: "Duke",
      awayTeam: "Kansas",
      lines: [{ provider: "DraftKings", spread: -4.5, overUnder: 145.5, homeMoneyline: -200, awayMoneyline: 170 }],
    },
    { id: 2, season: 2025, startDate: "2025-11-11", homeTeam: "UConn", awayTeam: "Michigan", lines: [] },
  ];
  let written = null;
  const result = await pullCbbdHistoricalLinesForSeason(2025, {
    getJson: async () => games,
    upsertRows: async (rows) => {
      written = rows;
    },
  });
  assert.equal(result.gamesFound, 2);
  assert.equal(result.rowsWritten, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(written.length, 1);
  assert.equal(written[0].game_id, "cbbd-1");
});

test("pullCbbdHistoricalLinesForSeason: dedupes multiple top-level entries sharing the same game id (one per provider), as CBBD's live API actually returns", async () => {
  // This is the real live shape discovered 2026-11-06 -- NOT the one-entry-per-game shape
  // originally assumed. Same `id` repeats across entries, each carrying one provider's line.
  const games = [
    {
      id: 42,
      season: 2025,
      startDate: "2025-11-10",
      homeTeam: "Duke",
      awayTeam: "Kansas",
      lines: [{ provider: "consensus", spread: -3, overUnder: 144, homeMoneyline: -180, awayMoneyline: 155 }],
    },
    {
      id: 42,
      season: 2025,
      startDate: "2025-11-10",
      homeTeam: "Duke",
      awayTeam: "Kansas",
      lines: [{ provider: "DraftKings", spread: -4.5, overUnder: 145.5, homeMoneyline: -200, awayMoneyline: 170 }],
    },
  ];
  let written = null;
  const result = await pullCbbdHistoricalLinesForSeason(2025, {
    getJson: async () => games,
    upsertRows: async (rows) => {
      written = rows;
    },
  });
  assert.equal(result.gamesFound, 2);
  assert.equal(result.rowsWritten, 1, "must collapse to exactly one row per game id");
  assert.equal(written.length, 1);
  assert.equal(written[0].game_id, "cbbd-42");
  assert.equal(written[0].provider, "DraftKings", "merged lines, then preferred DK over consensus");
  assert.equal(written[0].home_spread, -4.5);
});

test("pullCbbdHistoricalLinesForSeason: records a fetch error instead of throwing", async () => {
  const result = await pullCbbdHistoricalLinesForSeason(2025, {
    getJson: async () => {
      throw new Error("boom");
    },
    upsertRows: async () => {},
  });
  assert.equal(result.error, "boom");
  assert.equal(result.gamesFound, 0);
});

test("pullCbbdHistoricalLinesForSeason: flags unexpected non-array response", async () => {
  const result = await pullCbbdHistoricalLinesForSeason(2025, {
    getJson: async () => ({ not: "an array" }),
    upsertRows: async () => {},
  });
  assert.match(result.error, /unexpected response shape/);
});
