import test from "node:test";
import assert from "node:assert/strict";
import { pullHistoricalPropsForDate, MIN_CREDITS_FLOOR } from "./nba-props-historical-pull.js";

const scoreboardOneFinalGame = {
  events: [
    {
      id: "401", status: { type: { state: "post" } },
      competitions: [{
        date: "2026-10-22T23:00Z",
        competitors: [
          { homeAway: "home", team: { displayName: "Los Angeles Lakers" } },
          { homeAway: "away", team: { displayName: "Golden State Warriors" } },
        ],
      }],
    },
    {
      id: "402", status: { type: { state: "scheduled" } }, // not final -> skipped entirely
      competitions: [{ date: "2026-10-22T23:00Z", competitors: [
        { homeAway: "home", team: { displayName: "Boston Celtics" } },
        { homeAway: "away", team: { displayName: "Miami Heat" } },
      ] }],
    },
  ],
};

const oddsEvents = [{ id: "evt-1", home_team: "Los Angeles Lakers", away_team: "Golden State Warriors", commence_time: "2026-10-22T23:00Z" }];

const historicalOddsResponse = {
  bookmakers: [{
    key: "draftkings",
    markets: [
      { key: "player_points", outcomes: [
        { name: "Over", description: "LeBron James", point: 24.5, price: -115 },
        { name: "Under", description: "LeBron James", point: 24.5, price: -105 },
      ] },
      { key: "player_rebounds", outcomes: [
        { name: "Over", description: "LeBron James", point: 7.5, price: -110 },
        { name: "Under", description: "LeBron James", point: 7.5, price: -110 },
      ] },
    ],
  }],
};

function baseDeps(overrides = {}) {
  return {
    getEspnJson: async () => scoreboardOneFinalGame,
    getOddsEvents: async () => oddsEvents,
    getHistoricalOdds: async () => ({ data: historicalOddsResponse, creditsUsedThisCall: 50, requestsRemaining: 15000 }),
    upsertRows: async (rows) => { baseDeps.captured = rows; },
    ...overrides,
  };
}

test("pullHistoricalPropsForDate: only processes final games, matches via team-aliases, writes rows for 2 markets", async () => {
  let captured = null;
  const deps = baseDeps({ upsertRows: async (rows) => { captured = rows; } });
  const result = await pullHistoricalPropsForDate("20261022", deps);
  assert.equal(result.eventsProcessed, 1); // the non-final Celtics/Heat game never reaches getHistoricalOdds
  assert.equal(result.rowsWritten, 2); // points + rebounds for LeBron James
  assert.equal(result.stoppedEarly, false);
  assert.ok(captured.some((r) => r.market === "points" && r.dk_line === 24.5));
  assert.ok(captured.some((r) => r.market === "rebounds" && r.dk_line === 7.5));
});

test("pullHistoricalPropsForDate: snapshot timestamp sent to getHistoricalOdds is always full HH:MM:SSZ, no bare-minute or millisecond ESPN timestamps", async () => {
  let seenSnapshot = null;
  const deps = baseDeps({
    getHistoricalOdds: async (eventId, snapshotIso) => {
      seenSnapshot = snapshotIso;
      return { data: historicalOddsResponse, creditsUsedThisCall: 50, requestsRemaining: 15000 };
    },
  });
  await pullHistoricalPropsForDate("20261022", deps);
  // ESPN's own comp.date in the fixture is "2026-10-22T23:00Z" (no seconds) -- the real API
  // 422s on that AND on a full millisecond timestamp; only exact YYYY-MM-DDTHH:MM:SSZ works.
  assert.match(seenSnapshot, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test("pullHistoricalPropsForDate: no matching Odds API event is skipped with a reason, never guessed", async () => {
  const deps = baseDeps({ getOddsEvents: async () => [] });
  const result = await pullHistoricalPropsForDate("20261022", deps);
  assert.equal(result.eventsProcessed, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /no Odds API event matched/);
});

test("pullHistoricalPropsForDate: hard stop when a call reports remaining credits below the floor -- stoppedEarly, partial rows kept", async () => {
  const deps = baseDeps({
    getHistoricalOdds: async () => ({ data: historicalOddsResponse, creditsUsedThisCall: 50, requestsRemaining: MIN_CREDITS_FLOOR - 1 }),
  });
  const result = await pullHistoricalPropsForDate("20261022", deps);
  assert.equal(result.stoppedEarly, true);
  assert.equal(result.rowsWritten, 2); // the one event that DID complete still gets written
});

test("pullHistoricalPropsForDate: no games found returns zeroed result without calling odds endpoints", async () => {
  let oddsEventsCalled = false;
  const deps = baseDeps({
    getEspnJson: async () => ({ events: [] }),
    getOddsEvents: async () => { oddsEventsCalled = true; return []; },
  });
  const result = await pullHistoricalPropsForDate("20261022", deps);
  assert.equal(result.eventsProcessed, 0);
  assert.equal(oddsEventsCalled, false);
});

test("pullHistoricalPropsForDate: a single event's historical-odds error is skipped, not thrown", async () => {
  const deps = baseDeps({ getHistoricalOdds: async () => { throw new Error("odds api 500"); } });
  const result = await pullHistoricalPropsForDate("20261022", deps);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /odds api 500/);
});
