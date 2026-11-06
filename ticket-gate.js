// Ticket Gate -- code-level, deterministic validation for every ticket a builder writes,
// run before its request is marked "answered" (Seb's ask, 2026-11-05/06, after the
// JAX@BAL odds sign-conversion bug and the MIA@GSW 3u SGP that landed outside its target
// band with no note explaining why).
//
// Every function here is PURE (no network/Supabase calls) so it's directly unit-testable
// (see test-ticket-gate.mjs) -- server.js wires runTicketGate() to real data (news docs
// via its own getNewsDocForLeague/matchLegToInjury, the other desk's same-day tickets)
// and logs every result to Supabase's gate_results table (sql/ticket-gate-table.sql).
//
// Checks implemented here (see each function's own comment for the rule it enforces):
//   oddsMath        -- tight-real-prices' decimal<->American sign-conversion bug
//   priceFreshness  -- tight-real-prices' live-pricing-this-build requirement
//   newsHazards     -- news-check (Out/Doubtful legs) + NFL backup-QB disclosure
//   riskRange       -- three-unit-standard / one-unit-800 / bigger-min-500 / lotto-module
//   hardExclusions  -- milan-exclusion, ncaab-ny-nj-exclusion/no-ny-nj-college
//   sharedLegs      -- desk-priority's max-1-shared-leg-with-the-other-desk rule

export function parseAmericanOdds(raw) {
  if (raw == null) return null;
  const m = String(raw).match(/[-+]\d+(\.\d+)?/);
  if (!m) return null;
  return Number(m[0]);
}

export function americanToImpliedProb(american) {
  if (american == null || Number.isNaN(american)) return null;
  return american > 0 ? 100 / (american + 100) : -american / (-american + 100);
}

export function americanToDecimal(american) {
  if (american == null || Number.isNaN(american)) return null;
  return american > 0 ? 1 + american / 100 : 1 + 100 / -american;
}

// The actual incident-1 bug: given a combined DECIMAL price, convert back to American
// odds with the correct threshold check (>=2.0 -> positive, <2.0 -> NEGATIVE) instead of
// reflexively applying the positive-underdog formula. See rule tight-real-prices.
export function decimalToAmerican(decimal) {
  if (decimal == null || Number.isNaN(decimal) || decimal <= 1) return null;
  return decimal >= 2 ? (decimal - 1) * 100 : -100 / (decimal - 1);
}

// --- Check 1: odds math / sign-conversion -------------------------------------------
// Recomputes the naive combined probability from the ticket's own leg prices and checks
// that the ticket's quoted final odds has the right SIGN for that probability. A combined
// win probability over 50% can never have a positive (underdog-shaped) American price --
// that contradiction is exactly the JAX@BAL bug (four short favorites multiplied to a
// sub-2.0 decimal, but the positive-odds formula was applied anyway: +87 instead of -115).
export function checkOddsMath(ticket) {
  const legs = Array.isArray(ticket.legs) ? ticket.legs : [];
  const legOdds = legs.map((l) => parseAmericanOdds(l.price)).filter((n) => n != null);
  if (legs.length === 0 || legOdds.length !== legs.length) {
    return { pass: false, detail: "one or more legs missing a parseable price", legCount: legs.length, pricedLegs: legOdds.length };
  }
  const naiveProb = legOdds.reduce((p, a) => p * americanToImpliedProb(a), 1);
  const naiveDecimal = legOdds.reduce((d, a) => d * americanToDecimal(a), 1);
  const naiveAmerican = decimalToAmerican(naiveDecimal);

  const finalOdds = parseAmericanOdds(ticket.odds);
  if (finalOdds == null) {
    return { pass: false, detail: "ticket.odds has no parseable American price", naiveProb, naiveAmerican };
  }

  // Tolerance band around 50% -- a combined probability very close to even money can
  // legitimately round either way once a real correlation discount is layered on, so
  // only flag a clear contradiction (>52%/<48%), not a coin-flip edge case.
  if (naiveProb > 0.52 && finalOdds > 0) {
    return {
      pass: false,
      detail: `naive combined win probability is ${(naiveProb * 100).toFixed(1)}% (a favorite, decimal ${naiveDecimal.toFixed(3)} -> ${naiveAmerican.toFixed(0)} naive American) but the ticket's quoted odds (${finalOdds}) is positive -- sign-conversion bug (see tight-real-prices)`,
      naiveProb,
      naiveAmerican,
      finalOdds,
    };
  }
  if (naiveProb < 0.48 && finalOdds < 0) {
    return {
      pass: false,
      detail: `naive combined win probability is ${(naiveProb * 100).toFixed(1)}% (an underdog, decimal ${naiveDecimal.toFixed(3)} -> ${naiveAmerican.toFixed(0)} naive American) but the ticket's quoted odds (${finalOdds}) is negative -- sign-conversion bug (see tight-real-prices)`,
      naiveProb,
      naiveAmerican,
      finalOdds,
    };
  }
  return { pass: true, detail: "sign of quoted odds matches naive combined probability", naiveProb, naiveAmerican, finalOdds };
}

