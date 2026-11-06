import test from "node:test";
import assert from "node:assert/strict";
import {
  extractNbaPlayerLogs,
  buildNbaPlayerLogRows,
  trackNbaPlayerLogsForDate,
  aggregateNbaPlayerForm,
  nbaAbbr,
} from "./nba-player-logs.js";

function athlete(id, name, pos, starter, stats) {
  return { athlete: { id, displayName: name, position: { abbreviation: pos } }, starter, stats };
}

const KEYS = [
  "minutes",
  "fieldGoalsMade-fieldGoalsAttempted",
  "threePointFieldGoalsMade-threePointFieldGoalsAttempted",
  "freeThrowsMade-freeThrowsAttempted",
  "rebounds",
  "assists",
  "steals",
  "blocks",
  "turnovers",
  "points",
];
// index:                0           1                              2                        3                       4        5        6       7       8            9
function statsRow({ min, fg = "0-0", three = "0-0", ft = "0-0", reb = 0, ast = 0, stl = 0, blk = 0, tov = 0, pts = 0 }) {
  return [String(min), fg, three, ft, String(reb), String(ast), String(stl), String(blk), String(tov), String(pts)];
}

const SAMPLE_BOXSCORE = [
  {
    team: { abbreviation: "GS" },
    statistics: [
      {
        keys: KEYS,
        athletes: [
          athlete("1", "Steph Curry", "PG", true, statsRow({ min: 34, three: "6-11", reb: 4, ast: 7, stl: 1, blk: 0, tov: 2, pts: 29 })),
          athlete("2", "Bench Guy", "SG", false, statsRow({ min: 12, pts: 4, reb: 2, ast: 1 })),
          athlete("3", "DNP Guy", "C", false, ["DNP", "0-0", "0-0", "0-0", "0", "0", "0", "0", "0", "0"]),
        ],
      },
    ],
  },
  {
    team: { abbreviation: "LAL" },
    statistics: [
      {
        keys: KEYS,
        athletes: [athlete("4", "LeBron James", "PF", true, statsRow({ min: 36, three: "2-5", reb: 8, ast: 9, stl: 1, blk: 1, tov: 3, pts: 25 }))],
      },
    ],
  },
];

test("extractNbaPlayerLogs pulls every dressed player, splits made/att, skips nothing but keeps DNP flagged", () => {
  // Callers always pass already-normalized abbreviations (nbaAbbr() applied before this
  // call, same as trackNbaPlayerLogsForDate does) -- "GSW", not ESPN's raw "GS".
  const rows = extractNbaPlayerLogs(SAMPLE_BOXSCORE, "LAL", "GSW");
  assert.equal(rows.length, 4);
  const curry = rows.find((r) => r.player_id === "1");
  assert.equal(curry.team, "GSW"); // nbaAbbr("GS") -> "GSW"
  assert.equal(curry.opponent, "LAL");
  assert.equal(curry.home_away, "home");
  assert.equal(curry.started, true);
  assert.equal(curry.minutes, 34);
  assert.equal(curry.three_pm, 6);
  assert.equal(curry.points, 29);
  assert.equal(curry.did_not_play, false);

  const dnp = rows.find((r) => r.player_id === "3");
  assert.equal(dnp.did_not_play, true);
  assert.equal(dnp.minutes, 0);

  const lebron = rows.find((r) => r.player_id === "4");
  assert.equal(lebron.team, "LAL");
  assert.equal(lebron.opponent, "GSW");
  assert.equal(lebron.home_away, "away");
});

test("nbaAbbr maps ESPN's oddball team abbreviations to canonical ones", () => {
  assert.equal(nbaAbbr("UTAH"), "UTA");
  assert.equal(nbaAbbr("GS"), "GSW");
  assert.equal(nbaAbbr("BOS"), "BOS"); // passthrough for anything not in the table
});

test("buildNbaPlayerLogRows tags game_id/date/season onto every extracted row", () => {
  const rows = buildNbaPlayerLogRows("401584793", "20261105", SAMPLE_BOXSCORE, "LAL", "GSW");
  assert.equal(rows.length, 4);
  for (const r of rows) {
    assert.equal(r.game_id, "401584793");
    assert.equal(r.date, "2026-11-05");
    assert.equal(r.season, "2026-27");
  }
});

test("trackNbaPlayerLogsForDate skips non-final games, upserts rows for final ones, and survives a per-game failure", async () => {
  const fakeScoreboard = {
    events: [
      {
        id: "1",
        status: { type: { state: "post" } },
        competitions: [
          {
            competitors: [
              { homeAway: "away", team: { abbreviation: "LAL" } },
              { homeAway: "home", team: { abbreviation: "GS" } },
            ],
          },
        ],
      },
      { id: "2", status: { type: { state: "pre" } }, competitions: [{ competitors: [] }] }, // not final -> skipped
      {
        id: "3",
        status: { type: { state: "post" } },
        competitions: [{ competitors: [{ homeAway: "away", team: {} }] }], // missing home -> skipped
      },
    ],
  };
  let upsertCalls = 0;
  const deps = {
    getJson: async (url) => {
      if (url.includes("scoreboard")) return fakeScoreboard;
      if (url.includes("event=1")) return { boxscore: { players: SAMPLE_BOXSCORE } };
      throw new Error("unexpected url " + url);
    },
    upsertRows: async (rows) => {
      upsertCalls++;
      assert.equal(rows.length, 4);
    },
  };
  const result = await trackNbaPlayerLogsForDate("20261105", deps);
  assert.equal(result.gamesFound, 2); // only the two "post" events
  assert.equal(result.gamesRecorded, 1);
  assert.equal(upsertCalls, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, "missing competitors");
});

test("trackNbaPlayerLogsForDate reports a scoreboard fetch failure without throwing", async () => {
  const deps = { getJson: async () => { throw new Error("ESPN down"); }, upsertRows: async () => {} };
  const result = await trackNbaPlayerLogsForDate("20261105", deps);
  assert.equal(result.error, "ESPN down");
  assert.equal(result.gamesFound, 0);
});

test("aggregateNbaPlayerForm computes last-5/last-10 averages and a minutes trend per player", () => {
  // 12 games, most-recent-first: minutes trending up the last 5 (30) vs the 5 before (20).
  const games = [];
  for (let i = 0; i < 12; i++) {
    const minutes = i < 5 ? 30 : i < 10 ? 20 : 25;
    games.push({ player_id: "1", player_name: "Steph Curry", position: "PG", minutes, points: 25, rebounds: 4, assists: 6, three_pm: 5, steals: 1, blocks: 0, turnovers: 2 });
  }
  const [agg] = aggregateNbaPlayerForm(games);
  assert.equal(agg.player_id, "1");
  assert.equal(agg.gamesTracked, 12);
  assert.equal(agg.last5.minutes, 30);
  assert.equal(agg.last10.minutes, 25); // (5*30 + 5*20)/10
  assert.equal(agg.minutesTrend, 10); // 30 - 20
});

test("aggregateNbaPlayerForm returns null trend when fewer than 6 games tracked", () => {
  const games = [{ player_id: "2", player_name: "Bench Guy", position: "SG", minutes: 10, points: 4, rebounds: 2, assists: 1, three_pm: 0, steals: 0, blocks: 0, turnovers: 0 }];
  const [agg] = aggregateNbaPlayerForm(games);
  assert.equal(agg.minutesTrend, null);
});
