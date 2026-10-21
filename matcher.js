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

/**
 * Finds the one game matching `teamQuery` (and `opponentQuery` if given) among `games`
 * (each { competitors: [{ displayName, shortDisplayName, abbreviation, location, name,
 * score }, ...] }). Returns null — never a guess — when the match is ambiguous, so the
 * caller routes it to needs_review instead of risking a wrong grade.
 */
function findGame(games, teamQuery, opponentQuery) {
  let candidates = games.filter((g) => g.competitors.some((c) => teamMatches(teamQuery, c)));
  if (candidates.length > 1 && opponentQuery) {
    const narrowed = candidates.filter((g) => g.competitors.some((c) => teamMatches(opponentQuery, c)));
    if (narrowed.length >= 1) candidates = narrowed;
  }
  if (candidates.length !== 1) return null; // 0 or still-ambiguous -> no guess
  return candidates[0];
}

export { norm, teamMatches, findGame };
