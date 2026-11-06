import test from "node:test";
import assert from "node:assert/strict";
import {
  extractClosingLineFromSummary,
  extractFinalGamesFromScoreboard,
  pullClosingLinesForDate,
  pullClosingLinesForDateRange,
} from "./closing-lines.js";

test("extractClosingLineFromSummary: prefers DraftKings over a lower-priority book", () => {
  const summary = {
    pickcenter: [
      { provider: { name: "ESPN BET", priority: 1 }, spread: -3, overUnder: 220 },
      { provider: { name: "DraftKings", priority: 2 }, spread: -2.5, overUnder: 221.5, homeTeamOdds: { moneyLine: -140 }, awayTeamOdds: { moneyLine: 120 } },
    ],
  };
  const line = extractClosingLineFromSummary(summary);
  assert.equal(line.provider, "DraftKings");
  assert.equal(line.homeSpread, -2.5);
  assert.equal(line.total, 221.5);
  assert.equal(line.homeMoneyline, -140);
});

test("extractClosingLineFromSummary: falls back to lowest-priority book when no DK listed", () => {
  const summary = { pickcenter: [{ provider: { name: "ESPN BET", priority: 1 }, spread: -3, overUnder: 220 }] };
  const line = extractClosingLineFromSummary(summary);
  assert.equal(line.provider, "ESPN BET");
});

test("extractClosingLineFromSummary: no pickcenter data returns all-null shape", () => {
  const line = extractClosingLineFromSummary({});
  assert.equal(line.provider, null);
});

test("extractFinalGamesFromScoreboard: only includes games whose status state is 'post'", () => {
  const scoreboard = {
    events: [
      { id: "1", status: { type: { state: "post" } }, competitions: [{ competitors: [{ homeAway: "home", team: { abbreviation: "BOS" } }, { homeAway: "away", team: { abbreviation: "LAL" } }] }] },
      { id: "2", status: { type: { state: "in" } }, competitions: [{ competitors: [{ homeAway: "home", team: { abbreviation: "GSW" } }, { homeAway: "away", team: { abbreviation: "MIA" } }] }] },
    ],
  };
  const games = extractFinalGamesFromScoreboard(scoreboard, "2026-11-06");
  assert.equal(games.length, 1);
  assert.equal(games[0].id, "1");
  assert.equal(games[0].homeTeam, "BOS");
});

test("pullClosingLinesForDate: fetches scoreboard then one summary per final game, upserts rows, skips games with no pickcenter data", async () => {
  const scoreboard = {
    events: [
      { id: "1", status: { type: { state: "post" } }, competitions: [{ competitors: [{ homeAway: "home", team: { abbreviation: "BOS" } }, { homeAway: "away", team: { abbreviation: "LAL" } }] }] },
      { id: "2", status: { type: { state: "post" } }, competitions: [{ competitors: [{ homeAway: "home", team: { abbreviation: "GSW" } }, { homeAway: "away", team: { abbreviation: "MIA" } }] }] },
    ],
  };
  const deps = {
    getJson: async (url) => {
      if (url.includes("scoreboard")) return scoreboard;
      if (url.includes("event=1")) return { pickcenter: [{ provider: { name: "DraftKings" }, spread: -4, overUnder: 215 }] };
      if (url.includes("event=2")) return {}; // no pickcenter -> skipped
      throw new Error("unexpected " + url);
    },
    upsertRows: async (rows) => { deps.captured = rows; },
  };
  const result = await pullClosingLinesForDate("NBA", "20261106", deps);
  assert.equal(result.gamesFound, 2);
  assert.equal(result.rowsWritten, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(deps.captured[0].home_team, "BOS");
  assert.equal(deps.captured[0].home_spread, -4);
});

test("pullClosingLinesForDate: CBB scoreboard call carries groups=50&limit=400 (full D1 slate, not ESPN's default subset)", async () => {
  let scoreboardUrl = null;
  const deps = {
    getJson: async (url) => {
      if (url.includes("scoreboard")) { scoreboardUrl = url; return { events: [] }; }
      return {};
    },
    upsertRows: async () => {},
  };
  await pullClosingLinesForDate("CBB", "20261105", deps);
  assert.match(scoreboardUrl, /groups=50/);
  assert.match(scoreboardUrl, /limit=400/);
});

test("pullClosingLinesForDate: NBA scoreboard call does NOT add CBB-only groups/limit params", async () => {
  let scoreboardUrl = null;
  const deps = {
    getJson: async (url) => {
      if (url.includes("scoreboard")) { scoreboardUrl = url; return { events: [] }; }
      return {};
    },
    upsertRows: async () => {},
  };
  await pullClosingLinesForDate("NBA", "20261105", deps);
  assert.doesNotMatch(scoreboardUrl, /groups=/);
});

test("pullClosingLinesForDate: one bad scoreboard fetch is recorded, not thrown", async () => {
  const deps = { getJson: async () => { throw new Error("ESPN down"); }, upsertRows: async () => {} };
  const result = await pullClosingLinesForDate("CBB", "20261106", deps);
  assert.equal(result.error, "ESPN down");
  assert.equal(result.rowsWritten, 0);
});

test("pullClosingLinesForDateRange: iterates the inclusive date range, aggregates totals", async () => {
  let calls = 0;
  const deps = {
    getJson: async (url) => {
      calls++;
      if (url.includes("scoreboard")) return { events: [] };
      return {};
    },
    upsertRows: async () => {},
  };
  const result = await pullClosingLinesForDateRange("NBA", "20261104", "20261106", deps);
  assert.equal(result.datesProcessed, 3);
  assert.equal(calls, 3); // one scoreboard call per date, no games -> no summary calls
});
