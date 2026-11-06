import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import {
  buildMoneypuckTeamRows,
  buildMoneypuckGoalieRows,
  buildMoneypuckSkaterRows,
  buildMoneypuckShotRows,
  runMoneypuckJob,
  MONEYPUCK_FILES,
} from "./moneypuck.js";

test("buildMoneypuckShotRows: picks the shooting team from isHomeTeam, coerces goal/on_goal to real booleans, filters by season", () => {
  const rows = [
    { season: "2026", shotID: "s1", game_id: "g1", event: "SHOT", period: "2", time: "612", isHomeTeam: "1", homeTeamCode: "ANA", awayTeamCode: "VGK", shooterPlayerId: "2", shooterName: "Troy Terry", shotType: "WRIST", xCord: "70", yCord: "-5", arenaAdjustedShotDistance: "22", xGoal: "0.08", goal: "1", shotWasOnGoal: "1" },
    { season: "2025", shotID: "s0", game_id: "g0", isHomeTeam: "0", homeTeamCode: "X", awayTeamCode: "Y" }, // wrong season, excluded
  ];
  const out = buildMoneypuckShotRows(rows, "2026");
  assert.equal(out.length, 1);
  assert.equal(out[0].team, "ANA");
  assert.equal(out[0].goal, true);
  assert.equal(out[0].on_goal, true);
  assert.equal(out[0].x_goal, 0.08);
});

test("buildMoneypuckTeamRows: pairs a game's two team rows so xga is the opponent's xgf, filters to season+situation+Team Level", () => {
  const rows = [
    { season: "2026", situation: "all", position: "Team Level", gameId: "g1", team: "ANA", opposingTeam: "VGK", gameDate: "20261002", home_or_away: "AWAY", xGoalsFor: "2.1", highDangerShotsFor: "4", shotsOnGoalFor: "28", goalsFor: "3" },
    { season: "2026", situation: "all", position: "Team Level", gameId: "g1", team: "VGK", opposingTeam: "ANA", gameDate: "20261002", home_or_away: "HOME", xGoalsFor: "3.4", highDangerShotsFor: "7", shotsOnGoalFor: "31", goalsFor: "4" },
    { season: "2026", situation: "5on5", position: "Team Level", gameId: "g1", team: "ANA", opposingTeam: "VGK", xGoalsFor: "1.0" }, // wrong situation, excluded
    { season: "2025", situation: "all", position: "Team Level", gameId: "g0", team: "ANA", opposingTeam: "LAK", xGoalsFor: "9" }, // wrong season, excluded
  ];
  const out = buildMoneypuckTeamRows(rows, "2026");
  assert.equal(out.length, 2);
  const ana = out.find((r) => r.team === "ANA");
  assert.equal(ana.date, "2026-10-02");
  assert.equal(ana.home_away, "away");
  assert.equal(ana.xgf, 2.1);
  assert.equal(ana.xga, 3.4); // VGK's xgf
  assert.equal(ana.high_danger_shots_against, 7);
});

test("buildMoneypuckGoalieRows: computes GSAx = xGoals - goals, filters to season+'all' situation", () => {
  const rows = [
    { season: "2026", situation: "all", playerId: "1", name: "Lukas Dostal", gameId: "g1", playerTeam: "ANA", opposingTeam: "VGK", gameDate: "20261002", home_or_away: "AWAY", icetime: "3600", xGoals: "3.184", goals: "3", highDangerShots: "14", highDangerGoals: "2" },
    { season: "2026", situation: "5on5", playerId: "1", name: "Lukas Dostal", gameId: "g1", xGoals: "2.1", goals: "2" }, // excluded
  ];
  const out = buildMoneypuckGoalieRows(rows, "2026");
  assert.equal(out.length, 1);
  assert.equal(out[0].gsax, 0.184);
  assert.equal(out[0].player_name, "Lukas Dostal");
});

test("buildMoneypuckGoalieRows: GSAx is null if either input is unparsable", () => {
  const rows = [{ season: "2026", situation: "all", playerId: "1", gameId: "g1", xGoals: "", goals: "3" }];
  const out = buildMoneypuckGoalieRows(rows, "2026");
  assert.equal(out[0].gsax, null);
});

test("buildMoneypuckSkaterRows: pulls xG and both shot counts from the I_F_ individual-skater columns", () => {
  const rows = [
    { season: "2026", situation: "all", playerId: "2", name: "Troy Terry", gameId: "g1", playerTeam: "ANA", opposingTeam: "VGK", gameDate: "20261002", home_or_away: "AWAY", position: "R", icetime: "1100", I_F_xGoals: "0.45", I_F_goals: "1", I_F_shotsOnGoal: "4", I_F_shotAttempts: "6" },
  ];
  const out = buildMoneypuckSkaterRows(rows, "2026");
  assert.equal(out.length, 1);
  assert.equal(out[0].xg, 0.45);
  assert.equal(out[0].shots_on_goal, 4);
  assert.equal(out[0].shot_attempts, 6);
});

function zipOf(name, content) {
  const data = deflateRawSync(Buffer.from(content, "utf8"));
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(8, 8); // deflate
  header.writeUInt32LE(data.length, 18);
  header.writeUInt16LE(Buffer.byteLength(name), 26);
  return Buffer.concat([header, Buffer.from(name, "utf8"), data]);
}

test("runMoneypuckJob: downloads all four files via injected fetchBinary, unzips, upserts per entity type, isolates one file's failure", async () => {
  const teamsCsv = "season,situation,position,gameId,team,opposingTeam,gameDate,home_or_away,xGoalsFor,highDangerShotsFor,shotsOnGoalFor,goalsFor\n" +
    '2026,all,Team Level,g1,ANA,VGK,20261002,AWAY,2.1,4,28,3\n2026,all,Team Level,g1,VGK,ANA,20261002,HOME,3.4,7,31,4\n';
  const goaliesCsv = "season,situation,playerId,name,gameId,playerTeam,opposingTeam,gameDate,home_or_away,icetime,xGoals,goals,highDangerShots,highDangerGoals\n" +
    "2026,all,1,Lukas Dostal,g1,ANA,VGK,20261002,AWAY,3600,3.184,3,14,2\n";
  const skatersCsv = "season,situation,playerId,name,gameId,playerTeam,opposingTeam,gameDate,home_or_away,position,icetime,I_F_xGoals,I_F_goals,I_F_shotsOnGoal,I_F_shotAttempts\n" +
    "2026,all,2,Troy Terry,g1,ANA,VGK,20261002,AWAY,R,1100,0.45,1,4,6\n";

  const upserted = {};
  const deps = {
    fetchBinary: async (url) => {
      if (url === MONEYPUCK_FILES.teamsAllSeasons) return Buffer.from(teamsCsv, "utf8"); // not a zip
      if (url === MONEYPUCK_FILES.goalies) return zipOf("2026.csv", goaliesCsv);
      if (url === MONEYPUCK_FILES.skaters) return zipOf("2026.csv", skatersCsv);
      if (url === MONEYPUCK_FILES.shots) throw new Error("shots endpoint down"); // simulate one failure
      throw new Error("unexpected url " + url);
    },
    upsertRows: async (type, rows) => { upserted[type] = rows; },
  };
  const result = await runMoneypuckJob(deps);
  assert.equal(result.teams, 2);
  assert.equal(result.goalies, 1);
  assert.equal(result.skaters, 1);
  assert.equal(result.shots, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].file, "shots");
  assert.ok(upserted.team && upserted.goalie && upserted.skater);
  assert.equal(upserted.goalie[0].gsax, 0.184);
});
