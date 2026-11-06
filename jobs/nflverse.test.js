import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInjuryRows,
  buildSnapCountRows,
  buildTeamEpaRows,
  aggregateTeamEpaForm,
  runNflverseJob,
  NFLVERSE_FILES,
} from "./nflverse.js";

test("buildInjuryRows: maps the raw CSV fields straight across", () => {
  const rows = buildInjuryRows([
    { season: "2026", week: "9", team: "KC", gsis_id: "00-123", full_name: "Pat Mahomes", position: "QB", report_status: "Questionable", report_primary_injury: "Ankle", report_secondary_injury: "", practice_status: "Limited" },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].player_name, "Pat Mahomes");
  assert.equal(rows[0].week, 9);
  assert.equal(rows[0].report_status, "Questionable");
});

test("buildSnapCountRows: coerces numeric snap/pct fields, keeps empty secondary injury as null elsewhere handled by caller", () => {
  const rows = buildSnapCountRows([
    { game_id: "g1", season: "2026", week: "9", team: "KC", opponent: "BUF", player: "Travis Kelce", pfr_player_id: "KelcTr00", position: "TE", offense_snaps: "58", offense_pct: "0.92", defense_snaps: "0", defense_pct: "0", st_snaps: "2", st_pct: "0.03" },
  ]);
  assert.equal(rows[0].offense_snaps, 58);
  assert.equal(rows[0].offense_pct, 0.92);
});

test("buildTeamEpaRows: pairs a game's two teams so defense_epa_per_play is the opponent's offense_epa_per_play", () => {
  const rows = [
    { season: "2026", week: "9", game_id: "g1", team: "KC", opponent_team: "BUF", passing_epa: "10", rushing_epa: "2", attempts: "30", carries: "20" },
    { season: "2026", week: "9", game_id: "g1", team: "BUF", opponent_team: "KC", passing_epa: "5", rushing_epa: "1", attempts: "25", carries: "25" },
  ];
  const out = buildTeamEpaRows(rows);
  assert.equal(out.length, 2);
  const kc = out.find((r) => r.team === "KC");
  const buf = out.find((r) => r.team === "BUF");
  assert.equal(kc.offense_epa_per_play, 0.24); // (10+2)/50
  assert.equal(kc.defense_epa_per_play, buf.offense_epa_per_play); // KC's defense faced BUF's offense
  assert.equal(buf.offense_epa_per_play, 0.12); // (5+1)/50
});

test("buildTeamEpaRows: null epaPerPlay when a team ran 0 plays, doesn't crash the pairing", () => {
  const rows = [
    { season: "2026", week: "9", game_id: "g1", team: "KC", opponent_team: "BUF", passing_epa: "0", rushing_epa: "0", attempts: "0", carries: "0" },
    { season: "2026", week: "9", game_id: "g1", team: "BUF", opponent_team: "KC", passing_epa: "5", rushing_epa: "1", attempts: "25", carries: "25" },
  ];
  const out = buildTeamEpaRows(rows);
  const kc = out.find((r) => r.team === "KC");
  assert.equal(kc.offense_epa_per_play, null);
  assert.equal(kc.defense_epa_per_play, 0.12);
});

test("aggregateTeamEpaForm: season average over all weeks, last4Weeks over the most recent 4", () => {
  const rows = [];
  for (let week = 1; week <= 6; week++) {
    rows.push({ team: "KC", week, offense_epa_per_play: week <= 2 ? 0.0 : 0.2, defense_epa_per_play: -0.1 });
  }
  const [agg] = aggregateTeamEpaForm(rows);
  assert.equal(agg.weeksTracked, 6);
  assert.equal(agg.season.offenseEpaPerPlay, Number(((0 + 0 + 0.2 * 4) / 6).toFixed(4)));
  assert.equal(agg.last4Weeks.offenseEpaPerPlay, 0.2); // weeks 3-6, all 0.2
});

test("runNflverseJob: downloads all three files via injected fetchText, upserts per entity type, isolates one failure", async () => {
  const injuriesCsv = "season,week,team,gsis_id,full_name,position,report_status,report_primary_injury,report_secondary_injury,practice_status\n2026,9,KC,00-1,Pat Mahomes,QB,Questionable,Ankle,,Limited\n";
  const snapsCsv = "game_id,season,week,team,opponent,player,pfr_player_id,position,offense_snaps,offense_pct,defense_snaps,defense_pct,st_snaps,st_pct\ng1,2026,9,KC,BUF,Travis Kelce,KelcTr00,TE,58,0.92,0,0,2,0.03\n";
  const upserted = {};
  const deps = {
    fetchText: async (url) => {
      if (url === NFLVERSE_FILES.injuries) return injuriesCsv;
      if (url === NFLVERSE_FILES.snapCounts) return snapsCsv;
      if (url === NFLVERSE_FILES.teamStatsWeek) throw new Error("GitHub release down");
      throw new Error("unexpected " + url);
    },
    upsertRows: async (type, rows) => { upserted[type] = rows; },
  };
  const result = await runNflverseJob(deps);
  assert.equal(result.injuries, 1);
  assert.equal(result.snapCounts, 1);
  assert.equal(result.teamEpa, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].file, "teamEpa");
  assert.ok(upserted.injuries && upserted.snapCounts);
});
