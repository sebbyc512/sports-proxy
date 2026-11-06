import test from "node:test";
import assert from "node:assert/strict";
import {
  extractNhlPlayerLogs,
  buildNhlPlayerLogRows,
  trackNhlPlayerLogsForDate,
  aggregateNhlPlayerForm,
} from "./nhl-player-logs.js";

const KEYS = ["blockedShots", "hits", "takeaways", "plusMinus", "timeOnIce", "shifts", "goals", "assists", "shotsTotal", "giveaways", "penaltyMinutes"];
function row({ blocked = 0, hits = 0, takeaways = 0, plusMinus = 0, toi = "0:00", shifts = 0, goals = 0, assists = 0, shots = 0, giveaways = 0, pim = 0 }) {
  return [String(blocked), String(hits), String(takeaways), String(plusMinus), toi, String(shifts), String(goals), String(assists), String(shots), String(giveaways), String(pim)];
}
function athlete(id, name, pos, stats) {
  return { athlete: { id, displayName: name, position: { abbreviation: pos } }, stats };
}

const SAMPLE = [
  {
    team: { abbreviation: "OTT" },
    statistics: [
      { name: "forwards", keys: KEYS, athletes: [athlete("1", "Michael Amadio", "RW", row({ toi: "14:32", goals: 1, assists: 2, shots: 4, hits: 3, blocked: 1, giveaways: 2, takeaways: 1 }))] },
      { name: "defenses", keys: KEYS, athletes: [athlete("3", "Jake Sanderson", "D", row({ toi: "22:10" }))] },
      // ESPN's own "skaters" group is a real field but comes back EMPTY (confirmed live,
      // 2026-11-06) -- must be ignored, not relied on, even though it's present here too.
      { name: "skaters", keys: KEYS, athletes: [] },
      { name: "goalies", keys: [], athletes: [] },
    ],
  },
  {
    team: { abbreviation: "BUF" },
    statistics: [
      { name: "forwards", keys: KEYS, athletes: [athlete("2", "Tage Thompson", "C", row({ toi: "19:05", goals: 0, assists: 1, shots: 6 }))] },
      { name: "defenses", keys: KEYS, athletes: [] },
    ],
  },
];

test("extractNhlPlayerLogs: combines forwards+defenses (ignores the empty 'skaters' group), computes points = goals+assists", () => {
  const rows = extractNhlPlayerLogs(SAMPLE, "BUF", "OTT");
  assert.equal(rows.length, 3);
  const amadio = rows.find((r) => r.player_id === "1");
  assert.equal(amadio.team, "OTT");
  assert.equal(amadio.opponent, "BUF");
  assert.equal(amadio.home_away, "home");
  assert.equal(amadio.toi_seconds, 872); // 14:32
  assert.equal(amadio.points, 3);
  assert.equal(amadio.shots, 4);
  assert.equal(amadio.hits, 3);
});

test("extractNhlPlayerLogs: unparseable TOI yields null, not a crash", () => {
  const rows = extractNhlPlayerLogs(
    [{ team: { abbreviation: "X" }, statistics: [{ name: "forwards", keys: KEYS, athletes: [athlete("9", "Nobody", "D", row({ toi: "" }))] }] }],
    "X",
    "Y"
  );
  assert.equal(rows[0].toi_seconds, null);
});

test("buildNhlPlayerLogRows: tags game_id/date/season", () => {
  const rows = buildNhlPlayerLogRows("401892644", "20261104", SAMPLE, "BUF", "OTT");
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.game_id, "401892644");
    assert.equal(r.date, "2026-11-04");
    assert.equal(r.season, "2026-27");
  }
});

test("trackNhlPlayerLogsForDate: records final games, skips others, survives per-game errors", async () => {
  const fakeScoreboard = {
    events: [
      { id: "1", status: { type: { state: "post" } }, competitions: [{ competitors: [{ homeAway: "away", team: { abbreviation: "BUF" } }, { homeAway: "home", team: { abbreviation: "OTT" } }] }] },
      { id: "2", status: { type: { state: "pre" } }, competitions: [{ competitors: [] }] },
    ],
  };
  let upserts = 0;
  const deps = {
    getJson: async (url) => {
      if (url.includes("scoreboard")) return fakeScoreboard;
      if (url.includes("event=1")) return { boxscore: { players: SAMPLE } };
      throw new Error("unexpected " + url);
    },
    upsertRows: async (rows) => { upserts++; assert.equal(rows.length, 3); },
  };
  const result = await trackNhlPlayerLogsForDate("20261104", deps);
  assert.equal(result.gamesFound, 1);
  assert.equal(result.gamesRecorded, 1);
  assert.equal(upserts, 1);
});

test("aggregateNhlPlayerForm: last-5/last-10 averages and a TOI trend", () => {
  const games = [];
  for (let i = 0; i < 12; i++) {
    const toi = i < 5 ? 1200 : i < 10 ? 900 : 1000;
    games.push({ player_id: "1", player_name: "Amadio", position: "RW", toi_seconds: toi, goals: 1, assists: 1, points: 2, shots: 3 });
  }
  const [agg] = aggregateNhlPlayerForm(games);
  assert.equal(agg.last5.toiSeconds, 1200);
  assert.equal(agg.last10.toiSeconds, 1050);
  assert.equal(agg.toiTrend, 300);
});
