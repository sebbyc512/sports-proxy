// Phase 2 grader — parses leg text into a structured bet (team/number/matchup) for the
// bet types where a fixed rule can confidently settle it: moneyline, spread, and GAME-level
// totals. Everything else (player props, team totals, first/anytime TD, anything the regexes
// don't recognize) returns category "unsupported" so the caller marks it needs_review instead
// of guessing. Built and tuned against ~2000 real leg-text examples pulled from the migrated
// desks (see handbooks/phase2-log.md, test-grader-coverage.mjs) — deliberately conservative:
// coverage over cleverness, and a pattern is only added once a real example needs it.

const TEAM = "[\\p{L}0-9.'\\-& ]+?";
const SEP = "(?:vs|v|@|at)"; // all separators actually seen between two team names

// Noise substrings that appear around a real market description but carry no settlement
// information — stripped before pattern matching so one pattern covers many real variants
// instead of needing a new regex per annotation style.
const NOISE_RES = [
  /\([^()]*\d{1,2}:\d{2}\s*[AP]M\s*ET\)/gi, // trailing kickoff/tip time, e.g. "(7:00 PM ET)" or "(90 min, 12:30 PM ET)"
  [/\(\s*\d+\s*Pick SGP,\s*([^)]*)\)/gi, "($1)"], // "(2 Pick SGP, A vs B)" -> "(A vs B)"
  /\bSGP\s*\([+-]\d+\):\s*/gi, // "SGP (-115): " prefix
  /\s-\s*(?=SGP|$)/gi,
  /\(alt [a-z ]+\)/gi, // "(alt puck line)", "(alt spread)", etc.
  /\(alt\)/gi,
  /\balt spread\b/gi,
  /\(spread alternate\)/gi,
  /\balternate\b/gi,
  /\((?:low|med|medium|high|sprinkle)\)/gi, // staking-size annotations
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

// Explicitly excluded from TOTAL_PATTERNS on purpose — these are a single TEAM's total, not
// the combined game total, and need different settlement data (that team's score alone).
const TEAM_TOTAL_RE = /Team Total (?:Goals|Points|Runs)/i;

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

  if ((legType === "over" || legType === "under") && !TEAM_TOTAL_RE.test(raw)) {
    const g = tryPatterns(t, TOTAL_PATTERNS);
    if (g) return { category: "total", direction: g.dir.toLowerCase(), line: parseFloat(g.num), rawA: g.a?.trim() || null, rawB: g.b?.trim() || null };
  }

  return { category: "unsupported", reason: `no pattern matched for type "${legType}"` };
}

function sameTeam(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export { parseLeg, normalize };
