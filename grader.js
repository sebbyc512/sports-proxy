// Phase 2 grader — parses leg text into a structured bet (team/number/matchup) for the
// bet types where a fixed rule can confidently settle it: moneyline, spread, GAME-level
// totals, single-stat player props, and anytime-TD scorer. First-TD (who scored FIRST, not
// just whether they scored), player-prop combo stats ("hits + runs + RBIs"), and anytime
// GOALscorer (soccer) are deliberately out of scope — they need data this parser doesn't have
// (play-by-play order, multi-stat composition) and returning a wrong grade on real money is
// worse than needs_review. Built and tuned against real leg-text examples pulled from the
// migrated desks (see handbooks/phase2-log.md, test-grader-coverage.mjs) — deliberately
// conservative: coverage over cleverness, and a pattern is only added once a real example
// needs it.

const TEAM = "[\\p{L}0-9.'\\-& ]+?";
const SEP = "(?:vs|v|@|at)"; // all separators actually seen between two team names

// Noise substrings that appear around a real market description but carry no settlement
// information — stripped before pattern matching so one pattern covers many real variants
// instead of needing a new regex per annotation style.
const NOISE_RES = [
  // These three run first, before the generic bare-word "live" stripper below mangles a
  // "LIVE: " prefix, and before the kickoff-time stripper so a parenthetical with trailing
  // in-game commentary ("...ET; had 1 catch at 3-3 in the 1st)") is already cleaned up to end
  // in "...ET)" by the time the kickoff-time pattern runs.
  /^LIVE:\s*/gi, // "LIVE: Player N+ Stat (...)" prefix on a bet placed mid-game
  [/;[^()]*\)/g, ")"], // trailing in-game commentary inside the matchup parens -> just ")"
  /\s*\*\(I am 55% or less sure on this leg, add at your own risk\)\s*$/gi, // low-confidence 3-unit leg marker
  /,\s*alt\b/gi, // "Over 45.5 total points, alt (Low)" -> "Over 45.5 total points (Low)"
  /\([^()]*\d{1,2}:\d{2}\s*[AP]M\s*ET\)/gi, // trailing kickoff/tip time, e.g. "(7:00 PM ET)" or "(90 min, 12:30 PM ET)"
  [/\(\s*\d+\s*Pick SGP,\s*([^)]*)\)/gi, "($1)"], // "(2 Pick SGP, A vs B)" -> "(A vs B)"
  /\bSGP\s*\([+-]\d+\):\s*/gi, // "SGP (-115): " prefix
  /\s-\s*(?=SGP|$)/gi,
  /\(alt [a-z ]+\)/gi, // "(alt puck line)", "(alt spread)", etc.
  /\(alt\)/gi,
  /\balt spread\b/gi,
  /\(spread alternate\)/gi,
  /\balternate\b/gi,
  /\((?:low|med(?:ium)?(?:-high)?|high|sprinkle)\)/gi, // staking-size annotations, incl. "(Med-High)"
  /\b3-way\b/gi,
  /\blive\b/gi,
];

function normalize(text) {
  let t = text;
  for (const entry of NOISE_RES) {
    const [re, replacement] = Array.isArray(entry) ? entry : [entry, " "];
    t = t.replace(re, replacement);
  }
  return t.replace(/\(\s*\)/g, "").replace(/\s{2,}/g, " ").trim();
}

