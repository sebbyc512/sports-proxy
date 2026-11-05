// Shared team/game matching for the grader (used by both the production job and the
// backtest). Tuned against real false positives found while backtesting against historical
// settled tickets — see handbooks/phase2-log.md for the specific cases.

function norm(s) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

/**
 * True only when `query` identifies this competitor specifically enough to not also match
 * an unrelated team that happens to share a city or short code (e.g. query "Miami FL" must
 * NOT match the Miami Heat just because both contain "miami", and "TB Rays" must NOT match
 * the Tampa Bay Lightning just because both abbreviate to "TB"). Full names (displayName,
 * shortDisplayName) allow substring/contains matching since they're specific; short fields
 * (bare abbreviation, bare city/nickname) only match on exact equality.
 */
function teamMatches(query, competitor) {
  const q = norm(query);
  if (!q) return false;
  const full = [competitor.displayName, competitor.shortDisplayName].filter(Boolean).map(norm);
  const short = [competitor.abbreviation, competitor.location, competitor.name].filter(Boolean).map(norm);

  for (const nn of full) {
    if (!nn) continue;
    if (q === nn || q.includes(nn) || nn.includes(q)) return true;
    const qLast = q.split(" ").pop();
    const nLast = nn.split(" ").pop();
    if (qLast.length > 3 && qLast === nLast) return true;
  }
  for (const nn of short) {
    if (nn && q === nn) return true;
  }
  return false;
}

// True only when a whitespace-delimited token of `query` is an EXACT match for the
// competitor's own abbreviation (e.g. "CLE" inside "CLE Cavaliers" vs. Cleveland's
// abbreviation "CLE"). This is a much stronger signal than teamMatches' nickname-only
// fallback, which goes by the LAST WORD of the query and so cannot tell two same-nickname
// teams apart (e.g. NBA "Cleveland Cavaliers" vs. NCAAB "Virginia Cavaliers" both end in
// "Cavaliers" — query "CLE Cavaliers" fuzzy-matches both). Used by findGame below to
// prefer an abbreviation-confirmed candidate over a same-nickname collision before ever
// calling the match ambiguous.
function teamMatchesStrong(query, competitor) {
  const abbr = (competitor.abbreviation || "").trim().toLowerCase();
  if (!abbr) return false;
  const tokens = norm(query).split(" ").filter(Boolean);
  return tokens.includes(abbr);
}

/**
 * Finds the one game matching `teamQuery` (and `opponentQuery` if given) among `games`
 * (each { competitors: [{ displayName, shortDisplayName, abbreviation, location, name,
 * score }, ...] }). Returns null — never a guess — when the match is ambiguous, so the
 * caller routes it to needs_review instead of risking a wrong grade. `preferDate`
 * (YYYY-MM-DD, optional) is the ticket's own date — used only as a last tie-breaker when a
 * team has more than one real game in the scanned window (e.g. a back-to-back, or a settled
 * game plus that same team's next scheduled one a day or two later) and nothing else
 * narrows it down.
 */
function findGame(games, teamQuery, opponentQuery, preferDate) {
  let candidates = games.filter((g) => g.competitors.some((c) => teamMatches(teamQuery, c)));
  // Nickname collision across sports/leagues (e.g. two "Cavaliers" on the same day, one NBA
  // one NCAAB) — an abbreviation-exact-token match is strong enough to resolve this without
  // needing the opponent, so prefer it over the fuzzy nickname set before falling through to
  // "ambiguous". Found 2026-11-05 grading a bare "CLE Cavaliers Moneyline" leg (no matchup
  // text at all) that matched both Cleveland's real game and Virginia's NCAAB game.
  if (candidates.length > 1) {
    const strong = candidates.filter((g) => g.competitors.some((c) => teamMatchesStrong(teamQuery, c)));
    if (strong.length >= 1) candidates = strong;
  }
  if (candidates.length > 1 && opponentQuery) {
    const narrowed = candidates.filter((g) => g.competitors.some((c) => teamMatches(opponentQuery, c)));
    if (narrowed.length >= 1) candidates = narrowed;
  }
  // Same real team, two real games in the window (a back-to-back, or the completed game plus
  // that team's own next scheduled one a day or two later) — both already survived the
  // stronger filters above, so fall back to whichever is actually on the ticket's own date.
  // Found 2026-11-05: "CLE Cavaliers Moneyline" (ticket dated 2026-11-05) otherwise stayed
  // ambiguous between the already-final 11-04 game and the still-scheduled 11-06 rematch.
  if (candidates.length > 1 && preferDate) {
    const sameDate = candidates.filter((g) => (g.date || "").slice(0, 10) === preferDate);
    if (sameDate.length === 1) candidates = sameDate;
  }
  if (candidates.length !== 1) return null; // 0 or still-ambiguous -> no guess
  return candidates[0];
}

export { norm, teamMatches, findGame };