// --- Check 2: price freshness -------------------------------------------------------
// Every leg must be priced live within the last 60 minutes. There's no structured
// per-leg pull timestamp on a ticket doc today -- only prose in `note` (e.g. "DraftKings
// leg prices via sports-proxy at 7:27 PM ET") -- so this uses ticket.createdAt as the
// proxy pull time (the builder writes the ticket immediately after pricing it). A
// missing/unparseable createdAt is treated as unverifiable, which fails the same as a
// genuinely stale price -- there is nothing to check it against.
export function checkPriceFreshness(ticket, { now = Date.now(), maxAgeMinutes = 60 } = {}) {
  const createdAt = ticket.createdAt ? new Date(ticket.createdAt).getTime() : NaN;
  if (Number.isNaN(createdAt)) {
    return { pass: false, detail: "ticket has no parseable createdAt to verify price pull time against" };
  }
  const ageMinutes = (now - createdAt) / 60000;
  if (ageMinutes > maxAgeMinutes) {
    return { pass: false, detail: `ticket is ${ageMinutes.toFixed(0)} minutes old (createdAt), over the ${maxAgeMinutes}-minute live-price window`, ageMinutes };
  }
  if (ageMinutes < -5) {
    return { pass: false, detail: `ticket's createdAt (${ticket.createdAt}) is in the future relative to the gate run`, ageMinutes };
  }
  return { pass: true, detail: `ticket is ${Math.max(0, ageMinutes).toFixed(0)} minutes old`, ageMinutes };
}

// --- Check 3: news hazards (Out/Doubtful legs + backup-QB disclosure) ---------------
// `newsByLeague`: { [leagueKeyLower]: { injuries: [...] } } -- same shape as server.js's
// own getNewsDocForLeague() return value, keyed by news/<league> doc_id (nfl/nba/nhl/
// cbb/cfb). `matchLegToInjury` is injected so this module stays dependency-free --
// server.js passes its own existing matcher instead of this file duplicating it.
const BACKUP_QB_RE = /\bbackup qb\b|\bthird[- ]string\b|\b3rd[- ]string\b|\bQB\d\b|\bmaking his first start\b|\bundrafted (rookie )?QB\b|\bstarting in place of\b|\bfilling in at QB\b/i;