const ML_PATTERNS = [
  // "Arsenal Moneyline (Arsenal vs Lille) -475" / "... (A @ B)" / "... (A v B)"
  new RegExp(`^(?<team>${TEAM}) Moneyline\\s*\\((?<a>${TEAM}) ${SEP} (?<b>${TEAM})\\)\\s*([+-]\\d+)?$`, "iu"),
  // "Real Madrid Moneyline -425 (Real Madrid vs RB Leipzig)"
  new RegExp(`^(?<team>${TEAM}) Moneyline\\s*[+-]\\d+\\s*\\((?<a>${TEAM}) ${SEP} (?<b>${TEAM})\\)$`, "iu"),
  // "Como Moneyline (+120) - Feyenoord vs Como" — price in parens, then " - A vs B".
  new RegExp(`^(?<team>${TEAM}) Moneyline\\s*(?:\\([+-]\\d+\\))?\\s*-\\s*(?<a>${TEAM}) ${SEP} (?<b>${TEAM})$`, "iu"),
  // "Washington moneyline vs Minnesota" / "Alabama ML at Tennessee" — bare, no price/parens.
  new RegExp(`^(?<team>${TEAM}) (?:Moneyline|ML) ${SEP} (?<opp>${TEAM})$`, "iu"),
  // "LSU ML (vs Mississippi State)" — opponent wrapped in its own parens.
  new RegExp(`^(?<team>${TEAM}) (?:Moneyline|ML)\\s*\\(${SEP} (?<opp>${TEAM})\\)$`, "iu"),
  // "Texas Moneyline (-440) vs FLA" / "DAL Cowboys Moneyline (-105) at GB"
  new RegExp(`^(?<team>${TEAM}) Moneyline\\s*\\([+-]\\d+\\)\\s*${SEP} (?<opp>${TEAM})$`, "iu"),
  // "Utah Moneyline (-990)" — no opponent in text; caller supplies ticket context.
  new RegExp(`^(?<team>${TEAM}) Moneyline\\s*\\([+-]\\d+\\)$`, "iu"),
  // "LA Dodgers Moneyline" — bare, no price or opponent at all.
  new RegExp(`^(?<team>${TEAM}) Moneyline$`, "iu"),
];

const SPREAD_PATTERNS = [
  // "CLE Browns +7.5 Spread Alternate (-232) vs BAL" / "Commanders +7.5 (at 49ers)" / "Browns +7.5 (vs Ravens)"
  new RegExp(`^(?<team>${TEAM}) (?<num>[+-]\\d+\\.?\\d*)\\s*(?:(?:Spread|Puck Line)\\s*)?(?:\\([+-]\\d+\\)\\s*)?\\(?${SEP} (?<opp>${TEAM})\\)?$`, "iu"),
  // "MTL Canadiens +1.5 Puck Line (MTL vs WAS)"
  new RegExp(`^(?<team>${TEAM}) (?<num>[+-]\\d+\\.?\\d*) (?:Spread|Puck Line)\\s*\\((?<a>${TEAM}) ${SEP} (?<b>${TEAM})\\)$`, "iu"),
  // "Colorado +19.5 Spread (-117)" — price in parens, no opponent.
  new RegExp(`^(?<team>${TEAM}) (?<num>[+-]\\d+\\.?\\d*) Spread\\s*\\([+-]\\d+\\)$`, "iu"),
  // "SF 49ers -3.5 Spread" / "Knicks +7.5 spread" — no opponent in text.
  new RegExp(`^(?<team>${TEAM}) (?<num>[+-]\\d+\\.?\\d*)\\s*Spread$`, "iu"),
  // "Yankees -1.5" / "Indiana +3.5" / "Thunder -8.5 vs Nuggets" — bare team+number, with or
  // without a trailing "vs/at Opponent".
  new RegExp(`^(?<team>${TEAM}) (?<num>[+-]\\d+\\.?\\d*)(?:\\s*${SEP} (?<opp>${TEAM}))?$`, "iu"),
];

const TOTAL_PATTERNS = [
  // "Over 2.5 Total Goals (Inter Milan vs Club Brugge) -250"
  new RegExp(`^(?<dir>Over|Under) (?<num>\\d+\\.?\\d*) Total (?:Goals|Points|Runs)\\s*\\((?<a>${TEAM}) ${SEP} (?<b>${TEAM})\\)\\s*([+-]\\d+)?$`, "iu"),
  // "Over 2.5 Total Goals - Eintracht vs Cologne (-285)" / "Eintracht Frankfurt vs Cologne - Over 2.5 Total Goals (-320)"
  new RegExp(`^(?<dir>Over|Under) (?<num>\\d+\\.?\\d*) Total (?:Goals|Points|Runs) - (?<a>${TEAM}) ${SEP} (?<b>${TEAM})\\s*(?:\\([+-]\\d+\\))?$`, "iu"),
  new RegExp(`^(?<a>${TEAM}) ${SEP} (?<b>${TEAM}) - (?<dir>Over|Under) (?<num>\\d+\\.?\\d*) Total (?:Goals|Points|Runs)\\s*(?:\\([+-]\\d+\\))?$`, "iu"),
  // SGP-style: after normalize() strips "N Pick SGP, " / "SGP (price): " the matchup and
  // market usually land next to each other, e.g. "Over 1.5 Total Goals Aston Villa vs Fenerbahce)".
  new RegExp(`^(?<dir>Over|Under) (?<num>\\d+\\.?\\d*) Total (?:Goals|Points|Runs)\\s*\\(?(?<a>${TEAM}) ${SEP} (?<b>${TEAM})\\)?$`, "iu"),
  new RegExp(`^(?<a>${TEAM}) ${SEP} (?<b>${TEAM})\\s*:?\\s*(?<dir>Over|Under) (?<num>\\d+\\.?\\d*) Total (?:Goals|Points|Runs)$`, "iu"),
  // "Over 44.5 (Total Alternate)" / "Over 45.5 Total Alternate" — no matchup; use ticket context.
  new RegExp(`^(?<dir>Over|Under) (?<num>\\d+\\.?\\d*)\\s*(?:\\(Total\\s*\\)|Total)?$`, "iu"),
];

