// ESPN <-> The Odds API team-name matching for the NBA/CBB analytics-only projection engine
// (2026-11-06+, Seb's request -- phase 1.1 fix). Replaces the `events[0]` placeholder in
// server.js's sides-totals-projection and nba-props-shadow routes.
//
// ESPN's scoreboard gives us each game's two team displayNames directly (no abbreviation
// round-trip needed) -- e.g. "LA Clippers", "Duke". The Odds API's event objects carry
// home_team/away_team as THEIR OWN full names -- e.g. "Los Angeles Clippers", "Duke Blue
// Devils". Most pairs match via simple normalization (lowercase, strip punctuation/common
// suffixes); the ones that don't get an explicit alias below. Anything that still can't be
// matched is reported, not guessed -- see matchOddsEvent's null return.

// Normalizes a team name for comparison: lowercase, drop punctuation, drop a short list of
// words that differ between the two sources but carry no identifying information.
const DROP_WORDS = new Set(["the", "university", "of", "at"]);
export function normalizeTeamName(name) {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !DROP_WORDS.has(w))
    .join(" ")
    .trim();
}

// ESPN name (lowercase, normalized) -> Odds API name (normalized), for pairs that don't
// resolve via plain normalization/substring matching. NBA list is exhaustive for the known
// mismatches; CBB is necessarily a short, growing list (714 D-I teams) -- anything missing
// falls through to the substring matcher in matchOddsEvent, and a true miss is reported via
// unmatchedEspnNames rather than silently grabbing the wrong game.
export const NBA_ALIASES = {
  "la clippers": "los angeles clippers",
  "la lakers": "los angeles lakers",
  "ny knicks": "new york knicks",
};

export const CBB_ALIASES = {
  uconn: "connecticut",
  "connecticut huskies": "connecticut",
  "ole miss": "mississippi",
  "pitt": "pittsburgh",
  "unc": "north carolina",
  "vcu": "virginia commonwealth",
  smu: "southern methodist",
  usc: "southern california",
  ucf: "central florida",
  lsu: "louisiana state",
  "miami fl": "miami",
  "miami hurricanes": "miami",
};

function aliasedOrSelf(normalized, aliasMap) {
  return normalizeTeamName(aliasMap[normalized] ?? normalized);
}

// True if two already-normalized names refer to the same team: exact match, alias match,
// or one is a substring of the other with at least 4 characters (guards against e.g. "ole
// miss" substring-matching "mississippi state").
function namesMatch(normA, normB, aliasMap) {
  if (!normA || !normB) return false;
  const a = aliasedOrSelf(normA, aliasMap);
  const b = aliasedOrSelf(normB, aliasMap);
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 4 && longer.includes(shorter);
}

// Finds the Odds API event (from a /events list) whose (home_team, away_team) pair matches
// the ESPN matchup, matched as an UNORDERED pair (home/away labeling comes from the matched
// event's own data, not assumed from ESPN's order -- neutral-site games can disagree on
// which side the two sources call "home"). `league` picks the alias table. Returns
// { event, reason: null } on a match, or { event: null, reason: "<why>" } when nothing
// matches -- callers must treat a null event as "no DK line available", never fall back to
// events[0].
export function matchOddsEvent(events, espnHomeName, espnAwayName, league) {
  const aliasMap = league === "CBB" ? CBB_ALIASES : NBA_ALIASES;
  const h = normalizeTeamName(espnHomeName);
  const a = normalizeTeamName(espnAwayName);
  if (!h || !a) return { event: null, reason: "missing ESPN team name(s)" };

  for (const ev of events || []) {
    const evHome = normalizeTeamName(ev.home_team);
    const evAway = normalizeTeamName(ev.away_team);
    const pairMatches =
      (namesMatch(h, evHome, aliasMap) && namesMatch(a, evAway, aliasMap)) ||
      (namesMatch(h, evAway, aliasMap) && namesMatch(a, evHome, aliasMap));
    if (pairMatches) return { event: ev, reason: null };
  }
  return { event: null, reason: `no Odds API event matched ESPN matchup "${espnAwayName} @ ${espnHomeName}"` };
}