export function checkNewsHazards(ticket, newsByLeague, matchLegToInjury) {
  const legs = Array.isArray(ticket.legs) ? ticket.legs : [];
  const league = (ticket.league || "").toLowerCase();
  const newsDoc = newsByLeague?.[league];
  const hazards = [];
  if (newsDoc) {
    for (const leg of legs) {
      for (const inj of newsDoc.injuries || []) {
        const status = (inj.status || "").toLowerCase();
        if (status !== "out" && status !== "doubtful") continue;
        const m = matchLegToInjury(leg.text, inj);
        if (m) hazards.push({ leg: leg.text, player: inj.player, status: inj.status, confidence: m.confidence });
      }
    }
  }
  if (hazards.length > 0) {
    return { pass: false, detail: `${hazards.length} leg(s) touch a player listed Out/Doubtful in news/${league || "?"}`, hazards };
  }

  // NFL-specific: if a starting QB on either team is Out/Doubtful (a backup/3rd-string
  // QB starting instead), the ticket's own why/analysis/note text must say so explicitly
  // -- checked against the resulting ticket TEXT, not just that the rule was consulted,
  // same discipline the JAX@BAL tickets already got right by hand.
  if (league === "nfl" && newsDoc) {
    const qbOut = (newsDoc.injuries || []).some(
      (inj) => inj.position === "QB" && ["out", "doubtful"].includes((inj.status || "").toLowerCase())
    );
    if (qbOut) {
      const text = [ticket.analysis, ticket.note, ticket.why].filter(Boolean).join("\n");
      if (!BACKUP_QB_RE.test(text)) {
        return {
          pass: false,
          detail: "an NFL starting QB is listed Out/Doubtful this week but the ticket's own analysis/note never names the backup/replacement QB starting",
        };
      }
    }
  }
  return { pass: true, detail: "no Out/Doubtful leg matches; backup-QB disclosure present where required" };
}

// --- Check 4: risk range (after mandatory discounts) --------------------------------
// Bands from the rules collection as of 2026-11-05/06 (three-unit-standard, one-unit-800,
// bigger-min-500, lotto-module's NEVER-"NO LOTTO" fallback floors). Most bands are
// "guidelines" per units-are-guidelines -- landing outside one is allowed, but only with
// the ticket's own note/analysis explaining why (correlation discount, short slate, no
// padding, etc.), never silently wrong.
const EXPLAIN_RE = /\bbelow (lotto|mini lotto|target|3-?unit|standard)\b|\bshort slate\b|\bcorrelation discount\b|\bdiscount(ed)?\b|\bpadding\b|\bno padding\b|\boutside\b.*\b(target|standard|range)\b|\(est\.\)|\bcorrected\b/i;

function ticketTier(ticket) {
  const label = `${ticket.label || ""} ${ticket.slot || ""}`.toLowerCase();
  const units = ticket.units;
  if (ticket.tier === "mini" || /mini lotto/.test(label)) return "miniLotto";
  if (units === "lotto" || /\blotto\b/.test(label)) return "lotto";
  if (units === 1) return "1u";
  if (units === 2) return "2u";
  if (units === 3) return "3u";
  if (/bigger|big(ger)? payout/.test(label)) return "bigger";
  return null;
}

const TIER_BANDS = {
  "1u": { min: 800, firm: true },
  "3u": { min: -120, max: 130 },
  bigger: { min: 500, firm: true },
  lotto: { min: 2500 }, // NEVER-"NO LOTTO" fallback floor; normal target 5,000-20,000
  miniLotto: { min: 800 }, // fallback floor; normal target 1,500-4,000
};

export function checkRiskRange(ticket) {
  const tier = ticketTier(ticket);
  if (!tier) return { pass: true, detail: "no recognizable unit tier to check (2u or untagged -- guideline only, no firm band)" };
  const band = TIER_BANDS[tier];
  const odds = parseAmericanOdds(ticket.odds);
  if (odds == null) return { pass: false, detail: "ticket.odds has no parseable American price to check against its tier's target", tier };

  const inRange = tier === "3u" ? odds >= band.min && odds <= band.max : odds >= band.min;
  if (inRange) return { pass: true, detail: `${odds} is within ${tier}'s target band`, tier };

  const text = [ticket.analysis, ticket.note, ticket.why].filter(Boolean).join("\n");
  if (EXPLAIN_RE.test(text)) {
    return { pass: true, detail: `${odds} is outside ${tier}'s target band, but the ticket's own note/analysis explains why (per units-are-guidelines)`, tier };
  }
  return {
    pass: false,
    detail: `${odds} is outside ${tier}'s target band and the ticket's note/analysis gives no explanation for landing outside it`,
    tier,
  };
}