// A single TEAM's own total, not the combined game total — needs that team's score alone
// (TEAM_TOTAL_RE routes these to TEAM_TOTAL_PATTERNS below instead of TOTAL_PATTERNS).
const TEAM_TOTAL_RE = /Team Total (?:Goals|Points|Runs)/i;

const TEAM_TOTAL_PATTERNS = [
  // "Real Madrid Over 1.5 Team Total Goals (RB Leipzig vs Real Madrid)" / "... (Real Betis v Feyenoord) -140"
  new RegExp(`^(?<team>${TEAM}) (?<dir>Over|Under) (?<num>\\d+\\.?\\d*) Team Total (?:Goals|Points|Runs)\\s*(?:\\((?<a>${TEAM}) ${SEP} (?<b>${TEAM})\\))?\\s*([+-]\\d+)?$`, "iu"),
];

// --- Player props + anytime TD ---
// Same character class as TEAM — player names use the same punctuation (apostrophes, periods,
// hyphens: "De'Aaron Fox", "Luis Garcia Jr.", "Ja'Kobi Gillespie").
const PLAYER = TEAM;

// canonical stat key -> [sport this phrase unambiguously implies, or "ambiguous" when the same
// word is used by more than one sport (Points/Assists: NBA or NHL) and the caller has to
// resolve it from team context or by scanning both sports' box scores for the player.
// Longest phrase first within each sport so "Receiving Yards" is tried before any shorter
// phrase that might also appear inside it.
const STAT_PHRASES = [
  ["Receiving Yards", "recYds", "nfl"],
  ["Rushing Yards", "rushYds", "nfl"],
  ["Rushing Attempts", "rushAtt", "nfl"],
  ["Rush Attempts", "rushAtt", "nfl"],
  ["Passing Yards", "passYds", "nfl"],
  ["Passing Touchdowns", "passTd", "nfl"],
  ["Passing TDs", "passTd", "nfl"],
  ["Passing TD", "passTd", "nfl"],
  ["Receptions", "receptions", "nfl"],
  ["Completions", "completions", "nfl"],
  ["Touchdowns", "anyTdCount", "nfl"],
  ["TDs", "anyTdCount", "nfl"],
  ["Rebounds", "rebounds", "nba"],
  ["Blocks", "blocks", "nba"],
  ["Steals", "steals", "nba"],
  ["3-Pointers Made", "threes", "nba"],
  ["Three Pointers Made", "threes", "nba"],
  ["Threes", "threes", "nba"],
  ["3PM", "threes", "nba"],
  ["Shots on Goal", "shotsOnGoal", "nhl"],
  ["Strikeouts Thrown", "strikeouts", "mlb"],
  ["Strikeouts", "strikeouts", "mlb"],
  ["Outs Recorded", "outsRecorded", "mlb"],
  ["Hits", "hits", "mlb"],
  ["Hit", "hits", "mlb"], // "1+ hit" (singular) is just as common in real data as "1+ Hits"
  ["Points", "points", "ambiguous"], // NBA points or NHL points (goals+assists)
  ["Point", "points", "ambiguous"], // singular, e.g. "Connor McDavid 1+ point"
  ["Assists", "assists", "ambiguous"], // NBA or NHL
  ["Goals", "goals", "nhl"], // soccer goals handled separately (anytime goalscorer, unsupported)
].sort((a, b) => b[0].length - a[0].length);

