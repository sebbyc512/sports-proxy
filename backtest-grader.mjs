// Backtests the grader's parsing + scoring logic against real historical legs with known
// hit/miss/push outcomes (pulled from the migrated UAT desk, which already has real settled
// tickets). See handbooks/phase2-log.md for what this found and fixed.

import fs from "fs";
import { parseLeg } from "./grader.js";
import { teamMatches, findGame } from "./matcher.js";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";
const LEAGUES = [
  ["football", "nfl"],
  ["football", "college-football"],
  ["basketball", "nba"],
  ["hockey", "nhl"],
  ["baseball", "mlb"],
  ["soccer", "eng.1"],
  ["soccer", "esp.1"],
  ["soccer", "ita.1"],
  ["soccer", "ger.1"],
  ["soccer", "fra.1"],
  ["soccer", "usa.1"],
  ["soccer", "uefa.champions"],
  ["soccer", "uefa.europa"],
];

async function fetchDateGames(date) {
  const yyyymmdd = date.replace(/-/g, "");
  const games = [];
  for (const [sport, league] of LEAGUES) {
    try {
      const res = await fetch(`${ESPN_BASE}/${sport}/${league}/scoreboard?dates=${yyyymmdd}`, {
        headers: { "User-Agent": "sports-proxy-backtest/0.2" },
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const ev of data.events || []) {
        const comp = ev.competitions?.[0];
        if (!comp || ev.status?.type?.state !== "post") continue;
        const competitors = (comp.competitors || []).map((c) => ({
          homeAway: c.homeAway,
          score: Number(c.score),
          displayName: c.team?.displayName,
          shortDisplayName: c.team?.shortDisplayName,
          abbreviation: c.team?.abbreviation,
          location: c.team?.location,
          name: c.team?.name,
        }));
        if (competitors.length === 2) games.push({ sport, league, competitors, date: ev.date });
      }
    } catch (e) {
      // skip
    }
  }
  return games;
}

function scoreLeg(parsed, game) {
  if (!game) return { verdict: "no_match" };
  const comps = game.competitors;
  const isSoccer = game.sport === "soccer";

  if (parsed.category === "ml") {
    const mine = comps.find((c) => teamMatches(parsed.team, c));
    const other = comps.find((c) => c !== mine);
    if (!mine || !other) return { verdict: "no_match" };
    if (mine.score === other.score) {
      // A 2-way team moneyline loses on a draw; it does not push. (A literal "Draw" bet
      // would be its own leg, not parsed as category "ml" against a team name.)
      return { verdict: isSoccer ? "miss" : "push" };
    }
    return { verdict: mine.score > other.score ? "hit" : "miss" };
  }
  if (parsed.category === "spread") {
    const mine = comps.find((c) => teamMatches(parsed.team, c));
    const other = comps.find((c) => c !== mine);
    if (!mine || !other) return { verdict: "no_match" };
    const margin = mine.score - other.score + parsed.line;
    if (margin === 0) return { verdict: "push" };
    return { verdict: margin > 0 ? "hit" : "miss" };
  }
  if (parsed.category === "total") {
    const combined = comps[0].score + comps[1].score;
    if (combined === parsed.line) return { verdict: "push" };
    const over = combined > parsed.line;
    return { verdict: (parsed.direction === "over") === over ? "hit" : "miss" };
  }
  return { verdict: "unsupported" };
}

async function main() {
  const samples = JSON.parse(fs.readFileSync("backtest-samples.json", "utf8"));
  const dates = new Set();
  for (const s of samples) {
    const d = new Date(s.date + "T12:00:00Z");
    for (const delta of [-1, 0, 1]) {
      const dd = new Date(d);
      dd.setUTCDate(dd.getUTCDate() + delta);
      dates.add(dd.toISOString().slice(0, 10));
    }
  }
  const gamesByDate = {};
  for (const date of dates) {
    gamesByDate[date] = await fetchDateGames(date);
  }

  let correct = 0, wrong = 0, noMatch = 0, unsupported = 0;
  const wrongDetails = [];
  const noMatchDetails = [];

  for (const s of samples) {
    const parsed = parseLeg(s.legText, s.legType);
    if (parsed.category === "unsupported") {
      unsupported++;
      continue;
    }
    const d0 = new Date(s.date + "T12:00:00Z");
    const windowDates = [-1, 0, 1].map((delta) => {
      const dd = new Date(d0);
      dd.setUTCDate(dd.getUTCDate() + delta);
      return dd.toISOString().slice(0, 10);
    });
    const games = windowDates.flatMap((d) => gamesByDate[d] || []);
    const teamQuery = parsed.team || parsed.rawA;
    const oppQuery = parsed.opponent || parsed.rawB;
    const game = findGame(games, teamQuery || "", oppQuery || "");
    const { verdict } = scoreLeg(parsed, game);
    const actual = s.legStatus;
    if (verdict === "no_match") {
      noMatch++;
      noMatchDetails.push(`${s.date} [${s.legType}] "${s.legText}" (actual: ${actual})`);
      continue;
    }
    if (verdict === actual) {
      correct++;
    } else {
      wrong++;
      wrongDetails.push(`${s.date} [${s.legType}] "${s.legText}" -> computed ${verdict}, actual ${actual}`);
    }
  }

  console.log("=== Backtest results ===");
  console.log(`Total eligible legs: ${samples.length}`);
  console.log(`Unsupported (correctly deferred to needs_review): ${unsupported}`);
  console.log(`Matched to a real game: ${correct + wrong}`);
  console.log(`  Correct verdict: ${correct}`);
  console.log(`  WRONG verdict: ${wrong}`);
  console.log(`Could not confidently find the game (needs_review, not a wrong grade): ${noMatch}`);
  if (correct + wrong > 0) {
    console.log(`Accuracy among matched legs: ${((correct / (correct + wrong)) * 100).toFixed(1)}%`);
  }
  if (wrongDetails.length) {
    console.log("\n--- WRONG verdicts (must fix before trusting) ---");
    wrongDetails.forEach((d) => console.log("  " + d));
  }
  if (noMatchDetails.length) {
    console.log("\n--- No confident game match (stays needs_review) ---");
    noMatchDetails.forEach((d) => console.log("  " + d));
  }
}

main();