// --- Check 5: hard exclusions (Milan, NY/NJ college) ---------------------------------
const MILAN_RE = /\binter milan\b|\binternazionale\b|\bac milan\b/i;
// NY/NJ D1 schools per rule ncaab-ny-nj-exclusion / no-ny-nj-college.
const NY_NJ_COLLEGES = [
  "st. john's", "st johns", "syracuse", "fordham", "niagara", "canisius", "siena", "iona",
  "manhattan", "marist", "army west point", "colgate", "cornell", "columbia",
  "binghamton", "albany", "ualbany", "stony brook", "buffalo", "hofstra", "liu",
  "long island university", "st. bonaventure", "st bonaventure", "wagner", "le moyne",
  "rutgers", "seton hall", "princeton", "monmouth", "fairleigh dickinson", "fdu", "njit",
  "rider", "saint peter's", "saint peters",
];

export function checkHardExclusions(ticket) {
  const legs = Array.isArray(ticket.legs) ? ticket.legs : [];
  const haystacks = [ticket.game, ...legs.map((l) => l.text)].filter(Boolean).map((s) => s.toLowerCase());
  for (const h of haystacks) {
    if (MILAN_RE.test(h)) {
      return { pass: false, detail: `"${h}" matches the Milan exclusion (Inter Milan / AC Milan, any market/competition -- rule milan-exclusion)` };
    }
  }
  const league = (ticket.league || "").toLowerCase();
  if (["cbb", "ncaab", "cfb", "ncaaf"].includes(league)) {
    for (const h of haystacks) {
      for (const school of NY_NJ_COLLEGES) {
        const re = new RegExp(`\\b${school.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
        if (re.test(h)) {
          return { pass: false, detail: `"${h}" matches a NY/NJ college exclusion (${school} -- rule ncaab-ny-nj-exclusion/no-ny-nj-college)` };
        }
      }
    }
  }
  return { pass: true, detail: "no Milan or NY/NJ college legs" };
}

// --- Check 6: desk-priority (max 1 shared leg with the other desk's same-game ticket) --
// Best-effort text comparison, scoped to the other desk's ticket(s) for the exact same
// game/date (queried and passed in by the caller -- see server.js).
function normLegText(s) {
  return String(s || "").toLowerCase().replace(/\s*\*\(.*?\)\s*$/, "").trim();
}

export function checkSharedLegs(ticket, otherDeskTickets) {
  if (!Array.isArray(otherDeskTickets) || otherDeskTickets.length === 0) {
    return { pass: true, detail: "no other-desk ticket for this game/date to compare against" };
  }
  const myLegs = new Set((ticket.legs || []).map((l) => normLegText(l.text)));
  let maxShared = 0;
  let sharedWith = null;
  for (const other of otherDeskTickets) {
    const otherLegs = (other.legs || []).map((l) => normLegText(l.text));
    const shared = otherLegs.filter((t) => myLegs.has(t));
    if (shared.length > maxShared) {
      maxShared = shared.length;
      sharedWith = { ticketId: other.id || other.ticketId || null, shared };
    }
  }
  if (maxShared > 1) {
    return {
      pass: false,
      detail: `shares ${maxShared} legs with the other desk's ticket on the same game (max 1 allowed per desk-priority)`,
      sharedWith,
    };
  }
  return {
    pass: true,
    detail: maxShared === 1 ? "shares exactly 1 leg with the other desk (allowed)" : "no shared legs with the other desk",
    sharedWith,
  };
}

// --- Aggregate -----------------------------------------------------------------------
export function runTicketGate(ticket, deps = {}) {
  const { newsByLeague = {}, matchLegToInjury = () => null, otherDeskTickets = [], now } = deps;
  const checks = {
    oddsMath: checkOddsMath(ticket),
    priceFreshness: checkPriceFreshness(ticket, { now }),
    newsHazards: checkNewsHazards(ticket, newsByLeague, matchLegToInjury),
    riskRange: checkRiskRange(ticket),
    hardExclusions: checkHardExclusions(ticket),
    sharedLegs: checkSharedLegs(ticket, otherDeskTickets),
  };
  const failures = Object.entries(checks)
    .filter(([, v]) => !v.pass)
    .map(([k]) => k);
  return { passed: failures.length === 0, checks, failures };
}
