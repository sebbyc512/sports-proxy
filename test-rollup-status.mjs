// One-off verification for the 2026-11-03 rollUpTicketStatus hardening -- not wired into any
// npm script, just run directly before deploying this change. Duplicates the function body
// from server.js (which can't be imported standalone without starting the Express app) and
// checks it against the exact spec Seb gave for the fix.
const LEG_LOSS_STATUSES = new Set(["miss", "lost"]);
const LEG_WIN_STATUSES = new Set(["hit", "won", "push"]);

function rollUpTicketStatus(legs) {
  if (legs.length === 0) return "needs_review";
  if (legs.some((l) => LEG_LOSS_STATUSES.has(l.status))) return "lost";
  if (legs.some((l) => l.status === "needs_review")) return "needs_review";
  if (legs.some((l) => l.status === "pending")) return "pending";
  if (legs.every((l) => LEG_WIN_STATUSES.has(l.status))) return "won";
  return "needs_review";
}

const S = (status) => ({ status });
const cases = [
  { name: "single miss -> lost", legs: [S("miss")], want: "lost" },
  { name: "single lost synonym -> lost", legs: [S("lost")], want: "lost" },
  { name: "miss beats needs_review -> lost", legs: [S("miss"), S("needs_review")], want: "lost" },
  { name: "lost synonym beats needs_review -> lost", legs: [S("lost"), S("needs_review")], want: "lost" },
  { name: "miss beats pending -> lost", legs: [S("miss"), S("pending")], want: "lost" },
  { name: "all hit -> won", legs: [S("hit"), S("hit")], want: "won" },
  { name: "won synonym + hit -> won", legs: [S("won"), S("hit")], want: "won" },
  { name: "hit + push -> won", legs: [S("hit"), S("push")], want: "won" },
  { name: "all push -> won", legs: [S("push"), S("push")], want: "won" },
  { name: "needs_review alone -> needs_review", legs: [S("needs_review")], want: "needs_review" },
  { name: "pending alone -> pending", legs: [S("pending")], want: "pending" },
  { name: "hit + pending (not final yet) -> pending", legs: [S("hit"), S("pending")], want: "pending" },
  { name: "empty legs -> needs_review", legs: [], want: "needs_review" },
  // The actual 2026-11-03 incident: a leg manually written as "lost" (not "miss") used to
  // fall through every check and vacuously default to "won". Must now resolve to "lost".
  { name: "INCIDENT: single leg status 'lost' (manual revert) -> lost, not won", legs: [S("lost")], want: "lost" },
  // An unrecognized/garbage leg status must never vacuously become "won".
  { name: "unrecognized leg status -> needs_review, never won", legs: [S("???")], want: "needs_review" },
  { name: "hit + unrecognized -> needs_review, never won", legs: [S("hit"), S("typo")], want: "needs_review" },
];

let failed = 0;
for (const c of cases) {
  const got = rollUpTicketStatus(c.legs);
  const ok = got === c.want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}  (want ${c.want}, got ${got})`);
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed > 0) process.exit(1);
