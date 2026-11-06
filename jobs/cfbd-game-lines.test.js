import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCfbdGame, pullCfbdGameLines } from "./cfbd-game-lines.js";

test("normalizeCfbdGame: maps a well-formed game to a row", () => {
  const game = {
    id: 777,
    season: 2025,
    week: 10,
    startDate: "2025-11-08T17:00:00.000Z",
    homeTeam: "Georgia",
    awayTeam: "Florida",
    lines: [{ provider: "DraftKings", spread: -7.5, overUnder: 51.5, homeMoneyline: -300, awayMoneyline: 240 }],
  };
  const row = normalizeCfbdGame(game);
  assert.deepEqual(row, {
    game_id: "cfbd-777",
    season: "2025",
    week: 10,
    date: "2025-11-08",
    home_team: "Georgia",
    away_team: "Florida",
    home_spread: -7.5,
    total: 51.5,
    home_moneyline: -300,
    away_moneyline: 240,
    provider: "DraftKings",
    captured_at: row.captured_at,
  });
});

test("normalizeCfbdGame: null when there are no lines at all", () => {
  assert.equal(normalizeCfbdGame({ id: 1, lines: [] }), null);
});

test("pullCfbdGameLines: happy path with a week filter writes normalized rows", async () => {
  const games = [
    {
      id: 777,
      season: 2025,
      week: 10,
      startDate: "2025-11-08",
      homeTeam: "Georgia",
      awayTeam: "Florida",
      lines: [{ provider: "DraftKings", spread: -7.5, overUnder: 51.5, homeMoneyline: -300, awayMoneyline: 240 }],
    },
    { id: 778, season: 2025, week: 10, homeTeam: "Ohio State", awayTeam: "Michigan", lines: [] },
  ];
  let calledUrl = null;
  let written = null;
  const result = await pullCfbdGameLines(2025, 10, {
    getJson: async (url) => {
      calledUrl = url;
      return games;
    },
    upsertRows: async (rows) => {
      written = rows;
    },
  });
  assert.match(calledUrl, /year=2025&week=10/);
  assert.equal(result.gamesFound, 2);
  assert.equal(result.rowsWritten, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(written[0].game_id, "cfbd-777");
});

test("pullCfbdGameLines: omitting week queries the whole season", async () => {
  let calledUrl = null;
  await pullCfbdGameLines(2025, undefined, {
    getJson: async (url) => {
      calledUrl = url;
      return [];
    },
    upsertRows: async () => {},
  });
  assert.equal(calledUrl, "https://api.collegefootballdata.com/lines?year=2025");
});

test("pullCfbdGameLines: records a fetch error instead of throwing", async () => {
  const result = await pullCfbdGameLines(2025, 10, {
    getJson: async () => {
      throw new Error("boom");
    },
    upsertRows: async () => {},
  });
  assert.equal(result.error, "boom");
});

test("pullCfbdGameLines: flags unexpected non-array response", async () => {
  const result = await pullCfbdGameLines(2025, 10, {
    getJson: async () => ({ not: "an array" }),
    upsertRows: async () => {},
  });
  assert.match(result.error, /unexpected response shape/);
});