const STAT_KEY_BY_PHRASE = new Map(STAT_PHRASES.map(([phrase, key, sport]) => [phrase.toLowerCase(), { key, sport }]));
const STAT_ALT = STAT_PHRASES.map(([phrase]) => phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

const STAT_PATTERNS = [
  // "Jaxon Smith-Njigba 7+ Receptions (Team @ Team) -150"
  new RegExp(`^(?<player>${PLAYER}) (?<num>\\d+)\\+ (?<stat>${STAT_ALT})\\s*(?:\\((?<a>${TEAM}) ${SEP} (?<b>${TEAM})\\))?\\s*(?:[+-]\\d+)?$`, "iu"),
  // "OG Anunoby over 17.5 points (Team @ Team)" / "Derrick Henry over 22 rush attempts (...)"
  new RegExp(`^(?<player>${PLAYER}) (?<dir>Over|Under) (?<num>\\d+\\.?\\d*) (?<stat>${STAT_ALT})\\s*(?:\\((?<a>${TEAM}) ${SEP} (?<b>${TEAM})\\))?\\s*(?:[+-]\\d+)?$`, "iu"),
  // "Over 62.5 Davante Adams Receiving Yards" — direction+number first, stat phrase last.
  new RegExp(`^(?<dir>Over|Under) (?<num>\\d+\\.?\\d*) (?<player>${PLAYER}) (?<stat>${STAT_ALT})$`, "iu"),
];

const ANYTIME_TD_PATTERNS = [
  // Case-insensitive, covers "Bijan Robinson anytime TD", "...Anytime TD Scorer", and
  // "MarShawn Lloyd - Anytime TD Scorer" in one pattern. Kickoff-time parens already stripped
  // by normalize() before this runs.
  new RegExp(`^(?<player>${PLAYER})\\s*-?\\s*Anytime (?:TD|Touchdown)(?: Scorer)?\\s*(?:\\((?<a>${TEAM}) ${SEP} (?<b>${TEAM})\\))?\\s*(?:[+-]\\d+)?$`, "iu"),
];

// "Alaves vs Malaga draw (3:00 PM ET)" / "A vs B Tie" — a correlated-draw leg, stored with
// type "other" since it's neither a straight moneyline nor a spread/total. Kickoff-time and
// low-confidence-marker parens already stripped by normalize() before this runs.
const DRAW_PATTERNS = [
  new RegExp(`^(?<a>${TEAM}) ${SEP} (?<b>${TEAM}) (?:Draw|Tie)$`, "iu"),
];

function tryPatterns(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m.groups || {};
  }
  return null;
}

/**
 * Parse one leg's text into a structured bet, or return category "unsupported".
 * `legType` is the leg's own `type` field — used as a hint, not trusted blindly (the real
 * data has mislabeled legs, e.g. a player prop stored with type "over").
 */
