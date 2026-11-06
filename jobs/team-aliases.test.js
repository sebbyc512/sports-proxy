import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTeamName, matchOddsEvent } from "./team-aliases.js";

test("normalizeTeamName: lowercases and strips punctuation/filler words", () => {
  assert.equal(normalizeTeamName("Los Angeles Lakers"), "los angeles lakers");
  assert.equal(normalizeTeamName("University of Connecticut"), "connecticut");
});

test("matchOddsEvent: exact normalized match", () => {
  const events = [
    { id: "1", home_team: "Boston Celtics", away_team: "Los Angeles Lakers" },
    { id: "2", home_team: "Miami Heat", away_team: "Orlando Magic" },
  ];
  const { event, reason } = matchOddsEvent(events, "Boston Celtics", "LA Lakers", "NBA");
  assert.equal(event?.id, "1");
  assert.equal(reason, null);
});

test("matchOddsEvent: alias table resolves known ESPN/Odds-API mismatches", () => {
  const events = [{ id: "5", home_team: "Connecticut", away_team: "Duke" }];
  const { event } = matchOddsEvent(events, "UConn", "Duke", "CBB");
  assert.equal(event?.id, "5");
});

test("matchOddsEvent: matches regardless of which side ESPN vs Odds API call home", () => {
  const events = [{ id: "9", home_team: "Los Angeles Lakers", away_team: "Boston Celtics" }];
  const { event } = matchOddsEvent(events, "Boston Celtics", "LA Lakers", "NBA");
  assert.equal(event?.id, "9");
});

test("matchOddsEvent: no match returns null event + a clear reason, never a guess", () => {
  const events = [{ id: "1", home_team: "Miami Heat", away_team: "Orlando Magic" }];
  const { event, reason } = matchOddsEvent(events, "Boston Celtics", "LA Lakers", "NBA");
  assert.equal(event, null);
  assert.ok(reason.includes("no Odds API event matched"));
});
