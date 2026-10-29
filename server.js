#!/usr/bin/env node
// Public HTTP proxy for ESPN + DraftKings odds data.
// The real ODDS_API_KEY lives only here (server-side env var) — callers never see it.
// Callers authenticate with PROXY_TOKEN instead: a separate, low-stakes token that
// only protects this proxy's own rate limit, not the real odds-api quota.

import express from "express";
import { parseLeg } from "./grader.js";
import { teamMatches, findGame } from "./matcher.js";

const app = express();
const PORT = process.env.PORT || 3000;
const PROXY_TOKEN = process.env.PROXY_TOKEN;
const ODDS_API_KEY = process.env.ODDS_API_KEY;

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";
const ODDS_BASE = "https://api.the-odds-api.com/v4";

function requireToken(req, res, next) {
  if (!PROXY_TOKEN) {
    return res.status(500).json({ error: "PROXY_TOKEN is not configured on the server." });
  }
  const given = req.query.token || req.get("x-proxy-token");
  if (given !== PROXY_TOKEN) {
    return res.status(401).json({ error: "Missing or invalid token." });
  }
  next();
}

app.use(requireToken);
app.use(express.json());

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "sports-proxy/0.1" } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// Same as getJson, but for the-odds-api.com calls specifically: captures the
// x-requests-used/x-requests-remaining/x-requests-last headers it returns on every
// response (even a 4xx) and records them, so the odds-credit alert job always has the
// latest real usage without needing its own separate call to the-odds-api.com.
async function getOddsJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "sports-proxy/0.1" } });
  const usage = {
    requestsUsed: res.headers.get("x-requests-used"),
    requestsRemaining: res.headers.get("x-requests-remaining"),
    requestsLast: res.headers.get("x-requests-last"),
  };
  if (usage.requestsUsed != null || usage.requestsRemaining != null) {
    recordOddsUsage(usage).catch((err) => console.error("odds-usage record failed:", err.message));
  }
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