function parseLeg(text, legType) {
  const raw = (text || "").trim();
  if (!raw) return { category: "unsupported", reason: "empty text" };
  // DraftKings "Early Exit"/"Early Exit Protected" props can pay out on a promotional rule
  // (e.g. an early-payout guarantee) that a plain box score can't reproduce — grading this from
  // final stats alone risks a confidently wrong answer, so it stays needs_review on purpose,
  // checked on the raw text before normalize() would otherwise strip the marker away unseen.
  if (/early exit/i.test(raw)) return { category: "unsupported", reason: "Early Exit prop — needs DraftKings' promo rule, not just final stats" };
  const t = normalize(raw);

  if (legType === "ml") {
    const g = tryPatterns(t, ML_PATTERNS);
    if (g) {
      const opponent = g.opp ? g.opp.trim() : g.a && g.b ? (sameTeam(g.a, g.team) ? g.b : g.a).trim() : null;
      return { category: "ml", team: g.team.trim(), opponent, rawA: g.a?.trim(), rawB: g.b?.trim() };
    }
  }

  if (legType === "spread") {
    const g = tryPatterns(t, SPREAD_PATTERNS);
    if (g) return { category: "spread", team: g.team.trim(), line: parseFloat(g.num), opponent: (g.opp || g.a === g.team ? g.b : g.a)?.trim() || null };
  }

  if (legType === "over" || legType === "under" || legType === "total") {
    if (TEAM_TOTAL_RE.test(raw)) {
      const g = tryPatterns(t, TEAM_TOTAL_PATTERNS);
      // opponent must be whichever of a/b is NOT the queried team — the team can land in either
      // matchup slot ("(Team vs Opp)" or "(Opp @ Team)"), and querying findGame with the same
      // team as both the team and the opponent makes a same-day second fixture for that team
      // (common for e.g. Real Madrid across UCL + La Liga) look falsely ambiguous.
      if (g) return { category: "teamTotal", team: g.team.trim(), opponent: (g.a && sameTeam(g.a, g.team) ? g.b : g.a)?.trim() || null, direction: g.dir.toLowerCase(), line: parseFloat(g.num), rawA: g.a?.trim() || null, rawB: g.b?.trim() || null };
    } else {
      const g = tryPatterns(t, TOTAL_PATTERNS);
      if (g) return { category: "total", direction: g.dir.toLowerCase(), line: parseFloat(g.num), rawA: g.a?.trim() || null, rawB: g.b?.trim() || null };
    }
  }

  // Player props and anytime TD are tried regardless of legType: real data mislabels these
  // constantly (type "td" on a counting prop like "1+ Passing Touchdowns", type "stat_under",
  // type "receiving", a plain "stat" that's actually an anytime-TD leg never seen here because
  // the phrasing disambiguates it) — the TEXT SHAPE is what's reliable, not the stored type.
  // ftd legs are skipped on purpose: "first TD scorer" needs play-by-play order, which this
  // parser doesn't have, and must never be mistaken for anytime-TD (a materially different bet).
  // Try TOTAL_PATTERNS here too, defensively: a mislabeled game-total leg ("Over 45.5 total
  // points" under some other type) must settle as a game total, never get swallowed by the
  // STAT reversed-order pattern as a fake player named "total".
  if (legType !== "ftd" && legType !== "over" && legType !== "under" && legType !== "total") {
    if (TEAM_TOTAL_RE.test(raw)) {
      const g = tryPatterns(t, TEAM_TOTAL_PATTERNS);
      if (g) return { category: "teamTotal", team: g.team.trim(), opponent: (g.a && sameTeam(g.a, g.team) ? g.b : g.a)?.trim() || null, direction: g.dir.toLowerCase(), line: parseFloat(g.num), rawA: g.a?.trim() || null, rawB: g.b?.trim() || null };
    } else {
      const tot = tryPatterns(t, TOTAL_PATTERNS);
      if (tot) return { category: "total", direction: tot.dir.toLowerCase(), line: parseFloat(tot.num), rawA: tot.a?.trim() || null, rawB: tot.b?.trim() || null };
    }
  }
  if (legType !== "ftd") {
    const draw = tryPatterns(t, DRAW_PATTERNS);
    if (draw) {
      return { category: "draw", rawA: draw.a.trim(), rawB: draw.b.trim() };
    }
    const td = tryPatterns(t, ANYTIME_TD_PATTERNS);
    if (td) {
      return {
        category: "anytimeTd",
        player: td.player.trim(),
        rawA: td.a?.trim() || null,
        rawB: td.b?.trim() || null,
      };
    }
    const g = tryPatterns(t, STAT_PATTERNS);
    // Reject "total"/"team" as a matched player name: the reversed "Over N.N <player> <stat>"
    // pattern will happily swallow "Over 45.5 total points" as player="total" when the real
    // TOTAL_PATTERNS shape doesn't happen to match (e.g. no team context in the text) — that's
    // a game total with no player in it, never a prop, so it must stay needs_review, not get
    // graded as a nonexistent player's stat line.
    if (g && /^(total|team)$/i.test(g.player.trim())) {
      return { category: "unsupported", reason: `looks like a game/team total, not a player prop: "${raw}"` };
    }
    if (g) {
      const info = STAT_KEY_BY_PHRASE.get(g.stat.toLowerCase());
      if (info) {
        const line = parseFloat(g.num);
        return {
          category: "stat",
          player: g.player.trim(),
          statKey: info.key,
          sportHint: info.sport, // "nfl"/"nba"/"nhl"/"mlb", or "ambiguous" (Points/Assists)
          // "N+" (no decimal) means "at least N" — Number.isInteger(line) && the matched
          // pattern used "+" syntax, so a whole-number line here is always an at-least
          // threshold, never a half-point line (those always render as "Over X.5").
          direction: g.dir ? g.dir.toLowerCase() : "atleast",
          line,
          rawA: g.a?.trim() || null,
          rawB: g.b?.trim() || null,
        };
      }
    }
  }

  return { category: "unsupported", reason: `no pattern matched for type "${legType}"` };
}

function sameTeam(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export { parseLeg, normalize };
