import test from "node:test";
import assert from "node:assert/strict";
import {
  restMetricsForTeam,
  buildTeamGameList,
  buildScheduleContextRows,
  buildScheduleContextForLeague,
} from "./schedule-context.js";

test("restMetricsForTeam: first known game has no rest info but flags an away-game road trip of 1", () => {
  const games = [{ date: "2026-11-06", homeAway: "away", opponent: "BOS", venueLat: null, venueLon: null, isTarget: true }];
  const m = restMetricsForTeam(games, 0);
  assert.deepEqual(m, { daysOfRest: null, backToBack: false, threeInFour: false, roadTripLength: 1, travelMiles: null });
});

test("restMetricsForTeam: back-to-back (played yesterday) has daysOfRest 0", () => {
  const games = [
    { date: "2026-11-05", homeAway: "home", opponent: "LAL", venueLat: 1, venueLon: 1 },
    { date: "2026-11-06", homeAway: "away", opponent: "BOS", venueLat: 2, venueLon: 2, isTarget: true },
  ];
  const m = restMetricsForTeam(games, 1);
  assert.equal(m.daysOfRest, 0);
  assert.equal(m.backToBack, true);
});

test("restMetricsForTeam: 2 days off between games gives daysOfRest 1, not back-to-back", () => {
  const games = [
    { date: "2026-11-04", homeAway: "home", opponent: "LAL" },
    { date: "2026-11-06", homeAway: "away", opponent: "BOS", isTarget: true },
  ];
  const m = restMetricsForTeam(games, 1);
  assert.equal(m.daysOfRest, 1);
  assert.equal(m.backToBack, false);
});

test("restMetricsForTeam: 3-in-4 flags true when 3rd game falls inside the trailing 4-day window", () => {
  const games = [
    { date: "2026-11-03", homeAway: "home", opponent: "A" },
    { date: "2026-11-05", homeAway: "away", opponent: "B" },
    { date: "2026-11-06", homeAway: "home", opponent: "C", isTarget: true },
  ];
  const m = restMetricsForTeam(games, 2);
  assert.equal(m.threeInFour, true);
});

test("restMetricsForTeam: no 3-in-4 when only 2 games fall in the window", () => {
  const games = [
    { date: "2026-11-01", homeAway: "home", opponent: "A" },
    { date: "2026-11-06", homeAway: "home", opponent: "C", isTarget: true },
  ];
  const m = restMetricsForTeam(games, 1);
  assert.equal(m.threeInFour, false);
});

test("restMetricsForTeam: road-trip length counts consecutive away games ending at the target", () => {
  const games = [
    { date: "2026-11-01", homeAway: "home", opponent: "X" },
    { date: "2026-11-03", homeAway: "away", opponent: "A" },
    { date: "2026-11-05", homeAway: "away", opponent: "B" },
    { date: "2026-11-06", homeAway: "away", opponent: "C", isTarget: true },
  ];
  const m = restMetricsForTeam(games, 3);
  assert.equal(m.roadTripLength, 3);
});

test("restMetricsForTeam: road trip resets to 0 once home, and travelMiles is computed from consecutive venues", () => {
  const games = [
    { date: "2026-11-03", homeAway: "away", opponent: "A", venueLat: 40.0, venueLon: -75.0 },
    { date: "2026-11-06", homeAway: "home", opponent: "B", venueLat: 41.0, venueLon: -74.0, isTarget: true },
  ];
  const m = restMetricsForTeam(games, 1);
  assert.equal(m.roadTripLength, 0);
  assert.ok(m.travelMiles > 0);
});

test("buildTeamGameList: filters to one team, sorts ascending, tags venue from the home team's arena, carries isTarget", () => {
  const leagueGames = [
    { date: "2026-11-06", homeTeam: "BOS", awayTeam: "LAL", isTarget: true },
    { date: "2026-11-03", homeTeam: "LAL", awayTeam: "GSW", isTarget: false },
  ];
  const arenaTable = { BOS: { lat: 1, lon: 2 }, LAL: { lat: 3, lon: 4 } };
  const games = buildTeamGameList(leagueGames, "LAL", arenaTable);
  assert.equal(games.length, 2);
  assert.equal(games[0].date, "2026-11-03"); // ascending
  assert.equal(games[0].homeAway, "home");
  assert.equal(games[0].venueLat, 3); // LAL's own arena
  assert.equal(games[1].homeAway, "away");
  assert.equal(games[1].venueLat, 1); // BOS's arena (away game played there)
  assert.equal(games[1].isTarget, true);
});

test("buildTeamGameList: missing arena table (CBB) leaves venue coordinates null, no crash", () => {
  const leagueGames = [{ date: "2026-11-06", homeTeam: "DUKE", awayTeam: "UNC", isTarget: true }];
  const games = buildTeamGameList(leagueGames, "DUKE", null);
  assert.equal(games[0].venueLat, null);
  assert.equal(games[0].venueLon, null);
});

test("buildScheduleContextRows: one row per (team, target date), skips non-target games", () => {
  const leagueGames = [
    { date: "2026-11-04", homeTeam: "LAL", awayTeam: "GSW", isTarget: false },
    { date: "2026-11-06", homeTeam: "BOS", awayTeam: "LAL", isTarget: true },
  ];
  const rows = buildScheduleContextRows("NBA", leagueGames, new Set(["LAL", "BOS"]), null);
  assert.equal(rows.length, 2);
  const lal = rows.find((r) => r.team === "LAL");
  assert.equal(lal.league, "NBA");
  assert.equal(lal.date, "2026-11-06");
  assert.equal(lal.daysOfRest, 1); // last game 11-04, target 11-06
});

test("buildScheduleContextForLeague: pulls history+today/tomorrow via injected getJson, upserts rows, survives one bad date", async () => {
  function scoreboardWith(homeTeam, awayTeam) {
    return {
      events: [{ competitions: [{ competitors: [{ homeAway: "home", team: { abbreviation: homeTeam } }, { homeAway: "away", team: { abbreviation: awayTeam } }] }] }],
    };
  }
  const deps = {
    datesToFetch: () => ["20261104", "20261105", "20261106", "20261107"],
    getJson: async (url) => {
      if (url.includes("dates=20261104")) return scoreboardWith("LAL", "GSW");
      if (url.includes("dates=20261105")) throw new Error("ESPN hiccup"); // should be tolerated
      if (url.includes("dates=20261106")) return scoreboardWith("BOS", "LAL"); // today, target
      if (url.includes("dates=20261107")) return { events: [] }; // tomorrow, nothing
      throw new Error("unexpected " + url);
    },
    upsertRows: async (rows) => rows,
  };
  let captured;
  const wrapped = { ...deps, upsertRows: async (rows) => { captured = rows; } };
  const result = await buildScheduleContextForLeague("NBA", "20261106", wrapped);
  assert.equal(result.league, "NBA");
  assert.equal(result.teamsFound, 2); // BOS, LAL
  assert.equal(captured.length, 2);
  const lal = captured.find((r) => r.team === "LAL");
  assert.equal(lal.daysOfRest, 1); // played 11-04, target 11-06
  assert.equal(lal.home_away, "away");
});