app.get("/espn/scoreboard", async (req, res) => {
  try {
    const { sport, league, date } = req.query;
    if (!sport || !league) return res.status(400).json({ error: "sport and league are required" });
    const url = new URL(`${ESPN_BASE}/${sport}/${league}/scoreboard`);
    if (date) url.searchParams.set("dates", date);
    const data = await getJson(url.toString());
    const events = (data.events || []).map((ev) => {
      const comp = ev.competitions?.[0];
      return {
        name: ev.name,
        date: ev.date,
        status: ev.status?.type?.description,
        completed: ev.status?.type?.completed ?? false,
        competitors: (comp?.competitors || []).map((c) => ({
          team: c.team?.displayName,
          abbrev: c.team?.abbreviation,
          homeAway: c.homeAway,
          score: c.score,
          winner: c.winner ?? null,
        })),
      };
    });
    res.json({ sport, league, date: date || "(default)", count: events.length, events });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/espn/team", async (req, res) => {
  try {
    const { sport, league, team } = req.query;
    if (!sport || !league || !team) return res.status(400).json({ error: "sport, league and team are required" });
    const data = await getJson(`${ESPN_BASE}/${sport}/${league}/teams/${encodeURIComponent(team)}`);
    const t = data.team;
    res.json({
      name: t?.displayName,
      abbreviation: t?.abbreviation,
      record: t?.record?.items?.map((r) => ({ type: r.type, summary: r.summary })),
      standingSummary: t?.standingSummary,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/odds", async (req, res) => {
  if (!ODDS_API_KEY) return res.status(500).json({ error: "ODDS_API_KEY is not configured on the server." });
  try {
    const { sport_key, markets, bookmakers } = req.query;
    if (!sport_key) return res.status(400).json({ error: "sport_key is required" });
    const url = new URL(`${ODDS_BASE}/sports/${sport_key}/odds/`);
    url.searchParams.set("apiKey", ODDS_API_KEY);
    url.searchParams.set("regions", "us");
    url.searchParams.set("markets", markets || "h2h,spreads,totals");
    url.searchParams.set("oddsFormat", "american");
    url.searchParams.set("bookmakers", bookmakers || "draftkings");
    const data = await getOddsJson(url.toString());
    const games = data.map((g) => ({
      event_id: g.id,
      matchup: `${g.away_team} @ ${g.home_team}`,
      commence_time: g.commence_time,
      books: (g.bookmakers || []).map((b) => ({
        book: b.title,
        lastUpdate: b.last_update,
        markets: (b.markets || []).map((m) => ({ market: m.key, outcomes: m.outcomes })),
      })),
    }));
    res.json({ sport_key, count: games.length, games });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/odds/props", async (req, res) => {
  if (!ODDS_API_KEY) return res.status(500).json({ error: "ODDS_API_KEY is not configured on the server." });
  try {
    const { sport_key, markets, event_id, home_team, away_team, bookmakers } = req.query;
    if (!sport_key || !markets) return res.status(400).json({ error: "sport_key and markets are required" });
    let id = event_id;
    if (!id) {
      if (!home_team && !away_team) {
        return res.status(400).json({ error: "Provide event_id, or home_team/away_team to look the event up." });
      }
      const eventsUrl = new URL(`${ODDS_BASE}/sports/${sport_key}/events`);
      eventsUrl.searchParams.set("apiKey", ODDS_API_KEY);
      const events = await getOddsJson(eventsUrl.toString());
      const match = events.find(
        (e) =>
          (!home_team || e.home_team?.toLowerCase().includes(String(home_team).toLowerCase())) &&
          (!away_team || e.away_team?.toLowerCase().includes(String(away_team).toLowerCase()))
      );
      if (!match) return res.status(404).json({ error: `No upcoming ${sport_key} event matched the given team(s).` });
      id = match.id;
    }
    const url = new URL(`${ODDS_BASE}/sports/${sport_key}/events/${id}/odds`);
    url.searchParams.set("apiKey", ODDS_API_KEY);
    url.searchParams.set("regions", "us");
    url.searchParams.set("markets", markets);
    url.searchParams.set("oddsFormat", "american");
    url.searchParams.set("bookmakers", bookmakers || "draftkings");
    const data = await getOddsJson(url.toString());
    const books = (data.bookmakers || []).map((b) => ({
      book: b.title,
      markets: (b.markets || []).map((m) => ({
        market: m.key,
        lastUpdate: m.last_update,
        outcomes: m.outcomes.map((o) => ({ player: o.description, side: o.name, price: o.price, line: o.point })),
      })),
    }));
    res.json({ event_id: id, matchup: `${data.away_team} @ ${data.home_team}`, commence_time: data.commence_time, books });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Phase 2 engine additions ---
// These read/write the shared Supabase "docs" table (desk_id, collection, doc_id, data,
// version) instead of ArtifactData, so the engine can run without any Claude usage.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const DESKS = ["main", "steve", "lela", "uat"];

async function supabaseFetch(pathAndQuery, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_SECRET_KEY not configured on the server.");
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1${pathAndQuery}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res;
}

// GUARD (added 2026-10-29, after an incident where a Post-Cutover Sync run's own
// ad-hoc push script wrapped ~38 rows as {data: {...real fields...}} instead of
// posting the real fields flat): if a caller hands us exactly that double-wrapped
// shape -- a single top-level key literally named "data" whose value is itself a
// plain object -- unwrap it one level before storing, and log a warning so this is
// visible without silently normalizing bad callers forever. This is a last-resort
// safety net, not a substitute for callers sending the right shape.
function unwrapIfDoubleWrapped(deskId, collection, docId, data) {
  if (
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    Object.keys(data).length === 1 &&
    Object.prototype.hasOwnProperty.call(data, "data") &&
    data.data &&
    typeof data.data === "object" &&
    !Array.isArray(data.data)
  ) {
    console.warn(
      `[upsertDoc] double-wrapped write caught and auto-unwrapped for ${deskId}/${collection}/${docId} -- caller sent {data:{...}} instead of the flat fields`
    );
    return data.data;
  }
  return data;
}

async function upsertDoc(deskId, collection, docId, data) {
  data = unwrapIfDoubleWrapped(deskId, collection, docId, data);
  await supabaseFetch(`/docs?on_conflict=desk_id,collection,doc_id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([
      { desk_id: deskId, collection, doc_id: docId, data, updated_at: new Date().toISOString() },
    ]),
  });
}

async function getDoc(deskId, collection, docId) {
  const res = await supabaseFetch(
    `/docs?desk_id=eq.${encodeURIComponent(deskId)}&collection=eq.${encodeURIComponent(
      collection
    )}&doc_id=eq.${encodeURIComponent(docId)}&select=data,version,updated_at`
  );
  const rows = await res.json();
  return rows[0] || null;
}

// Read-merge-write: upsertDoc()'s "merge-duplicates" is a Postgres row upsert, which
// replaces the whole jsonb "data" column -- it does NOT deep-merge JSON keys. Every
// engine job below that touches a doc some OTHER writer (a Claude routine, another
// engine job) also writes to (nbaTeams' note/blowout fields, soccerTeams' note/asr,
// nba/meta's openingGames/injuries, etc.) must go through this instead of upsertDoc
// directly, so it never clobbers a field it doesn't know about.
async function mergeUpsertDoc(deskId, collection, docId, patch) {
  const existing = await getDoc(deskId, collection, docId);
  const clean = { ...patch };
  Object.keys(clean).forEach((k) => clean[k] === undefined && delete clean[k]);
  const merged = { ...(existing?.data || {}), ...clean };
  await upsertDoc(deskId, collection, docId, merged);
  return merged;
}

// --- Odds API credit tracking + alert (2026-10-23, Seb's request) ---
// Every the-odds-api.com call (via getOddsJson above) reports its own current
// requests-used/requests-remaining here. Stored once, under desk "main" (this is
// account-wide usage, not desk-scoped data, but reuses the same docs table rather than
// adding a new table). "quota" is used+remaining, recomputed every call, so it tracks
// itself up automatically the moment Seb's plan is upgraded -- nothing here is a
// hardcoded 500/month number. alertedThresholds resets itself the next time usage is
// LOWER than last seen (the-odds-api resets requests-used at the start of each billing
// cycle), so the same two DMs fire again next cycle instead of staying silenced forever.
async function recordOddsUsage({ requestsUsed, requestsRemaining, requestsLast }) {
  if (requestsUsed == null && requestsRemaining == null) return;
  const used = requestsUsed != null ? Number(requestsUsed) : null;
  const remaining = requestsRemaining != null ? Number(requestsRemaining) : null;
  const prev = await getDoc("main", "oddsApiUsage", "current");
  const prevData = prev?.data || {};
  const cycleReset = prevData.requestsUsed != null && used != null && used < prevData.requestsUsed;
  const alertedThresholds = cycleReset ? [] : prevData.alertedThresholds || [];
  await upsertDoc("main", "oddsApiUsage", "current", {
    requestsUsed: used,
    requestsRemaining: remaining,
    requestsLast: requestsLast != null ? Number(requestsLast) : prevData.requestsLast ?? null,
    quota: used != null && remaining != null ? used + remaining : prevData.quota ?? null,
    alertedThresholds,
    updatedAt: new Date().toISOString(),
  });
}

const ODDS_USAGE_ALERT_THRESHOLDS = [75, 90];

// Pulled daily by a Supabase pg_cron job (see sports-proxy/sql/odds-usage-cron.sql) --
// not Claude usage, same pattern as /internal/jobs/live-scores above. Reads the usage
// doc recordOddsUsage keeps current, sends Seb a private DM the first time usage
// crosses 75% or 90% of the current cycle's quota (used+remaining from the real
// the-odds-api.com headers, so it adjusts itself the moment Seb's plan changes), and
// remembers which thresholds it already sent so it never repeats one in the same cycle.
// ?test=<percent> sends one clearly-labeled fake DM to prove the wiring works, without
// touching the real usage doc or its dedup state at all -- use this once, manually, not
// from the cron job.
app.get("/internal/jobs/odds-usage-check", async (req, res) => {
  try {
    if (!TELEGRAM_SEB_CHAT_ID) return res.status(500).json({ error: "TELEGRAM_SEB_CHAT_ID not configured on the server." });
    const dryRun = req.query.dryRun === "true";

    if (req.query.test != null) {
      const testPercent = Number(req.query.test);
      const text =
        `🧪 TEST — odds-credit alert wiring check.\n` +
        `Simulated usage: ${testPercent}% of this cycle's the-odds-api quota.\n` +
        `This is a test DM only -- no real usage data or dedup state was touched.`;
      if (!dryRun) await telegramApi("sendMessage", { chat_id: TELEGRAM_SEB_CHAT_ID, text, parse_mode: "HTML" });
      return res.json({ ok: true, test: true, testPercent, sent: !dryRun, dryRun });
    }

    const doc = await getDoc("main", "oddsApiUsage", "current");
    if (!doc || doc.data.requestsUsed == null || doc.data.requestsRemaining == null) {
      return res.json({ ok: true, checked: false, reason: "no real odds-api usage recorded yet" });
    }
    const { requestsUsed: used, requestsRemaining: remaining, alertedThresholds = [] } = doc.data;
    const quota = used + remaining;
    const percent = quota > 0 ? (used / quota) * 100 : 0;
    const newlyAlerted = [];
    for (const threshold of ODDS_USAGE_ALERT_THRESHOLDS) {
      if (percent >= threshold && !alertedThresholds.includes(threshold)) {
        const text =
          `⚠️ the-odds-api usage at ${percent.toFixed(1)}% (${used}/${quota} credits this cycle) ` +
          `-- crossed the ${threshold}% alert line.`;
        if (!dryRun) await telegramApi("sendMessage", { chat_id: TELEGRAM_SEB_CHAT_ID, text, parse_mode: "HTML" });
        newlyAlerted.push(threshold);
      }
    }
    if (newlyAlerted.length && !dryRun) {
      await upsertDoc("main", "oddsApiUsage", "current", { ...doc.data, alertedThresholds: [...alertedThresholds, ...newlyAlerted] });
    }
    res.json({ ok: true, checked: true, percent, used, remaining, quota, newlyAlerted, dryRun });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

const LIVE_SCORE_SPORTS = [
  { key: "NFL", sport: "football", league: "nfl" },
  { key: "CFB", sport: "football", league: "college-football" },
  { key: "NBA", sport: "basketball", league: "nba" },
  { key: "NHL", sport: "hockey", league: "nhl" },
  { key: "other", sport: "baseball", league: "mlb" },
];
const SOCCER_LEAGUES = ["eng.1", "esp.1", "ita.1", "ger.1", "fra.1", "usa.1", "uefa.champions", "uefa.europa"];

// Same event shape as the "Parlay Desk · live scores" cloud tasks this replaces.
async function fetchScoreboardEvents(sport, league) {
  const data = await getJson(`${ESPN_BASE}/${sport}/${league}/scoreboard`);
  return (data.events || [])
    .map((ev) => {
      const comp = ev.competitions?.[0];
      const away = comp?.competitors?.find((c) => c.homeAway === "away");
      const home = comp?.competitors?.find((c) => c.homeAway === "home");
      return {
        state: ev.status?.type?.state,
        detail: ev.status?.type?.shortDetail,
        start: ev.date,
        away: away?.team?.abbreviation,
        awayName: away?.team?.shortDisplayName,
        awayScore: away?.score,
        home: home?.team?.abbreviation,
        homeName: home?.team?.shortDisplayName,
        homeScore: home?.score,
      };
    })
    .filter((e) => ["pre", "in", "post"].includes(e.state));
}

// Pulled on a schedule by an external cron (not Claude usage) — see handbooks/phase2-log.md.
app.get("/internal/jobs/live-scores", async (req, res) => {
  try {
    const sports = { NFL: [], CFB: [], NBA: [], NHL: [], other: [], Soccer: [] };
    for (const s of LIVE_SCORE_SPORTS) {
      try {
        sports[s.key] = await fetchScoreboardEvents(s.sport, s.league);
      } catch (err) {
        console.error(`live-scores: ${s.key} failed: ${err.message}`);
      }
    }
    for (const lg of SOCCER_LEAGUES) {
      try {
        sports.Soccer.push(...(await fetchScoreboardEvents("soccer", lg)));
      } catch (err) {
        console.error(`live-scores: soccer/${lg} failed: ${err.message}`);
      }
    }
    const payload = { updatedAt: new Date().toISOString(), source: "espn", sports };
    for (const desk of DESKS) {
      await upsertDoc(desk, "liveScores", "now", payload);
    }
    res.json({
      ok: true,
      updatedAt: payload.updatedAt,
      counts: Object.fromEntries(Object.entries(sports).map(([k, v]) => [k, v.length])),
      desksUpdated: DESKS,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Desk-facing read API (Part D connects the desk pages to this instead of ArtifactData).
app.get("/api/:desk/live-scores", async (req, res) => {
  try {
    if (!DESKS.includes(req.params.desk)) return res.status(404).json({ error: "unknown desk" });
    const doc = await getDoc(req.params.desk, "liveScores", "now");
    if (!doc) return res.status(404).json({ error: "not found" });
    res.json(doc.data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Telegram (Part C) ---
// Not wired to any trigger yet — blocked on the real Friends Desk message formats and the
// target chat id (see handbooks/phase2-log.md). This is just the reusable send primitive,
// ready to use once both are known.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// Real group chat id (see handbooks/friends-desk-tasks.md). Defined here, above
// sendTelegram, so the quiet-hours check below and grade-and-alert further down can both
// reference it.
const TELEGRAM_GROUP_CHAT_ID = "-5191991471";

// Group quiet hours (2026-10-29, Seb's request): 1:00-7:59 AM America/New_York, the GROUP
// chat only -- every DM (Steve's 1:1, Seb's own private chat) is unaffected, since this
// only checks the chat id. Timezone computed in code (Intl, DST-proof) rather than a fixed
// UTC hour range, which would silently drift wrong across the EST/EDT change.
function isGroupQuietHours() {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date())
  );
  // hour12:false can format midnight as "24" instead of "0" -- normalize.
  const h = hour === 24 ? 0 : hour;
  return h >= 1 && h < 8; // 1:00 AM through 7:59 AM ET
}

async function sendTelegram(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN not configured on the server.");
  const silent = chatId === TELEGRAM_GROUP_CHAT_ID && isGroupQuietHours();
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_notification: silent }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram sendMessage failed: ${JSON.stringify(data)}`);
  return data.result;
}

// One-time helper: once the bot has been added to a chat and sent at least one message
// there, this surfaces that chat's id so it can go into Supabase/task config.
app.get("/internal/telegram/chats", async (req, res) => {
  try {
    if (!TELEGRAM_BOT_TOKEN) return res.status(500).json({ error: "TELEGRAM_BOT_TOKEN not configured." });
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`);
    const data = await r.json();
    const chats = (data.result || []).map((u) => {
      const m = u.message || u.channel_post;
      return m ? { chatId: m.chat.id, type: m.chat.type, title: m.chat.title || m.chat.first_name } : null;
    }).filter(Boolean);
    res.json({ ok: true, chats: [...new Map(chats.map((c) => [c.chatId, c])).values()] });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Telegram alerting, ported from production (Phase 2, item 1) ---
// Captions ported verbatim from MAIN's real tgConfig/captions doc (read via ArtifactData
// 2026-10-21). Timing/dedup logic ported from the real "Friends Desk · requests, new bets &
// Telegram" task prompt (handbooks/friends-desk-tasks.md). Slip-picture rendering (Playwright)
// is NOT ported yet -- it needs Chromium on Render, which this host doesn't have and which may
// not fit the current 512MB plan; falls back to the plain-text caption, same as production's
// own documented fallback behavior when rendering/sendPhoto fails. Scoped to desk "uat" only.
const TELEGRAM_CAPTIONS = {
  placed: "{emoji} {name} placed a bet",
  won: "🎉💰 THIS BET HAS CASHED! 💰🎉\n{emoji} {name} hits it! 🔥🍾🙌",
  cashout: "💵 BET CASHED 💵",
  lost: "❌ {name}'s bet LOST · {odds}",
  push: "↩️ {name}'s bet PUSHED · {odds}",
  livePrefix: "🔴 IN LIVE 🔴\n",
};
const TELEGRAM_PERSON_EMOJI = { main: "🏈", steve: "🏀", lela: "⚽️" };

function buildTelegramCaption({ kind, person, odds, live, lowConfidenceLegs }) {
  const template = TELEGRAM_CAPTIONS[kind];
  if (!template) throw new Error(`Unknown alert kind "${kind}" -- expected placed/won/cashout/lost/push.`);
  const name = person === "main" ? "Seb" : person.charAt(0).toUpperCase() + person.slice(1);
  const emoji = TELEGRAM_PERSON_EMOJI[person] || "";
  let text = template.replace(/\{name\}/g, name).replace(/\{odds\}/g, odds || "").replace(/\{emoji\}/g, emoji);
  if (live) text = TELEGRAM_CAPTIONS.livePrefix + text;
  for (const leg of lowConfidenceLegs || []) {
    text += `\n⚠️ *the ${leg} leg is at or under the confidence level*`;
  }
  return text;
}

// WAIT FOR FINALS: LOST/PUSH only send once every game on the bet is over (last game start +
// 4h), unless Seb graded it himself (gradedBy "seb"), which sends immediately. WON/CASHOUT/
// PLACED always send immediately -- there's no loss being prematurely announced in those cases.
function telegramShouldSendNow({ kind, gradedBy, lastGameStart }) {
  if (kind !== "lost" && kind !== "push") return { ok: true };
  if (gradedBy === "seb") return { ok: true };
  if (!lastGameStart) return { ok: true }; // no game-start info to wait on -- don't block forever
  const readyAt = new Date(lastGameStart).getTime() + 4 * 60 * 60 * 1000;
  if (Date.now() >= readyAt) return { ok: true };
  return { ok: false, reason: "waiting_for_finals", readyAt: new Date(readyAt).toISOString() };
}

// Dedup: claims the alert (desk/tgAlerts/<entryId>:<kind>) before sending. Unlike upsertDoc,
// this is insert-only (ignore-duplicates) so a second claim attempt fails harmlessly instead of
// overwriting -- same "first writer wins" semantics as production's MAIN tgAlerts doc.
async function claimTelegramAlert(deskId, alertId) {
  const res = await supabaseFetch(`/docs?on_conflict=desk_id,collection,doc_id`, {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify([
      { desk_id: deskId, collection: "tgAlerts", doc_id: alertId, data: { sentAt: new Date().toISOString() } },
    ]),
  });
  const rows = await res.json();
  return rows.length > 0; // true = we claimed it; false = already claimed by an earlier call
}

// desk (query param, dedup scope) can be any real desk post-Part F cutover (main/steve/lela)
// or uat for testing -- the dedup doc (desk/tgAlerts/<entryId>:<kind>) is scoped per desk so
// the same entryId never collides across desks. person (body) is who the alert is
// ABOUT (main/steve/lela, for the caption name+emoji) and is independent of desk -- so a UAT
// test can still exercise any of the three real caption identities. Body: { kind:
// placed|won|cashout|lost|push, person, chatId, odds, live, lowConfidenceLegs: [string],
// gradedBy, lastGameStart (ISO), entryId (for dedup), dryRun }.
// dryRun defaults to true -- builds the caption and runs the timing/dedup checks (including
// actually claiming the dedup doc, so repeat-call behavior is real) but does NOT call Telegram,
// so testing this never risks pinging the real group chat with test traffic. Pass dryRun:false
// only once Seb has confirmed which chat id is safe to actually send to.
app.post("/internal/jobs/telegram-alert", async (req, res) => {
  try {
    const desk = req.query.desk;
    if (!DESKS.includes(desk)) return res.status(404).json({ error: "unknown desk" });
    const { kind, person, chatId, odds, live, lowConfidenceLegs, gradedBy, lastGameStart, entryId, dryRun = true } = req.body || {};
    if (!kind || !entryId || !person) return res.status(400).json({ error: "kind, person and entryId are required." });
    if (!TELEGRAM_CAPTIONS[kind]) return res.status(400).json({ error: `Unknown alert kind "${kind}" -- expected placed/won/cashout/lost/push.` });
    if (!dryRun && !chatId) return res.status(400).json({ error: "chatId is required unless dryRun." });

    const timing = telegramShouldSendNow({ kind, gradedBy, lastGameStart });
    if (!timing.ok) return res.json({ sent: false, dryRun, reason: timing.reason, readyAt: timing.readyAt });

    const claimed = await claimTelegramAlert(desk, `${entryId}:${kind}`);
    if (!claimed) return res.json({ sent: false, dryRun, reason: "already_sent" });

    const text = buildTelegramCaption({ kind, person, odds, live, lowConfidenceLegs });
    if (!dryRun) await sendTelegram(chatId, text);
    res.json({ sent: !dryRun, dryRun, text });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Free-text send -- no caption template, no dedup, no timing hold. Used for manual corrections
// (e.g. retracting a bad telegram-alert send) so a mistaken post can be fixed without inventing
// a fake "kind" to abuse telegram-alert's templates. Also used by the automated BET PLACED
// alerts (Post-Cutover Sync + Friends Desk step 0) to post newly-placed entries to the group.
// dryRun defaults to true, same convention as the other Telegram endpoints.
app.post("/internal/jobs/telegram-send-raw", async (req, res) => {
  try {
    const { chatId, text, dryRun = true } = req.body || {};
    if (!text) return res.status(400).json({ error: "text is required." });
    if (!dryRun && !chatId) return res.status(400).json({ error: "chatId is required unless dryRun." });
    if (!dryRun) await sendTelegram(chatId, text);
    res.json({ sent: !dryRun, dryRun, text });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Releases a claim taken by claimTelegramAlert -- used only when the claimed send itself
// failed, so a transient Telegram error can't permanently block that alert (the claim doc
// would otherwise sit there forever looking "already sent" to every future caller).
async function releaseTelegramAlertClaim(deskId, alertId) {
  await supabaseFetch(
    `/docs?desk_id=eq.${encodeURIComponent(deskId)}&collection=eq.tgAlerts&doc_id=eq.${encodeURIComponent(alertId)}`,
    { method: "DELETE" }
  );
}

// Atomic claim-then-send for Phase 1c's placed/tail alerts (2026-10-29): unlike
// telegram-send-raw, this claims desk/tgAlerts/<entryId>:placed in Supabase BEFORE
// sending -- insert-only, so only one caller across any number of overlapping runs
// can ever win it, regardless of how stale each run's own snapshot of groupAlerted
// was. Fixes the 2026-10-29 double-post (two overlapping Post-Cutover Sync fast-path
// runs both decided to send from stale reads). If the claimed send itself fails (a
// real Telegram/network error, not a dedup), the claim is released so the alert isn't
// stuck forever -- the next run (or a retry) gets a fresh chance at it.
app.post("/internal/jobs/telegram-placed-alert", async (req, res) => {
  try {
    const { desk, entryId, text, chatId, dryRun = true } = req.body || {};
    if (!DESKS.includes(desk)) return res.status(404).json({ error: "unknown desk" });
    if (!entryId || !text) return res.status(400).json({ error: "desk, entryId and text are required." });
    if (!dryRun && !chatId) return res.status(400).json({ error: "chatId is required unless dryRun." });

    const alertId = `${entryId}:placed`;
    const claimed = await claimTelegramAlert(desk, alertId);
    if (!claimed) return res.json({ sent: false, dryRun, reason: "already_sent" });

    if (!dryRun) {
      try {
        await sendTelegram(chatId, text);
      } catch (err) {
        await releaseTelegramAlertClaim(desk, alertId).catch(() => {});
        return res.status(502).json({ sent: false, dryRun, reason: "send_failed", released: true, error: err.message });
      }
    }
    res.json({ sent: !dryRun, dryRun, text });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Instant-wake relay for Post-Cutover Sync (2026-10-28) ---
// A Supabase `docs` trigger calls this the moment the APP inserts a new requests/appUploads/
// appEdits row, so the routine can pick it up within seconds instead of waiting for the hourly
// cron. Also called a second time by the pick-request builder triggers right after they answer
// a request, so the round-trip (ticket pushed up + Supabase request marked "answered") doesn't
// wait for the next hourly tick either.
// Fires Post-Cutover Sync directly via its own "API" trigger (claude.ai/code routine Fire URL +
// token, generated once in that routine's trigger settings) -- no GitHub/webhook plumbing
// needed. The appended `text` carries the FAST_PATH_WAKE marker the routine's own prompt
// branches on, so a woken run only does Phase 0 + 1 + 1c and the scheduled hourly fire (which
// carries no such text) still does the full Phase 0-4 sync.
// Rate-limited to at most one real fire per 90s (in-memory -- resets on redeploy, which is
// fine: this is a courtesy coalesce so a burst of app inserts fires once, not a correctness
// guarantee. The routine's own idempotent status checks are what actually prevent
// double-processing, same as every other Phase 0 step already relies on.) A call made DURING
// the cooldown is never just dropped: it schedules one trailing fire for the moment the
// cooldown ends (at most one pending at a time -- a second call while one is already scheduled
// just no-ops), so e.g. an app request made 30s after an upload still wakes the sync once the
// window clears, instead of waiting for the one that already fired.
const CLAUDE_FIRE_URL = process.env.CLAUDE_FIRE_URL;
const CLAUDE_FIRE_TOKEN = process.env.CLAUDE_FIRE_TOKEN;
const SYNC_WAKE_COOLDOWN_MS = 90_000;
let lastSyncWakeAt = 0;
let trailingSyncWakeTimer = null;

async function sendSyncWake() {
  lastSyncWakeAt = Date.now();
  const fireRes = await fetch(CLAUDE_FIRE_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${CLAUDE_FIRE_TOKEN}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "experimental-cc-routine-2026-04-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: "FAST_PATH_WAKE" }),
  });
  if (!fireRes.ok) {
    const body = await fireRes.text();
    throw new Error(`Sync wake fire -> HTTP ${fireRes.status}: ${body}`);
  }
}

app.post("/internal/jobs/wake-sync", async (req, res) => {
  try {
    if (!CLAUDE_FIRE_URL || !CLAUDE_FIRE_TOKEN) {
      return res.status(500).json({ error: "CLAUDE_FIRE_URL/CLAUDE_FIRE_TOKEN not configured on the server." });
    }
    const sinceLast = Date.now() - lastSyncWakeAt;
    if (sinceLast >= SYNC_WAKE_COOLDOWN_MS) {
      await sendSyncWake();
      return res.json({ ok: true, fired: true });
    }
    if (trailingSyncWakeTimer) {
      return res.json({ ok: true, fired: false, reason: "cooldown", trailingAlreadyScheduled: true });
    }
    const delay = SYNC_WAKE_COOLDOWN_MS - sinceLast;
    trailingSyncWakeTimer = setTimeout(async () => {
      trailingSyncWakeTimer = null;
      try {
        await sendSyncWake();
      } catch (err) {
        console.error("Trailing sync wake failed:", err.message);
      }
    }, delay);
    res.json({ ok: true, fired: false, reason: "cooldown", trailingScheduledInMs: delay });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Builder fire relay (2026-10-29, Seb's request) ---
// Replaces direct fire_trigger calls to the two pick-request builders (Sebas Desk pick
// requests, Friends Desk picks/slips/grading) -- those are plain http_api routines now
// (recreated after the cowork-task ArtifactData incident), which fire_trigger can't start.
// Same cooldown + trailing-fire shape as /internal/jobs/wake-sync above, kept PER DESK
// (main and steve fire independently -- one desk's cooldown never blocks the other's).
const BUILDER_FIRE = {
  main: { url: process.env.MAIN_BUILDER_FIRE_URL, token: process.env.MAIN_BUILDER_FIRE_TOKEN },
  steve: { url: process.env.FRIENDS_BUILDER_FIRE_URL, token: process.env.FRIENDS_BUILDER_FIRE_TOKEN },
};
const BUILDER_FIRE_COOLDOWN_MS = 90_000;
const builderFireState = {
  main: { lastFireAt: 0, trailingTimer: null },
  steve: { lastFireAt: 0, trailingTimer: null },
};

async function sendBuilderFire(desk, text) {
  const cfg = BUILDER_FIRE[desk];
  builderFireState[desk].lastFireAt = Date.now();
  const fireRes = await fetch(cfg.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "experimental-cc-routine-2026-04-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(text ? { text } : {}),
  });
  if (!fireRes.ok) {
    const body = await fireRes.text();
    throw new Error(`${desk} builder fire -> HTTP ${fireRes.status}: ${body}`);
  }
}

app.post("/internal/jobs/fire-builder", async (req, res) => {
  try {
    const desk = req.query.desk;
    if (!BUILDER_FIRE[desk]) return res.status(400).json({ error: "desk must be main or steve" });
    const cfg = BUILDER_FIRE[desk];
    if (!cfg.url || !cfg.token) {
      return res
        .status(500)
        .json({ error: `${desk === "main" ? "MAIN" : "FRIENDS"}_BUILDER_FIRE_URL/TOKEN not configured on the server.` });
    }
    const state = builderFireState[desk];
    const text = req.query.text || req.body?.text;
    const sinceLast = Date.now() - state.lastFireAt;
    if (sinceLast >= BUILDER_FIRE_COOLDOWN_MS) {
      await sendBuilderFire(desk, text);
      return res.json({ ok: true, fired: true, desk });
    }
    if (state.trailingTimer) {
      return res.json({ ok: true, fired: false, desk, reason: "cooldown", trailingAlreadyScheduled: true });
    }
    const delay = BUILDER_FIRE_COOLDOWN_MS - sinceLast;
    state.trailingTimer = setTimeout(async () => {
      state.trailingTimer = null;
      try {
        await sendBuilderFire(desk, text);
      } catch (err) {
        console.error(`Trailing ${desk} builder fire failed:`, err.message);
      }
    }, delay);
    res.json({ ok: true, fired: false, desk, reason: "cooldown", trailingScheduledInMs: delay });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Telegram private-chat routing (2026-10-22, Seb's request) ---
// The group chat (real chat_id, passed by the caller as before) keeps getting ONLY the 5
// bet-lifecycle captions above -- unchanged. Everything below always goes to Seb's own DM
// (TELEGRAM_SEB_CHAT_ID), regardless of what a caller passes, so these can never leak into the
// group by a caller mistake. Inbound button taps/commands are only ever acted on if they come
// from that same chat id (see /telegram/webhook below).
const TELEGRAM_SEB_CHAT_ID = process.env.TELEGRAM_SEB_CHAT_ID;

function isSebChat(id) {
  return !!TELEGRAM_SEB_CHAT_ID && String(id) === String(TELEGRAM_SEB_CHAT_ID);
}

async function telegramApi(method, body) {
  if (!TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN not configured on the server.");
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${JSON.stringify(data)}`);
  return data.result;
}

const PRIVATE_CAPTIONS = {
  newRequest: "📝 New {desk} request\n{summary}",
  backupRun: "⚠️ {task} needs a manual “Run now”\n{reason}",
  failure: "🚨 {task} failed\n{reason}",
  usageReport: "{text}",
  test: "✅ Test DM from sports-proxy — private-chat routing is working.",
};

function buildPrivateText({ kind, desk, task, summary, reason, text }) {
  const template = PRIVATE_CAPTIONS[kind];
  if (!template) throw new Error(`Unknown private alert kind "${kind}".`);
  return template
    .replace(/\{desk\}/g, desk || "")
    .replace(/\{task\}/g, task || "")
    .replace(/\{summary\}/g, summary || "")
    .replace(/\{reason\}/g, reason || "")
    .replace(/\{text\}/g, text || "");
}

// kind: newRequest/backupRun/failure/usageReport/test. desk+requestId are required for
// "newRequest" -- they get encoded into the Approve/Skip buttons' callback_data so the webhook
// knows which request a tap refers to. dryRun defaults to true, same convention as
// telegram-alert above, so testing this can't accidentally DM Seb.
app.post("/internal/jobs/telegram-private", async (req, res) => {
  try {
    if (!TELEGRAM_SEB_CHAT_ID) return res.status(500).json({ error: "TELEGRAM_SEB_CHAT_ID not configured on the server." });
    const { kind, desk, task, summary, reason, text, requestId, dryRun = true } = req.body || {};
    if (!PRIVATE_CAPTIONS[kind]) {
      return res.status(400).json({ error: `Unknown kind "${kind}" -- expected newRequest/backupRun/failure/usageReport/test.` });
    }
    const body = buildPrivateText({ kind, desk, task, summary, reason, text });
    let reply_markup;
    if (kind === "newRequest") {
      if (!desk || !requestId) return res.status(400).json({ error: 'desk and requestId are required for kind "newRequest".' });
      reply_markup = {
        inline_keyboard: [[
          { text: "✅ Approve", callback_data: `approve:${desk}:${requestId}` },
          { text: "⏭ Skip", callback_data: `skip:${desk}:${requestId}` },
        ]],
      };
    }
    if (!dryRun) await telegramApi("sendMessage", { chat_id: TELEGRAM_SEB_CHAT_ID, text: body, parse_mode: "HTML", reply_markup });
    res.json({ sent: !dryRun, dryRun, text: body });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Inbound updates from Telegram. Registered once via /internal/telegram/set-webhook below.
// Hard rule (Seb's own requirement): only ever act on an update whose chat/user id matches
// TELEGRAM_SEB_CHAT_ID. Anything else is acknowledged (200, so Telegram doesn't retry) and
// otherwise ignored. Approve/Skip write a flag doc to a new, narrow "requestApprovals"
// collection (desk-scoped but NOT behind the general uat-only write guard, since this is a
// server-internal upsertDoc call, not the public /api/:desk/docs write route) -- it does not
// by itself make the real pick-request/prime-time/Friends-picks tasks build or skip anything
// yet; their prompts need a small added check against this collection before that's true (not
// done in this pass -- see handbooks note).
app.post("/telegram/webhook", async (req, res) => {
  try {
    const update = req.body || {};
    if (update.callback_query) {
      const cq = update.callback_query;
      if (!isSebChat(cq.from?.id)) {
        await telegramApi("answerCallbackQuery", { callback_query_id: cq.id, text: "Not authorized.", show_alert: true });
        return res.json({ ok: true, ignored: true });
      }
      const [action, desk, requestId] = String(cq.data || "").split(":");
      if ((action === "approve" || action === "skip") && desk && requestId) {
        await upsertDoc(desk, "requestApprovals", requestId, {
          approval: action === "approve" ? "approved" : "skipped",
          decidedAt: new Date().toISOString(),
          decidedBy: "seb-telegram",
        });
        await telegramApi("answerCallbackQuery", { callback_query_id: cq.id, text: action === "approve" ? "Approved" : "Skipped" });
        await telegramApi("editMessageText", {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: `${cq.message.text}\n\n${action === "approve" ? "✅ Approved" : "⏭ Skipped"}`,
        });
      } else {
        await telegramApi("answerCallbackQuery", { callback_query_id: cq.id });
      }
      return res.json({ ok: true });
    }
    if (update.message) {
      const msg = update.message;
      if (!isSebChat(msg.chat?.id)) {
        // 2026-10-28: capture any non-Seb private chat that messages the bot (e.g. a friend
        // tapping Start) so Seb can read off their chat id here instead of needing getUpdates
        // (which Telegram stops delivering once a webhook is registered). Read-only side
        // effect -- never acts on the message, never replies, same ignored response as before.
        try {
          await upsertDoc("main", "telegramIntros", String(msg.chat?.id), {
            chatId: msg.chat?.id,
            firstName: msg.chat?.first_name || msg.from?.first_name || null,
            username: msg.chat?.username || msg.from?.username || null,
            lastText: (msg.text || "").slice(0, 200),
            lastSeenAt: new Date().toISOString(),
          });
        } catch (e) { console.error("telegramIntros capture failed:", e.message); }
        return res.json({ ok: true, ignored: true });
      }
      if ((msg.text || "").trim() === "/usage") {
        const doc = await getDoc("main", "opsReports", "usage-latest");
        const reply = doc?.data?.text || "No usage report yet — the nightly report task hasn't run.";
        await telegramApi("sendMessage", { chat_id: msg.chat.id, text: reply });
      }
      return res.json({ ok: true });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("telegram webhook error:", err.message);
    res.status(200).json({ ok: false }); // 200 so Telegram doesn't retry-storm on a server bug
  }
});

// One-time setup (safe to re-call any time -- Telegram just re-registers the same URL). Points
// Telegram's webhook at this same server, reusing PROXY_TOKEN in the query string so the global
// requireToken middleware still protects the inbound endpoint above.
app.get("/internal/telegram/set-webhook", async (req, res) => {
  try {
    const base = req.query.url || `https://${req.get("host")}`;
    const webhookUrl = `${base}/telegram/webhook?token=${encodeURIComponent(PROXY_TOKEN)}`;
    const result = await telegramApi("setWebhook", { url: webhookUrl, allowed_updates: ["message", "callback_query"] });
    res.json({ ok: true, webhookUrl, result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Grader (Part C) ---
// Settles ml/spread/game-total legs from real ESPN box scores using fixed rules (see
// grader.js/matcher.js, validated against ~70 real historical bets in handbooks/phase2-log.md
// — 100% accuracy on every leg it was confident about, zero wrong grades). Anything it can't
// confidently parse or match -> needs_review, never a guess. Scoped to desk "uat" only for
// now (Supabase-side; UAT's real ArtifactData desk isn't connected to this yet — that's
// Part D) so nothing live can be affected by this endpoint.
const GRADER_LEAGUES = [
  ["football", "nfl"], ["football", "college-football"], ["basketball", "nba"],
  ["hockey", "nhl"], ["baseball", "mlb"],
  ["soccer", "eng.1"], ["soccer", "esp.1"], ["soccer", "ita.1"], ["soccer", "ger.1"],
  ["soccer", "fra.1"], ["soccer", "usa.1"], ["soccer", "uefa.champions"], ["soccer", "uefa.europa"],
];

async function fetchGamesForDate(date) {
  const yyyymmdd = date.replace(/-/g, "");
  const games = [];
  for (const [sport, league] of GRADER_LEAGUES) {
    try {
      const data = await getJson(`${ESPN_BASE}/${sport}/${league}/scoreboard?dates=${yyyymmdd}`);
      for (const ev of data.events || []) {
        const comp = ev.competitions?.[0];
        if (!comp) continue;
        const competitors = (comp.competitors || []).map((c) => ({
          score: Number(c.score),
          displayName: c.team?.displayName,
          shortDisplayName: c.team?.shortDisplayName,
          abbreviation: c.team?.abbreviation,
          location: c.team?.location,
          name: c.team?.name,
        }));
        if (competitors.length === 2) {
          games.push({ sport, league, id: ev.id, competitors, state: ev.status?.type?.state });
        }
      }
    } catch (err) {
      // skip this league/date combo, keep going
    }
  }
  return games;
}

function scoreLeg(parsed, game) {
  const comps = game.competitors;
  const isSoccer = game.sport === "soccer";
  if (parsed.category === "ml") {
    const mine = comps.find((c) => teamMatches(parsed.team, c));
    const other = comps.find((c) => c !== mine);
    if (!mine || !other) return null;
    if (mine.score === other.score) return isSoccer ? "miss" : "push";
    return mine.score > other.score ? "hit" : "miss";
  }
  if (parsed.category === "spread") {
    const mine = comps.find((c) => teamMatches(parsed.team, c));
    const other = comps.find((c) => c !== mine);
    if (!mine || !other) return null;
    const margin = mine.score - other.score + parsed.line;
    if (margin === 0) return "push";
    return margin > 0 ? "hit" : "miss";
  }
  if (parsed.category === "total") {
    const combined = comps[0].score + comps[1].score;
    if (combined === parsed.line) return "push";
    const over = combined > parsed.line;
    return (parsed.direction === "over") === over ? "hit" : "miss";
  }
  if (parsed.category === "teamTotal") {
    const mine = comps.find((c) => teamMatches(parsed.team, c));
    if (!mine) return null;
    if (mine.score === parsed.line) return "push";
    const over = mine.score > parsed.line;
    return (parsed.direction === "over") === over ? "hit" : "miss";
  }
  if (parsed.category === "draw") {
    return comps[0].score === comps[1].score ? "hit" : "miss";
  }
  if (parsed.category === "doubleChance") {
    const isTie = (n) => /^(tie|draw)$/i.test(n.trim());
    const options = [parsed.first, parsed.second];
    if (comps[0].score === comps[1].score) {
      return options.some(isTie) ? "hit" : "miss";
    }
    const winner = comps[0].score > comps[1].score ? comps[0] : comps[1];
    return options.some((n) => !isTie(n) && teamMatches(n, winner)) ? "hit" : "miss";
  }
  return null;
}

// --- Player props + anytime TD (box-score lookups) ---
// ml/spread/total only ever need the two final scores, already on the scoreboard payload.
// Props need an individual player's box-score line, which is a separate ESPN endpoint per
// game (.../summary?event=<id>) — fetched lazily, only for the one matched game, never for a
// whole date's slate at once.

function normalizePlayerName(name) {
  return (name || "").toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
}

const boxScoreCache = new Map(); // "sport/league/id" -> parsed boxscore.players, shared across legs within one process lifetime (cheap, read-only data for a final game)

async function fetchBoxScorePlayers(game) {
  const key = `${game.sport}/${game.league}/${game.id}`;
  if (boxScoreCache.has(key)) return boxScoreCache.get(key);
  const data = await getJson(`${ESPN_BASE}/${game.sport}/${game.league}/summary?event=${game.id}`);
  const players = data.boxscore?.players || [];
  boxScoreCache.set(key, players);
  return players;
}

function findAthlete(categories, playerName, labelFilter) {
  const target = normalizePlayerName(playerName);
  for (const cat of categories) {
    if (labelFilter && !labelFilter(cat)) continue;
    for (const ath of cat.athletes || []) {
      if (normalizePlayerName(ath.athlete?.displayName) === target) return { cat, ath };
    }
  }
  return null;
}

// NFL: labels differ per category (passing/rushing/receiving), each with its own athlete list.
const NFL_FIELD = {
  recYds: { cat: "receiving", label: "YDS" },
  rushYds: { cat: "rushing", label: "YDS" },
  rushAtt: { cat: "rushing", label: "CAR" },
  receptions: { cat: "receiving", label: "REC" },
  passYds: { cat: "passing", label: "YDS" },
  passTd: { cat: "passing", label: "TD" },
  completions: { cat: "passing", label: "C/ATT" }, // "19/33" -> take completions (first number)
};

async function nflStatValue(game, playerName, statKey) {
  const players = await fetchBoxScorePlayers(game);
  // "anyTdCount" backs the bare counting prop ("CeeDee Lamb 2+ touchdowns") — rushing +
  // receiving only. A QB's passing TDs never belong here: he didn't personally cross the goal
  // line, so a passing TD doesn't make him "the scorer" (that's what broke "Anytime TD Scorer"
  // grading before this fix — Josh Allen throwing 2 TDs with 0 rush/rec TDs was coming back
  // "hit" when the real bet was a miss). Passing TDs still count on their own via "passTd".
  if (statKey === "anyTdCount") {
    let total = null;
    for (const team of players) {
      for (const cat of team.statistics) {
        if (!["rushing", "receiving"].includes(cat.name)) continue;
        const iTD = cat.labels.indexOf("TD");
        if (iTD < 0) continue;
        const hit = findAthlete([cat], playerName);
        if (hit) total = (total || 0) + (Number(hit.ath.stats[iTD]) || 0);
      }
    }
    return total;
  }
  const field = NFL_FIELD[statKey];
  if (!field) return null;
  for (const team of players) {
    const cat = team.statistics.find((c) => c.name === field.cat);
    if (!cat) continue;
    const idx = cat.labels.indexOf(field.label);
    if (idx < 0) continue;
    const hit = findAthlete([cat], playerName);
    if (hit) {
      const raw = hit.ath.stats[idx];
      return field.label === "C/ATT" ? Number(raw.split("/")[0]) : Number(raw);
    }
  }
  return null;
}

async function nflAnytimeTd(game, playerName) {
  const n = await nflStatValue(game, playerName, "anyTdCount");
  return n === null ? null : n >= 1;
}

// NBA: one flat athlete list per team, labels shared: MIN,PTS,FG,3PT,FT,REB,AST,TO,STL,BLK,OREB,DREB,PF,+/-
const NBA_LABEL = { points: "PTS", rebounds: "REB", assists: "AST", blocks: "BLK", steals: "STL" };

async function nbaStatValue(game, playerName, statKey) {
  const players = await fetchBoxScorePlayers(game);
  for (const team of players) {
    const cat = team.statistics[0];
    if (!cat) continue;
    const hit = findAthlete([cat], playerName);
    if (!hit) continue;
    if (statKey === "threes") {
      const idx = cat.labels.indexOf("3PT");
      return idx < 0 ? null : Number(hit.ath.stats[idx].split("-")[0]); // "3-7" made-attempted -> made
    }
    const label = NBA_LABEL[statKey];
    const idx = label ? cat.labels.indexOf(label) : -1;
    return idx < 0 ? null : Number(hit.ath.stats[idx]);
  }
  return null;
}

// NHL: players split across forwards/defenses/skaters/goalies categories, shared skater labels.
// Verified against a real game: summed "S" per team == the opposing goalie's shots-against, so
// "S" is shots on goal (the column named "SOG" here is shootout goals, almost always 0 and NOT
// what a "shots on goal" prop means — do not use it).
const NHL_LABEL = { goals: "G", assists: "A", shotsOnGoal: "S" };

async function nhlStatValue(game, playerName, statKey) {
  const players = await fetchBoxScorePlayers(game);
  const skaterCats = (team) => team.statistics.filter((c) => c.name !== "goalies");
  for (const team of players) {
    const hit = findAthlete(skaterCats(team), playerName);
    if (!hit) continue;
    if (statKey === "points") {
      const iG = hit.cat.labels.indexOf("G");
      const iA = hit.cat.labels.indexOf("A");
      if (iG < 0 || iA < 0) return null;
      return (Number(hit.ath.stats[iG]) || 0) + (Number(hit.ath.stats[iA]) || 0);
    }
    const label = NHL_LABEL[statKey];
    const idx = label ? hit.cat.labels.indexOf(label) : -1;
    return idx < 0 ? null : Number(hit.ath.stats[idx]);
  }
  return null;
}

// MLB: category.name is unlabeled ("undefined") on this endpoint — distinguish batting vs
// pitching by which labels are present instead.
async function mlbStatValue(game, playerName, statKey) {
  const players = await fetchBoxScorePlayers(game);
  for (const team of players) {
    for (const cat of team.statistics) {
      const isPitching = cat.labels.includes("IP");
      const isBatting = cat.labels.includes("AB");
      if (statKey === "hits" && isBatting) {
        const hit = findAthlete([cat], playerName);
        if (hit) return Number(hit.ath.stats[cat.labels.indexOf("H")]);
      }
      if (statKey === "strikeouts" && isPitching) {
        const hit = findAthlete([cat], playerName);
        if (hit) return Number(hit.ath.stats[cat.labels.indexOf("K")]);
      }
      if (statKey === "outsRecorded" && isPitching) {
        const hit = findAthlete([cat], playerName);
        if (hit) {
          const ip = hit.ath.stats[cat.labels.indexOf("IP")]; // "5.1" = 5 innings + 1 out
          const [whole, part] = ip.split(".").map(Number);
          return whole * 3 + (part || 0);
        }
      }
    }
  }
  return null;
}

const SPORT_STAT_FN = { nfl: nflStatValue, nba: nbaStatValue, nhl: nhlStatValue, mlb: mlbStatValue };
const STAT_SPORT_CANDIDATES = {
  recYds: [["football", "nfl"]], rushYds: [["football", "nfl"]], rushAtt: [["football", "nfl"]],
  receptions: [["football", "nfl"]], passYds: [["football", "nfl"]], passTd: [["football", "nfl"]],
  completions: [["football", "nfl"]], anyTdCount: [["football", "nfl"]],
  rebounds: [["basketball", "nba"]], blocks: [["basketball", "nba"]], steals: [["basketball", "nba"]], threes: [["basketball", "nba"]],
  shotsOnGoal: [["hockey", "nhl"]], goals: [["hockey", "nhl"]],
  strikeouts: [["baseball", "mlb"]], outsRecorded: [["baseball", "mlb"]], hits: [["baseball", "mlb"]],
  points: [["basketball", "nba"], ["hockey", "nhl"]], assists: [["basketball", "nba"], ["hockey", "nhl"]],
};

// Resolve which game a prop leg is about. If the text had team context, this is exactly the
// same team-matching the ml/spread/total legs already use. If it didn't (an older, bare
// "Player anytime TD" with no matchup in the text), fall back to scanning the plausible
// sport(s)' box scores for that date for the player by name — more expensive, only hit when
// the cheap path has nothing to go on, and returns no match (never a guess) if the player turns
// up in more than one game that date.
async function resolveGameForProp(parsed, games, statKey) {
  if (parsed.rawA || parsed.rawB) {
    const game = findGame(games, parsed.rawA || "", parsed.rawB || "");
    if (game) return { game };
  }
  const candidates = STAT_SPORT_CANDIDATES[statKey] || (statKey === "anytimeTd" ? [["football", "nfl"]] : []);
  const candidateGames = games.filter((g) => candidates.some(([sport, league]) => g.sport === sport && g.league === league));
  let found = null;
  let anyNotFinal = false;
  for (const g of candidateGames) {
    if (g.state !== "post") { anyNotFinal = true; continue; } // can't confirm a player's a box-score match pregame anyway
    const players = await fetchBoxScorePlayers(g);
    const flatCats = players.flatMap((t) => t.statistics);
    if (findAthlete(flatCats, parsed.player)) {
      if (found) return { game: null }; // ambiguous — same-named player in two of today's games, never guess
      found = g;
    }
  }
  // No completed box score has this player, but a same-sport game today/this window hasn't
  // finished yet -- it's too early to call this unresolvable, so say so rather than guessing
  // the player's game is simply unfindable.
  if (!found && anyNotFinal) return { game: null, pending: true };
  return { game: found };
}

// A leg's game hasn't necessarily started or finished just because we can't grade the market
// (unsupported) or can't confidently match a game (ambiguous/missing team text). Before calling
// any of that needs_review, check whether the relevant game is even over yet -- first by
// spotting a team abbreviation/name token from the leg text among the fetched games, then by
// falling back to the ticket's own date vs. today. Only once we have reason to believe the game
// is actually final does "we still can't resolve this" mean needs_review; otherwise it's pending.
function stillAwaitingResult(text, games, ticketDate) {
  const tokens = new Set();
  for (const m of (text || "").match(/\(([^)]+)\)/g) || []) {
    for (const part of m.slice(1, -1).split(/[,@/]/)) {
      const tok = part.trim();
      if (tok && tok.length <= 5 && /^[A-Za-z.]+$/.test(tok)) tokens.add(tok.toUpperCase());
    }
  }
  if (tokens.size > 0) {
    const matched = games.filter((g) => g.competitors.some((c) => tokens.has((c.abbreviation || "").toUpperCase())));
    if (matched.length > 0) return matched.some((g) => g.state !== "post");
  }
  const todayStr = new Date().toISOString().slice(0, 10);
  return Boolean(ticketDate && ticketDate >= todayStr);
}

async function gradeOneLeg(leg, ticketDate) {
  const parsed = parseLeg(leg.text, leg.type);

  const base = ticketDate ? new Date(ticketDate + "T12:00:00Z") : new Date();
  const dates = [-1, 0, 1].map((delta) => {
    const dd = new Date(base);
    dd.setUTCDate(dd.getUTCDate() + delta);
    return dd.toISOString().slice(0, 10);
  });
  const gameLists = await Promise.all(dates.map(fetchGamesForDate));
  const games = gameLists.flat();

  if (parsed.category === "unsupported") {
    if (stillAwaitingResult(leg.text, games, ticketDate)) {
      return { status: "pending", reason: `${parsed.reason} (game not final yet, so not calling this needs_review)` };
    }
    return { status: "needs_review", reason: parsed.reason };
  }

  if (parsed.category === "stat" || parsed.category === "anytimeTd") {
    const statKey = parsed.category === "anytimeTd" ? "anytimeTd" : parsed.statKey;
    const resolved = await resolveGameForProp(parsed, games, statKey);
    if (resolved.pending) return { status: "pending", reason: "game not final yet" };
    const game = resolved.game;
    if (!game) {
      if (stillAwaitingResult(leg.text, games, ticketDate)) return { status: "pending", reason: "no confident game match yet, but game not final" };
      return { status: "needs_review", reason: "no confident game match for this player" };
    }
    if (game.state !== "post") return { status: "pending", reason: "game not final yet" };

    if (parsed.category === "anytimeTd") {
      if (game.sport !== "football") return { status: "needs_review", reason: "anytime-scorer grading only supports NFL for now" };
      const scored = await nflAnytimeTd(game, parsed.player);
      if (scored === null) return { status: "needs_review", reason: "player not found in box score" };
      return { status: scored ? "hit" : "miss" };
    }

    const sportFn = SPORT_STAT_FN[game.sport === "football" ? "nfl" : game.sport === "basketball" ? "nba" : game.sport === "hockey" ? "nhl" : game.sport === "baseball" ? "mlb" : null];
    if (!sportFn) return { status: "needs_review", reason: `prop grading not supported for sport "${game.sport}"` };
    const value = await sportFn(game, parsed.player, parsed.statKey);
    if (value === null) return { status: "needs_review", reason: "player not found in box score, or stat not tracked for this sport/position" };

    if (parsed.direction === "atleast") {
      return { status: value >= parsed.line ? "hit" : "miss" };
    }
    // Over/Under: a whole-number line can push (actual === line); a half-point line never can.
    if (Number.isInteger(parsed.line) && value === parsed.line) return { status: "push" };
    const over = value > parsed.line;
    return { status: (parsed.direction === "over") === over ? "hit" : "miss" };
  }

  const teamQuery = parsed.team || parsed.rawA;
  const oppQuery = parsed.opponent || parsed.rawB;
  const game = findGame(games, teamQuery || "", oppQuery || "");
  if (!game) {
    if (stillAwaitingResult(leg.text, games, ticketDate)) return { status: "pending", reason: "no confident game match yet, but game not final" };
    return { status: "needs_review", reason: "no confident game match" };
  }
  if (game.state !== "post") return { status: "pending", reason: "game not final yet" };

  const verdict = scoreLeg(parsed, game);
  if (!verdict) return { status: "needs_review", reason: "matched game but could not score it" };
  return { status: verdict };
}

function rollUpTicketStatus(legs) {
  // An empty/missing legs array is a malformed-doc signal (e.g. a double-wrapped
  // Supabase row where the real legs sit one level deeper) -- NOT "every leg resolved."
  // Falling through to "won" here was a vacuous-truth bug: it silently marked
  // corrupted docs as won. Caller should treat this as "don't touch the status."
  if (legs.length === 0) return "needs_review";
  if (legs.some((l) => l.status === "needs_review")) return "needs_review";
  if (legs.some((l) => l.status === "pending")) return "pending";
  if (legs.some((l) => l.status === "miss")) return "lost";
  return "won"; // every leg is hit or push
}

app.get("/internal/jobs/grader", async (req, res) => {
  const desk = req.query.desk;
  // "collection" lets this same grader run against any single-ticket-shaped collection,
  // not just "parlays" -- added 2026-10-28 for "ftd" (First TD options queue), which uses
  // the identical {legs:[{text,type,status}], status} shape, just one leg per doc.
  const collection = req.query.collection || "parlays";
  if (!DESKS.includes(desk)) return res.status(404).json({ error: "unknown desk" });
  try {
    const listRes = await supabaseFetch(
      `/docs?desk_id=eq.${encodeURIComponent(desk)}&collection=eq.${encodeURIComponent(collection)}&select=doc_id,data,version`
    );
    const docs = await listRes.json();
    const results = [];
    for (const doc of docs) {
      const data = doc.data;
      const legs = data.legs || [];
      // Re-check "needs_review" too, not just "pending" -- a leg can land on needs_review
      // while its game is still in progress (stillAwaitingResult correctly defers a hard
      // "needs_review" call at that point), but was previously never revisited once the
      // game went final, so it stayed wrong indefinitely instead of resolving to a real
      // hit/miss/push. Found 2026-10-28: 3 real MAIN/Steve/Lela tickets stuck needs_review
      // for 6-9h after their games finished.
      const pendingIdx = legs
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => !l.status || l.status === "pending" || l.status === "needs_review");

      let changed = false;
      const newLegs = [...legs];
      for (const { l, i } of pendingIdx) {
        const graded = await gradeOneLeg(l, data.date);
        if (graded.status !== (l.status || "pending")) {
          newLegs[i] = { ...l, status: graded.status };
          changed = true;
        }
      }

      // Roll up and write even when no leg changed this run (including when pendingIdx was
      // empty from the start, i.e. every leg was ALREADY hit/miss/push -- a ticket whose legs
      // came in pre-graded, e.g. read straight off an uploaded slip, never had a "pending" leg
      // for this loop to grade, so its own ticket-level `status` field could sit wrong
      // (stuck "needs_review"/"pending") forever with nothing to ever correct it. Comparing
      // against the ticket's CURRENT stored status, not just whether a leg changed, is what
      // catches that. Found 2026-10-28: 2 real MAIN tickets stuck this way, fully graded legs
      // but a stale ticket-level status.
      const newTicketStatus = rollUpTicketStatus(newLegs);
      if (!changed && newTicketStatus === data.status) continue;

      const newData = { ...data, legs: newLegs, status: newTicketStatus };
      await upsertDoc(desk, collection, doc.doc_id, newData);
      results.push({ ticketId: doc.doc_id, newStatus: newTicketStatus, legStatuses: newLegs.map((l) => l.status) });
    }
    res.json({ ok: true, collection, ticketsChecked: docs.length, ticketsUpdated: results.length, results });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Engine-only grade + alert, no Claude run (2026-10-29, Seb's request) ---
// Reuses the same grading logic as /internal/jobs/grader above, writing only the engine's
// Supabase mirror. SAFE BY CONSTRUCTION against Post-Cutover Sync's Phase 1 push-up:
// upsertDoc always stamps `updated_at` to now, and Phase 1 only pushes the real desk's
// copy UP (overwriting the mirror) when the real desk's own updatedAt/createdAt is newer
// than the mirror's updated_at -- a grade written here always makes the mirror the newer
// one, so Phase 1 skips it on its own, no prompt change needed.
//
// Telegram alerting here ONLY ever acts on "pnlEntries" transitions to won/lost/push --
// those are real stake>0 placed bets by construction. "parlays" and "ftd" are graded (same
// Supabase-mirror-only write) but never alerted from this job: a "parlays" alert needs
// Phase 4's own played:true gate checked against the REAL desk (which this job never
// touches), and "ftd" is explicitly never alerted per Post-Cutover Sync's Phase 3b.
//
// mode=shadow (default): grades for real (so tomorrow's comparison has real data), logs
// what WOULD be sent to collection "graderShadowLog" -- NEVER calls claimTelegramAlert, so
// it can never pre-claim the dedup key and block a later real send. mode=live: actually
// claims (via the SAME claimTelegramAlert helper, same `${entryId}:${kind}` key Phase
// 1c/4 use) and sends -- only ever pass mode=live after Seb has reviewed shadow output.
//
// SCOPE (2026-10-29, Seb's ask, after the first unscoped run took 2m37s/desk re-checking
// hundreds of permanently-stuck needs_review legs every tick): "parlays" and "ftd" only
// grade tickets whose game date is within the last 3 days (server-side filter, cheap).
// "pnlEntries" grades that same 3-day window PLUS, regardless of date, every doc that's
// still pending/needs_review with a real stake > 0 -- real money is never skipped just
// because it's an old open bet.
function etDateDaysAgo(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d); // YYYY-MM-DD
}

async function gradeCollectionForDesk(desk, collection, mode) {
  const dateFloor = etDateDaysAgo(3);
  const base = `/docs?desk_id=eq.${encodeURIComponent(desk)}&collection=eq.${encodeURIComponent(collection)}&select=doc_id,data,version`;
  let docs;
  if (collection === "pnlEntries") {
    // Needs the stake>0-regardless-of-date OR, which isn't safe to express as a numeric
    // Supabase/PostgREST filter on a jsonb field -- fetch this (modest-sized) collection
    // in full and filter in JS instead.
    const listRes = await supabaseFetch(base);
    const all = await listRes.json();
    docs = all.filter((doc) => {
      const d = doc.data || {};
      if (d.date && d.date >= dateFloor) return true;
      const stillOpen = !d.status || d.status === "pending" || d.status === "needs_review";
      return stillOpen && Number(d.stake) > 0;
    });
  } else {
    const listRes = await supabaseFetch(`${base}&data->>date=gte.${encodeURIComponent(dateFloor)}`);
    docs = await listRes.json();
  }
  const results = [];
  for (const doc of docs) {
    const data = doc.data;
    const legs = data.legs || [];
    const pendingIdx = legs
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => !l.status || l.status === "pending" || l.status === "needs_review");
    let changed = false;
    const newLegs = [...legs];
    for (const { l, i } of pendingIdx) {
      const graded = await gradeOneLeg(l, data.date);
      if (graded.status !== (l.status || "pending")) {
        newLegs[i] = { ...l, status: graded.status };
        changed = true;
      }
    }
    const newTicketStatus = rollUpTicketStatus(newLegs);
    const prevStatus = data.status;
    if (!changed && newTicketStatus === prevStatus) continue;
    const newData = { ...data, legs: newLegs, status: newTicketStatus };
    if (mode === "live") {
      await upsertDoc(desk, collection, doc.doc_id, newData);
    } else {
      // SHADOW MODE: never touch the real collection -- only log what would have
      // been written, so Phase 1 (desk -> Supabase push) is never starved by a
      // shadow-bumped updated_at, and nothing here can corrupt pnlEntries/parlays/ftd.
      await upsertDoc(desk, "graderShadowLog", `${doc.doc_id}-${collection}-${Date.now()}`, {
        desk,
        collection,
        docId: doc.doc_id,
        prevStatus,
        wouldBeStatus: newTicketStatus,
        wouldBeLegs: newLegs,
        loggedAt: new Date().toISOString(),
      });
    }
    results.push({ docId: doc.doc_id, prevStatus, newStatus: newTicketStatus, data: newData });
  }
  return results;
}

app.get("/internal/jobs/grade-and-alert", async (req, res) => {
  const desks = req.query.desk ? [req.query.desk] : ["main", "steve"];
  const mode = req.query.mode === "live" ? "live" : "shadow";
  for (const d of desks) if (!DESKS.includes(d)) return res.status(404).json({ error: `unknown desk: ${d}` });
  try {
    const summary = { mode, results: {} };
    for (const desk of desks) {
      const deskSummary = { parlays: 0, pnlEntries: 0, ftd: 0, alertsSent: 0, alertsLogged: 0 };
      for (const collection of ["parlays", "pnlEntries", "ftd"]) {
        const changed = await gradeCollectionForDesk(desk, collection, mode);
        deskSummary[collection] = changed.length;
        if (collection !== "pnlEntries") continue;

        for (const c of changed) {
          if (!["won", "lost", "push"].includes(c.newStatus)) continue;
          if (c.prevStatus === c.newStatus) continue;
          const kind = c.newStatus;
          const person = c.data.who || c.data.source || "claude";
          const entryId = c.docId;

          if (mode === "shadow") {
            // gradeCollectionForDesk already wrote the per-doc shadow-log entry above;
            // this just tallies the "would have alerted" count for the summary.
            deskSummary.alertsLogged++;
          } else {
            const timing = telegramShouldSendNow({ kind, gradedBy: c.data.gradedBy, lastGameStart: c.data.lastStart });
            if (!timing.ok) continue;
            const claimed = await claimTelegramAlert(desk, `${entryId}:${kind}`);
            if (!claimed) continue;
            const text = buildTelegramCaption({ kind, person, odds: c.data.odds });
            try {
              await sendTelegram(TELEGRAM_GROUP_CHAT_ID, text);
              deskSummary.alertsSent++;
            } catch (err) {
              await releaseTelegramAlertClaim(desk, `${entryId}:${kind}`).catch(() => {});
            }
          }
        }
      }
      summary.results[desk] = deskSummary;
    }
    res.json({ ok: true, ...summary });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- First TD weekly archive (2026-10-28, Seb's request) ---
// Tuesday-morning engine job (pg_cron, not a Claude run -- see sports-proxy/sql/ftd-archive-cron.sql),
// scheduled AFTER the NFL TD weekly learning loop has graded the week's "ftd" docs. Moves every
// doc in collection "ftd" for a desk into collection "ftdHistory" under the SAME doc_id (so the
// learning loop and any later lookup can still find a given week's option by id), then deletes it
// from "ftd" so the app's First TD tab starts the new week empty. With no ?desk given, runs for
// both "main" and "steve" (Seb's desk and Steve's desk get the same First TD options and the same
// archive treatment; Lela is not on this feature). Safe to re-run: archiving an already-empty "ftd"
// collection for a desk is just a no-op for that desk.
async function archiveFtdForDesk(desk) {
  const listRes = await supabaseFetch(
    `/docs?desk_id=eq.${encodeURIComponent(desk)}&collection=eq.ftd&select=doc_id,data`
  );
  const docs = await listRes.json();
  for (const doc of docs) {
    await upsertDoc(desk, "ftdHistory", doc.doc_id, doc.data);
  }
  if (docs.length > 0) {
    await supabaseFetch(
      `/docs?desk_id=eq.${encodeURIComponent(desk)}&collection=eq.ftd`,
      { method: "DELETE" }
    );
  }
  return docs.length;
}

app.get("/internal/jobs/archive-ftd", async (req, res) => {
  const desks = req.query.desk ? [req.query.desk] : ["main", "steve"];
  for (const d of desks) {
    if (!DESKS.includes(d)) return res.status(404).json({ error: `unknown desk: ${d}` });
  }
  try {
    const archived = {};
    for (const d of desks) {
      archived[d] = await archiveFtdForDesk(d);
    }
    res.json({ ok: true, archived });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Part E: pure read-only dry-run of the grader for the daily engine-vs-production comparison.
// Takes a leg's text/type/date, returns the engine's independent verdict, touches no desk at all
// (no Supabase read/write) -- safe to call against any desk's real settled legs for comparison.
app.get("/internal/jobs/grade-dry-run", async (req, res) => {
  const { text, type, date } = req.query;
  if (!text) return res.status(400).json({ error: "text is required" });
  try {
    const graded = await gradeOneLeg({ text, type }, date);
    res.json(graded);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Desk-facing API + Claude's Supabase access (Part C) ---
// Generic docs CRUD mirroring ArtifactData's own shape, so both desk pages (Part D) and
// Claude cloud tasks (via a plain WebFetch instead of the ArtifactData tool) can read/write
// Supabase through this one proxy-token-protected surface. Reads are open to all desks (same
// exposure as /api/:desk/live-scores already has). Writes are open to all desks as of Part F
// cutover (2026-10-23) -- note this only ever writes the ENGINE's own Supabase mirror for that
// desk_id, never the real claude.ai artifact's ArtifactData store directly; a real desk's
// actual data only changes via the separate Post-Cutover Sync task, which writes through the
// ArtifactData tool with if_version pinning.

app.get("/api/:desk/docs/:collection", async (req, res) => {
  try {
    if (!DESKS.includes(req.params.desk)) return res.status(404).json({ error: "unknown desk" });
    const r = await supabaseFetch(
      `/docs?desk_id=eq.${encodeURIComponent(req.params.desk)}&collection=eq.${encodeURIComponent(req.params.collection)}&select=doc_id,data,version,updated_at`
    );
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/:desk/docs/:collection/:docId", async (req, res) => {
  try {
    if (!DESKS.includes(req.params.desk)) return res.status(404).json({ error: "unknown desk" });
    const doc = await getDoc(req.params.desk, req.params.collection, req.params.docId);
    if (!doc) return res.status(404).json({ error: "not found" });
    res.json(doc);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/:desk/docs/:collection/:docId", async (req, res) => {
  try {
    if (!DESKS.includes(req.params.desk)) return res.status(404).json({ error: "unknown desk" });
    if (!req.body || typeof req.body !== "object") return res.status(400).json({ error: "JSON body required" });
    await upsertDoc(req.params.desk, req.params.collection, req.params.docId, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Atomic claim (2026-10-28): the plain POST above is a blind upsert, fine for one writer --
// but now that Post-Cutover Sync can be woken mid-cycle by the fast path AND still run on its
// own hourly cron, two overlapping runs could both see the same appUpload/appEdit/request at
// "pending" and both process it (double BET PLACED, worst case). This calls a single Postgres
// UPDATE ... WHERE data->>'status' = expected (claim_doc_status, see sql/app-wake-sync.sql) --
// row-level locking means only the first of two concurrent callers actually matches that WHERE
// clause and updates anything; the other gets `claimed:false` back and must skip the row
// entirely rather than process it. Call this BEFORE doing any real work on a row, not just
// before the final write.
app.post("/api/:desk/docs/:collection/:docId/claim", async (req, res) => {
  try {
    if (!DESKS.includes(req.params.desk)) return res.status(404).json({ error: "unknown desk" });
    const { expected, next } = req.body || {};
    if (!expected || !next) return res.status(400).json({ error: "expected and next are required" });
    const r = await supabaseFetch(`/rpc/claim_doc_status`, {
      method: "POST",
      body: JSON.stringify({
        p_desk_id: req.params.desk,
        p_collection: req.params.collection,
        p_doc_id: req.params.docId,
        p_expected: expected,
        p_next: next,
      }),
    });
    const claimed = await r.json();
    res.json({ ok: true, claimed: claimed === true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Stuck-claim recovery (2026-10-28): if a run dies right after claiming a row (crash, killed
// task) before finishing it, that row would sit at "processing" forever -- nothing would ever
// touch it again. The hourly FULL run (never the fast path -- see Post-Cutover Sync's own
// prompt) sweeps for rows still "processing" with a `claimedAt` older than staleMinutes
// (default 20) and takes them over via reclaim_stuck_doc, same atomic
// UPDATE-with-the-check-in-the-WHERE-clause pattern as /claim above.
app.post("/api/:desk/docs/:collection/:docId/reclaim-stuck", async (req, res) => {
  try {
    if (!DESKS.includes(req.params.desk)) return res.status(404).json({ error: "unknown desk" });
    const staleMinutes = Number(req.body?.staleMinutes) || 20;
    const r = await supabaseFetch(`/rpc/reclaim_stuck_doc`, {
      method: "POST",
      body: JSON.stringify({
        p_desk_id: req.params.desk,
        p_collection: req.params.collection,
        p_doc_id: req.params.docId,
        p_stale_minutes: staleMinutes,
      }),
    });
    const claimed = await r.json();
    res.json({ ok: true, claimed: claimed === true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.delete("/api/:desk/docs/:collection/:docId", async (req, res) => {
  try {
    if (!DESKS.includes(req.params.desk)) return res.status(404).json({ error: "unknown desk" });
    await supabaseFetch(
      `/docs?desk_id=eq.${encodeURIComponent(req.params.desk)}&collection=eq.${encodeURIComponent(req.params.collection)}&doc_id=eq.${encodeURIComponent(req.params.docId)}`,
      { method: "DELETE" }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Convenience read-only shortcuts for the desk's most-used collections.
for (const collection of ["parlays", "pnlEntries", "rules", "requests", "ftd", "ftdHistory"]) {
  app.get(`/api/:desk/${collection}`, async (req, res) => {
    try {
      if (!DESKS.includes(req.params.desk)) return res.status(404).json({ error: "unknown desk" });
      const r = await supabaseFetch(
        `/docs?desk_id=eq.${encodeURIComponent(req.params.desk)}&collection=eq.${collection}&select=doc_id,data,version,updated_at`
      );
      res.json(await r.json());
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
}

// --- App uploads: slip image fetch (Session B, Phase 3A "app can save") ---
// The 'slips' Storage bucket is private -- only the SERVICE key can read it. The Slip
// reader trigger (B4) has no Supabase credentials of its own and never should; it calls
// this proxy-token-protected endpoint instead, same pattern as every other engine call.
app.get("/api/:desk/slip-image", async (req, res) => {
  try {
    if (!DESKS.includes(req.params.desk)) return res.status(404).json({ error: "unknown desk" });
    const path = req.query.path;
    if (!path || !path.startsWith(`${req.params.desk}/`)) {
      return res.status(400).json({ error: "path is required and must start with '<desk>/'" });
    }
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/slips/${path}`, {
      headers: { apikey: SUPABASE_SECRET_KEY, Authorization: `Bearer ${SUPABASE_SECRET_KEY}` },
    });
    if (!r.ok) return res.status(r.status).json({ error: await r.text() });
    res.set("Content-Type", r.headers.get("content-type") || "application/octet-stream");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Phase 3 prep tables (model_versions, learning_log, pick_sources) ---
// These have no desk_id column (schema.sql) -- they're global learning-history tables, not
// per-desk docs, so no UAT-only write gate applies (nothing live reads from them yet).
async function insertRow(table, row) {
  await supabaseFetch(`/${table}`, {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify([row]),
  });
}

const LEARNING_TABLES = {
  "model-versions": { table: "model_versions", fields: ["spec", "version", "what_changed"], orderBy: "date" },
  "learning-log": {
    table: "learning_log",
    fields: ["task", "what_it_learned", "data_used", "hit_rate_before", "hit_rate_after"],
    orderBy: "created_at",
  },
  "pick-sources": {
    table: "pick_sources",
    fields: ["pick_id", "source_type", "url_or_ref"],
    orderBy: "created_at",
  },
};

for (const [route, { table, fields, orderBy }] of Object.entries(LEARNING_TABLES)) {
  app.post(`/api/learning/${route}`, async (req, res) => {
    try {
      if (!req.body || typeof req.body !== "object") return res.status(400).json({ error: "JSON body required" });
      const row = {};
      for (const f of fields) if (req.body[f] !== undefined) row[f] = req.body[f];
      await insertRow(table, row);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get(`/api/learning/${route}`, async (req, res) => {
    try {
      const r = await supabaseFetch(`/${table}?order=${orderBy}.desc&limit=${req.query.limit || 100}`);
      res.json(await r.json());
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
}

// --- NBA blowout tracker (2026-10-24, Seb's request) ---
// Nightly engine job (no Claude usage): for every FINAL NBA game on a date, records the
// score margin at the 4:00 mark of the 4th quarter (a 25+ margin there flags a blowout --
// the point a trailing team's bench is typically already in) plus the final margin and
// both teams' starters' minutes, so blowout rate and garbage-time starter-minutes loss can
// be computed per team once there's enough sample. DATA COLLECTION ONLY -- see rule
// nba-blowout-factor. Nothing reads this for picks yet; the Monday/Thursday NBA Tracker
// refresh merges it into nbaTeams as reference data only.

// ESPN's team abbreviations don't always match the Desk's nbaTeams doc ids.
const ESPN_TO_NBA_ABBR = { GS: "GSW", NO: "NOP", NY: "NYK", SA: "SAS", UTAH: "UTA", WSH: "WAS" };
function nbaAbbr(a) {
  return ESPN_TO_NBA_ABBR[a] || a;
}

function secondsRemaining(clockDisplay) {
  const m = /^(\d+):(\d+)/.exec(clockDisplay || "");
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Score (away, home) as of the play closest to 4:00 remaining in the 4th quarter --
// prefers the last play still at >=240s remaining, so the snapshot is the score AS the
// clock reaches 4:00 rather than just after. Play-by-play granularity means this is a
// close approximation, not an exact frame.
function marginAtFourMinutes(plays) {
  const q4 = (plays || []).filter((p) => p.period?.number === 4);
  let best = null;
  let bestDiff = Infinity;
  for (const p of q4) {
    const sec = secondsRemaining(p.clock?.displayValue);
    if (sec == null) continue;
    const diff = sec >= 240 ? sec - 240 : 240 - sec + 0.5; // ties prefer the >=240s side
    if (diff < bestDiff) {
      bestDiff = diff;
      best = p;
    }
  }
  if (!best || best.awayScore == null || best.homeScore == null) return null;
  return { away: Number(best.awayScore), home: Number(best.homeScore) };
}

function extractStarters(boxscorePlayers) {
  const out = {};
  for (const teamBlock of boxscorePlayers || []) {
    const abbr = nbaAbbr(teamBlock.team?.abbreviation);
    if (!abbr) continue;
    const stat = teamBlock.statistics?.[0];
    const athletes = stat?.athletes || [];
    const minIdx = (stat?.keys || []).indexOf("minutes");
    out[abbr] = athletes
      .filter((a) => a.starter)
      .map((a) => ({
        name: a.athlete?.displayName,
        position: a.athlete?.position?.abbreviation,
        minutes: Number(a.stats?.[minIdx >= 0 ? minIdx : 0]) || 0,
      }));
  }
  return out;
}

async function upsertBlowoutRow(row) {
  await supabaseFetch(`/nba_blowouts?on_conflict=game_id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ ...row, updated_at: new Date().toISOString() }]),
  });
}

async function trackBlowoutsForDate(yyyymmdd) {
  const result = { date: yyyymmdd, gamesFound: 0, gamesRecorded: 0, skipped: [] };
  let scoreboard;
  try {
    scoreboard = await getJson(`${ESPN_BASE}/basketball/nba/scoreboard?dates=${yyyymmdd}`);
  } catch (err) {
    result.error = err.message;
    return result;
  }
  const events = (scoreboard.events || []).filter((ev) => ev.status?.type?.state === "post");
  result.gamesFound = events.length;
  for (const ev of events) {
    try {
      const comp = ev.competitions?.[0];
      const away = comp?.competitors?.find((c) => c.homeAway === "away");
      const home = comp?.competitors?.find((c) => c.homeAway === "home");
      if (!away || !home) {
        result.skipped.push({ id: ev.id, reason: "missing competitors" });
        continue;
      }
      const awayAbbr = nbaAbbr(away.team?.abbreviation);
      const homeAbbr = nbaAbbr(home.team?.abbreviation);
      const finalAway = Number(away.score);
      const finalHome = Number(home.score);
      const winnerAbbr = finalAway > finalHome ? awayAbbr : homeAbbr;
      const loserAbbr = finalAway > finalHome ? homeAbbr : awayAbbr;
      const finalMargin = Math.abs(finalAway - finalHome);

      const summary = await getJson(`${ESPN_BASE}/basketball/nba/summary?event=${ev.id}`);
      const snap = marginAtFourMinutes(summary.plays);
      if (!snap) {
        result.skipped.push({ id: ev.id, reason: "no Q4 4:00 play found (OT game or missing play-by-play)" });
        continue;
      }
      const marginAt4 = Math.abs(snap.away - snap.home);
      const starters = extractStarters(summary.boxscore?.players);

      await upsertBlowoutRow({
        game_id: ev.id,
        date: `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`,
        away_team: awayAbbr,
        home_team: homeAbbr,
        winner: winnerAbbr,
        loser: loserAbbr,
        margin_at_4min: marginAt4,
        final_margin: finalMargin,
        is_blowout: marginAt4 >= 25,
        starters,
      });
      result.gamesRecorded++;
    } catch (err) {
      result.skipped.push({ id: ev.id, reason: err.message });
    }
  }
  return result;
}

// Pulled nightly by a Supabase pg_cron job (see sports-proxy/sql/nba-blowout-cron.sql).
// ?date=YYYYMMDD does one night (default: yesterday in ET, since games finish after
// midnight UTC); ?from=&to=YYYYMMDD (both YYYYMMDD) backfills every date in the range
// inclusive -- used once to backfill the season to date, safe to re-run since every write
// upserts on game_id.
app.get("/internal/jobs/nba-blowout-tracker", async (req, res) => {
  try {
    const { date, from, to } = req.query;
    const dates = [];
    if (from && to) {
      let d = new Date(Date.UTC(Number(from.slice(0, 4)), Number(from.slice(4, 6)) - 1, Number(from.slice(6, 8))));
      const end = new Date(Date.UTC(Number(to.slice(0, 4)), Number(to.slice(4, 6)) - 1, Number(to.slice(6, 8))));
      while (d <= end) {
        dates.push(d.toISOString().slice(0, 10).replace(/-/g, ""));
        d.setUTCDate(d.getUTCDate() + 1);
      }
    } else if (date) {
      dates.push(date);
    } else {
      const yesterdayET = new Date(Date.now() - 24 * 60 * 60 * 1000);
      dates.push(yesterdayET.toISOString().slice(0, 10).replace(/-/g, ""));
    }
    const results = [];
    for (const d of dates) {
      results.push(await trackBlowoutsForDate(d));
    }
    res.json({
      ok: true,
      nights: results.length,
      gamesRecorded: results.reduce((s, r) => s + r.gamesRecorded, 0),
      results,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Per-team blowout risk, computed from nba_blowouts rows. Shared by the desk-facing read
// below and by the nightly NBA tracker (which merges these fields into nbaTeams directly
// instead of making the builder call this route separately).
async function computeNbaBlowoutRisk() {
  const r = await supabaseFetch(`/nba_blowouts?select=*&order=date.asc&limit=2000`);
  const rows = await r.json();
  const byTeam = {};
  const ensure = (team) =>
    (byTeam[team] ||= {
      team,
      gamesPlayed: 0,
      gamesAsWinner: 0,
      gamesAsLoser: 0,
      blowoutsAsWinner: 0,
      blowoutsAsLoser: 0,
      starterMinutesInBlowouts: [],
      starterMinutesNormal: [],
    });
  for (const row of rows) {
    const winner = ensure(row.winner);
    const loser = ensure(row.loser);
    winner.gamesPlayed++;
    loser.gamesPlayed++;
    winner.gamesAsWinner++;
    loser.gamesAsLoser++;
    if (row.is_blowout) {
      winner.blowoutsAsWinner++;
      loser.blowoutsAsLoser++;
    }
    for (const abbr of [row.away_team, row.home_team]) {
      const starters = row.starters?.[abbr] || [];
      if (!starters.length || !byTeam[abbr]) continue;
      const avgMin = starters.reduce((s, p) => s + (p.minutes || 0), 0) / starters.length;
      (row.is_blowout ? byTeam[abbr].starterMinutesInBlowouts : byTeam[abbr].starterMinutesNormal).push(avgMin);
    }
  }
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const byAbbr = {};
  for (const t of Object.values(byTeam)) {
    const normalAvg = avg(t.starterMinutesNormal);
    const blowoutAvg = avg(t.starterMinutesInBlowouts);
    byAbbr[t.team] = {
      sampleSize: t.gamesPlayed,
      blowoutRateAsWinner: t.gamesAsWinner ? Number((t.blowoutsAsWinner / t.gamesAsWinner).toFixed(3)) : null,
      blowoutRateAsLoser: t.gamesAsLoser ? Number((t.blowoutsAsLoser / t.gamesAsLoser).toFixed(3)) : null,
      blowoutRateOverall: t.gamesPlayed
        ? Number(((t.blowoutsAsWinner + t.blowoutsAsLoser) / t.gamesPlayed).toFixed(3))
        : null,
      avgStarterMinutesDropInBlowouts:
        normalAvg != null && blowoutAvg != null ? Number((normalAvg - blowoutAvg).toFixed(1)) : null,
    };
  }
  return { byAbbr, gamesTracked: rows.length };
}

// Desk-facing read: per-team blowout risk. Used by the Monday/Thursday NBA Tracker
// refresh instead of WebFetch (which has been failing) — plain GET, no Supabase access
// needed by the caller.
app.get("/api/nba/blowout-risk", async (req, res) => {
  try {
    const { byAbbr, gamesTracked } = await computeNbaBlowoutRisk();
    const teams = Object.entries(byAbbr).map(([team, v]) => ({ team, ...v }));
    res.json({ ok: true, updatedAt: new Date().toISOString(), gamesTracked, teams });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- NBA nightly tracker + engine-gated learning loop (2026-10-29, Seb's request) ---
// Replaces the Claude "NBA Tracker refresh" (8:30 AM) and "NBA Team Tracker — daily
// learning" (9:00 AM) triggers' NUMERIC/structural work. Writes record/ptsFor/ptsAgainst
// straight from ESPN standings, plus an APPROXIMATE pace/offRtg/defRtg -- ESPN's public
// site API doesn't expose true NBA advanced ratings, so this uses the standard
// Dean-Oliver-style estimate from each team's own box-score averages (Poss ≈ FGA - OREB +
// TOV + 0.44*FTA; ORtg = avgPoints/Poss*100; DRtg = avgPointsAgainst/Poss*100, using the
// SAME team's own pace as a stand-in for the defensive end's pace). This is a disclosed
// simplification, not a hidden fudge -- flagged to Seb as "approxRatings: true" on every
// team doc so it's visible to anything reading it, not just buried in a code comment.
// offRank/defRank (1-30) and identity are derived from these numbers; blowout-risk fields
// are merged in from computeNbaBlowoutRisk() above. Everything else on the doc (note,
// anything a Claude routine wrote) survives via mergeUpsertDoc's read-merge-write.

const ESPN_V2_BASE = "https://site.api.espn.com/apis/v2/sports";

async function fetchNbaTeamAdvanced(espnId) {
  const data = await getJson(`${ESPN_BASE}/basketball/nba/teams/${espnId}/statistics`);
  const cats = data.results?.stats?.categories || [];
  const stat = (catName, statName) => {
    const cat = cats.find((c) => c.name === catName);
    return cat?.stats?.find((s) => s.name === statName)?.value ?? null;
  };
  return {
    avgFGA: stat("offensive", "avgFieldGoalsAttempted"),
    avg3PA: stat("offensive", "avgThreePointFieldGoalsAttempted"),
    avgOREB: stat("offensive", "avgOffensiveRebounds"),
    avgTOV: stat("offensive", "avgTurnovers"),
    avgFTA: stat("offensive", "avgFreeThrowsAttempted"),
  };
}

async function refreshNbaTeams() {
  const standings = await getJson(`${ESPN_V2_BASE}/basketball/nba/standings`);
  const entries = [];
  for (const child of standings.children || []) entries.push(...(child.standings?.entries || []));
  if (!entries.length) entries.push(...(standings.standings?.entries || []));

  const byTeam = {};
  for (const e of entries) {
    const abbr = nbaAbbr(e.team?.abbreviation);
    if (!abbr) continue;
    const get = (name) => e.stats?.find((s) => s.name === name)?.value ?? null;
    byTeam[abbr] = {
      espnId: e.team?.id,
      wins: get("wins"),
      losses: get("losses"),
      // ESPN's standings stats include BOTH a season-total "pointsFor"/"pointsAgainst"
      // AND a per-game "avgPointsFor"/"avgPointsAgainst" -- the Desk's docs always store
      // the PER-GAME number (e.g. 118.5, not 474), so avg* must win when both are present.
      ptsFor: get("avgPointsFor") ?? get("pointsFor"),
      ptsAgainst: get("avgPointsAgainst") ?? get("pointsAgainst"),
    };
  }

  let total3PARate = 0;
  let count3PARate = 0;
  for (const abbr of Object.keys(byTeam)) {
    try {
      const adv = await fetchNbaTeamAdvanced(byTeam[abbr].espnId);
      const poss = (adv.avgFGA ?? 0) - (adv.avgOREB ?? 0) + (adv.avgTOV ?? 0) + 0.44 * (adv.avgFTA ?? 0);
      byTeam[abbr].pace = poss > 0 ? Number(poss.toFixed(1)) : null;
      byTeam[abbr].offRtg =
        poss > 0 && byTeam[abbr].ptsFor != null ? Number(((byTeam[abbr].ptsFor / poss) * 100).toFixed(1)) : null;
      byTeam[abbr].defRtg =
        poss > 0 && byTeam[abbr].ptsAgainst != null
          ? Number(((byTeam[abbr].ptsAgainst / poss) * 100).toFixed(1))
          : null;
      byTeam[abbr].threePARate = adv.avgFGA ? (adv.avg3PA ?? 0) / adv.avgFGA : null;
      if (byTeam[abbr].threePARate != null) {
        total3PARate += byTeam[abbr].threePARate;
        count3PARate++;
      }
    } catch (err) {
      byTeam[abbr].advError = err.message;
    }
    await sleep(150);
  }
  const league3PARate = count3PARate ? total3PARate / count3PARate : null;

  const abbrs = Object.keys(byTeam);
  const byOffRtg = abbrs.filter((a) => byTeam[a].offRtg != null).sort((a, b) => byTeam[b].offRtg - byTeam[a].offRtg);
  const byDefRtg = abbrs.filter((a) => byTeam[a].defRtg != null).sort((a, b) => byTeam[a].defRtg - byTeam[b].defRtg);
  byOffRtg.forEach((a, i) => (byTeam[a].offRank = i + 1));
  byDefRtg.forEach((a, i) => (byTeam[a].defRank = i + 1));

  const { byAbbr: blowoutRisk } = await computeNbaBlowoutRisk();

  const result = { teamsUpdated: 0, errors: [] };
  for (const abbr of abbrs) {
    const t = byTeam[abbr];
    let identity;
    if (t.threePARate != null && league3PARate != null && t.offRank && t.defRank) {
      if (t.threePARate >= league3PARate + 0.04) identity = "3PT-heavy";
      else if (t.threePARate <= league3PARate - 0.04) identity = "Paint-heavy";
      else if (t.offRank <= 5 && t.defRank <= 5) identity = "Elite";
      else if (t.offRank >= 26 && t.defRank >= 26) identity = "Struggling";
      else identity = "Balanced";
    }
    const patch = {
      record: t.wins != null && t.losses != null ? `${t.wins}-${t.losses}` : undefined,
      ptsFor: t.ptsFor ?? undefined,
      ptsAgainst: t.ptsAgainst ?? undefined,
      pace: t.pace ?? undefined,
      offRtg: t.offRtg ?? undefined,
      defRtg: t.defRtg ?? undefined,
      offRank: t.offRank ?? undefined,
      defRank: t.defRank ?? undefined,
      identity: identity ?? undefined,
      approxRatings: true,
    };
    const risk = blowoutRisk[abbr];
    if (risk) {
      patch.blowoutRateAsWinner = risk.blowoutRateAsWinner;
      patch.blowoutRateAsLoser = risk.blowoutRateAsLoser;
      patch.blowoutRateOverall = risk.blowoutRateOverall;
      patch.avgStarterMinutesDropInBlowouts = risk.avgStarterMinutesDropInBlowouts;
      patch.blowoutSampleSize = risk.sampleSize;
    }
    try {
      await mergeUpsertDoc("main", "nbaTeams", abbr, patch);
      result.teamsUpdated++;
    } catch (err) {
      result.errors.push({ abbr, error: err.message });
    }
  }

  await mergeUpsertDoc("main", "nba", "meta", { lastUpdated: new Date().toISOString().slice(0, 10) });
  return result;
}

// Pulled nightly by a Supabase pg_cron job (see sql/nba-tracker-cron.sql).
app.get("/internal/jobs/nba-nightly-tracker", async (req, res) => {
  try {
    const result = await refreshNbaTeams();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

const NBA_LOOP_FIRE_URL = process.env.NBA_LOOP_FIRE_URL;
const NBA_LOOP_FIRE_TOKEN = process.env.NBA_LOOP_FIRE_TOKEN;
const NBA_LOOP_THRESHOLD = 10;

async function fireNbaLearningLoop() {
  if (!NBA_LOOP_FIRE_URL || !NBA_LOOP_FIRE_TOKEN) {
    throw new Error("NBA_LOOP_FIRE_URL/NBA_LOOP_FIRE_TOKEN not configured on the server.");
  }
  const fireRes = await fetch(NBA_LOOP_FIRE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NBA_LOOP_FIRE_TOKEN}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "experimental-cc-routine-2026-04-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  if (!fireRes.ok) {
    const body = await fireRes.text();
    throw new Error(`NBA loop fire -> HTTP ${fireRes.status}: ${body}`);
  }
}

// Same tail/tag logic as nhlTailTag above, generalized -- a "tail" is a copy of the
// other person's real-world bet, excluded from independent-sample hit-rate math.
function deskTailTag(desk, source) {
  const s = (source || "").toLowerCase();
  if (desk === "steve" && (s === "seb" || s === "seb's bets")) return true;
  if (desk === "main" && (s === "steve" || s === "steve's plays")) return true;
  return false;
}

async function countNewGradedLegsByLeague(league, sinceIso) {
  const counts = { main: { claude: 0, seb: 0, tail: 0 }, steve: { claude: 0, steve: 0, tail: 0 } };
  let total = 0;
  for (const desk of ["main", "steve"]) {
    for (const collection of ["parlays", "pnlEntries"]) {
      const r = await supabaseFetch(
        `/docs?desk_id=eq.${desk}&collection=eq.${collection}&updated_at=gt.${encodeURIComponent(
          sinceIso
        )}&select=doc_id,data,updated_at`
      );
      const rows = await r.json();
      for (const row of rows) {
        const data = row.data || {};
        const source = data.source;
        if (collection === "parlays" && (source || "").toLowerCase() !== "claude") continue;
        const legs = Array.isArray(data.legs) ? data.legs : [];
        for (const leg of legs) {
          const legLeague = leg.league || data.league;
          if (legLeague !== league) continue;
          if (!["won", "lost", "push"].includes(leg.status)) continue;
          let tag;
          if (collection === "parlays") tag = "claude";
          else if (deskTailTag(desk, source)) tag = "tail";
          else tag = desk === "main" ? "seb" : "steve";
          counts[desk][tag] = (counts[desk][tag] || 0) + 1;
          total++;
        }
      }
    }
  }
  return { total, counts };
}

// Pulled hourly by a Supabase pg_cron job (see sql/nba-tracker-cron.sql).
app.get("/internal/jobs/nba-learning-gate", async (req, res) => {
  try {
    const state = await getDoc("main", "taskConfig", "nbaLearningGate");
    const lastFiredAt = state?.data?.lastFiredAt || "1970-01-01T00:00:00Z";
    const { total, counts } = await countNewGradedLegsByLeague("NBA", lastFiredAt);
    if (total < NBA_LOOP_THRESHOLD) {
      return res.json({ ok: true, fired: false, total, threshold: NBA_LOOP_THRESHOLD, counts, lastFiredAt });
    }
    await fireNbaLearningLoop();
    const firedAt = new Date().toISOString();
    await upsertDoc("main", "taskConfig", "nbaLearningGate", { lastFiredAt: firedAt, lastFireTotal: total, lastFireCounts: counts });
    res.json({ ok: true, fired: true, total, threshold: NBA_LOOP_THRESHOLD, counts, firedAt });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Soccer nightly tracker + engine-gated learning loop (2026-10-29, Seb's request) ---
// Writes the numeric/structural fields only (comp/rank/rec/gf/ga/gd/pts domestic block,
// euroComp/euroRank/... European block, identity). Note/ASR/xG/lineup-injury notes and the
// Libertadores/Sudamericana knockout bracket are NOT engine-automatable -- confirmed live
// (plain fetches to sofascore.com return HTTP 403 from this server, and fotmob disallows
// scraping per its own footer), so those stay on the light weekly Claude trigger. Doc ids
// here are freshly assigned by this job (soccerTeams didn't exist in Supabase before this)
// -- NOT required to match whatever ids the old Claude-maintained ArtifactData docs used,
// since builders now read this Supabase mirror as their primary source.

const SOCCER_COMPETITIONS = [
  { slug: "eng.1", label: "Premier League", block: "domestic" },
  { slug: "esp.1", label: "La Liga", block: "domestic" },
  { slug: "ita.1", label: "Serie A", block: "domestic" },
  { slug: "ger.1", label: "Bundesliga", block: "domestic" },
  { slug: "fra.1", label: "Ligue 1", block: "domestic" },
  { slug: "usa.1", label: "MLS", block: "domestic", hasConf: true },
  { slug: "arg.1", label: "Liga Argentina", block: "domestic", hasGroup: true },
  { slug: "col.1", label: "FPC", block: "domestic" },
  { slug: "uefa.champions", label: "Champions League", block: "euro" },
  { slug: "uefa.europa", label: "Europa League", block: "euro" },
];

function soccerTeamDocId(team) {
  const base = team.abbreviation || team.displayName || String(team.id);
  return base.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) || `T${team.id}`;
}

async function fetchSoccerStandings(slug) {
  const data = await getJson(`${ESPN_V2_BASE}/soccer/${slug}/standings`);
  const entries = [];
  for (const e of data.standings?.entries || []) entries.push({ ...e, group: null });
  for (const child of data.children || []) {
    for (const e of child.standings?.entries || []) entries.push({ ...e, group: child.name });
  }
  return entries;
}

async function refreshSoccerTeams() {
  const result = { teamsUpdated: 0, competitions: [], errors: [] };
  const uniqueDocIds = new Set();

  for (const comp of SOCCER_COMPETITIONS) {
    try {
      const entries = await fetchSoccerStandings(comp.slug);
      result.competitions.push({ slug: comp.slug, teams: entries.length });
      for (const e of entries) {
        const docId = soccerTeamDocId(e.team);
        uniqueDocIds.add(docId);
        const get = (name) => e.stats?.find((s) => s.name === name)?.value ?? null;
        const wins = get("wins");
        const ties = get("ties");
        const losses = get("losses");
        const rec = [wins, ties, losses].every((v) => v != null) ? `${wins}-${ties}-${losses}` : undefined;
        const patch = {
          teamName: e.team?.displayName,
        };
        if (comp.block === "domestic") {
          patch.comp = comp.label;
          patch.rank = get("rank") ?? undefined;
          patch.rec = rec;
          patch.gf = get("pointsFor") ?? undefined;
          patch.ga = get("pointsAgainst") ?? undefined;
          patch.gd = get("pointDifferential") ?? undefined;
          patch.pts = get("points") ?? undefined;
          if (comp.hasConf) patch.conf = e.group ?? undefined;
          if (comp.hasGroup) patch.group = e.group ?? undefined;
        } else {
          patch.euroComp = comp.label;
          patch.euroRank = get("rank") ?? undefined;
          patch.euroRec = rec;
          patch.euroGf = get("pointsFor") ?? undefined;
          patch.euroGa = get("pointsAgainst") ?? undefined;
          patch.euroGd = get("pointDifferential") ?? undefined;
          patch.euroPts = get("points") ?? undefined;
        }
        await mergeUpsertDoc("main", "soccerTeams", docId, patch);
        result.teamsUpdated++;
        await sleep(60);
      }
    } catch (err) {
      result.errors.push({ competition: comp.slug, error: err.message });
    }
  }

  // Identity pass: goals-for/against-per-game vs league average, from whichever block
  // (domestic or European) has the larger sample for that team -- same disclosed
  // approximation style as the NBA tracker's offRtg/defRtg above.
  try {
    const docsRes = await supabaseFetch(`/docs?desk_id=eq.main&collection=eq.soccerTeams&select=doc_id,data`);
    const rows = await docsRes.json();
    const parsePlayed = (rec) => (rec || "").split("-").reduce((s, n) => s + (Number(n) || 0), 0);
    const rates = rows
      .map((row) => {
        const d = row.data || {};
        const domesticPlayed = parsePlayed(d.rec);
        const euroPlayed = parsePlayed(d.euroRec);
        const useDomestic = domesticPlayed >= euroPlayed;
        const played = useDomestic ? domesticPlayed : euroPlayed;
        const gf = useDomestic ? d.gf : d.euroGf;
        const ga = useDomestic ? d.ga : d.euroGa;
        return {
          docId: row.doc_id,
          played,
          gfRate: played && gf != null ? gf / played : null,
          gaRate: played && ga != null ? ga / played : null,
        };
      })
      .filter((r) => r.gfRate != null && r.gaRate != null);
    const avgGf = rates.length ? rates.reduce((s, r) => s + r.gfRate, 0) / rates.length : null;
    const avgGa = rates.length ? rates.reduce((s, r) => s + r.gaRate, 0) / rates.length : null;
    for (const r of rates) {
      let identity;
      if (r.played < 3) {
        const diff = r.gfRate - r.gaRate;
        identity = diff >= 0.3 ? "Hot start" : diff <= -0.3 ? "Rough start" : "Even";
      } else if (avgGf != null && avgGa != null) {
        if (r.gfRate >= avgGf + 0.3 && r.gaRate <= avgGa - 0.3) identity = "Elite";
        else if (r.gfRate >= avgGf + 0.3) identity = "High-scoring";
        else if (r.gaRate <= avgGa - 0.3) identity = "Stingy D";
        else if (r.gaRate >= avgGa + 0.3) identity = "Leaky D";
        else if (r.gfRate <= avgGf - 0.3 && r.gaRate >= avgGa) identity = "Struggling";
        else identity = "Balanced";
      }
      if (identity) await mergeUpsertDoc("main", "soccerTeams", r.docId, { identity });
    }
  } catch (err) {
    result.errors.push({ step: "identity", error: err.message });
  }

  await mergeUpsertDoc("main", "soccer", "meta", {
    lastUpdated: new Date().toISOString().slice(0, 10),
    teamCount: uniqueDocIds.size,
  });
  return result;
}

// Pulled nightly by a Supabase pg_cron job (see sql/soccer-tracker-cron.sql).
app.get("/internal/jobs/soccer-nightly-tracker", async (req, res) => {
  try {
    const result = await refreshSoccerTeams();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

const SOCCER_LOOP_FIRE_URL = process.env.SOCCER_LOOP_FIRE_URL;
const SOCCER_LOOP_FIRE_TOKEN = process.env.SOCCER_LOOP_FIRE_TOKEN;
const SOCCER_LOOP_THRESHOLD = 10;

async function fireSoccerLearningLoop() {
  if (!SOCCER_LOOP_FIRE_URL || !SOCCER_LOOP_FIRE_TOKEN) {
    throw new Error("SOCCER_LOOP_FIRE_URL/SOCCER_LOOP_FIRE_TOKEN not configured on the server.");
  }
  const fireRes = await fetch(SOCCER_LOOP_FIRE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SOCCER_LOOP_FIRE_TOKEN}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "experimental-cc-routine-2026-04-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  if (!fireRes.ok) {
    const body = await fireRes.text();
    throw new Error(`Soccer loop fire -> HTTP ${fireRes.status}: ${body}`);
  }
}

// Pulled hourly by a Supabase pg_cron job (see sql/soccer-tracker-cron.sql).
app.get("/internal/jobs/soccer-learning-gate", async (req, res) => {
  try {
    const state = await getDoc("main", "taskConfig", "soccerLearningGate");
    const lastFiredAt = state?.data?.lastFiredAt || "1970-01-01T00:00:00Z";
    const { total, counts } = await countNewGradedLegsByLeague("Soccer", lastFiredAt);
    if (total < SOCCER_LOOP_THRESHOLD) {
      return res.json({ ok: true, fired: false, total, threshold: SOCCER_LOOP_THRESHOLD, counts, lastFiredAt });
    }
    await fireSoccerLearningLoop();
    const firedAt = new Date().toISOString();
    await upsertDoc("main", "taskConfig", "soccerLearningGate", {
      lastFiredAt: firedAt,
      lastFireTotal: total,
      lastFireCounts: counts,
    });
    res.json({ ok: true, fired: true, total, threshold: SOCCER_LOOP_THRESHOLD, counts, firedAt });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- NHL tracker + engine-gated learning loop (2026-10-29, Seb's request) ---
// Two pieces, both pure engine (no Claude usage until the gate actually fires):
// 1. /internal/jobs/nhl-nightly-tracker -- pulled nightly by pg_cron (see
//    sql/nhl-tracker-cron.sql), writes final games' scores, starting goalies, team
//    shots/saves and skater points/SOG into nhl_game_logs/nhl_skater_logs (see
//    sql/nhl-game-logs-table.sql). Same shape/pattern as nba-blowout-tracker above.
// 2. /internal/jobs/nhl-learning-gate -- pulled hourly by the same cron file. Counts
//    newly graded NHL legs (since the last time this gate actually fired) across BOTH
//    main and steve's Supabase-mirrored parlays/pnlEntries, tagged claude/seb/steve/tail
//    the same way the NHL learning loop routine itself tags them (see rule
//    nhl-model-spec and the routine's own prompt, trig_013nPeQ8Sk74619muX8a2f8k). Only
//    once that count reaches 10 does it fire the routine via its own Fire URL/token
//    (NHL_LOOP_FIRE_URL/NHL_LOOP_FIRE_TOKEN, generated once in the routine's own trigger
//    settings on claude.ai) -- same mechanism CLAUDE_FIRE_URL/CLAUDE_FIRE_TOKEN already
//    use for Post-Cutover Sync's fast-path wake, above. No scheduled Claude run ever
//    fires just to check and find nothing -- this endpoint is the only thing that checks.

async function upsertNhlGameRow(row) {
  await supabaseFetch(`/nhl_game_logs?on_conflict=game_id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ ...row, updated_at: new Date().toISOString() }]),
  });
}

async function upsertNhlSkaterRow(row) {
  await supabaseFetch(`/nhl_skater_logs?on_conflict=game_id,player`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ ...row, updated_at: new Date().toISOString() }]),
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// "M:SS" or "MM:SS" -> whole seconds. Returns null for anything unparseable (DNP, missing).
function toiToSeconds(toi) {
  if (!toi || typeof toi !== "string" || !toi.includes(":")) return null;
  const [m, s] = toi.split(":").map(Number);
  if (!Number.isFinite(m) || !Number.isFinite(s)) return null;
  return m * 60 + s;
}

async function trackNhlForDate(yyyymmdd) {
  const result = { date: yyyymmdd, gamesFound: 0, gamesRecorded: 0, skaterRowsRecorded: 0, skipped: [] };
  let scoreboard;
  try {
    scoreboard = await getJson(`${ESPN_BASE}/hockey/nhl/scoreboard?dates=${yyyymmdd}`);
  } catch (err) {
    result.error = err.message;
    return result;
  }
  const events = (scoreboard.events || []).filter((ev) => ev.status?.type?.state === "post");
  result.gamesFound = events.length;
  const isoDate = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

  for (const ev of events) {
    try {
      const comp = ev.competitions?.[0];
      const away = comp?.competitors?.find((c) => c.homeAway === "away");
      const home = comp?.competitors?.find((c) => c.homeAway === "home");
      if (!away || !home) {
        result.skipped.push({ id: ev.id, reason: "missing competitors" });
        continue;
      }
      const awayAbbr = away.team?.abbreviation;
      const homeAbbr = home.team?.abbreviation;

      // Paced (see sleep() below, after each event) so a multi-night backfill doesn't
      // hammer ESPN's public API in a tight loop.
      const summary = await getJson(`${ESPN_BASE}/hockey/nhl/summary?event=${ev.id}`);
      const teamBlocks = summary.boxscore?.players || [];

      // Team-level stats (PP goals/opportunities) live in boxscore.teams, a SEPARATE array
      // from boxscore.players used below for per-athlete stats -- added 2026-10-29, this
      // array was never read before.
      let awayPpGoals = null, awayPpOpp = null, homePpGoals = null, homePpOpp = null;
      for (const tb of summary.boxscore?.teams || []) {
        const abbr = tb.team?.abbreviation;
        const side = abbr === awayAbbr ? "away" : abbr === homeAbbr ? "home" : null;
        if (!side) continue;
        const stats = tb.statistics || [];
        const find = (name) => stats.find((s) => s.name === name);
        const ppg = Number(find("powerPlayGoals")?.displayValue);
        const ppo = Number(find("powerPlayOpportunities")?.displayValue);
        if (side === "away") {
          awayPpGoals = Number.isFinite(ppg) ? ppg : null;
          awayPpOpp = Number.isFinite(ppo) ? ppo : null;
        } else {
          homePpGoals = Number.isFinite(ppg) ? ppg : null;
          homePpOpp = Number.isFinite(ppo) ? ppo : null;
        }
      }

      let awayGoalie = null;
      let homeGoalie = null;
      const skaterRows = [];

      for (const block of teamBlocks) {
        const abbr = block.team?.abbreviation;
        const side = abbr === awayAbbr ? "away" : abbr === homeAbbr ? "home" : null;
        if (!side) continue;
        for (const cat of block.statistics || []) {
          const isGoalieCat = cat.name === "goalies";
          const iG = (cat.labels || []).indexOf("G");
          const iA = (cat.labels || []).indexOf("A");
          const iS = (cat.labels || []).indexOf("S");
          const iTOI = (cat.labels || []).indexOf("TOI");
          const iPPTOI = (cat.labels || []).indexOf("PPTOI");
          const iSHTOI = (cat.labels || []).indexOf("SHTOI");
          const iESTOI = (cat.labels || []).indexOf("ESTOI");
          // SA (shots against) / SV (saves) label names are the best guess for the goalie
          // category -- unlike NHL_LABEL above (confirmed against a real game already),
          // these haven't been verified against a live goalie box score yet. If they come
          // back null on the first real run, check the actual label strings in a raw
          // summary response for a finished NHL game and fix these two lines.
          const iSA = (cat.labels || []).indexOf("SA");
          const iSV = (cat.labels || []).indexOf("SV");
          for (const ath of cat.athletes || []) {
            if (isGoalieCat) {
              const info = {
                name: ath.athlete?.displayName,
                starter: !!ath.starter,
                shotsAgainst: iSA >= 0 ? Number(ath.stats?.[iSA]) || null : null,
                saves: iSV >= 0 ? Number(ath.stats?.[iSV]) || null : null,
              };
              // A team can dress a backup who never enters; prefer whichever goalie
              // actually logged shots-against/saves (the one who played) over one with no
              // stats yet.
              const better = (cur) => !cur || (info.saves != null && cur.saves == null);
              if (side === "away" && better(awayGoalie)) awayGoalie = info;
              if (side === "home" && better(homeGoalie)) homeGoalie = info;
            } else {
              const name = ath.athlete?.displayName;
              if (!name) continue;
              const goals = iG >= 0 ? Number(ath.stats?.[iG]) || 0 : 0;
              const assists = iA >= 0 ? Number(ath.stats?.[iA]) || 0 : 0;
              const sog = iS >= 0 ? Number(ath.stats?.[iS]) || 0 : 0;
              skaterRows.push({
                game_id: ev.id,
                date: isoDate,
                team: abbr,
                player: name,
                goals,
                assists,
                points: goals + assists,
                shots_on_goal: sog,
                toi_seconds: iTOI >= 0 ? toiToSeconds(ath.stats?.[iTOI]) : null,
                pp_toi_seconds: iPPTOI >= 0 ? toiToSeconds(ath.stats?.[iPPTOI]) : null,
                sh_toi_seconds: iSHTOI >= 0 ? toiToSeconds(ath.stats?.[iSHTOI]) : null,
                es_toi_seconds: iESTOI >= 0 ? toiToSeconds(ath.stats?.[iESTOI]) : null,
              });
            }
          }
        }
      }

      // Team shots-for == the OPPOSING goalie's shots-against (same identity NHL_LABEL's
      // comment above already confirmed against a real game for skaters' "S").
      const awayShots = homeGoalie?.shotsAgainst ?? null;
      const homeShots = awayGoalie?.shotsAgainst ?? null;

      await upsertNhlGameRow({
        game_id: ev.id,
        date: isoDate,
        away_team: awayAbbr,
        home_team: homeAbbr,
        away_score: Number(away.score),
        home_score: Number(home.score),
        away_goalie: awayGoalie?.name ?? null,
        home_goalie: homeGoalie?.name ?? null,
        away_goalie_confirmed_starter: !!awayGoalie?.starter,
        home_goalie_confirmed_starter: !!homeGoalie?.starter,
        away_shots: awayShots,
        home_shots: homeShots,
        away_saves: awayGoalie?.saves ?? null,
        home_saves: homeGoalie?.saves ?? null,
        away_pp_goals: awayPpGoals,
        away_pp_opportunities: awayPpOpp,
        home_pp_goals: homePpGoals,
        home_pp_opportunities: homePpOpp,
        raw: { awayGoalie, homeGoalie },
      });
      result.gamesRecorded++;

      for (const row of skaterRows) {
        await upsertNhlSkaterRow(row);
        result.skaterRowsRecorded++;
      }
    } catch (err) {
      result.skipped.push({ id: ev.id, reason: err.message });
    }
    await sleep(200); // pace ESPN calls, esp. during a multi-night backfill
  }
  return result;
}

// Pulled nightly by a Supabase pg_cron job (see sql/nhl-tracker-cron.sql). Same
// date/from/to convention as /internal/jobs/nba-blowout-tracker above.
// Standings (record/points/goals for/against/diff) from ESPN, plus PP%/PK%/shots
// for-against aggregated from nhl_game_logs (already-collected per-game data, more
// accurate than ESPN's team-stats endpoint since that one exposes PP GOALS but not PP
// OPPORTUNITIES, so a true PP% can't be computed from it alone). Added 2026-10-29 so
// builders reading nhlTeams from Supabase (per the sports-proxy switch) get fresh data --
// this was previously maintained by a Claude routine that no longer exists as an active
// trigger. Merges in, never overwrites identity/note (untouched, same read-merge-write
// pattern as the NBA/soccer trackers above).
async function refreshNhlTeams() {
  const standings = await getJson(`${ESPN_V2_BASE}/hockey/nhl/standings`);
  const entries = [];
  for (const child of standings.children || []) entries.push(...(child.standings?.entries || []));
  if (!entries.length) entries.push(...(standings.standings?.entries || []));

  const byTeam = {};
  for (const e of entries) {
    const abbr = e.team?.abbreviation;
    if (!abbr) continue;
    const get = (name) => e.stats?.find((s) => s.name === name)?.value ?? null;
    byTeam[abbr] = {
      wins: get("wins"),
      losses: get("losses"),
      otLosses: get("otLosses") ?? get("overtimeLosses"),
      points: get("points"),
      goalsFor: get("pointsFor"),
      goalsAgainst: get("pointsAgainst"),
      goalDiff: get("pointDifferential"),
    };
  }

  const gamesRes = await supabaseFetch(
    `/nhl_game_logs?select=away_team,home_team,away_shots,home_shots,away_pp_goals,away_pp_opportunities,home_pp_goals,home_pp_opportunities&limit=2000`
  );
  const games = await gamesRes.json();
  const agg = {};
  const ensure = (abbr) =>
    (agg[abbr] ||= { shotsFor: 0, shotsAgainst: 0, ppGoals: 0, ppOpp: 0, pkGoalsAllowed: 0, pkOpp: 0, games: 0 });
  for (const g of games) {
    if (g.away_team) {
      const a = ensure(g.away_team);
      a.games++;
      if (g.away_shots != null) a.shotsFor += g.away_shots;
      if (g.home_shots != null) a.shotsAgainst += g.home_shots;
      if (g.away_pp_goals != null) a.ppGoals += g.away_pp_goals;
      if (g.away_pp_opportunities != null) a.ppOpp += g.away_pp_opportunities;
      if (g.home_pp_goals != null) a.pkGoalsAllowed += g.home_pp_goals;
      if (g.home_pp_opportunities != null) a.pkOpp += g.home_pp_opportunities;
    }
    if (g.home_team) {
      const h = ensure(g.home_team);
      h.games++;
      if (g.home_shots != null) h.shotsFor += g.home_shots;
      if (g.away_shots != null) h.shotsAgainst += g.away_shots;
      if (g.home_pp_goals != null) h.ppGoals += g.home_pp_goals;
      if (g.home_pp_opportunities != null) h.ppOpp += g.home_pp_opportunities;
      if (g.away_pp_goals != null) h.pkGoalsAllowed += g.away_pp_goals;
      if (g.away_pp_opportunities != null) h.pkOpp += g.away_pp_opportunities;
    }
  }

  const result = { teamsUpdated: 0, errors: [] };
  for (const abbr of Object.keys(byTeam)) {
    const t = byTeam[abbr];
    const a = agg[abbr];
    const patch = {
      record: t.wins != null && t.losses != null ? `${t.wins}-${t.losses}-${t.otLosses ?? 0}` : undefined,
      points: t.points ?? undefined,
      goalsFor: t.goalsFor ?? undefined,
      goalsAgainst: t.goalsAgainst ?? undefined,
      goalDiff: t.goalDiff ?? undefined,
    };
    if (a) {
      patch.shotsForPerGame = a.games ? Number((a.shotsFor / a.games).toFixed(1)) : undefined;
      patch.shotsAgainstPerGame = a.games ? Number((a.shotsAgainst / a.games).toFixed(1)) : undefined;
      patch.ppPct = a.ppOpp ? Number(((a.ppGoals / a.ppOpp) * 100).toFixed(1)) : undefined;
      patch.pkPct = a.pkOpp ? Number((100 - (a.pkGoalsAllowed / a.pkOpp) * 100).toFixed(1)) : undefined;
      patch.specialTeamsSampleGames = a.games;
    }
    try {
      await mergeUpsertDoc("main", "nhlTeams", abbr, patch);
      result.teamsUpdated++;
    } catch (err) {
      result.errors.push({ abbr, error: err.message });
    }
  }

  await mergeUpsertDoc("main", "nhl", "meta", { lastUpdated: new Date().toISOString().slice(0, 10) });
  return result;
}

app.get("/internal/jobs/nhl-nightly-tracker", async (req, res) => {
  try {
    const { date, from, to } = req.query;
    const dates = [];
    if (from && to) {
      let d = new Date(Date.UTC(Number(from.slice(0, 4)), Number(from.slice(4, 6)) - 1, Number(from.slice(6, 8))));
      const end = new Date(Date.UTC(Number(to.slice(0, 4)), Number(to.slice(4, 6)) - 1, Number(to.slice(6, 8))));
      while (d <= end) {
        dates.push(d.toISOString().slice(0, 10).replace(/-/g, ""));
        d.setUTCDate(d.getUTCDate() + 1);
      }
    } else if (date) {
      dates.push(date);
    } else {
      const yesterdayET = new Date(Date.now() - 24 * 60 * 60 * 1000);
      dates.push(yesterdayET.toISOString().slice(0, 10).replace(/-/g, ""));
    }
    const results = [];
    for (const d of dates) {
      results.push(await trackNhlForDate(d));
      await sleep(300); // pace between nights on a multi-night backfill
    }
    const teamsResult = await refreshNhlTeams();
    res.json({
      ok: true,
      nights: results.length,
      gamesRecorded: results.reduce((s, r) => s + r.gamesRecorded, 0),
      skaterRowsRecorded: results.reduce((s, r) => s + (r.skaterRowsRecorded || 0), 0),
      results,
      nhlTeams: teamsResult,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Read-only aggregation over nhl_game_logs -- no new ESPN pulls, pure math over rows the
// tracker above already wrote. Used by pick builders at request time (never scheduled).
// GET /api/nhl/team-form?team=BOS&n=10&asOf=2026-10-28 (n defaults to 10; asOf defaults to
// today, both ends inclusive of games on or before asOf).
app.get("/api/nhl/team-form", async (req, res) => {
  try {
    const team = (req.query.team || "").toUpperCase();
    if (!team) return res.status(400).json({ error: "team is required (e.g. ?team=BOS)" });
    const n = Math.max(1, Math.min(50, Number(req.query.n) || 10));
    const asOf = req.query.asOf || new Date().toISOString().slice(0, 10);

    const r = await supabaseFetch(
      `/nhl_game_logs?or=(away_team.eq.${team},home_team.eq.${team})&date=lte.${asOf}&order=date.desc&limit=50&select=game_id,date,away_team,home_team,away_score,home_score`
    );
    const rows = await r.json();

    const withResult = rows.map((row) => {
      const isHome = row.home_team === team;
      const gf = isHome ? row.home_score : row.away_score;
      const ga = isHome ? row.away_score : row.home_score;
      return { ...row, isHome, gf, ga, win: gf != null && ga != null ? gf > ga : null };
    });

    function summarize(list) {
      const played = list.filter((g) => g.win !== null);
      const wins = played.filter((g) => g.win).length;
      const gf = played.reduce((s, g) => s + (g.gf || 0), 0);
      const ga = played.reduce((s, g) => s + (g.ga || 0), 0);
      return {
        gamesPlayed: played.length,
        record: `${wins}-${played.length - wins}`,
        goalsFor: gf,
        goalsAgainst: ga,
        avgGoalsFor: played.length ? Number((gf / played.length).toFixed(2)) : null,
        avgGoalsAgainst: played.length ? Number((ga / played.length).toFixed(2)) : null,
      };
    }

    const last5 = summarize(withResult.slice(0, 5));
    const lastN = summarize(withResult.slice(0, n));
    const homeGames = summarize(withResult.filter((g) => g.isHome));
    const awayGames = summarize(withResult.filter((g) => !g.isHome));

    let backToBack = false;
    if (withResult.length) {
      const mostRecent = new Date(withResult[0].date);
      const asOfDate = new Date(asOf);
      const diffDays = Math.round((asOfDate - mostRecent) / 86400000);
      backToBack = diffDays === 1;
    }

    res.json({
      team,
      asOf,
      last5,
      [`last${n}`]: lastN,
      homeSplit: homeGames,
      awaySplit: awayGames,
      backToBack,
      mostRecentGame: withResult[0] || null,
      gamesConsidered: withResult.length,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- NHL learning-loop gate ---
const NHL_LOOP_FIRE_URL = process.env.NHL_LOOP_FIRE_URL;
const NHL_LOOP_FIRE_TOKEN = process.env.NHL_LOOP_FIRE_TOKEN;
const NHL_LOOP_THRESHOLD = 10;

async function fireNhlLearningLoop() {
  if (!NHL_LOOP_FIRE_URL || !NHL_LOOP_FIRE_TOKEN) {
    throw new Error("NHL_LOOP_FIRE_URL/NHL_LOOP_FIRE_TOKEN not configured on the server.");
  }
  const fireRes = await fetch(NHL_LOOP_FIRE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NHL_LOOP_FIRE_TOKEN}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "experimental-cc-routine-2026-04-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  if (!fireRes.ok) {
    const body = await fireRes.text();
    throw new Error(`NHL loop fire -> HTTP ${fireRes.status}: ${body}`);
  }
}

// A "tail" is the SAME real-world leg already counted once under its original tag (a
// copy of the other person's bet) -- identified here only to be labeled and excluded
// from the learning loop's hit-rate math, never to be double-counted as new data.
function nhlTailTag(desk, source) {
  const s = (source || "").toLowerCase();
  if (desk === "steve" && (s === "seb" || s === "seb's bets")) return true;
  if (desk === "main" && (s === "steve" || s === "steve's plays")) return true;
  return false;
}

async function countNewGradedNhlLegs(sinceIso) {
  const counts = { main: { claude: 0, seb: 0, tail: 0 }, steve: { claude: 0, steve: 0, tail: 0 } };
  let total = 0;
  for (const desk of ["main", "steve"]) {
    for (const collection of ["parlays", "pnlEntries"]) {
      const r = await supabaseFetch(
        `/docs?desk_id=eq.${desk}&collection=eq.${collection}&updated_at=gt.${encodeURIComponent(sinceIso)}&select=doc_id,data,updated_at`
      );
      const rows = await r.json();
      for (const row of rows) {
        const data = row.data || {};
        const source = data.source;
        // A Claude-built "parlays" doc is counted here; an uploaded-slip "parlays" mirror
        // (source "upload") is skipped since the SAME bet is also a pnlEntries doc, which
        // gets tagged seb/steve/tail below -- counting both would double the same leg.
        if (collection === "parlays" && (source || "").toLowerCase() !== "claude") continue;
        const legs = Array.isArray(data.legs) ? data.legs : [];
        for (const leg of legs) {
          const league = leg.league || data.league;
          if (league !== "NHL") continue;
          if (!["won", "lost", "push"].includes(leg.status)) continue;
          let tag;
          if (collection === "parlays") tag = "claude";
          else if (nhlTailTag(desk, source)) tag = "tail";
          else tag = desk === "main" ? "seb" : "steve";
          counts[desk][tag] = (counts[desk][tag] || 0) + 1;
          total++;
        }
      }
    }
  }
  return { total, counts };
}

// Pulled hourly by a Supabase pg_cron job (see sql/nhl-tracker-cron.sql). Pure read +
// count against the existing docs mirror -- no ESPN calls, cheap enough to run hourly so
// a threshold crossing gets caught same-day instead of waiting for the next nightly tick.
app.get("/internal/jobs/nhl-learning-gate", async (req, res) => {
  try {
    const state = await getDoc("main", "taskConfig", "nhlLearningGate");
    const lastFiredAt = state?.data?.lastFiredAt || "1970-01-01T00:00:00Z";
    const { total, counts } = await countNewGradedNhlLegs(lastFiredAt);
    if (total < NHL_LOOP_THRESHOLD) {
      return res.json({ ok: true, fired: false, total, threshold: NHL_LOOP_THRESHOLD, counts, lastFiredAt });
    }
    await fireNhlLearningLoop();
    const firedAt = new Date().toISOString();
    await upsertDoc("main", "taskConfig", "nhlLearningGate", {
      lastFiredAt: firedAt,
      lastFireTotal: total,
      lastFireCounts: counts,
    });
    res.json({ ok: true, fired: true, total, threshold: NHL_LOOP_THRESHOLD, counts, firedAt });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`sports-proxy listening on ${PORT}`));
