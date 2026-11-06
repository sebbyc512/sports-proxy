// Unit tests for ticket-gate.js's pure check functions -- no network/Supabase needed.
// Run: node test-ticket-gate.mjs
import {
  runTicketGate,
  checkOddsMath,
  checkPriceFreshness,
  checkNewsHazards,
  checkHardExclusions,
} from "./ticket-gate.js";

let pass = 0;
let fail = 0;
function assert(cond, label) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${label}`);
  }
}

// Shared matcher stub mirroring server.js's matchLegToInjury: full-name substring match.
function matchLegToInjury(legText, injury) {
  if (!legText || !injury?.player) return null;
  return legText.toLowerCase().includes(injury.player.toLowerCase()) ? { confidence: "high" } : null;
}

// --- Test case 1: the real incident-1 regression (JAX@BAL 4-leg SGP, 2026-11-05) -------
// Legs: Lawrence 170+ pass yds -660, Strange 2+ rec -880, Washington 3+ rec -522,
// Henry 14+ rush att -443. Naive combined implied prob ~53.4% (a favorite) -- the bug
// quoted +87 (positive/underdog-shaped) instead of the correct -115/-227.
const incidentLegs = [
  { price: "-660", text: "Trevor Lawrence 170+ passing yards", type: "stat" },
  { price: "-880", text: "Brenton Strange 2+ receptions", type: "stat" },
  { price: "-522", text: "Parker Washington 3+ receptions", type: "stat" },
  { price: "-443", text: "Derrick Henry 14+ rush attempts", type: "stat" },
];

{
  const buggyTicket = { legs: incidentLegs, odds: "+87" };
  const r = checkOddsMath(buggyTicket);
  assert(r.pass === false, "incident-1 regression: buggy +87 ticket must fail oddsMath");
  assert(Math.abs(r.naiveProb - 0.534) < 0.01, `incident-1 regression: naive prob should be ~53.4%, got ${r.naiveProb}`);
}
{
  const fixedTicket = { legs: incidentLegs, odds: "-227 (corrected)" };
  const r = checkOddsMath(fixedTicket);
  assert(r.pass === true, "incident-1 regression: corrected -227 ticket must pass oddsMath");
}
{
  // Underdog-shaped sanity check in the other direction: a parlay of real underdogs
  // (naive prob well under 50%) quoted with a NEGATIVE price should also fail.
  const dogLegs = [
    { price: "+150", text: "Team A ML", type: "ml" },
    { price: "+120", text: "Team B ML", type: "ml" },
  ];
  const r = checkOddsMath({ legs: dogLegs, odds: "-120" });
  assert(r.pass === false, "underdog parlay quoted negative must fail oddsMath");
}

// --- Test case 2: out-of-news-window stale-price rejection ----------------------------
{
  const now = new Date("2026-11-06T02:00:00Z").getTime(); // 90 min after createdAt below
  const staleTicket = { createdAt: "2026-11-06T00:29:41Z" };
  const r = checkPriceFreshness(staleTicket, { now });
  assert(r.pass === false, "ticket priced 90 minutes ago must fail priceFreshness");
  assert(r.ageMinutes > 60, "stale ticket's ageMinutes should exceed the 60-minute window");
}
{
  const now = new Date("2026-11-06T00:35:00Z").getTime(); // ~5 min after createdAt
  const freshTicket = { createdAt: "2026-11-06T00:29:41Z" };
  const r = checkPriceFreshness(freshTicket, { now });
  assert(r.pass === true, "ticket priced 5 minutes ago must pass priceFreshness");
}
{
  const r = checkPriceFreshness({}, { now: Date.now() });
  assert(r.pass === false, "ticket with no createdAt must fail priceFreshness (unverifiable)");
}

// --- Test case 3: backup-QB-not-mentioned rejection ------------------------------------
const nflNewsQbOut = {
  nfl: {
    injuries: [
      { player: "Lamar Jackson", lastName: "Jackson", position: "QB", status: "Out", team: { abbr: "BAL" } },
    ],
  },
};
{
  const ticketNoMention = {
    league: "NFL",
    legs: [{ price: "-200", text: "Derrick Henry 14+ rush attempts", type: "stat" }],
    note: "Standard price check via sports-proxy at 7 PM ET.",
    analysis: "Henry gets heavy volume in this spot.",
  };
  const r = checkNewsHazards(ticketNoMention, nflNewsQbOut, matchLegToInjury);
  assert(r.pass === false, "NFL ticket must fail newsHazards when starting QB is Out and ticket never names the backup");
}
{
  const ticketWithMention = {
    league: "NFL",
    legs: [{ price: "-200", text: "Derrick Henry 14+ rush attempts", type: "stat" }],
    note: "BAL starts undrafted rookie QB Joe Fagnano (Lamar Jackson and Huntley both on IR).",
    analysis: "With a rookie QB making his first start, BAL leans on Henry.",
  };
  const r = checkNewsHazards(ticketWithMention, nflNewsQbOut, matchLegToInjury);
  assert(r.pass === true, "NFL ticket must pass newsHazards when it explicitly names the backup QB situation");
}
{
  const ticketOnOutPlayer = {
    league: "NFL",
    legs: [{ price: "-150", text: "Lamar Jackson 2+ passing TDs", type: "stat" }],
    note: "n/a",
  };
  const r = checkNewsHazards(ticketOnOutPlayer, nflNewsQbOut, matchLegToInjury);
  assert(r.pass === false, "ticket with a leg directly on an Out player must fail newsHazards");
}

// --- Test case 4: Milan-exclusion rejection ---------------------------------------------
{
  const milanTicket = {
    league: "SOCCER",
    game: "Inter Milan vs Napoli",
    legs: [{ price: "-150", text: "Inter Milan ML", type: "ml" }],
  };
  const r = checkHardExclusions(milanTicket);
  assert(r.pass === false, "Inter Milan leg must fail hardExclusions");
}
{
  const acMilanTicket = {
    league: "SOCCER",
    game: "AC Milan vs Juventus",
    legs: [{ price: "+150", text: "AC Milan ML", type: "ml" }],
  };
  const r = checkHardExclusions(acMilanTicket);
  assert(r.pass === false, "AC Milan leg must fail hardExclusions");
}
{
  const nyCollegeTicket = {
    league: "CBB",
    game: "Syracuse vs Duke",
    legs: [{ price: "-120", text: "Syracuse ML", type: "ml" }],
  };
  const r = checkHardExclusions(nyCollegeTicket);
  assert(r.pass === false, "Syracuse (NY) CBB leg must fail hardExclusions");
}
{
  const cleanTicket = {
    league: "SOCCER",
    game: "Napoli vs Juventus",
    legs: [{ price: "-150", text: "Napoli ML", type: "ml" }],
  };
  const r = checkHardExclusions(cleanTicket);
  assert(r.pass === true, "a non-excluded soccer game must pass hardExclusions");
}

// --- Test case 5: a passing ticket (the real, corrected JAX@BAL "safer" ticket) ---------
{
  const now = new Date("2026-11-06T00:40:00Z").getTime(); // ~10 min after createdAt
  const realPassingTicket = {
    league: "NFL",
    game: "Jaguars @ Ravens",
    date: "2026-11-05",
    units: 3,
    label: "Safer version",
    slot: "TNF",
    createdAt: "2026-11-06T00:29:41Z",
    legs: incidentLegs,
    odds: "-227 (corrected)",
    note:
      "DraftKings leg prices via sports-proxy at 7:27 PM ET. CORRECTED 2026-11-05 (record only, game over): naive multiplied decimal 1.873 -> -115, not the original +87 (sign-conversion bug, see rule tight-real-prices) -> -227 est. after 1.3x correlation discount. BAL starts undrafted rookie QB Joe Fagnano (Lamar Jackson and Huntley both on IR; Fagnano 10/21, 91 yds, INT in his Week 8 debut).",
    analysis: "Ticket: naive implied 53.4% (-115, corrected from the original +87 sign error); after the mandatory 1.3x SGP correlation discount, -227.",
  };
  const r = runTicketGate(realPassingTicket, { newsByLeague: nflNewsQbOut, matchLegToInjury, now });
  assert(r.passed === true, `the real corrected JAX@BAL ticket must pass the full gate -- failures: ${JSON.stringify(r.failures)} / ${JSON.stringify(r.checks, null, 2)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
