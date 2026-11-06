#!/usr/bin/env node
// Public HTTP proxy for ESPN + DraftKings odds data.
// The real ODDS_API_KEY lives only here (server-side env var) — callers never see it.
// Callers authenticate with PROXY_TOKEN instead: a separate, low-stakes token that
// only protects this proxy's own rate limit, not the real odds-api quota.

import express from "express";
import { parseLeg } from "./grader.js";
import { norm, teamMatches, findGame } from "./matcher.js";
import { runTicketGate } from "./ticket-gate.js";
import { trackNbaPlayerLogsForDate } from "./jobs/nba-player-logs.js";

const app = express();
const PORT = process.env.PORT || 3000;
// Temporary token-rotation override (cutover step 5): PROXY_TOKEN on Render keeps
// resolving to a stale value across repeated env-var saves/redeploys, so while
// PROXY_TOKEN_NEXT is set it is the ONLY accepted token -- PROXY_TOKEN is ignored
// entirely, not merely dual-accepted. Remove PROXY_TOKEN_NEXT and this override once
// Render is confirmed on the new value, restoring PROXY_TOKEN as the single source.
const PROXY_TOKEN_NEXT = process.env.PROXY_TOKEN_NEXT;
const PROXY_TOKEN = PROXY_TOKEN_NEXT || process.env.PROXY_TOKEN;
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";
const ODDS_BASE = "https://api.the-odds-api.com/v4";
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";

async function getApiFootballJson(path) {
  const res = await fetch(`${API_FOOTBALL_BASE}${path}`, {
    headers: { "x-apisports-key": API_FOOTBALL_KEY, "User-Agent": "sports-proxy/0.1" },
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

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
  { key: "CBB", sport: "basketball", league: "mens-college-basketball" },
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
    const sports = { NFL: [], CFB: [], NBA: [], CBB: [], NHL: [], other: [], Soccer: [] };
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

// GROUP POST GUARD (2026-11-02, Seb's permanent rule): no dollar amounts in ANY group post
// (Telegram group today, Discord later), from ANY sender -- the engine itself, Post-Cutover
// Sync, both builders, the stuck-bet resolver, cleanup/summary messages, anything. This is
// the actual enforcement point, not just a prompt instruction, because sendTelegram is the
// single choke point every one of those senders already goes through to reach the group
// chat id (telegram-alert, telegram-send-raw, grade-and-alert's own alerts all call this).
// A caught message is NEVER sent to the group -- it's redirected to Seb's private DM instead
// (prefixed so it's obvious it was blocked) and logged, so nothing with a $ amount in it can
// reach the group even if a routine's prompt forgets the rule.
const GROUP_DOLLAR_AMOUNT_RE = /\$\s?\d[\d,]*(\.\d+)?/;

async function sendTelegramRaw(chatId, text, disableNotification) {
  if (!TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN not configured on the server.");
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_notification: disableNotification }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram sendMessage failed: ${JSON.stringify(data)}`);
  return data.result;
}

async function sendTelegram(chatId, text) {
  if (chatId === TELEGRAM_GROUP_CHAT_ID && GROUP_DOLLAR_AMOUNT_RE.test(text)) {
    await upsertDoc("main", "groupPostBlocked", `block-${Date.now()}`, {
      blockedAt: new Date().toISOString(),
      reason: "contained a $ amount",
      text,
    }).catch((err) => console.error("groupPostBlocked log failed:", err.message));
    const dmText = `⛔ Blocked from the group (contained a $ amount) -- sent here instead:\n\n${text}`;
    const result = TELEGRAM_SEB_CHAT_ID
      ? await sendTelegramRaw(TELEGRAM_SEB_CHAT_ID, dmText, false).catch((err) => {
          console.error("groupPostBlocked DM redirect failed:", err.message);
          return null;
        })
      : null;
    return { ...(result || {}), blocked: true, blockedReason: "contained a $ amount" };
  }
  const silent = chatId === TELEGRAM_GROUP_CHAT_ID && isGroupQuietHours();
  return sendTelegramRaw(chatId, text, silent);
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

// Shared by the HTTP route below and by the self-heal job (which needs to trigger a wake
// internally without an extra network hop back into its own server).
async function triggerSyncWake() {
  if (!CLAUDE_FIRE_URL || !CLAUDE_FIRE_TOKEN) {
    throw new Error("CLAUDE_FIRE_URL/CLAUDE_FIRE_TOKEN not configured on the server.");
  }
  const sinceLast = Date.now() - lastSyncWakeAt;
  if (sinceLast >= SYNC_WAKE_COOLDOWN_MS) {
    await sendSyncWake();
    return { ok: true, fired: true };
  }
  if (trailingSyncWakeTimer) {
    return { ok: true, fired: false, reason: "cooldown", trailingAlreadyScheduled: true };
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
  return { ok: true, fired: false, reason: "cooldown", trailingScheduledInMs: delay };
}

// --- Full (non-fast-path) sync wake (2026-11-04, sync-needed gating) ---
// Fires the SAME Post-Cutover Sync trigger as triggerSyncWake() above, but WITHOUT the
// FAST_PATH_WAKE marker text -- Post-Cutover Sync's own prompt already branches on that
// marker's absence to mean "this is a full run" (same as its plain hourly/daily cron
// fire), so this needs no prompt change there. Used only by sync-needed's stuck-claim
// check, which specifically needs the hourly-only stuck-claim-recovery step that a
// fast-path wake would skip. Own cooldown (separate from the fast-path one above, which
// app actions and sync-needed's backlog check both still use) so a persistently-stuck
// claim can't loop-fire a full run more than once an hour.
const FULL_SYNC_WAKE_COOLDOWN_MS = 60 * 60 * 1000;
let lastFullSyncWakeAt = 0;

async function sendFullSyncWake() {
  lastFullSyncWakeAt = Date.now();
  const fireRes = await fetch(CLAUDE_FIRE_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${CLAUDE_FIRE_TOKEN}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "experimental-cc-routine-2026-04-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  if (!fireRes.ok) {
    const body = await fireRes.text();
    throw new Error(`Full sync wake fire -> HTTP ${fireRes.status}: ${body}`);
  }
}

async function triggerFullSyncWake() {
  if (!CLAUDE_FIRE_URL || !CLAUDE_FIRE_TOKEN) {
    throw new Error("CLAUDE_FIRE_URL/CLAUDE_FIRE_TOKEN not configured on the server.");
  }
  const sinceLast = Date.now() - lastFullSyncWakeAt;
  if (sinceLast < FULL_SYNC_WAKE_COOLDOWN_MS) {
    return { ok: true, fired: false, reason: "cooldown" };
  }
  await sendFullSyncWake();
  return { ok: true, fired: true };
}

// (2026-11-05, Seb's request, after a request sat stuck for ~10min despite the instant-wake
// trigger firing correctly) -- the DB trigger below now also passes desk/collection/docId in
// its body. When collection is "requests", this handler fires that desk's own builder directly
// via the SAME relay/cooldown sync-needed already uses (triggerBuilderFire), in ADDITION to the
// existing PCS fast-path wake -- so the builder itself (which now also checks the Supabase
// mirror for app-sourced queued/sent requests PCS hasn't copied up yet, see its own prompt) gets
// a chance to pick the row up immediately, without waiting on PCS's own copy-up step at all.
// Unknown/missing desk, or collection other than "requests", is a no-op for this part -- the
// PCS fast-path wake below still always fires regardless. The 10-min sync-needed cron + its
// retry cap stays as the backstop for whichever of these two instant paths misses.
app.post("/internal/jobs/wake-sync", async (req, res) => {
  try {
    const result = await triggerSyncWake();
    const { desk, collection, docId } = req.body || {};
    if (collection === "requests" && BUILDER_FIRE[desk]) {
      result.builderFire = await triggerBuilderFire(
        desk,
        `APP_INSERT_WAKE: new request ${docId || ""} -- check Supabase for it and build it now if Post-Cutover Sync hasn't copied it up yet.`
      ).catch((err) => ({ ok: false, error: err.message }));
    }
    res.json(result);
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

// Shared by the HTTP route below and by the self-heal job.
async function triggerBuilderFire(desk, text) {
  if (!BUILDER_FIRE[desk]) throw new Error("desk must be main or steve");
  const cfg = BUILDER_FIRE[desk];
  if (!cfg.url || !cfg.token) {
    throw new Error(`${desk === "main" ? "MAIN" : "FRIENDS"}_BUILDER_FIRE_URL/TOKEN not configured on the server.`);
  }
  const state = builderFireState[desk];
  const sinceLast = Date.now() - state.lastFireAt;
  if (sinceLast >= BUILDER_FIRE_COOLDOWN_MS) {
    await sendBuilderFire(desk, text);
    return { ok: true, fired: true, desk };
  }
  if (state.trailingTimer) {
    return { ok: true, fired: false, desk, reason: "cooldown", trailingAlreadyScheduled: true };
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
  return { ok: true, fired: false, desk, reason: "cooldown", trailingScheduledInMs: delay };
}

app.post("/internal/jobs/fire-builder", async (req, res) => {
  try {
    const desk = req.query.desk;
    const text = req.query.text || req.body?.text;
    res.json(await triggerBuilderFire(desk, text));
  } catch (err) {
    let status = 502;
    if (err.message === "desk must be main or steve") status = 400;
    else if (err.message.endsWith("not configured on the server.")) status = 500;
    res.status(status).json({ error: err.message });
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
  balanceApproval: "💰 {desk} balance change needs your OK\n{summary}",
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
      return res.status(400).json({ error: `Unknown kind "${kind}" -- expected newRequest/backupRun/failure/usageReport/test/balanceApproval.` });
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
    // Balance-change approval gate (2026-11-05, Seb's request): requestId here is the
    // appEdits doc_id proposing the change -- Approve/Reject writes to "balanceApprovals",
    // checked by Post-Cutover Sync's own prompt before it ever writes an adj- entry.
    if (kind === "balanceApproval") {
      if (!desk || !requestId) return res.status(400).json({ error: 'desk and requestId are required for kind "balanceApproval".' });
      reply_markup = {
        inline_keyboard: [[
          { text: "✅ Approve", callback_data: `balok:${desk}:${requestId}` },
          { text: "❌ Reject", callback_data: `balno:${desk}:${requestId}` },
        ]],
      };
    }
    if (!dryRun) await telegramApi("sendMessage", { chat_id: TELEGRAM_SEB_CHAT_ID, text: body, parse_mode: "HTML", reply_markup });
    res.json({ sent: !dryRun, dryRun, text: body });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- ONE-OFF: Steve's weekly report Telegram send (2026-11-02, Seb's request) ---
// Single-purpose, hardcoded target (not a generic "send any file anywhere" endpoint on
// purpose -- this is meant to fire exactly once, from a one-time pg_cron job, then be
// deleted). Pulls the PDF from the private 'slips' Storage bucket (reusing the same
// service-key read pattern as /api/:desk/slip-image) and posts it to Steve's PRIVATE
// Telegram chat only via Telegram's sendDocument (multipart). Refuses outright if the
// hardcoded chat id were ever changed to the group chat id -- belt-and-suspenders with
// the no-dollar-amounts-in-group rule, even though this is a fixed constant here.
// DELETE THIS ENDPOINT (and the one-time cron job that calls it) once Seb confirms the
// message_id came back -- it has no reason to exist after that single send.
const STEVE_REPORT_BUCKET = "slips";
const STEVE_REPORT_PATH = "reports/steve-weekly-2026-10-25-to-11-02.pdf";
const STEVE_REPORT_CHAT_ID = "1294297670";
const STEVE_REPORT_CAPTION = "Your weekly Parlay Desk report \u{1F4CA}";

app.get("/internal/jobs/send-steve-weekly-report-20261102", async (req, res) => {
  try {
    if (String(STEVE_REPORT_CHAT_ID) === String(TELEGRAM_GROUP_CHAT_ID)) {
      return res.status(400).json({ error: "refusing: target chat id matches the group chat id" });
    }
    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
      return res.status(500).json({ error: "SUPABASE_URL / SUPABASE_SECRET_KEY not configured on the server." });
    }
    if (!TELEGRAM_BOT_TOKEN) {
      return res.status(500).json({ error: "TELEGRAM_BOT_TOKEN not configured on the server." });
    }

    const fileRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${STEVE_REPORT_BUCKET}/${STEVE_REPORT_PATH}`, {
      headers: { apikey: SUPABASE_SECRET_KEY, Authorization: `Bearer ${SUPABASE_SECRET_KEY}` },
    });
    if (!fileRes.ok) {
      return res.status(502).json({ error: `storage fetch failed: HTTP ${fileRes.status} ${await fileRes.text()}` });
    }
    const buf = Buffer.from(await fileRes.arrayBuffer());

    const form = new FormData();
    form.append("chat_id", STEVE_REPORT_CHAT_ID);
    form.append("caption", STEVE_REPORT_CAPTION);
    form.append("document", new Blob([buf], { type: "application/pdf" }), "Report-Steve-2026-10-25-to-11-02.pdf");

    const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, {
      method: "POST",
      body: form,
    });
    const data = await tgRes.json();
    if (!data.ok) {
      return res.status(502).json({ error: `Telegram sendDocument failed: ${JSON.stringify(data)}` });
    }
    res.json({ sent: true, message_id: data.result.message_id, chat_id: STEVE_REPORT_CHAT_ID });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Self-heal watchdog (2026-11-01, Seb's request) ---
// sports-proxy only ever holds Supabase + ESPN credentials -- it has no access to the real
// desk (that's the claude.ai Artifact's own ArtifactData store, only reachable by a Claude
// routine like Post-Cutover Sync). So "compare desk vs Supabase" here is implemented as an
// internal-consistency check against the Supabase mirror: it reuses gradeCollectionForDesk's
// shadow mode (the exact same ESPN-backed re-grade /internal/jobs/grade-and-alert already
// trusts) to find any pnlEntries doc whose status/ret/stake is NOT what it should be given
// real game results -- that's either a stuck-open bet whose game already went final, or a
// settle that never got its ret backfilled. That is precisely the signature of Post-Cutover
// Sync being stuck/broken (the thing this job exists to catch and wake back up), without
// needing a second read of the real desk.
const SELF_HEAL_BALANCE_EPSILON = 0.01;
const SELF_HEAL_WAKE_COOLDOWN_MS = 60 * 60 * 1000; // at most one wake per hour, per Seb's ask

// Winnings for a bonus-bet WIN (2026-11-05 correction -- "ret-stake" can undercount a
// bonus win: a DraftKings bonus-bet slip's displayed payout usually excludes the stake
// already, since there was no real stake to return. Compute winnings directly from odds
// when they're known -- stake * (decimal odds - 1), boost applied to the profit portion
// only, same shape as toWinAmount's profit term -- and ignore the recorded ret/potential
// entirely in that case. Only when `odds` is missing/unusable fall back to the recorded
// payout, and only subtract stake from THAT when the payout is actually bigger than the
// stake (a real stake+profit number); a payout no bigger than the stake must already be
// winnings-only.
function bonusWinAmount(d) {
  const stake = Number(d.stake) || 0;
  const odds = Number(d.odds);
  if (Number.isFinite(odds) && odds !== 0) {
    let profit = odds > 0 ? stake * (odds / 100) : stake * (100 / Math.abs(odds));
    const b = Number(d.boost) || 0;
    if (b) profit *= 1 + b / 100;
    return Math.round(profit * 100) / 100;
  }
  const payout = Number(d.ret) || 0;
  return payout > stake ? Math.round((payout - stake) * 100) / 100 : payout;
}

function pnlDelta(d) {
  if (d.protected === true) {
    // A locked Early Exit still has a real, final ret -- same math as a normal win, just
    // never recomputed from odds (see settlePnlRet). It must still count toward balance.
    if (d.status === "won") return (Number(d.ret) || 0) - (Number(d.stake) || 0);
    return 0;
  }
  if (d.status === "won") {
    // Bonus bet (bonus:true, 2026-11-05): use bonusWinAmount instead of the normal
    // ret-minus-stake math -- see that function's own comment for why.
    if (d.bonus === true) return bonusWinAmount(d);
    return (Number(d.ret) || 0) - (Number(d.stake) || 0);
  }
  // "cashout" is also a real, final payout (what Seb actually got paid, manually entered --
  // never derivable from legs/odds) -- same ret-minus-stake math as a win. Missing this
  // case silently understated the computed balance by every cashout's net on both sides of
  // self-heal's comparison. Found 2026-11-02 alongside the same gap in the live grader.
  // Never bonus-adjusted: a cashout amount is always a real, manually-entered dollar figure.
  if (d.status === "cashout") return (Number(d.ret) || 0) - (Number(d.stake) || 0);
  // A bonus/free bet (bonus:true, 2026-11-05) that loses costs nothing real -- `stake` on
  // that doc is a face amount for ret math only, never actual money at risk, so don't
  // subtract it.
  if (d.status === "lost") return d.bonus === true ? 0 : -(Number(d.stake) || 0);
  return 0; // push/open/pending never move the balance
}

function sumPnlBalance(docs) {
  return Math.round(docs.reduce((total, d) => total + pnlDelta(d), 0) * 100) / 100;
}

// One hourly self-heal pass for a single desk: finds what the shadow grader says SHOULD
// change in pnlEntries (covers both "status/ret/stake drift" and "open bet, game is final
// but never settled"), and the balance swing that correction would cause.
async function selfHealCheckDesk(desk) {
  const listRes = await supabaseFetch(`/docs?desk_id=eq.${encodeURIComponent(desk)}&collection=eq.pnlEntries&select=doc_id,data`);
  const allDocs = await listRes.json();
  const currentBalance = sumPnlBalance(allDocs.map((d) => d.data));

  const graded = await gradeCollectionForDesk(desk, "pnlEntries", "shadow");

  const correctedById = new Map(allDocs.map((d) => [d.doc_id, d.data]));
  for (const g of graded) correctedById.set(g.docId, g.data);
  const correctedBalance = sumPnlBalance([...correctedById.values()]);
  const balanceDelta = Math.round((correctedBalance - currentBalance) * 100) / 100;

  const stuckOpens = graded.filter(
    (g) => ["pending", "needs_review", undefined, null].includes(g.prevStatus) && ["won", "lost", "push"].includes(g.newStatus)
  );

  const mismatches = graded.map((g) => ({ docId: g.docId, prevStatus: g.prevStatus, newStatus: g.newStatus }));
  const hasMismatch = mismatches.length > 0 || Math.abs(balanceDelta) > SELF_HEAL_BALANCE_EPSILON;

  return { desk, hasMismatch, mismatches, stuckOpenCount: stuckOpens.length, currentBalance, correctedBalance, balanceDelta };
}

function selfHealSignature(result) {
  const ids = result.mismatches.map((m) => m.docId).sort();
  return JSON.stringify({ ids, balanceDelta: result.balanceDelta });
}

// --- SGP price calibration (2026-11-06, Seb's self-healing ask) ---
// A builder's ticket quotes an "odds" field for a same-game parlay; when Seb/Steve actually
// places that bet and later uploads the slip, the resulting pnlEntries doc carries the
// REAL DraftKings price (its own "odds" field) and a "ticketId" linking it back to the
// built ticket. Comparing those two numbers is how the correlation-discount guess in rule
// tight-real-prices gets calibrated against real data instead of staying a fixed 30-50%.
// Idempotent (stamps sgpCalibrationCheckedAt) so each pnlEntry is only ever compared once.
// Reuses americanToImplied(), defined once below (function declarations hoist).
async function sgpCalibrationCheckDesk(desk) {
  const pnlRes = await supabaseFetch(`/docs?desk_id=eq.${encodeURIComponent(desk)}&collection=eq.pnlEntries&select=doc_id,data`);
  const pnlDocs = await pnlRes.json();
  const candidates = pnlDocs.filter((d) => d.data?.ticketId && d.data?.odds != null && !d.data?.sgpCalibrationCheckedAt);
  if (candidates.length === 0) return { desk, checked: 0, logged: 0 };

  const ticketIds = [...new Set(candidates.map((d) => d.data.ticketId))];
  const idList = ticketIds.map((id) => encodeURIComponent(id)).join(",");
  const parlaysRes = await supabaseFetch(
    `/docs?desk_id=eq.${encodeURIComponent(desk)}&collection=eq.parlays&doc_id=in.(${idList})&select=doc_id,data`
  );
  const parlaysDocs = await parlaysRes.json();
  const parlaysById = new Map(parlaysDocs.map((p) => [p.doc_id, p.data]));

  let logged = 0;
  for (const entry of candidates) {
    const ticket = parlaysById.get(entry.data.ticketId);
    // Stamp checked regardless of outcome -- a non-SGP or unmatched entry never needs
    // re-checking every hour.
    await mergeUpsertDoc(desk, "pnlEntries", entry.doc_id, { sgpCalibrationCheckedAt: new Date().toISOString() }).catch(() => {});
    if (!ticket || ticket.betType !== "sgp" || ticket.odds == null) continue;
    const ourImplied = americanToImplied(ticket.odds);
    const realImplied = americanToImplied(entry.data.odds);
    if (ourImplied == null || realImplied == null) continue;
    // >1 means DraftKings' real price implies a HIGHER win probability (a shorter/worse
    // price for the bettor) than what we quoted -- the correlation discount was too weak.
    const gapRatio = Math.round((realImplied / ourImplied) * 1000) / 1000;
    await upsertDoc(desk, "sgpCalibration", `sgp-${desk}-${entry.doc_id}`, {
      desk,
      pnlEntryId: entry.doc_id,
      ticketId: entry.data.ticketId,
      legCount: Array.isArray(ticket.legs) ? ticket.legs.length : null,
      league: ticket.league || null,
      ourOdds: ticket.odds,
      realOdds: entry.data.odds,
      ourImpliedProb: Math.round(ourImplied * 1000) / 1000,
      realImpliedProb: Math.round(realImplied * 1000) / 1000,
      gapRatio,
      loggedAt: new Date().toISOString(),
    });
    logged++;
  }
  return { desk, checked: candidates.length, logged };
}

app.get("/internal/jobs/sgp-calibration", async (req, res) => {
  const desks = req.query.desk ? [req.query.desk] : ["main", "steve"];
  for (const d of desks) if (!["main", "steve"].includes(d)) return res.status(404).json({ error: `unknown desk: ${d}` });
  try {
    const results = [];
    for (const desk of desks) results.push(await sgpCalibrationCheckDesk(desk));
    res.json({ ok: true, results });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/internal/jobs/self-heal", async (req, res) => {
  const desks = req.query.desk ? [req.query.desk] : ["main", "steve"];
  for (const d of desks) if (!["main", "steve"].includes(d)) return res.status(404).json({ error: `unknown desk: ${d}` });
  const dryRun = req.query.dryRun === "true";
  try {
    // Piggyback the SGP calibration sweep on self-heal's existing hourly cron -- no new
    // Supabase cron job needed. Failures here never block the balance-drift check below.
    if (!dryRun) {
      for (const d of desks) await sgpCalibrationCheckDesk(d).catch((err) => console.error("sgp-calibration:", d, err.message));
    }
    const summary = { dryRun, desks: {} };
    let anyMismatch = false;
    const mismatchedDesks = [];

    for (const desk of desks) {
      const result = await selfHealCheckDesk(desk);
      summary.desks[desk] = {
        hasMismatch: result.hasMismatch,
        mismatchCount: result.mismatches.length,
        stuckOpenCount: result.stuckOpenCount,
        currentBalance: result.currentBalance,
        correctedBalance: result.correctedBalance,
        balanceDelta: result.balanceDelta,
      };
      if (result.hasMismatch) {
        anyMismatch = true;
        mismatchedDesks.push(result);
      }
    }

    if (!anyMismatch) {
      return res.json({ ok: true, action: "none", ...summary });
    }

    // Repeat-mismatch detection is per-desk (Steve's desk can be stuck while main's is fine,
    // and vice versa); persisted in Supabase (not memory) so it survives a Render restart.
    const actions = [];
    for (const result of mismatchedDesks) {
      const signature = selfHealSignature(result);
      const prevState = dryRun ? null : await getDoc(result.desk, "selfHealState", "status");
      const prev = prevState?.data;
      const repeating = prev && prev.signature === signature;
      const consecutiveCount = repeating ? (prev.consecutiveCount || 1) + 1 : 1;

      if (repeating && consecutiveCount >= 2) {
        // Same mismatch, 2nd (or later) run in a row -- stop poking wake-sync/fire-builder
        // (that would just loop) and flag it directly to Seb instead.
        actions.push({ desk: result.desk, action: "flagged-persistent", consecutiveCount });
        if (!dryRun) {
          const reason = `${result.desk}: ${result.mismatches.length} pnlEntries mismatch(es), ${result.stuckOpenCount} stuck-open, balance drift $${result.balanceDelta} -- unchanged for ${consecutiveCount} hourly checks in a row. wake-sync/fire-builder already tried and didn't clear it -- needs a manual look.`;
          await telegramApi("sendMessage", {
            chat_id: TELEGRAM_SEB_CHAT_ID,
            text: buildPrivateText({ kind: "failure", task: "Self-heal watchdog", reason }),
            parse_mode: "HTML",
          }).catch((err) => console.error("self-heal: persistent-flag DM failed:", err.message));
          await upsertDoc(result.desk, "selfHealLog", `sh-${result.desk}-${Date.now()}`, {
            desk: result.desk,
            foundAt: new Date().toISOString(),
            mismatches: result.mismatches,
            stuckOpenCount: result.stuckOpenCount,
            balanceDelta: result.balanceDelta,
            action: "flagged-persistent",
            consecutiveCount,
          });
          await upsertDoc(result.desk, "selfHealState", "status", { signature, consecutiveCount, lastCheckedAt: new Date().toISOString() });
        }
        continue;
      }

      // New or changed mismatch (or first time seeing it repeat) -- try to actually fix it:
      // wake the sync engine, and if it's Steve's desk specifically, also re-light his
      // pick-request builder (his pipeline couples sync+builder, so a stuck desk there
      // usually means both need a nudge).
      let actionTaken = "woke-sync";
      if (!dryRun) {
        const globalState = await getDoc("main", "selfHealState", "_global");
        const sinceLastWake = Date.now() - (globalState?.data?.lastWakeAt ? new Date(globalState.data.lastWakeAt).getTime() : 0);
        if (sinceLastWake >= SELF_HEAL_WAKE_COOLDOWN_MS) {
          await triggerSyncWake().catch((err) => console.error("self-heal: wake-sync failed:", err.message));
          await upsertDoc("main", "selfHealState", "_global", { lastWakeAt: new Date().toISOString() });
        } else {
          actionTaken = "suppressed-cooldown";
        }
        if (result.desk === "steve") {
          await triggerBuilderFire("steve", "SELF_HEAL_WAKE").catch((err) => console.error("self-heal: fire-builder failed:", err.message));
          actionTaken += "+fired-builder";
        }
        await upsertDoc(result.desk, "selfHealLog", `sh-${result.desk}-${Date.now()}`, {
          desk: result.desk,
          foundAt: new Date().toISOString(),
          mismatches: result.mismatches,
          stuckOpenCount: result.stuckOpenCount,
          balanceDelta: result.balanceDelta,
          action: actionTaken,
          consecutiveCount,
        });
        await upsertDoc(result.desk, "selfHealState", "status", { signature, consecutiveCount, lastCheckedAt: new Date().toISOString() });
      }
      actions.push({ desk: result.desk, action: actionTaken, consecutiveCount });
    }

    res.json({ ok: true, action: "mismatch-handled", actions, ...summary });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Balance guard (2026-11-05, Seb's request) ---
// Pure engine code, no Claude involved at all -- watches each desk's real account balance
// (start + deposits/withdrawals/DK-match adjustments + settled-bet net, the exact same
// formula Post-Cutover Sync's own balanceUpdate math uses) and DMs Seb immediately, in plain
// language, the moment it moves by more than $50 in a way that ISN'T explained by a bet
// settling, a deposit/withdrawal, or a DraftKings-match adjustment. This is a tripwire, not a
// fixer -- it never writes anything to pnlEntries itself, only reads and alerts.
const BALANCE_GUARD_THRESHOLD = 50;

// BALANCE FORMULA (2026-11-05, Seb's rule: "must match the app, exactly") -- ported verbatim
// from the real app's own data.js loadDesk(), NOT the simpler start+deposits-withdrawals+pnl
// sum this guard used before 2026-11-05 (that gave main $1190.36 while the app showed ~$1,500+
// in play -- wrong, because it ignored the app's own DK-match anchor mechanic entirely). The
// app pins the balance to the most recent "Balance update: set to $X" (adj-/type:"adjust") row
// -- the DraftKings-match anchor -- then adds only what happened AFTER it: full net of bets
// placed after the anchor, the full payout (not net) of bets that were still open AT the
// anchor and have since settled (their stake was already removed from the DK balance the
// anchor captured), and deposits/withdrawals dated after it. Falls back to the plain
// start+deposits-withdrawals+pnl sum only when there is no anchor row at all. Keep this in
// lockstep with data.js's loadDesk() if that formula ever changes -- the two must never drift.
const bgN = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);
const bgPick = (o, ...keys) => {
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  return undefined;
};
const bgTs = (v) => {
  if (!v) return 0;
  const str = String(v);
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(str) ? str + "T23:59:59" : str);
  return Number.isNaN(t) ? 0 : t;
};
function bgIsAdjRow(docId, d) {
  return /^adj-/i.test(docId) || /adjust|balance|sync/i.test(String(d.type || ""));
}

// One lightweight fingerprint per pnlEntries doc -- just enough fields for the explain-delta
// heuristic below to tell, on the NEXT run, whether this exact doc is new or changed in a way
// that would move the balance. Never stores leg text/analysis/etc -- this state doc is a
// monitoring checkpoint, not a mirror. (The actual balance NUMBER is recomputed from scratch
// every run via the anchored formula below, never accumulated from these fingerprints.)
function balanceGuardFingerprint(docId, d) {
  return {
    docId,
    isAdj: bgIsAdjRow(docId, d),
    type: d.type || (/^wd-/i.test(docId) ? "withdrawal" : /^dep-/i.test(docId) ? "deposit" : "bet"),
    status: d.status ?? null,
    amount: bgN(bgPick(d, "amount", "value", "stake")),
    stake: bgN(d.stake),
    ret: d.ret === null || d.ret === undefined ? null : Number(d.ret),
  };
}

async function computeDeskBalance(desk) {
  const [settingsDoc, entriesRes] = await Promise.all([
    getDoc(desk, "pnl", "settings"),
    supabaseFetch(`/docs?desk_id=eq.${encodeURIComponent(desk)}&collection=eq.pnlEntries&select=doc_id,data`),
  ]);
  const settings = settingsDoc?.data || {};
  const start = bgN(bgPick(settings, "start", "startBalance", "startingBalance", "starting", "startAmount", "startingBankroll", "bankroll", "initialBalance"));
  const rows = await entriesRes.json();

  const fingerprints = {};
  const bets = [];
  const cashRows = [];
  const adjRows = [];
  for (const row of rows) {
    const d = row.data || {};
    const fp = balanceGuardFingerprint(row.doc_id, d);
    fingerprints[row.doc_id] = fp;

    if (fp.isAdj) {
      let val = bgN(bgPick(d, "setTo", "balance", "newBalance", "target", "value"));
      if (!val) {
        const m = String(d.desc || d.note || "").match(/set to \$?([\d,]+(?:\.\d+)?)/i);
        if (m) val = Number(m[1].replace(/,/g, ""));
      }
      const exact = bgTs(d.createdAt || d.updatedAt);
      const day = String(d.date || (row.doc_id.match(/(\d{8})/)?.[1] || "").replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"));
      const dayStart = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(day + "T00:00:00") : 0;
      if (val && (exact || bgTs(day))) adjRows.push({ val, day, t: exact || bgTs(day), tSettle: exact || dayStart });
      continue;
    }
    if (d.type && d.type !== "bet") {
      cashRows.push({
        docId: row.doc_id,
        type: /withdraw/i.test(d.type) || /^wd-/i.test(row.doc_id) ? "withdrawal" : /deposit/i.test(d.type) || /^dep-/i.test(row.doc_id) ? "deposit" : "other",
        amount: Math.abs(bgN(bgPick(d, "amount", "value", "stake"))),
        date: bgPick(d, "date", "createdAt", "settledAt") || "",
        exact: bgTs(d.createdAt),
        appEditId: bgPick(d, "appEditId", "editId") || null,
      });
      continue;
    }
    bets.push({
      status: (bgPick(d, "status", "result") || "open").toLowerCase(),
      stake: bgN(bgPick(d, "stake", "risk", "wager", "amount")),
      ret: bgN(bgPick(d, "ret", "payout", "return", "toReturn")),
      placedAt: bgPick(d, "placedAt", "createdAt", "created_at", "date"),
      loggedAt: bgPick(d, "createdAt", "created_at", "uploadedAt", "loggedAt") || ((String(row.doc_id).match(/(\d{13})/) || [])[1] ? new Date(Number(String(row.doc_id).match(/(\d{13})/)[1])).toISOString() : ""),
      settledAt: bgPick(d, "settledAt", "settled_at"),
    });
  }

  const withdrawn = cashRows.filter((c) => c.type === "withdrawal").reduce((t, c) => t + c.amount, 0);
  const deposited = cashRows.filter((c) => c.type === "deposit").reduce((t, c) => t + c.amount, 0);
  const settledBets = bets.filter((b) => ["won", "lost", "push", "cashout"].includes(b.status));
  const pnlAll = settledBets.reduce((t, b) => t + (b.status === "push" ? 0 : b.ret - b.stake), 0);

  adjRows.sort((a, b) => b.t - a.t);
  const anchor = adjRows[0];
  let anchored = 0;
  let anchorDate = "";
  if (anchor) {
    anchored = anchor.val;
    for (const b of bets) {
      const placed = bgTs(b.placedAt);
      const settledT = bgTs(b.settledAt);
      const done = ["won", "lost", "push", "cashout"].includes(b.status);
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(b.placedAt || ""));
      const sameDay = dateOnly && String(b.placedAt) === String(anchor.day).slice(0, 10);
      const logged = Date.parse(b.loggedAt || "") || 0;
      const isNew = placed && (dateOnly ? (String(b.placedAt) > String(anchor.day).slice(0, 10) || (sameDay && logged > anchor.t)) : placed > anchor.t);
      if (isNew) anchored += done ? b.ret - b.stake : -b.stake;
      else if (done && settledT >= anchor.tSettle) anchored += b.ret;
    }
    for (const c of cashRows) {
      const after = c.exact ? c.exact > anchor.t : String(c.date).slice(0, 10) > String(anchor.day).slice(0, 10);
      if (after) anchored += c.type === "withdrawal" ? -c.amount : c.type === "deposit" ? c.amount : 0;
    }
    anchored = Math.round(anchored * 100) / 100;
    anchorDate = new Date(anchor.t).toISOString();
  }

  const synced = anchored || bgN(bgPick(settings, "balance", "dkBalance", "syncedBalance"));
  const balance = synced || start + deposited - withdrawn + pnlAll;
  const duplicates = findDuplicateCashRows(cashRows);
  return { balance: Math.round(balance * 100) / 100, fingerprints, anchored: !!anchor, anchorDate, start, duplicates };
}

// --- Duplicate cash-entry detector (2026-11-05, Seb's request, after a false "-$400 balance"
// scare that turned out to have no actual duplicate) -- a withdrawal/deposit counts as
// "explained" by balanceGuardFindEvents the instant it exists, so a genuine DUPLICATE
// withdrawal (two real pnlEntries docs for the same real-world cash movement) would sail
// through that check as two separate "explained" events and never get flagged on its own.
// This runs independently of the unexplained-delta check and fires even when every event is
// individually explained. Two cash rows are a duplicate pair when they share type+appEditId
// (the same app edit literally produced two docs -- should be structurally impossible, but
// cheap to check), or share type+amount and landed within 24h of each other (two docs for
// what was almost certainly the same real withdrawal/deposit).
const DUPLICATE_CASH_WINDOW_MS = 24 * 60 * 60 * 1000;
function findDuplicateCashRows(cashRows) {
  const pairs = [];
  for (let i = 0; i < cashRows.length; i++) {
    for (let j = i + 1; j < cashRows.length; j++) {
      const a = cashRows[i], b = cashRows[j];
      if (a.type !== b.type || a.type === "other") continue;
      const sameAppEdit = a.appEditId && b.appEditId && a.appEditId === b.appEditId;
      const sameAmountRecent = a.amount === b.amount && a.amount > 0 && Math.abs(a.exact - b.exact) <= DUPLICATE_CASH_WINDOW_MS;
      if (sameAppEdit || sameAmountRecent) {
        pairs.push({ docIds: [a.docId, b.docId], type: a.type, amount: a.amount, reason: sameAppEdit ? "same appEditId" : "same amount within 24h" });
      }
    }
  }
  return pairs;
}

// Finds every qualifying event since the last check: a new or re-valued DK-match anchor, a
// new deposit/withdrawal (or an edit to one), or a bet leaving "pending"/"open" for a real
// result. Seb's rule is binary, not a dollar reconciliation: if ANY such event happened, the
// whole balance move is explained by definition -- never try to partially attribute how much
// of a move "came from" which event (the anchor mechanic re-pins the ENTIRE balance, so there
// is no clean per-doc split anyway). Only when NONE of these fired at all is a move flagged.
function balanceGuardFindEvents(prevFingerprints, currFingerprints) {
  const events = [];
  for (const [docId, fp] of Object.entries(currFingerprints)) {
    const prev = prevFingerprints[docId];
    if (!prev) {
      if (fp.isAdj) events.push({ docId, type: "adjust", why: "new DK-match anchor" });
      else if (fp.type === "deposit" || fp.type === "withdrawal") events.push({ docId, type: fp.type, why: `new ${fp.type}` });
      else if (fp.type === "bet" && fp.status && !["pending", "needs_review", "open"].includes(fp.status))
        events.push({ docId, type: "bet", why: `new bet already ${fp.status}` });
      continue;
    }
    if (fp.isAdj || prev.isAdj) {
      if (fp.isAdj !== prev.isAdj || fp.amount !== prev.amount) events.push({ docId, type: "adjust", why: "DK-match anchor changed" });
      continue;
    }
    if (fp.type !== prev.type) continue; // a type change with no adj row involved is itself unexplained
    if (fp.type === "bet") {
      const wasOpen = !prev.status || ["pending", "needs_review", "open"].includes(prev.status);
      const nowSettled = fp.status && !["pending", "needs_review", "open"].includes(fp.status);
      if (wasOpen && nowSettled) events.push({ docId, type: "bet", why: `bet settled (${fp.status})` });
    } else if ((fp.type === "deposit" || fp.type === "withdrawal") && fp.amount !== prev.amount) {
      events.push({ docId, type: fp.type, why: `${fp.type} amount changed` });
    }
  }
  return events;
}

async function balanceGuardCheckDesk(desk, dryRun) {
  const current = await computeDeskBalance(desk);

  // Duplicate cash entries are flagged immediately, independent of the explained/unexplained
  // delta logic below and regardless of baseline state -- a duplicate is never "explained" by
  // the fact that both copies exist (see findDuplicateCashRows' comment).
  if (current.duplicates.length > 0) {
    const prevDupState = dryRun ? null : await getDoc(desk, "balanceGuardDupState", "status");
    const dupSignature = JSON.stringify(current.duplicates.map((d) => d.docIds.slice().sort()).sort());
    if (!prevDupState || prevDupState.data?.signature !== dupSignature) {
      const who = desk === "main" ? "Your" : "Steve's";
      const lines = current.duplicates.map((d) => `${d.type} $${d.amount.toFixed(2)} (${d.docIds.join(" / ")}) -- ${d.reason}`).join("; ");
      const reason = `${who} desk has what looks like a DUPLICATE cash entry: ${lines}. Check before trusting the balance.`;
      if (!dryRun) {
        await telegramApi("sendMessage", {
          chat_id: TELEGRAM_SEB_CHAT_ID,
          text: buildPrivateText({ kind: "failure", task: "Balance guard: duplicate cash entry", reason }),
          parse_mode: "HTML",
        }).catch((err) => console.error("balance-guard: duplicate DM failed:", err.message));
        await upsertDoc(desk, "balanceGuardDupState", "status", { signature: dupSignature, checkedAt: new Date().toISOString() });
      }
    }
  }

  const prevState = await getDoc(desk, "balanceGuardState", "status");

  if (!prevState) {
    if (!dryRun) {
      await upsertDoc(desk, "balanceGuardState", "status", {
        balance: current.balance,
        fingerprints: current.fingerprints,
        checkedAt: new Date().toISOString(),
      });
    }
    return { desk, action: "baseline-set", balance: current.balance, anchored: current.anchored, anchorDate: current.anchorDate, duplicates: current.duplicates };
  }

  const prevBalance = Number(prevState.data.balance) || 0;
  const rawDelta = Math.round((current.balance - prevBalance) * 100) / 100;
  const events = balanceGuardFindEvents(prevState.data.fingerprints || {}, current.fingerprints);
  // Binary per Seb's rule: any qualifying event at all makes the WHOLE move explained (no
  // per-doc dollar attribution -- see balanceGuardFindEvents for why). Only a move with zero
  // qualifying events, past the threshold, is unexplained.
  const unexplained = events.length > 0 ? 0 : rawDelta;

  const result = { desk, rawDelta, unexplained, events, balance: current.balance, anchored: current.anchored, anchorDate: current.anchorDate, duplicates: current.duplicates };

  if (Math.abs(unexplained) <= BALANCE_GUARD_THRESHOLD) {
    result.action = "no-op";
    if (!dryRun) {
      await upsertDoc(desk, "balanceGuardState", "status", {
        balance: current.balance,
        fingerprints: current.fingerprints,
        checkedAt: new Date().toISOString(),
      });
    }
    return result;
  }

  // Unexplained move past the threshold -- DM Seb right away, plain language, no field names
  // or dollar-math jargon, just what changed. Moves the checkpoint forward either way (dryRun
  // aside) so this is a one-time notice per occurrence, never a repeat every run until fixed.
  const who = desk === "main" ? "Your" : "Steve's";
  const direction = unexplained > 0 ? "went up" : "went down";
  const reason = `${who} balance ${direction} by $${Math.abs(unexplained).toFixed(2)} and I can't explain it -- it's not a bet settling, a deposit or withdrawal, or a DraftKings match. Worth checking the app.`;
  result.action = dryRun ? "would-alert" : "alerted";
  result.message = reason;

  if (!dryRun) {
    await telegramApi("sendMessage", {
      chat_id: TELEGRAM_SEB_CHAT_ID,
      text: buildPrivateText({ kind: "failure", task: "Balance guard", reason }),
      parse_mode: "HTML",
    }).catch((err) => console.error("balance-guard: DM failed:", err.message));
    await upsertDoc(desk, "balanceGuardLog", `bg-${Date.now()}`, {
      desk,
      foundAt: new Date().toISOString(),
      rawDelta,
      unexplained,
      events,
    });
    await upsertDoc(desk, "balanceGuardState", "status", {
      balance: current.balance,
      fingerprints: current.fingerprints,
      checkedAt: new Date().toISOString(),
    });

    // 2026-11-06, Seb's request: the moment the balance guard itself flags an unexplained
    // move, automatically run the ledger-diff (report-only, never repair=true here -- that
    // stays a manual decision) and DM Seb the plain-language list of what looks suspicious.
    // ledgerDiffDesk is defined further down in this file (function declarations are
    // hoisted, so the forward reference is fine); it no-ops safely (caught below) if no
    // good snapshot has been taken yet for this desk.
    const diffResult = await ledgerDiffDesk(desk, { repair: false }).catch((err) => ({ error: err.message }));
    if (!diffResult.error) {
      await telegramApi("sendMessage", {
        chat_id: TELEGRAM_SEB_CHAT_ID,
        text: ledgerSuspiciousDmText(desk, diffResult.suspicious),
      }).catch((err) => console.error("balance-guard: ledger-diff DM failed:", err.message));
    } else {
      console.error("balance-guard: ledger-diff auto-run failed:", diffResult.error);
    }
  }
  return result;
}

app.get("/internal/jobs/balance-guard", async (req, res) => {
  const desks = req.query.desk ? [req.query.desk] : ["main", "steve"];
  for (const d of desks) if (!["main", "steve"].includes(d)) return res.status(404).json({ error: `unknown desk: ${d}` });
  const dryRun = req.query.dryRun === "true";
  try {
    const results = [];
    for (const desk of desks) results.push(await balanceGuardCheckDesk(desk, dryRun));
    res.json({ ok: true, dryRun, results });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Ledger baseline + change log (2026-11-06, Seb's request) -------------------------
// Three independent, LOGGING-ONLY layers. None of this ever blocks, delays, or fails a
// real write to the `docs` table -- see sql/ledger-audit-run-me.sql for the trigger's own
// exception guard.
//   1. ledger_snapshots / ledger_snapshot_runs (Supabase tables) -- a labeled, point-in-time
//      copy of every main/steve pnlEntries doc + the pnl/settings doc, plus that moment's
//      computed balance (computeDeskBalance, same formula as balance-guard -- never a
//      second formula). Immutable history; a label is never overwritten.
//   2. ledger_audit (Supabase table + a Postgres trigger on public.docs) -- fires on every
//      insert/update/delete to a main/steve pnlEntries row and records desk/doc/before/
//      after/when, best-effort "who". Lives entirely in SQL (see the run-me file) so it
//      catches writes from ANY path (this server, a manual Supabase edit, a future script),
//      not just ones that go through upsertDoc here.
//   3. /internal/jobs/ledger-diff -- compares the live desk against its latest "good"
//      snapshot, labels every change NORMAL or SUSPICIOUS, and (only with &repair=true)
//      restores just the SUSPICIOUS ones from that snapshot.
// Nightly (sql/ledger-audit-run-me.sql's cron, 4 AM ET), /internal/jobs/ledger-nightly-
// snapshot takes a fresh "good" snapshot per desk IF that desk's balance guard shows no
// unexplained move or duplicate right now, and keeps only the last 14 per desk.
const LEDGER_DESKS = ["main", "steve"];

// Classification is necessarily heuristic -- this engine has no ground truth beyond what's
// already in Supabase -- so it's written to err toward flagging anything it can't positively
// explain as SUSPICIOUS rather than assuming it's fine. Report-only by default; a human
// (Seb) decides whether to repair.
function ledgerLooksLikeOtherDesk(desk, docId) {
  const otherDeskPrefix = desk === "main" ? /^steve[-_]/i : /^(main|seb)[-_]/i;
  return otherDeskPrefix.test(String(docId));
}

// A new balance anchor is NORMAL only if it's actually linked to a real "balanceUpdate"
// appEdit on this SAME desk -- i.e. the app's own DK-match box (Seb on main, Steve on
// steve) -- never from matching the anchor's own desc text alone (2026-11-06, Seb's
// correction: description text is trivially fakeable; the appEdit link is not). Checks
// both an explicit appEditId field on the anchor doc (if ever added) and the real
// production doc-id convention actually observed (syncNeededBackfillAppEditMirror):
// appEdits doc "ed-<X>" produces pnlEntries mirror doc "adj-<X>".
function ledgerAnchorLinkedAppEdit(docId, d, appEdits) {
  const directId = d.appEditId ? String(d.appEditId) : null;
  if (directId && appEdits.get(directId) === "balanceUpdate") return true;
  const conventionId = `ed-${String(docId).replace(/^adj-/i, "")}`;
  return appEdits.get(conventionId) === "balanceUpdate";
}

function ledgerClassifyChange(desk, docId, beforeData, afterData, appEdits) {
  if (beforeData && !afterData) return { label: "SUSPICIOUS", why: "doc deleted since the last good snapshot" };
  if (ledgerLooksLikeOtherDesk(desk, docId)) {
    return { label: "SUSPICIOUS", why: `doc id looks like it belongs to the other desk ("${docId}")` };
  }

  const d = afterData || {};
  const isAdj = bgIsAdjRow(docId, d);
  const isCash = !isAdj && d.type && d.type !== "bet";

  if (!beforeData) {
    // Added since the last good snapshot.
    if (isAdj) {
      const linked = ledgerAnchorLinkedAppEdit(docId, d, appEdits);
      return linked
        ? { label: "NORMAL", why: "new DK-match anchor linked to a balanceUpdate appEdit on this desk" }
        : {
            label: "SUSPICIOUS",
            why: "new balance anchor with no linked balanceUpdate appEdit on this desk -- matching 'set to $X to match DraftKings' description text alone is not enough",
          };
    }
    if (isCash) {
      const linked = d.appEditId && appEdits.has(String(d.appEditId));
      return linked
        ? { label: "NORMAL", why: `${d.type} tied to appEdit ${d.appEditId} on this desk` }
        : { label: "SUSPICIOUS", why: `new ${d.type || "cash"} entry with no matching appEdit on this desk` };
    }
    return { label: "NORMAL", why: "new bet entry (slip upload or a pick placed)" };
  }

  // Changed since the last good snapshot.
  if (isAdj) return { label: "SUSPICIOUS", why: "an existing balance anchor row was changed" };
  if (isCash) {
    const linked = d.appEditId && appEdits.has(String(d.appEditId));
    return linked
      ? { label: "NORMAL", why: "cash entry edited, still tied to an appEdit on this desk" }
      : { label: "SUSPICIOUS", why: "cash entry changed with no matching appEdit on this desk" };
  }
  const wasSettled = ["won", "lost", "push", "cashout"].includes(String(beforeData.status || "").toLowerCase());
  const nowSettled = ["won", "lost", "push", "cashout"].includes(String(d.status || "").toLowerCase());
  const stakeChanged = bgN(beforeData.stake) !== bgN(d.stake);
  const retChanged = Number(beforeData.ret ?? NaN) !== Number(d.ret ?? NaN) && !(beforeData.ret == null && d.ret == null);
  if (wasSettled && (stakeChanged || retChanged)) {
    return { label: "SUSPICIOUS", why: "stake or payout changed on an already-settled bet" };
  }
  if (!wasSettled && nowSettled) return { label: "NORMAL", why: `bet settled (${d.status})` };
  return { label: "NORMAL", why: "bet field edit before settling" };
}

async function ledgerSnapshotDesk(desk, label) {
  const [entriesRes, settingsDoc] = await Promise.all([
    supabaseFetch(
      `/docs?desk_id=eq.${encodeURIComponent(desk)}&collection=eq.pnlEntries&select=doc_id,data,version`
    ),
    getDoc(desk, "pnl", "settings"),
  ]);
  const entries = await entriesRes.json();
  const rows = entries.map((r) => ({ desk_id: desk, collection: "pnlEntries", doc_id: r.doc_id, data: r.data, version: r.version || 1 }));
  rows.push({ desk_id: desk, collection: "pnl", doc_id: "settings", data: settingsDoc?.data || {}, version: settingsDoc?.version || 1 });

  if (rows.length > 0) {
    await supabaseFetch(`/ledger_snapshots`, {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(rows.map((r) => ({ ...r, label }))),
    });
  }

  const balance = await computeDeskBalance(desk);
  await supabaseFetch(`/ledger_snapshot_runs?on_conflict=label,desk_id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([
      {
        label,
        desk_id: desk,
        doc_count: rows.length,
        balance: balance.balance,
        anchored: balance.anchored,
        anchor_date: balance.anchorDate || null,
        good: true,
      },
    ]),
  });

  return { desk, label, docCount: rows.length, balance: balance.balance, anchored: balance.anchored, anchorDate: balance.anchorDate };
}

async function ledgerLatestGoodSnapshot(desk) {
  const res = await supabaseFetch(
    `/ledger_snapshot_runs?desk_id=eq.${encodeURIComponent(desk)}&good=eq.true&order=created_at.desc&limit=1`
  );
  const rows = await res.json();
  return rows[0] || null;
}

async function ledgerSnapshotDocsMap(label, desk, collection) {
  const res = await supabaseFetch(
    `/ledger_snapshots?label=eq.${encodeURIComponent(label)}&desk_id=eq.${encodeURIComponent(
      desk
    )}&collection=eq.${encodeURIComponent(collection)}&select=doc_id,data,version`
  );
  const rows = await res.json();
  return new Map(rows.map((r) => [r.doc_id, r]));
}

async function ledgerPruneSnapshots(desk, keep) {
  const res = await supabaseFetch(
    `/ledger_snapshot_runs?desk_id=eq.${encodeURIComponent(desk)}&order=created_at.desc&select=label,created_at`
  );
  const rows = await res.json();
  const stale = rows.slice(keep);
  for (const r of stale) {
    await supabaseFetch(
      `/ledger_snapshots?desk_id=eq.${encodeURIComponent(desk)}&label=eq.${encodeURIComponent(r.label)}`,
      { method: "DELETE" }
    );
    await supabaseFetch(
      `/ledger_snapshot_runs?desk_id=eq.${encodeURIComponent(desk)}&label=eq.${encodeURIComponent(r.label)}`,
      { method: "DELETE" }
    );
  }
  return stale.map((r) => r.label);
}

async function ledgerDiffDesk(desk, { repair } = {}) {
  const snap = await ledgerLatestGoodSnapshot(desk);
  if (!snap) return { desk, error: "no good snapshot found for this desk yet -- run /internal/jobs/ledger-snapshot first" };

  const [snapEntries, snapSettingsMap, liveEntriesRes, liveSettingsDoc, appEditsRes] = await Promise.all([
    ledgerSnapshotDocsMap(snap.label, desk, "pnlEntries"),
    ledgerSnapshotDocsMap(snap.label, desk, "pnl"),
    supabaseFetch(`/docs?desk_id=eq.${encodeURIComponent(desk)}&collection=eq.pnlEntries&select=doc_id,data,version`),
    getDoc(desk, "pnl", "settings"),
    supabaseFetch(`/docs?desk_id=eq.${encodeURIComponent(desk)}&collection=eq.appEdits&select=doc_id,data`),
  ]);
  const liveEntries = await liveEntriesRes.json();
  // Map of appEdit doc_id -> its action (e.g. "balanceUpdate", "withdrawal", "deposit"),
  // not just existence -- ledgerAnchorLinkedAppEdit needs the action to confirm an anchor
  // is really tied to a balanceUpdate edit, not just any appEdit sharing an id.
  const appEdits = new Map((await appEditsRes.json()).map((r) => [r.doc_id, r.data?.action]));
  const liveMap = new Map(liveEntries.map((r) => [r.doc_id, r]));
  const allIds = new Set([...snapEntries.keys(), ...liveMap.keys()]);

  const changes = [];
  for (const docId of allIds) {
    const before = snapEntries.get(docId) || null;
    const live = liveMap.get(docId) || null;
    const beforeData = before?.data ?? null;
    const afterData = live?.data ?? null;
    if (JSON.stringify(beforeData) === JSON.stringify(afterData)) continue;

    const op = !before ? "added" : !live ? "deleted" : "changed";
    const cls = ledgerClassifyChange(desk, docId, beforeData, afterData, appEdits);
    changes.push({ docId, op, label: cls.label, why: cls.why, before: beforeData, after: afterData });
  }

  const snapSettingsRow = snapSettingsMap.get("settings") || null;
  const liveSettingsData = liveSettingsDoc?.data ?? {};
  if (JSON.stringify(snapSettingsRow?.data ?? {}) !== JSON.stringify(liveSettingsData)) {
    changes.push({
      docId: "pnl/settings",
      op: "changed",
      label: "SUSPICIOUS",
      why: "pnl settings doc changed outside the normal balance-anchor flow",
      before: snapSettingsRow?.data ?? null,
      after: liveSettingsData,
    });
  }

  const suspicious = changes.filter((c) => c.label === "SUSPICIOUS");
  const normal = changes.filter((c) => c.label === "NORMAL");

  const result = {
    desk,
    snapshotLabel: snap.label,
    snapshotAt: snap.created_at,
    suspicious: suspicious.map(({ before, after, ...rest }) => rest),
    normal: normal.map(({ before, after, ...rest }) => rest),
  };

  if (repair && suspicious.length > 0) {
    const repaired = [];
    for (const c of suspicious) {
      if (c.docId === "pnl/settings") {
        await upsertDoc(desk, "pnl", "settings", snapSettingsRow?.data ?? {});
      } else if (c.op === "added") {
        await supabaseFetch(
          `/docs?desk_id=eq.${encodeURIComponent(desk)}&collection=eq.pnlEntries&doc_id=eq.${encodeURIComponent(c.docId)}`,
          { method: "DELETE" }
        );
      } else {
        await upsertDoc(desk, "pnlEntries", c.docId, c.before);
      }
      repaired.push(c.docId);
    }
    result.repaired = repaired;
    result.balanceAfterRepair = (await computeDeskBalance(desk)).balance;
  }

  return result;
}

function ledgerSuspiciousDmText(desk, suspicious) {
  const who = desk === "main" ? "Your" : "Steve's";
  if (!suspicious || suspicious.length === 0) {
    return `${who} ledger diff against the last good snapshot found nothing suspicious -- whatever moved the balance isn't something this check knows how to classify yet. Worth a manual look.`;
  }
  const lines = suspicious.map((c) => `- ${c.op} entry (${c.docId}): ${c.why}`).join("\n");
  return `${who} ledger diff found ${suspicious.length} change(s) since the last good snapshot that don't look normal:\n${lines}\n\nReport-only -- nothing was changed. Say the word and I'll restore just these from the snapshot.`;
}

app.post("/internal/jobs/ledger-snapshot", async (req, res) => {
  const label = String(req.query.label || "").trim();
  if (!label) return res.status(400).json({ error: "label is required, e.g. ?label=baseline-2026-11-06" });
  const desks = req.query.desk ? [req.query.desk] : LEDGER_DESKS;
  for (const d of desks) if (!LEDGER_DESKS.includes(d)) return res.status(404).json({ error: `unknown desk: ${d}` });
  try {
    const results = [];
    for (const desk of desks) results.push(await ledgerSnapshotDesk(desk, label));
    res.json({ ok: true, label, results });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/internal/jobs/ledger-diff", async (req, res) => {
  const desks = req.query.desk ? [req.query.desk] : LEDGER_DESKS;
  for (const d of desks) if (!LEDGER_DESKS.includes(d)) return res.status(404).json({ error: `unknown desk: ${d}` });
  const repair = req.query.repair === "true";
  try {
    const results = [];
    for (const desk of desks) results.push(await ledgerDiffDesk(desk, { repair }));
    res.json({ ok: true, repair, results });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Nightly (4 AM ET, see sql/ledger-audit-run-me.sql): only saves a fresh "good" snapshot
// for a desk when that desk's own balance guard shows a clean read right now (no
// unexplained move, no duplicate cash rows) -- a snapshot taken on top of an already-bad
// state would just become a new "good" baseline for a bad ledger. dryRun on the guard call
// so this never itself sends the hourly alert DM or moves balance-guard's own checkpoint.
app.get("/internal/jobs/ledger-nightly-snapshot", async (req, res) => {
  const desks = req.query.desk ? [req.query.desk] : LEDGER_DESKS;
  for (const d of desks) if (!LEDGER_DESKS.includes(d)) return res.status(404).json({ error: `unknown desk: ${d}` });
  try {
    const results = [];
    for (const desk of desks) {
      const guard = await balanceGuardCheckDesk(desk, true);
      const clean = Math.abs(guard.unexplained || 0) <= BALANCE_GUARD_THRESHOLD && (guard.duplicates || []).length === 0;
      if (!clean) {
        results.push({ desk, skipped: true, reason: "balance guard shows an unexplained move or duplicate right now -- not saving a new good snapshot tonight" });
        continue;
      }
      const label = `nightly-${new Date().toISOString().slice(0, 10)}`;
      const snapshot = await ledgerSnapshotDesk(desk, label);
      const prunedLabels = await ledgerPruneSnapshots(desk, 14);
      results.push({ desk, skipped: false, snapshot, prunedLabels });
    }
    res.json({ ok: true, results });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Sync-needed gate (2026-11-04, Seb's request -- replaces hourly Post-Cutover Sync
// polling with an engine-gated wake). Post-Cutover Sync itself now runs once daily
// (6:00 AM ET) as a backup sweep; instant wakes on real app actions (the docs_app_insert_
// dispatch trigger, the builders' post-answer wake) are untouched and still fire
// immediately. This endpoint is pg_cron-driven, every 10 minutes, and catches the gap
// those two don't: a request/appUpload/appEdit that's been sitting queued/pending for a
// while (the instant-wake path missed it, or never fired) and a claim stuck in
// "processing" after a crash. Pure Supabase reads -- this process has no ArtifactData
// access, so it can only ever see what's already mirrored here, never the real desk
// directly; see the two FTD/FBM-side wake-sync calls added to the prep routines for how
// desk-side changes (new picks, stale-doc archiving) get mirrored instead -- at the
// source, not polled for here.
const SYNC_NEEDED_PENDING_STALE_MS = 5 * 60 * 1000;
const SYNC_NEEDED_STUCK_CLAIM_MS = 20 * 60 * 1000;
const SYNC_NEEDED_COLLECTIONS = ["requests", "appUploads", "appEdits"];
// "requests" goes through an extra hold PCS itself creates -- "sent" means PCS already
// copied the app's queued row onto the real desk (status "new" there) and attempted to
// fire that desk's builder, but never saw it come back "answered". A "sent" row stuck
// past the stale window almost always means the builder-fire attempt itself failed (e.g.
// a stale/misconfigured *_BUILDER_FIRE_URL/TOKEN -- see the 2026-11-04 Friends builder
// incident), not that PCS never ran -- so it needs a direct per-desk builder retry below,
// not just another generic PCS wake. appUploads/appEdits have no such intermediate hold
// (PCS claims and finishes them in one pass), so they stay on "queued"/"pending" only.
const SYNC_NEEDED_STALE_STATUSES = {
  requests: ["queued", "pending", "sent"],
  appUploads: ["queued", "pending"],
  appEdits: ["queued", "pending"],
};

// --- "requests" retry guards (2026-11-04, Seb's request, after the Friends builder-fire-
// URL incident) --- A stale "sent" request means PCS already copied it to the real desk
// and tried to fire that desk's builder, but the fire attempt itself may have failed. Three
// guards before ever retrying: (1) re-check fresh, right before firing, that it isn't
// already answered/working, or that a parlay doc already exists for it (data.requestId ===
// this doc's id -- confirmed live on 2026-11-04's own steve-nba-...-3u parlay) -- covers the
// race where the real build succeeded but PCS's own round-trip just hasn't caught up yet;
// (2) at most 2 retries per request, tracked as retryCount/lastRetryAt/retryGaveUp on the
// request doc itself via a full read-merge-write (mergeUpsertDoc, never a blind overwrite --
// this doc gets written by the app/PCS too); (3) never more than one retry per 10 minutes
// per request. After 2 retries with no answer, stop retrying and DM Seb once -- plain
// English only, no $ and no technical detail, same as the group-post-no-dollars rule applied
// to this private DM too.
const SYNC_NEEDED_RETRY_MAX = 2;
const SYNC_NEEDED_RETRY_COOLDOWN_MS = 10 * 60 * 1000;

function syncNeededGaveUpText(desk) {
  return desk === "main" ? "Your pick request didn't start — check it" : "Steve's pick request didn't start — check it";
}

// Plain-language, no $ amounts, no technical detail -- same DM-content rules as the group
// posts, applied to a direct friend DM. Sent once per request, only on the final give-up
// (not on every retry), using the same chat id the News Layer already DMs Steve on
// (NEWS_STEVE_CHAT_ID, defined further down in this file).
function syncNeededRequesterDelayText() {
  return "Your pick is delayed — it's being retried, no need to resend the request.";
}

// True if the real build already landed, even if the Supabase "requests" row hasn't been
// round-tripped to "answered" yet (PCS's job, not this one's).
async function syncNeededRequestAlreadyBuilt(desk, docId) {
  const parlaysRes = await supabaseFetch(
    `/docs?desk_id=eq.${encodeURIComponent(desk)}&collection=eq.parlays&select=data`
  );
  const parlays = await parlaysRes.json();
  return parlays.some((p) => p.data?.requestId === docId);
}

// --- Ticket-linkage guard (2026-11-05, Seb's self-healing ask) ---
// A "requests" row with status "answered" and ticketIds is NOT actually done until every
// one of those ticket ids exists as a real doc in Supabase's "parlays" collection -- the
// request mirror and the ticket mirror are two separate writes (confirmed 2026-11-05: a
// builder run posted its answer straight to the requests endpoint, called wake-sync to
// carry the parlays doc down, but never verified that second write actually landed; it
// didn't that time, leaving Steve's app showing an "answered" request with no ticket to
// show). This checks every ticketId on an answered request still exists in Supabase; any
// missing one means the request is NOT done regardless of its status field.
async function syncNeededRequestTicketsLinked(desk, ticketIds) {
  if (!Array.isArray(ticketIds) || ticketIds.length === 0) return true;
  const res = await getDocsBulk(desk, "parlays", ticketIds);
  return ticketIds.every((id) => res.has(id));
}

// Bulk existence check -- one query for every id in `docIds` instead of N round trips.
async function getDocsBulk(deskId, collection, docIds) {
  const idList = docIds.map((id) => encodeURIComponent(id)).join(",");
  const res = await supabaseFetch(
    `/docs?desk_id=eq.${encodeURIComponent(deskId)}&collection=eq.${encodeURIComponent(
      collection
    )}&doc_id=in.(${idList})&select=doc_id`
  );
  const rows = await res.json();
  return new Set(rows.map((r) => r.doc_id));
}

// Decides what to do with ONE stale "requests" doc, applying all three guards against a
// fresh read (never the earlier backlog scan, which can be stale by the time this runs).
// dryRun skips every write (mergeUpsertDoc, Telegram) and just reports the decision.
async function syncNeededRetryRequest(desk, docId, dryRun) {
  const fresh = await getDoc(desk, "requests", docId);
  const d = fresh?.data || {};

  if (d.status === "working") {
    return { desk, docId, action: "skip-already-handled", status: d.status };
  }
  if (d.status === "answered") {
    const linked = await syncNeededRequestTicketsLinked(desk, d.ticketIds).catch(() => true);
    if (linked) return { desk, docId, action: "skip-already-handled", status: d.status };
    // else: answered but the ticket mirror never landed -- fall through to the normal
    // retry guards below (gave-up/cooldown/max-retries), which re-fire the desk's builder.
  }
  if (d.retryGaveUp) {
    return { desk, docId, action: "skip-gave-up" };
  }
  if (await syncNeededRequestAlreadyBuilt(desk, docId)) {
    return { desk, docId, action: "skip-parlay-exists" };
  }

  const retryCount = Number(d.retryCount) || 0;
  const lastRetryAt = d.lastRetryAt ? new Date(d.lastRetryAt).getTime() : 0;
  if (Date.now() - lastRetryAt < SYNC_NEEDED_RETRY_COOLDOWN_MS) {
    return { desk, docId, action: "skip-cooldown", retryCount, lastRetryAt: d.lastRetryAt };
  }
  if (retryCount >= SYNC_NEEDED_RETRY_MAX) {
    if (!dryRun) {
      await mergeUpsertDoc(desk, "requests", docId, { retryGaveUp: true });
      await telegramApi("sendMessage", { chat_id: TELEGRAM_SEB_CHAT_ID, text: syncNeededGaveUpText(desk) }).catch(
        (err) => console.error("sync-needed: give-up DM failed:", err.message)
      );
      // Also tell the requester directly, once, on a desk that has its own chat id (Steve's
      // -- see NEWS_STEVE_CHAT_ID below). MAIN has no separate "requester" to notify (Seb
      // already got the DM above).
      if (desk === "steve") {
        await telegramApi("sendMessage", { chat_id: NEWS_STEVE_CHAT_ID, text: syncNeededRequesterDelayText() }).catch(
          (err) => console.error("sync-needed: requester give-up DM failed:", err.message)
        );
      }
    }
    return { desk, docId, action: dryRun ? "would-give-up" : "gave-up", retryCount };
  }

  if (!dryRun) {
    await mergeUpsertDoc(desk, "requests", docId, { retryCount: retryCount + 1, lastRetryAt: new Date().toISOString() });
  }
  return { desk, docId, action: dryRun ? "would-retry" : "retrying", retryCount: retryCount + 1 };
}

function syncNeededAppEditGaveUpText(desk) {
  return desk === "main"
    ? "An app edit (withdrawal/deposit/bet correction) didn't finish going through -- check it"
    : "An app edit on Steve's desk didn't finish going through -- check it";
}

// Same three-guard shape as syncNeededRetryRequest (re-check fresh, max 2 retries, 10-min
// cooldown, DM-and-stop on giveup), generalized to appEdits/appUploads: re-checks the SAME
// condition that put this doc in the backlog -- still stuck queued/pending past the stale
// window, OR (appEdits only) "applied" but still incomplete per syncNeededAppEditIncomplete
// -- against a fresh read before ever retrying, since the earlier scan can be stale by the
// time this runs. Unlike "requests", there is no desk-specific builder to fire directly here
// -- the blanket fastWake the caller already fires once per call IS the retry action, so this
// is pure bookkeeping (retry count / cooldown / giveup), not a second wake.
async function syncNeededRetryAppEdit(desk, collection, docId, dryRun) {
  const fresh = await getDoc(desk, collection, docId);
  const d = fresh?.data || {};

  if (d.retryGaveUp) return { desk, collection, docId, action: "skip-gave-up" };

  const stillStale = (SYNC_NEEDED_STALE_STATUSES[collection] || []).includes(d.status);
  const stillIncomplete =
    collection === "appEdits" && d.status === "applied" && (await syncNeededAppEditIncomplete(desk, docId, d).catch(() => false));
  if (!stillStale && !stillIncomplete) return { desk, collection, docId, action: "skip-already-handled", status: d.status };

  const retryCount = Number(d.retryCount) || 0;
  const lastRetryAt = d.lastRetryAt ? new Date(d.lastRetryAt).getTime() : 0;
  if (Date.now() - lastRetryAt < SYNC_NEEDED_RETRY_COOLDOWN_MS) {
    return { desk, collection, docId, action: "skip-cooldown", retryCount, lastRetryAt: d.lastRetryAt };
  }
  if (retryCount >= SYNC_NEEDED_RETRY_MAX) {
    if (!dryRun) {
      await mergeUpsertDoc(desk, collection, docId, { retryGaveUp: true });
      await telegramApi("sendMessage", { chat_id: TELEGRAM_SEB_CHAT_ID, text: syncNeededAppEditGaveUpText(desk) }).catch(
        (err) => console.error("sync-needed: appEdit give-up DM failed:", err.message)
      );
    }
    return { desk, collection, docId, action: dryRun ? "would-give-up" : "gave-up", retryCount };
  }

  if (!dryRun) {
    await mergeUpsertDoc(desk, collection, docId, { retryCount: retryCount + 1, lastRetryAt: new Date().toISOString() });
  }
  return { desk, collection, docId, action: dryRun ? "would-retry" : "retrying", retryCount: retryCount + 1 };
}

// --- appEdits completeness guard (2026-11-05, Seb's request) --------------------------
// Found this day: a $400 withdrawal appEdit was claimed and flipped to status "applied" by
// Post-Cutover Sync within about a minute -- the real desk write landed fine -- but the
// Supabase MIRROR copy of the resulting pnlEntries doc was never written. "applied" is PCS's
// own claim; this engine has no live access to the real desk, so it is not proof the mirror
// write actually landed, and every engine-side view (self-heal, balance-guard, Steve-side
// comparisons) stayed blind to the $400 move until this was caught by hand. Deterministic
// edits -- ones with no judgment call, just a fixed conversion from the edit's own fields --
// should never sit unresolved more than ~5 minutes, same bar as a plain stuck queued/pending
// edit.
const SYNC_NEEDED_DETERMINISTIC_EDIT_ACTIONS = new Set([
  "withdrawal", "deposit", "balanceUpdate", "keepOut", "private", "live", "stake", "bonus", "won", "lost", "push",
]);

// Predicts the Supabase pnlEntries doc_id a "pnlEntries/new"-target edit should have produced,
// ported from the conventions actually observed in real data (wd-app-<editId> for a
// withdrawal, adj-<editId minus its "ed-" prefix> for a balanceUpdate; deposit mirrors
// withdrawal's own "dep-app-" shape). Returns null for an action with no "new doc" convention
// to predict (it targets an EXISTING pnlEntries doc instead) -- never guess a shape that
// hasn't actually been observed.
function syncNeededExpectedMirrorDocId(action, editDocId) {
  if (action === "withdrawal") return `wd-app-${editDocId}`;
  if (action === "deposit") return `dep-app-${editDocId}`;
  if (action === "balanceUpdate") return `adj-${editDocId.replace(/^ed-/, "")}`;
  return null;
}

// True when a deterministic appEdit already marked "applied" has NOT actually finished
// landing in the Supabase mirror. For a "pnlEntries/new" edit, predicts the doc id (above) and
// checks it exists. For an edit against an EXISTING pnlEntries doc (won/lost/push/stake/
// bonus/private/live/keepOut -- no new id to predict), falls back to checking that doc's own
// updated_at moved past the edit's createdAt: not a semantic check of WHAT changed, just proof
// SOME write landed on it after the edit was logged, which is the most this engine (no direct
// desk access) can verify without guessing at per-action field shapes.
async function syncNeededAppEditIncomplete(desk, docId, d) {
  if (!SYNC_NEEDED_DETERMINISTIC_EDIT_ACTIONS.has(d.action)) return false;
  const target = String(d.target || "");
  if (target === "pnlEntries/new") {
    const expectedId = syncNeededExpectedMirrorDocId(d.action, docId);
    if (!expectedId) return false; // no known convention for this action -- can't verify, don't guess
    return !(await getDoc(desk, "pnlEntries", expectedId));
  }
  const m = target.match(/^pnlEntries\/(.+)$/);
  if (!m) return false;
  const targetDoc = await getDoc(desk, "pnlEntries", m[1]);
  if (!targetDoc) return true; // the edit's own target doesn't even exist -- definitely incomplete
  const editCreated = new Date(d.createdAt || 0).getTime();
  const targetUpdated = new Date(targetDoc.updated_at || 0).getTime();
  return !(editCreated && targetUpdated >= editCreated);
}

// --- Deterministic mirror backfill (2026-11-05, Seb's request) -----------------------
// An edit this engine already knows is deterministic -- no judgment call, no research, just
// a fixed conversion from the edit's own fields -- never needs a Claude run to finish writing
// the Supabase mirror. When syncNeededAppEditIncomplete finds one PCS marked "applied" but
// never actually mirrored, this constructs and writes the exact same doc shape PCS itself
// would have (ported from the real conventions observed in production data), instead of
// re-waking PCS to redo work it already half-did. Returns {ok:false, reason} -- never
// guesses -- for any action/shape this engine hasn't actually seen and verified; those fall
// through to a DM instead (see syncNeededBackfillIncompleteAppEdit).
async function syncNeededBackfillAppEditMirror(desk, docId, d) {
  const action = d.action;
  const target = String(d.target || "");

  if (target === "pnlEntries/new") {
    const v = d.value || {};
    if (action === "withdrawal" || action === "deposit") {
      const amount = Math.abs(bgN(bgPick(v, "amount", "value")));
      if (!amount) return { ok: false, reason: `no amount on "${action}" edit` };
      const mirrorId = `${action === "withdrawal" ? "wd" : "dep"}-app-${docId}`;
      await upsertDoc(desk, "pnlEntries", mirrorId, {
        type: action,
        date: v.date || String(d.createdAt || "").slice(0, 10),
        desc: v.desc || `${action === "withdrawal" ? "Withdrawal" : "Deposit"} requested in app by Seb`,
        amount,
        source: "app",
        createdAt: d.createdAt || new Date().toISOString(),
      });
      return { ok: true, mirrorId };
    }
    if (action === "balanceUpdate") {
      const setTo = bgN(bgPick(v, "setTo", "balance", "newBalance", "target", "value"));
      if (!setTo) return { ok: false, reason: "no setTo on balanceUpdate edit" };
      // "amount" on an adj- row is the delta from the balance walked BEFORE this row exists
      // (verified against real adj- rows: amount === setTo - the prior computed balance) --
      // compute it the same way, from everything already in the mirror except this new row.
      const before = await computeDeskBalance(desk);
      const amount = Math.round((setTo - before.balance) * 100) / 100;
      const mirrorId = `adj-${docId.replace(/^ed-/, "")}`;
      await upsertDoc(desk, "pnlEntries", mirrorId, {
        type: "adjust",
        date: v.date || String(d.createdAt || "").slice(0, 10),
        desc: v.desc || `Balance update: set to $${setTo.toFixed(2)} to match DraftKings`,
        setTo,
        amount,
        createdAt: d.createdAt || new Date().toISOString(),
      });
      return { ok: true, mirrorId };
    }
    return { ok: false, reason: `no known "pnlEntries/new" convention for action "${action}"` };
  }

  const m = target.match(/^pnlEntries\/(.+)$/);
  if (!m) return { ok: false, reason: `unrecognized target "${target}"` };
  const targetId = m[1];
  const current = await getDoc(desk, "pnlEntries", targetId);
  if (!current) return { ok: false, reason: `target doc ${targetId} doesn't exist in the mirror at all -- can't patch it` };
  const cd = current.data || {};

  // Ticket-level settle actions: same ret math settlePnlRet already uses everywhere else in
  // this engine (grader, self-heal, balance-guard) -- never a separate formula.
  if (action === "won" || action === "lost" || action === "push") {
    const ret = settlePnlRet(action, cd);
    if (ret === undefined) return { ok: false, reason: `settlePnlRet gave no ret for "${action}"` };
    await upsertDoc(desk, "pnlEntries", targetId, { ...cd, status: action, ret, settledAt: cd.settledAt || new Date().toISOString() });
    return { ok: true, mirrorId: targetId };
  }
  // Cashout -- same shape as PCS's own prompt (0b): the dollar figure is always a real,
  // manually-entered amount (data.value on the appEdit), never recomputed/guessed.
  if (action === "cashout") {
    const amount = bgN(d.value);
    if (!amount) return { ok: false, reason: "cashout needs a dollar amount" };
    await upsertDoc(desk, "pnlEntries", targetId, {
      ...cd,
      status: "cashout",
      ret: amount,
      settledAt: cd.settledAt || new Date().toISOString(),
      autoSettled: false,
      needsCashAmount: false,
    });
    return { ok: true, mirrorId: targetId };
  }
  // Simple field-set edits -- the app's own field names match these action names exactly
  // (confirmed against data.js's pick(x,'bonus','bonusBet',...) / pick(x,'matt','isMatt')
  // style field normalization), so the edit's `value` IS the new field value.
  if (["stake", "bonus", "private", "live", "keepOut", "matt"].includes(action)) {
    if (d.value === undefined) return { ok: false, reason: `edit has no value to apply for action "${action}"` };
    await upsertDoc(desk, "pnlEntries", targetId, { ...cd, [action]: d.value });
    return { ok: true, mirrorId: targetId };
  }
  return { ok: false, reason: `no known field-patch convention for action "${action}"` };
}

function syncNeededMirrorBackfillFailedText(desk) {
  return desk === "main"
    ? "An app edit finished on the app but the engine couldn't mirror it automatically — check it"
    : "An app edit on Steve's desk finished on the app but the engine couldn't mirror it automatically — check it";
}

// Handles ONE "applied but incomplete" appEdit: re-verifies against a fresh read (the earlier
// scan can be stale), attempts the deterministic backfill above, and DMs Seb -- once, never
// every tick -- only when that backfill itself can't be done. Never re-wakes PCS: that would
// just repeat whatever already-partial write happened the first time.
async function syncNeededBackfillIncompleteAppEdit(desk, docId, dryRun) {
  const fresh = await getDoc(desk, "appEdits", docId);
  const d = fresh?.data || {};
  if (d.status !== "applied") return { desk, docId, action: "skip-not-applied" };
  if (d.mirrorBackfillDmSent) return { desk, docId, action: "skip-already-dmed" };
  const stillIncomplete = await syncNeededAppEditIncomplete(desk, docId, d).catch(() => false);
  if (!stillIncomplete) return { desk, docId, action: "skip-already-complete" };

  if (dryRun) return { desk, docId, action: "would-backfill" };

  const result = await syncNeededBackfillAppEditMirror(desk, docId, d).catch((err) => ({ ok: false, reason: err.message }));
  if (result.ok) {
    await upsertDoc(desk, "selfHealLog", `sn-backfill-${Date.now()}`, {
      source: "sync-needed-backfill",
      docId,
      mirrorId: result.mirrorId,
      action: d.action,
      at: new Date().toISOString(),
    });
    return { desk, docId, action: "backfilled", mirrorId: result.mirrorId };
  }

  await mergeUpsertDoc(desk, "appEdits", docId, { mirrorBackfillDmSent: true });
  await telegramApi("sendMessage", { chat_id: TELEGRAM_SEB_CHAT_ID, text: syncNeededMirrorBackfillFailedText(desk) }).catch(
    (err) => console.error("sync-needed: mirror-backfill-failed DM failed:", err.message)
  );
  return { desk, docId, action: "backfill-failed-dmed", reason: result.reason };
}

// --- Retire-the-sync, Phase 1-2 (2026-11-06, Seb's request) --------------------------
// Post-Cutover Sync (a Claude routine) stays ON as the backup/safety net -- nothing here
// pauses or edits it. These two phases are an ADDITIVE fast path that tries to beat PCS to
// the same work, purely in code, with zero Claude usage and sub-10-minute latency instead
// of PCS's own cadence. Both are gated by ONE flag, checked live (no redeploy) every tick:
//   desk "main", collection "systemFlags", doc_id "retireSync", {enabled: true|false}
// Missing doc or enabled !== true => OFF => both phases no-op entirely and PCS does
// everything exactly as before. Flip it with (the engine's existing generic doc-write
// route, same PROXY_TOKEN auth as every other call):
//   curl -X POST "https://sports-proxy-nv9n.onrender.com/api/main/docs/systemFlags/retireSync?token=<PROXY_TOKEN>" \
//     -H "Content-Type: application/json" -d "{\"enabled\": false}"
// (swap false->true to turn it back on). Takes effect on the very next sync-needed tick
// (every 10 minutes), nothing to redeploy, nothing to restart.
async function retireSyncEnabled() {
  const doc = await getDoc("main", "systemFlags", "retireSync").catch(() => null);
  return doc?.data?.enabled === true;
}

// PHASE 1 -- appEdits applied directly to the Supabase mirror, bypassing PCS's own Phase 0b
// entirely for this fixed, judgment-free action set (ported straight from PCS's own prompt,
// same field-level formulas -- see syncNeededBackfillAppEditMirror above, which this reuses
// unchanged). Any appEdit whose action is OUTSIDE this set (e.g. "delete", "wonProtected",
// reopening to "pending") is left completely untouched -- never claimed, never looked at --
// so PCS remains the only writer for anything this fast path doesn't explicitly know.
const PHASE1_APPEDIT_ACTIONS = new Set([
  "withdrawal", "deposit", "balanceUpdate", "won", "lost", "push",
  "stake", "cashout", "keepOut", "private", "live", "bonus", "matt",
]);

// One desk's pass. dryRun never claims anything (claiming itself mutates state) -- it just
// reports what WOULD be claimed and applied, same convention as every other dryRun path in
// this file.
async function applyAppEditsDirectly(desk, dryRun) {
  const res = await supabaseFetch(`/docs?desk_id=eq.${encodeURIComponent(desk)}&collection=eq.appEdits&select=doc_id,data`);
  const rows = await res.json();
  const out = [];

  for (const row of rows) {
    const d = row.data || {};
    if (d.status !== "pending") continue;
    if (!PHASE1_APPEDIT_ACTIONS.has(d.action)) continue;

    if (dryRun) {
      out.push({ desk, docId: row.doc_id, action: "would-apply", editAction: d.action });
      continue;
    }

    // Atomic claim -- the EXACT same claim_doc_status RPC PCS's own Phase 0b uses, so this
    // and a PCS run can never both apply the same appEdit: whichever claims "pending" ->
    // "processing" first wins, the other sees claimed:false and skips the row entirely.
    const claimRes = await supabaseFetch(`/rpc/claim_doc_status`, {
      method: "POST",
      body: JSON.stringify({ p_desk_id: desk, p_collection: "appEdits", p_doc_id: row.doc_id, p_expected: "pending", p_next: "processing" }),
    });
    if ((await claimRes.json()) !== true) {
      out.push({ desk, docId: row.doc_id, action: "skip-already-claimed" });
      continue;
    }

    try {
      const fresh = await getDoc(desk, "appEdits", row.doc_id);
      const fd = fresh?.data || {};

      // Idempotency guard (Seb's explicit ask): if the deterministic mirror doc this action
      // would CREATE already exists -- PCS beat us to it on a prior tick, or an earlier
      // Phase 1 attempt got this far before a crash -- never re-apply, just confirm and mark
      // applied. Actions that PATCH an existing doc (won/lost/push/stake/cashout/etc.) are
      // naturally idempotent re-applies of the same deterministic write, so no separate
      // check is needed there.
      let result;
      const alreadyExpectedId = String(fd.target || "") === "pnlEntries/new" ? syncNeededExpectedMirrorDocId(fd.action, row.doc_id) : null;
      if (alreadyExpectedId && (await getDoc(desk, "pnlEntries", alreadyExpectedId))) {
        result = { ok: true, mirrorId: alreadyExpectedId, alreadyExisted: true };
      } else {
        result = await syncNeededBackfillAppEditMirror(desk, row.doc_id, fd);
      }

      if (!result.ok) {
        // Shouldn't happen for anything in PHASE1_APPEDIT_ACTIONS -- revert the claim so PCS
        // (which handles a far wider action set with real judgment) can still pick this row
        // up, instead of leaving it stuck at "processing" for 20 minutes.
        await upsertDoc(desk, "appEdits", row.doc_id, { ...fd, status: "pending" });
        out.push({ desk, docId: row.doc_id, action: "reverted-to-pcs", reason: result.reason });
        continue;
      }

      // Mark applied only after read-back confirms the mirror write actually landed.
      const confirmed = await getDoc(desk, "pnlEntries", result.mirrorId);
      if (!confirmed) {
        await upsertDoc(desk, "appEdits", row.doc_id, { ...fd, status: "pending" });
        out.push({ desk, docId: row.doc_id, action: "reverted-readback-failed", mirrorId: result.mirrorId });
        continue;
      }

      await upsertDoc(desk, "appEdits", row.doc_id, {
        ...fd,
        status: "applied",
        appliedBy: "engine-phase1",
        appliedAt: new Date().toISOString(),
      });
      out.push({ desk, docId: row.doc_id, action: result.alreadyExisted ? "already-applied" : "applied", mirrorId: result.mirrorId });
    } catch (err) {
      await mergeUpsertDoc(desk, "appEdits", row.doc_id, { status: "pending" }).catch(() => {});
      out.push({ desk, docId: row.doc_id, action: "error", error: err.message });
    }
  }
  return out;
}

// PHASE 2 -- appUploads: wake a dedicated Sonnet "Slip Reader v2" routine the moment either
// desk has a pending upload, instead of waiting for PCS's own inline Phase 0c. Same Fire-URL
// + cooldown + trailing-fire shape as triggerSyncWake/triggerBuilderFire above -- the routine
// itself claims each appUpload via the SAME /claim endpoint PCS already uses, so the two can
// never double-process the same upload no matter which one wakes first.
const SLIP_READER_V2_FIRE_URL = process.env.SLIP_READER_V2_FIRE_URL;
const SLIP_READER_V2_FIRE_TOKEN = process.env.SLIP_READER_V2_FIRE_TOKEN;
const SLIP_READER_V2_COOLDOWN_MS = 90_000;
let lastSlipReaderV2FireAt = 0;
let trailingSlipReaderV2Timer = null;

async function sendSlipReaderV2Fire() {
  lastSlipReaderV2FireAt = Date.now();
  const fireRes = await fetch(SLIP_READER_V2_FIRE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLIP_READER_V2_FIRE_TOKEN}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "experimental-cc-routine-2026-04-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  if (!fireRes.ok) {
    const body = await fireRes.text();
    throw new Error(`Slip reader v2 fire -> HTTP ${fireRes.status}: ${body}`);
  }
}

async function triggerSlipReaderV2Fire() {
  if (!SLIP_READER_V2_FIRE_URL || !SLIP_READER_V2_FIRE_TOKEN) {
    return { ok: false, reason: "SLIP_READER_V2_FIRE_URL/SLIP_READER_V2_FIRE_TOKEN not configured" };
  }
  const sinceLast = Date.now() - lastSlipReaderV2FireAt;
  if (sinceLast >= SLIP_READER_V2_COOLDOWN_MS) {
    await sendSlipReaderV2Fire();
    return { ok: true, fired: true };
  }
  if (trailingSlipReaderV2Timer) {
    return { ok: true, fired: false, reason: "cooldown", trailingAlreadyScheduled: true };
  }
  const delay = SLIP_READER_V2_COOLDOWN_MS - sinceLast;
  trailingSlipReaderV2Timer = setTimeout(async () => {
    trailingSlipReaderV2Timer = null;
    try {
      await sendSlipReaderV2Fire();
    } catch (err) {
      console.error("Trailing slip reader v2 fire failed:", err.message);
    }
  }, delay);
  return { ok: true, fired: false, reason: "cooldown", trailingScheduledInMs: delay };
}

async function wakeSlipReaderV2IfPending(desks, dryRun) {
  for (const desk of desks) {
    const res = await supabaseFetch(`/docs?desk_id=eq.${encodeURIComponent(desk)}&collection=eq.appUploads&select=doc_id,data`);
    const rows = await res.json();
    if (rows.some((r) => r.data?.status === "pending")) {
      return dryRun ? { ok: true, wouldFire: true } : await triggerSlipReaderV2Fire().catch((err) => ({ ok: false, error: err.message }));
    }
  }
  return { ok: true, fired: false, reason: "nothing-pending" };
}

async function syncNeededCheckDesk(desk) {
  const now = Date.now();
  const backlog = [];
  const stuck = [];
  for (const collection of SYNC_NEEDED_COLLECTIONS) {
    const listRes = await supabaseFetch(
      `/docs?desk_id=eq.${encodeURIComponent(desk)}&collection=eq.${collection}&select=doc_id,data,updated_at`
    );
    const docs = await listRes.json();
    const staleStatuses = SYNC_NEEDED_STALE_STATUSES[collection] || ["queued", "pending"];
    for (const doc of docs) {
      const d = doc.data || {};
      const ref = d.createdAt || doc.updated_at;
      const isStale = ref && now - new Date(ref).getTime() > SYNC_NEEDED_PENDING_STALE_MS;
      if (staleStatuses.includes(d.status)) {
        if (isStale) backlog.push({ desk, collection, docId: doc.doc_id });
      } else if (collection === "requests" && d.status === "answered" && isStale) {
        // TICKET-LINKAGE GUARD -- see syncNeededRequestTicketsLinked's own comment above.
        // "answered" alone doesn't mean done: the ticket write to Supabase is a separate
        // step from the request-answer write and can silently fail to land.
        const linked = await syncNeededRequestTicketsLinked(desk, d.ticketIds).catch(() => true);
        if (!linked) backlog.push({ desk, collection, docId: doc.doc_id, missingTicket: true });
      } else if (collection === "appEdits" && d.status === "applied" && isStale) {
        // COMPLETENESS GUARD -- see syncNeededAppEditIncomplete's own comment above.
        const incomplete = await syncNeededAppEditIncomplete(desk, doc.doc_id, d).catch(() => false);
        if (incomplete) backlog.push({ desk, collection, docId: doc.doc_id, incomplete: true });
      }
      if (d.status === "processing" && d.claimedAt) {
        if (now - new Date(d.claimedAt).getTime() > SYNC_NEEDED_STUCK_CLAIM_MS) {
          stuck.push({ desk, collection, docId: doc.doc_id });
        }
      }
    }
  }
  return { desk, backlog, stuck };
}

app.get("/internal/jobs/sync-needed", async (req, res) => {
  const dryRun = req.query.dryRun === "true";
  try {
    // Retire-the-sync Phase 1-2 -- OFF unless the "retireSync" flag doc says enabled:true
    // (see that function's own comment for exactly how to flip it). Runs BEFORE the
    // staleness-based backlog check below, against EVERY pending row, not just stale
    // ones -- that's the whole point: beat PCS to it on this same 10-minute tick instead
    // of waiting for a row to go stale first.
    let phase1 = null;
    const phase1On = await retireSyncEnabled().catch(() => false);
    if (phase1On) {
      const [mainEdits, steveEdits, uploadWake] = await Promise.all([
        applyAppEditsDirectly("main", dryRun),
        applyAppEditsDirectly("steve", dryRun),
        wakeSlipReaderV2IfPending(["main", "steve"], dryRun),
      ]);
      phase1 = { appEdits: { main: mainEdits, steve: steveEdits }, slipReaderV2Wake: uploadWake };
    }

    const results = await Promise.all(["main", "steve"].map(syncNeededCheckDesk));
    const allBacklog = results.flatMap((r) => r.backlog);
    const allStuck = results.flatMap((r) => r.stuck);

    if (allBacklog.length === 0 && allStuck.length === 0) {
      return res.json({ ok: true, action: "none", dryRun, phase1 });
    }

    const actions = {};
    // An "incomplete" entry (appEdits marked "applied" whose mirror write never landed) needs
    // a direct deterministic backfill, NOT another PCS wake -- re-waking PCS just repeats
    // whatever already-partial write happened the first time. Keep it entirely out of the
    // generic backlog handling below (fastWake / per-doc retry-wake bookkeeping), which stays
    // for the genuinely-stuck-before-PCS-ever-claimed-it case.
    const incompleteAppEdits = allBacklog.filter((b) => b.incomplete === true);
    const otherBacklog = allBacklog.filter((b) => b.incomplete !== true);

    if (incompleteAppEdits.length > 0) {
      actions.mirrorBackfills = [];
      for (const b of incompleteAppEdits) {
        actions.mirrorBackfills.push(
          await syncNeededBackfillIncompleteAppEdit(b.desk, b.docId, dryRun).catch((err) => ({
            desk: b.desk,
            docId: b.docId,
            action: "error",
            error: err.message,
          }))
        );
      }
    }

    if (otherBacklog.length > 0) {
      if (!dryRun) {
        actions.fastWake = await triggerSyncWake().catch((err) => ({ ok: false, error: err.message }));
      } else {
        actions.fastWake = { ok: true, wouldFire: true };
      }

      // A stale "requests" row means a specific desk's pick request is stuck -- run it
      // through the three retry guards (already-built check, max 2 retries, 10-min
      // cooldown) and only fire that desk's builder directly if at least one request on
      // that desk actually clears them.
      const requestBacklogByDesk = {};
      for (const b of otherBacklog) {
        if (b.collection !== "requests") continue;
        (requestBacklogByDesk[b.desk] = requestBacklogByDesk[b.desk] || []).push(b.docId);
      }
      if (Object.keys(requestBacklogByDesk).length > 0) {
        actions.requestRetries = {};
        for (const [desk, docIds] of Object.entries(requestBacklogByDesk)) {
          const perDoc = [];
          for (const docId of docIds) {
            perDoc.push(
              await syncNeededRetryRequest(desk, docId, dryRun).catch((err) => ({
                desk,
                docId,
                action: "error",
                error: err.message,
              }))
            );
          }
          const eligibleAction = dryRun ? "would-retry" : "retrying";
          const eligible = perDoc.some((r) => r.action === eligibleAction);
          const entry = { perDoc, fired: false };
          if (eligible) {
            entry.fired = !dryRun;
            entry.fire = dryRun
              ? { ok: true, wouldFire: true }
              : await triggerBuilderFire(desk, "SYNC_NEEDED_WAKE").catch((err) => ({ ok: false, error: err.message }));
          }
          actions.requestRetries[desk] = entry;
        }
      }

      // appEdits/appUploads backlog -- no desk-specific builder to fire (the blanket
      // fastWake above is the retry action itself), just the per-doc retry-count/cooldown/
      // giveup bookkeeping.
      const appEditBacklog = otherBacklog.filter((b) => b.collection === "appEdits" || b.collection === "appUploads");
      if (appEditBacklog.length > 0) {
        actions.appEditRetries = [];
        for (const b of appEditBacklog) {
          actions.appEditRetries.push(
            await syncNeededRetryAppEdit(b.desk, b.collection, b.docId, dryRun).catch((err) => ({
              desk: b.desk,
              collection: b.collection,
              docId: b.docId,
              action: "error",
              error: err.message,
            }))
          );
        }
      }
    }
    if (allStuck.length > 0) {
      actions.fullWake = dryRun
        ? { ok: true, wouldFire: true }
        : await triggerFullSyncWake().catch((err) => ({ ok: false, error: err.message }));
    }

    if (dryRun) {
      return res.json({ ok: true, action: "would-handle", dryRun, phase1, backlog: allBacklog, stuck: allStuck, actions });
    }

    await upsertDoc("main", "selfHealLog", `sn-${Date.now()}`, {
      source: "sync-needed",
      foundAt: new Date().toISOString(),
      phase1,
      backlog: allBacklog,
      stuck: allStuck,
      actions,
    });

    res.json({ ok: true, action: "handled", phase1, backlog: allBacklog, stuck: allStuck, actions });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Diagnostic for the retire-the-sync Phase 1-2 kill switch -- reports current on/off state
// and whether the Phase 2 Fire URL/token are configured, without flipping anything.
app.get("/internal/jobs/retire-sync-status", async (req, res) => {
  try {
    const enabled = await retireSyncEnabled();
    res.json({
      ok: true,
      enabled,
      slipReaderV2FireConfigured: !!(SLIP_READER_V2_FIRE_URL && SLIP_READER_V2_FIRE_TOKEN),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Stuck-bet resolver gate (2026-11-02, Seb's request) ---
// The resolver itself is a separate claude.ai routine (trig_01XucFaBvmZ4GpdqnTEELUVt,
// "Parlay Desk Stuck Bet Resolver (engine-gated)", model Sonnet, already built and enabled,
// cron_expression empty -- it only ever runs when fired via its API, never on a schedule).
// This endpoint is that trigger: it's the "engine" half -- it finds bets whose games are long
// over but are still sitting pending/needs_review (the self-heal shadow-grader diff can't fix
// these on its own because they need real research: play-by-play order for First-TD legs, or
// slip-upload text the regex grader never learned to parse -- see the self-heal watchdog's own
// comment for why), and fires the Sonnet routine with exactly the list to work on. The routine
// does the actual re-grading (ArtifactData + WebFetch against ESPN) and writes both the real
// desk and the Supabase mirror itself -- this endpoint never touches pnlEntries directly.
//
// GATING RULE (Seb's ask): a bet qualifies once it's at least 1 hour past (lastStart + 4h) --
// i.e. 5 hours after its last leg's kickoff, giving every sport's own box score/play-by-play
// time to go final. Falls back to firstStart, then to a real ESPN kickoff lookup (matching the
// teams named in the bet's own text against that date's scoreboard), then to createdAt+6h, when
// lastStart is missing (the FTD-singles path never set it -- see Phase 0c fix on the Post-Cutover
// Sync routine) -- documented here so a future "why did this one take longer to fire" question
// has an answer. The old end-of-day-on-`date` guess is kept only as a last-last-resort for the
// pathological case where createdAt is also missing.
const STUCK_BET_GATE_HOURS = 5;
const STUCK_BET_WAKE_COOLDOWN_MS = 60 * 60 * 1000; // at most one fire per hour, same shape as self-heal
const STUCK_RESOLVER_FIRE_URL = process.env.STUCK_RESOLVER_FIRE_URL;
const STUCK_RESOLVER_FIRE_TOKEN = process.env.STUCK_RESOLVER_FIRE_TOKEN;

// Pulls the two team names out of a bet's own text, e.g. "...(CHI @ SEA)" -> {away:"CHI", home:"SEA"}.
// Every bet doc on this desk carries the matchup in that exact "(A @ B)" shape in desc and/or leg text.
// SEPARATOR (fixed 2026-11-05): only matched "@" -- every soccer slip-upload leg writes its
// matchup as "(A vs B)", not "(A @ B)", so this returned null for any soccer bet, pushing the
// stuck-bet gate's kickoff estimate to the much-later createdAt+6h fallback instead of the
// real kickoff time. Same separator set as grader.js's own SEP pattern.
function extractMatchupFromBetText(data) {
  const texts = [data.desc, ...((Array.isArray(data.legs) ? data.legs : []).map((l) => l.text))].filter(Boolean);
  for (const t of texts) {
    const m = t.match(/\(([A-Za-z.' ]+?)\s+(?:vs\.?|v\.?|@|at)\s+([A-Za-z.' ]+?)\)/i);
    if (m) return { away: m[1].trim(), home: m[2].trim() };
  }
  return null;
}

// One scoreboard fetch per `date` even when several stuck bets share it (e.g. a whole slate).
const gamesForDateCache = new Map();
function gamesForDateCached(date) {
  if (!gamesForDateCache.has(date)) gamesForDateCache.set(date, fetchGamesForDate(date).catch(() => []));
  return gamesForDateCache.get(date);
}

async function espnKickoffForBet(data) {
  if (!data.date) return null;
  const matchup = extractMatchupFromBetText(data);
  if (!matchup) return null;
  const games = await gamesForDateCached(data.date);
  const game = findGame(games, matchup.away, matchup.home, data.date) || findGame(games, matchup.home, matchup.away, data.date);
  if (!game || !game.date) return null;
  const t = new Date(game.date);
  return Number.isNaN(t.getTime()) ? null : t;
}

async function effectiveLastStart(data) {
  if (data.lastStart) return new Date(data.lastStart);
  if (data.firstStart) return new Date(data.firstStart);
  const espnKickoff = await espnKickoffForBet(data);
  if (espnKickoff) return espnKickoff;
  if (data.createdAt) return new Date(new Date(data.createdAt).getTime() + 6 * 60 * 60 * 1000);
  if (data.date) return new Date(`${data.date}T23:59:00Z`);
  return null;
}

async function findStuckBets(desk) {
  const listRes = await supabaseFetch(`/docs?desk_id=eq.${encodeURIComponent(desk)}&collection=eq.pnlEntries&select=doc_id,data`);
  const docs = await listRes.json();
  const cutoffMs = STUCK_BET_GATE_HOURS * 60 * 60 * 1000;
  const now = Date.now();
  const stuck = [];
  for (const doc of docs) {
    const d = doc.data || {};
    if (d.type !== "bet") continue; // balance adjustments/withdrawals also live in pnlEntries, never bets to grade
    if (d.protected === true) continue;
    if (!["pending", "needs_review"].includes(d.status)) continue; // "cashout"/"won"/"lost"/"push" are all terminal-or-locked
    if (!Array.isArray(d.legs) || d.legs.length === 0) continue; // malformed doc, not a real gradeable bet
    const start = await effectiveLastStart(d);
    if (!start || Number.isNaN(start.getTime())) continue; // no kickoff info at all -- never guess, skip
    if (now - start.getTime() < cutoffMs) continue; // not yet 5h past kickoff
    stuck.push({ desk, docId: doc.doc_id, desc: d.desc || d.ticketId || doc.doc_id });
  }
  return stuck;
}

async function fireStuckResolver(items) {
  if (!STUCK_RESOLVER_FIRE_URL || !STUCK_RESOLVER_FIRE_TOKEN) {
    throw new Error("STUCK_RESOLVER_FIRE_URL/STUCK_RESOLVER_FIRE_TOKEN not configured on the server.");
  }
  const lines = items.map((it) => `- ${it.desk}/${it.docId}: ${it.desc}`).join("\n");
  const text = `STUCK_BET_GATE_WAKE -- resolve exactly these ${items.length} doc(s), none other:\n${lines}`;
  const fireRes = await fetch(STUCK_RESOLVER_FIRE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STUCK_RESOLVER_FIRE_TOKEN}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "experimental-cc-routine-2026-04-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
  if (!fireRes.ok) {
    const body = await fireRes.text();
    throw new Error(`Stuck-bet resolver fire -> HTTP ${fireRes.status}: ${body}`);
  }
}

app.get("/internal/jobs/stuck-bet-gate", async (req, res) => {
  const desks = req.query.desk ? [req.query.desk] : ["main", "steve"];
  for (const d of desks) if (!["main", "steve"].includes(d)) return res.status(404).json({ error: `unknown desk: ${d}` });
  const dryRun = req.query.dryRun === "true";
  try {
    const found = [];
    for (const desk of desks) found.push(...(await findStuckBets(desk)));

    if (found.length === 0) return res.json({ ok: true, action: "none", stuck: [] });

    if (dryRun) return res.json({ ok: true, action: "would-fire", stuck: found });

    const state = await getDoc("main", "stuckResolverState", "_global");
    const sinceLastWake = Date.now() - (state?.data?.lastWakeAt ? new Date(state.data.lastWakeAt).getTime() : 0);
    if (sinceLastWake < STUCK_BET_WAKE_COOLDOWN_MS) {
      return res.json({ ok: true, action: "suppressed-cooldown", stuck: found });
    }

    await fireStuckResolver(found);
    await upsertDoc("main", "stuckResolverState", "_global", { lastWakeAt: new Date().toISOString(), lastFired: found });
    res.json({ ok: true, action: "fired", stuck: found });
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
      } else if ((action === "balok" || action === "balno") && desk && requestId) {
        // Balance-change approval gate (2026-11-05, Seb's request): no automated process may
        // write an adj-/balance pnlEntries doc without this. requestId here is the appEdits
        // doc_id that proposed the change -- Post-Cutover Sync's own prompt checks this same
        // "balanceApprovals" collection before it ever writes the adj- entry.
        await upsertDoc(desk, "balanceApprovals", requestId, {
          approval: action === "balok" ? "approved" : "rejected",
          decidedAt: new Date().toISOString(),
          decidedBy: "seb-telegram",
        });
        await telegramApi("answerCallbackQuery", { callback_query_id: cq.id, text: action === "balok" ? "Approved" : "Rejected" });
        await telegramApi("editMessageText", {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: `${cq.message.text}\n\n${action === "balok" ? "✅ Approved" : "❌ Rejected"}`,
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
  ["basketball", "mens-college-basketball"],
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
          // Carried through (2026-11-06, CLV capture) so a matched leg's team can be
          // resolved to home/away without a second fetch -- nothing read this field before,
          // so this is purely additive.
          homeAway: c.homeAway || null,
          // Half scores (NCAAB 1H/2H grading only, 2026-11-02) -- ESPN's scoreboard
          // competitor already carries these as {value, displayValue, period}, period 1 =
          // first half, period 2 = second half (an OT period, if any, is period 3+ and
          // never part of a half bet's settlement). Carried for every sport/league here
          // since it's free on this same response, but only CBB's scoreLeg below ever
          // reads it.
          linescores: c.linescores || null,
        }));
        if (competitors.length === 2) {
          games.push({ sport, league, id: ev.id, date: ev.date, competitors, state: ev.status?.type?.state });
        }
      }
    } catch (err) {
      // skip this league/date combo, keep going
    }
  }
  return games;
}

// NCAAB 1H/2H grading only (2026-11-02). Returns the competitor's score for that half, or
// null if the leg asked for a half on anything other than basketball/mens-college-basketball
// (half-line bets aren't supported for any other sport yet -- refusing to grade is the safe
// default, never silently reinterpreting a quarter/period as a "half") or if ESPN didn't
// carry a linescore for that period (OT-only edge cases, data gaps).
function halfAwareScore(comp, period, game) {
  if (!period || period === "full") return comp.score;
  if (game.sport !== "basketball" || game.league !== "mens-college-basketball") return null;
  const periodNum = period === "1H" ? 1 : 2;
  const row = (comp.linescores || []).find((l) => l.period === periodNum);
  return row ? Number(row.value) : null;
}

function scoreLeg(parsed, game) {
  const comps = game.competitors;
  const isSoccer = game.sport === "soccer";
  if (parsed.category === "ml") {
    const mine = comps.find((c) => teamMatches(parsed.team, c));
    const other = comps.find((c) => c !== mine);
    if (!mine || !other) return null;
    const mineScore = halfAwareScore(mine, parsed.period, game);
    const otherScore = halfAwareScore(other, parsed.period, game);
    if (mineScore == null || otherScore == null) return null;
    if (mineScore === otherScore) return isSoccer ? "miss" : "push";
    return mineScore > otherScore ? "hit" : "miss";
  }
  if (parsed.category === "spread") {
    const mine = comps.find((c) => teamMatches(parsed.team, c));
    const other = comps.find((c) => c !== mine);
    if (!mine || !other) return null;
    const mineScore = halfAwareScore(mine, parsed.period, game);
    const otherScore = halfAwareScore(other, parsed.period, game);
    if (mineScore == null || otherScore == null) return null;
    const margin = mineScore - otherScore + parsed.line;
    if (margin === 0) return "push";
    return margin > 0 ? "hit" : "miss";
  }
  if (parsed.category === "total") {
    const score0 = halfAwareScore(comps[0], parsed.period, game);
    const score1 = halfAwareScore(comps[1], parsed.period, game);
    if (score0 == null || score1 == null) return null;
    const combined = score0 + score1;
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

// First-TD-scorer grading (2026-11-05, Seb's ask): ESPN's own summary response carries a
// dedicated, already-chronological `scoringPlays` array (separate from boxscore.players) --
// no full play-by-play parsing needed. Verified against a real finished NFL game 2026-11-05:
// entries carry {scoringType.name, team.abbreviation, text, period.number, clock.value}, and
// the scorer's name is always the first thing in `text`, immediately before "{N} Yd " for
// both rushing ("D'Andre Swift 5 Yd Rush...") and passing ("Luther Burden III 1 Yd pass
// from...") touchdowns -- the receiver/rusher, never the passer, which is exactly who a
// first-TD-scorer bet is about.
const scoringPlaysCache = new Map(); // "sport/league/id" -> normalized scoring plays, same lifetime as boxScoreCache
async function fetchScoringPlays(game) {
  const key = `${game.sport}/${game.league}/${game.id}`;
  if (scoringPlaysCache.has(key)) return scoringPlaysCache.get(key);
  const data = await getJson(`${ESPN_BASE}/${game.sport}/${game.league}/summary?event=${game.id}`);
  const raw = data.scoringPlays || [];
  const plays = raw
    .map((p) => ({
      type: p.scoringType?.name || null, // "touchdown" | "field-goal" | "safety" | ...
      teamAbbr: p.team?.abbreviation || null,
      text: p.text || "",
      period: p.period?.number ?? 0,
      clock: p.clock?.value ?? 0, // counts DOWN within a period -- higher value = earlier
    }))
    // Explicit chronological sort rather than trusting ESPN's own array order: period
    // ascending, then clock value descending (more time remaining = happened first).
    .sort((a, b) => a.period - b.period || b.clock - a.clock);
  scoringPlaysCache.set(key, plays);
  return plays;
}

// Extracts the scorer's name from a scoring play's own text -- "{Name} {N} Yd Rush (...)" /
// "{Name} {N} Yd pass from {Passer} (...)" both put the actual scorer first. Falls back to a
// "... by {Name}" trailing shape (blocked-kick/fumble-recovery touchdowns sometimes render
// this way) before giving up -- returns null rather than guessing when neither matches.
function extractTdScorerName(playText) {
  const m1 = playText.match(/^([^\d]+?)\s+\d+\s*Yd\b/i);
  if (m1) return m1[1].trim();
  const m2 = playText.match(/\bby\s+([A-Za-z.'\- ]+?)\s*(?:\(|$)/i);
  if (m2) return m2[1].trim();
  return null;
}

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
  // Last-name fallback (2026-11-05, Seb's ask after a real slip-upload ATD leg carried the
  // wrong first name -- "Brady Tkachuk" entered for a game Ottawa wasn't even in, when the
  // real goalscorer bet, win or lose, was about Florida's own Tkachuk/Verhaeghe). Deliberately
  // NOT a global last-name search: `categories` here is already scoped to ONE team of the ONE
  // game gradeOneLeg resolved from the leg's own text, so two same-surname players can only
  // collide within that single team's roster -- never across unrelated games. If that still
  // happens, return no match (needs_review) rather than guess which one.
  const targetLast = target.split(" ").pop();
  if (targetLast && targetLast.length > 2) {
    let found = null;
    for (const cat of categories) {
      if (labelFilter && !labelFilter(cat)) continue;
      for (const ath of cat.athletes || []) {
        const full = normalizePlayerName(ath.athlete?.displayName);
        if (full.split(" ").pop() === targetLast) {
          if (found) return null; // same-surname collision within this one team -- no guess
          found = { cat, ath };
        }
      }
    }
    if (found) return found;
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

// NHL "Anytime TD"/"Anytime Goalscorer" legs are stored under the same "anytimeTd" category
// as NFL's (the slip-upload text borrows football's "TD" wording for a hockey goal) --
// settled the same way, just off the "G" column instead of a rush/rec TD count. Added
// 2026-11-05 after finding these sat needs_review forever: gradeOneLeg used to hard-refuse
// anytimeTd grading for any sport but football.
async function nhlAnytimeGoal(game, playerName) {
  const n = await nhlStatValue(game, playerName, "goals");
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
async function resolveGameForProp(parsed, games, statKey, ticketDate) {
  if (parsed.rawA || parsed.rawB) {
    const game = findGame(games, parsed.rawA || "", parsed.rawB || "", ticketDate);
    if (game) return { game };
  }
  // anytimeTd with no team context in the leg text: scan both sports it could plausibly be
  // (football TD or hockey goal) -- resolveGameForProp's own ambiguous-match guard below
  // already returns no game (never a guess) if the same-named player turns up in more than
  // one of today's candidate games, so widening this is safe.
  const candidates = STAT_SPORT_CANDIDATES[statKey] || (statKey === "anytimeTd" ? [["football", "nfl"], ["hockey", "nhl"]] : []);
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

  if (parsed.category === "ftd") {
    if (parsed.scoped && !parsed.team) {
      return { status: "needs_review", reason: "team-scoped first-TD leg but no team could be determined" };
    }
    const teamQuery = parsed.team || parsed.rawA || "";
    const oppQuery = parsed.team ? "" : parsed.rawB || "";
    // Restrict the search to NFL games before matching -- FTD is an NFL-only market
    // (ftd-model-only), and a bare team abbreviation with no opponent (the Desk's own queue
    // format never includes one) real-world collides across sports on the same date (e.g.
    // "CHI" matches the NFL Bears, NBA Bulls AND NHL Blackhawks all on 2026-11-02) and would
    // otherwise come back falsely ambiguous. Found 2026-11-05 dry-running real archived FTD
    // picks: 8 of 28 failed this way before the restriction.
    const nflGames = games.filter((g) => g.sport === "football" && g.league === "nfl");
    const game = findGame(nflGames, teamQuery, oppQuery, ticketDate);
    if (!game) {
      if (stillAwaitingResult(leg.text, games, ticketDate)) return { status: "pending", reason: "no confident game match yet, but game not final" };
      return { status: "needs_review", reason: "no confident NFL game match for this player's team" };
    }
    if (game.state !== "post") return { status: "pending", reason: "game not final yet" };

    const scoring = await fetchScoringPlays(game);
    const allTds = scoring.filter((p) => p.type === "touchdown");
    // A standard sportsbook "no touchdown scored" settlement is a push/refund, never a loss --
    // this covers both the game-wide market (nobody scored at all) and the team-scoped one
    // (that specific team never found the end zone, even if the other team did).
    const relevant = parsed.scoped ? allTds.filter((p) => p.teamAbbr === parsed.team) : allTds;
    if (relevant.length === 0) return { status: "push" };

    const scorerName = extractTdScorerName(relevant[0].text);
    if (!scorerName) return { status: "needs_review", reason: "couldn't parse the scorer's name from the scoring play text" };
    const target = normalizePlayerName(parsed.player);
    const scored = normalizePlayerName(scorerName);
    const lastMatch = target.split(" ").pop() === scored.split(" ").pop() && target.split(" ").pop().length > 2;
    return { status: scored === target || lastMatch ? "hit" : "miss" };
  }

  if (parsed.category === "stat" || parsed.category === "anytimeTd") {
    const statKey = parsed.category === "anytimeTd" ? "anytimeTd" : parsed.statKey;
    const resolved = await resolveGameForProp(parsed, games, statKey, ticketDate);
    if (resolved.pending) return { status: "pending", reason: "game not final yet" };
    const game = resolved.game;
    if (!game) {
      if (stillAwaitingResult(leg.text, games, ticketDate)) return { status: "pending", reason: "no confident game match yet, but game not final" };
      return { status: "needs_review", reason: "no confident game match for this player" };
    }
    if (game.state !== "post") return { status: "pending", reason: "game not final yet" };

    if (parsed.category === "anytimeTd") {
      if (game.sport !== "football" && game.sport !== "hockey") {
        return { status: "needs_review", reason: "anytime-scorer grading only supports NFL/NHL for now" };
      }
      const scored = game.sport === "hockey" ? await nhlAnytimeGoal(game, parsed.player) : await nflAnytimeTd(game, parsed.player);
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
  const game = findGame(games, teamQuery || "", oppQuery || "", ticketDate);
  if (!game) {
    if (stillAwaitingResult(leg.text, games, ticketDate)) return { status: "pending", reason: "no confident game match yet, but game not final" };
    return { status: "needs_review", reason: "no confident game match" };
  }
  if (game.state !== "post") return { status: "pending", reason: "game not final yet" };

  const verdict = scoreLeg(parsed, game);
  if (!verdict) return { status: "needs_review", reason: "matched game but could not score it" };
  return { status: verdict };
}

// American-odds payout, stake included -- same math the Desk's own slip math uses for a
// plain (non-boosted-by-DK) bet. "boost" is a parlay-boost percentage applied to the profit
// portion only (never the stake itself), matching how the Desk's own boost field is used
// everywhere else (r09, ticket notes). Added 2026-10-30 after a settled bet was found with
// ret left null even though it had cleared -- every settle must write a real number now.
function toWinAmount(stake, odds, boost) {
  const s = Number(stake) || 0;
  const o = parseFloat(String(odds ?? "").replace(/[^0-9.+-]/g, ""));
  if (!s || !Number.isFinite(o) || o === 0) return 0;
  let profit = o > 0 ? s * (o / 100) : s * (100 / Math.abs(o));
  const b = Number(boost) || 0;
  if (b) profit *= 1 + b / 100;
  return Math.round((s + profit) * 100) / 100;
}

// The real settle payout for a pnlEntries doc, given its ticket-level status just computed.
// Prefers `potential` (the slip's own read-off payout -- ground truth for an uploaded slip,
// where DraftKings' own boost/promo math can't be replicated by toWinAmount) over computing
// it, and only falls back to toWinAmount when no potential is on file. Never returns null/
// undefined for a terminal status -- that's the whole point of this function existing.
// "cashout" is deliberately NOT handled here: it's never a computed status (rollUpTicketStatus
// only ever returns needs_review/pending/lost/won) and its ret is a real, manually-entered
// dollar amount (what Seb actually got paid for cashing out early) -- never derivable from
// stake/odds/potential, so it must never be auto-corrected or backfilled by formula.
function settlePnlRet(status, data) {
  if (status === "lost") return 0;
  if (status === "push") return Number(data.stake) || 0;
  if (status === "won") {
    const potential = Number(data.potential);
    if (Number.isFinite(potential) && potential > 0) return potential;
    return toWinAmount(data.stake, data.odds, data.boost);
  }
  return undefined; // not a terminal status -- caller must not write ret from this
}

// Leg-status vocabulary is normally "hit"/"miss"/"push"/"pending"/"needs_review", but a
// manual correction (an app edit, or Claude fixing a bet by hand) sometimes writes the
// ticket-level words "lost"/"won" onto a LEG instead -- treat those as synonyms for
// "miss"/"hit" respectively, rather than as unrecognized, so a manual fix can't itself
// get silently re-flipped by the vacuous-won bug below (found 2026-11-03: a hand-reverted
// FTD leg written as status:"lost" wasn't recognized as a miss, fell through to the old
// unconditional "every leg is hit or push" default, and the next live grader tick flipped
// the ticket back to "won" and sent a wrong WON alert).
const LEG_LOSS_STATUSES = new Set(["miss", "lost"]);
const LEG_WIN_STATUSES = new Set(["hit", "won", "push"]);

function rollUpTicketStatus(legs) {
  // An empty/missing legs array is a malformed-doc signal (e.g. a double-wrapped
  // Supabase row where the real legs sit one level deeper) -- NOT "every leg resolved."
  // Falling through to "won" here was a vacuous-truth bug: it silently marked
  // corrupted docs as won. Caller should treat this as "don't touch the status."
  if (legs.length === 0) return "needs_review";
  // A confirmed miss dooms the parlay outright -- check it BEFORE needs_review/pending,
  // since one leg still being ambiguous or not-yet-final never changes the fact that
  // another leg has already lost it. Checking needs_review/pending first (the old order)
  // left real losers stuck "needs_review" forever instead of resolving to "lost" the
  // moment any leg missed -- found 2026-10-30 comparing shadow-grader output to real
  // production results.
  if (legs.some((l) => LEG_LOSS_STATUSES.has(l.status))) return "lost";
  if (legs.some((l) => l.status === "needs_review")) return "needs_review";
  if (legs.some((l) => l.status === "pending")) return "pending";
  // Every leg must be AFFIRMATIVELY recognized as a win/push to call the ticket won --
  // never a vacuous default. An unrecognized leg status (a typo, a future new status this
  // function hasn't learned yet, anything that isn't one of the sets above) falls to
  // needs_review instead of silently becoming "won" -- this is the actual fix for the
  // 2026-11-03 incident, not just the "lost" synonym above.
  if (legs.every((l) => LEG_WIN_STATUSES.has(l.status))) return "won";
  return "needs_review";
}

// A "lost" ticket is safe to keep re-grading (to fill in remaining pending legs as their
// games finish) exactly when a real confirmed-miss leg is what's backing that status --
// rollUpTicketStatus's unconditional first check means such a ticket can never be rolled
// back to won/needs_review/pending no matter what the other legs resolve to. A "lost"
// with no such leg (e.g. a bare manual correction) has nothing proving it's safe, so it
// stays fully locked by the terminal-lock checks that call this.
function isEarlyLossBacked(data) {
  return Array.isArray(data.legs) && data.legs.some((l) => LEG_LOSS_STATUSES.has(l.status));
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
      // TERMINAL LOCK (2026-11-03, Seb's ask, after a manually-reverted FTD bet got flipped
      // back by the next grader tick): once a ticket is already won/push/cashout --
      // whether by this engine, the stuck-bet resolver, or a manual app edit -- the engine
      // never re-grades it again, period. The only way back in is a manual "pending" app
      // edit (Post-Cutover Sync Phase 0b's "pending" action), which clears the status and
      // makes it eligible again on its own, no special-case needed here. Same guard as
      // gradeCollectionForDesk below (see its comment) -- a protected/cashout bet's legs can
      // still be "pending", so without this, re-grading them for real and rolling up a fresh
      // status overwrites a real manual lock/cash-out/settlement the moment the game goes
      // final. This route had no such guard at all until 2026-11-02 (protected/cashout only;
      // won/lost/push added 2026-11-03).
      //
      // EARLY-LOSS EXCEPTION (2026-11-05, Seb's ask): "lost" is excluded from the lock above
      // ONLY when that status is actually backed by a confirmed-miss leg (isEarlyLossBacked
      // below) -- rollUpTicketStatus's very first check is "any miss -> lost", unconditional,
      // so a ticket in that state can never be rolled back to won/needs_review/pending by
      // continuing to grade it; the remaining pending legs just get filled in as their games
      // finish, which is the whole point (full leg-level stats without waiting on every game
      // in the parlay). A "lost" with NO confirmed-miss leg (a bare manual correction, nothing
      // for rollUpTicketStatus to re-derive) stays fully locked, same as before.
      if (data.protected === true || data.status === "cashout" || data.status === "won" || data.status === "push") continue;
      if (data.status === "lost" && !isEarlyLossBacked(data)) continue;
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
      // PAPER-TRADE TAG (2026-11-05) -- same as gradeCollectionForDesk below; this route
      // shares the same collections (parlays/ftd) and needs the same explicit tag.
      const paperPatch = collection === "pnlEntries" ? {} : { paper: data.played !== true };
      if (!changed && newTicketStatus === data.status && (collection === "pnlEntries" || data.paper === paperPatch.paper)) continue;

      const newData = { ...data, legs: newLegs, status: newTicketStatus, ...paperPatch };
      await upsertDoc(desk, collection, doc.doc_id, newData);
      results.push({ ticketId: doc.doc_id, newStatus: newTicketStatus, legStatuses: newLegs.map((l) => l.status) });
    }
    res.json({ ok: true, collection, ticketsChecked: docs.length, ticketsUpdated: results.length, results });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- CLV (closing-line value) capture (2026-11-06, Seb's request, item 1 of the learning-
// data batch) --- Engine code only, no Claude run. For every GRADED leg (hit/miss/push) on a
// Claude-built "parlays" ticket (main + steve, bet or paper), writes one row to the dedicated
// `clv_legs` table (never onto the parlays doc itself -- v2, Seb's ask, so Post-Cutover
// Sync's cross-desk mirror sync can never wipe this and the real ticket docs stay untouched)
// recording the closing number against the price/line already on the leg at build time and a
// signed `clv` (positive = beat the close). Reuses extractCbbClosingLine's free ESPN-
// pickcenter proxy (no paid historical-odds call, same reasoning as the 2026-11-02 CBB/CFB
// closing-line work) -- works for any sport ESPN carries pickcenter for, not just basketball
// despite the function's name (see its own comment). ml/spread/total only: props, FTD,
// anytime-scorer and single-stat legs have no free closing-price source, same as half-line
// (1H/2H) legs (pickcenter's line is full-game only) and a leg whose game can't be re-matched
// -- all three still get a row (clv null, clv_type explaining why) so the capture job never
// retries the same dead end on every run. Never touches the parlays doc's status/price/text/
// anything the grader or Post-Cutover Sync owns, and never touches pnlEntries at all.
function teamIsHome(teamQuery, competitors) {
  const home = competitors.find((c) => c.homeAway === "home");
  const away = competitors.find((c) => c.homeAway === "away");
  if (home && teamMatches(teamQuery, home)) return true;
  if (away && teamMatches(teamQuery, away)) return false;
  return null; // couldn't confirm either side -- never guess
}

async function computeLegClv(leg, game) {
  const parsed = parseLeg(leg.text, leg.type);
  if (!["ml", "spread", "total"].includes(parsed.category)) {
    return { betType: "unsupported", clvType: "unsupported" };
  }
  if (parsed.period && parsed.period !== "full") {
    return { betType: parsed.category, clvType: "unsupported" }; // pickcenter's line is full-game only
  }

  const { closing } = await fetchClosingLineInfo(game); // cached per game id -- see fetchClosingLineInfo
  if (!closing.provider) return { betType: parsed.category, clvType: "no-closing-data" };

  if (parsed.category === "total") {
    if (closing.total == null || parsed.line == null) return { betType: "total", clvType: "no-closing-data" };
    const clv = parsed.direction === "over" ? closing.total - parsed.line : parsed.line - closing.total;
    return { betType: "total", closingLine: closing.total, clv: Number(clv.toFixed(1)), clvType: "points" };
  }

  const isHome = teamIsHome(parsed.team, game.competitors);
  if (isHome == null) return { betType: parsed.category, clvType: "no-match" };

  if (parsed.category === "ml") {
    const closingPrice = isHome ? closing.homeMoneyline : closing.awayMoneyline;
    if (closingPrice == null || leg.price == null) return { betType: "ml", clvType: "no-closing-data" };
    const buildImplied = americanToImplied(leg.price);
    const closeImplied = americanToImplied(closingPrice);
    if (buildImplied == null || closeImplied == null) return { betType: "ml", clvType: "no-closing-data" };
    return {
      betType: "ml",
      closingPrice,
      clv: Number(((closeImplied - buildImplied) * 100).toFixed(2)),
      clvType: "implied % pts",
    };
  }

  // spread -- homeSpread is already home-signed (see extractCbbClosingLine's own comment);
  // flip it to be signed for parsed.team the same way parsed.line already is.
  if (closing.homeSpread == null || parsed.line == null) return { betType: "spread", clvType: "no-closing-data" };
  const closingSideLine = isHome ? closing.homeSpread : -closing.homeSpread;
  return {
    betType: "spread",
    closingLine: Number(closingSideLine.toFixed(1)),
    clv: Number((parsed.line - closingSideLine).toFixed(1)),
    clvType: "points",
  };
}

// Builds the same {sport,league,id,competitors,state} game shape gradeOneLeg's matching
// already uses, scanning the ticket's own date +/-1 day -- CLV only ever runs on legs the
// grader already resolved to a terminal status, so the same matching window is always enough.
// `dateCache` is a plain object the caller owns for the lifetime of one clv-capture run, so the
// same date's scoreboard slate is fetched once total across every leg/ticket that needs it
// (not once per leg) -- the actual odds/pickcenter fetch is deduped separately, per game id,
// by fetchClosingLineInfo's own module-level cache.
async function findGameForLeg(leg, ticketDate, dateCache) {
  const base = ticketDate ? new Date(ticketDate + "T12:00:00Z") : new Date();
  const dates = [-1, 0, 1].map((delta) => {
    const dd = new Date(base);
    dd.setUTCDate(dd.getUTCDate() + delta);
    return dd.toISOString().slice(0, 10);
  });
  const gameLists = await Promise.all(
    dates.map(async (d) => {
      if (!dateCache.has(d)) dateCache.set(d, await fetchGamesForDate(d));
      return dateCache.get(d);
    })
  );
  const games = gameLists.flat();
  // Mirrors gradeOneLeg's own non-ftd/non-stat team/opponent derivation exactly (server.js,
  // the plain ml/spread/total fallthrough at the end of gradeOneLeg) so CLV matches against
  // the SAME game the grader already matched.
  const parsed = parseLeg(leg.text, leg.type);
  if (parsed.category === "total") {
    return findGame(games, parsed.rawA || "", parsed.rawB || "", ticketDate);
  }
  const teamQuery = parsed.team || parsed.rawA;
  const oppQuery = parsed.opponent || parsed.rawB;
  return findGame(games, teamQuery || "", oppQuery || "", ticketDate);
}

// PostgREST caps an unpaged response at its project default (1000 on this project) -- found
// 2026-11-06 testing against real data: past 1000 clv_legs rows, this silently returned only
// the first page, so every leg past row 1000 looked "not yet captured" and got reprocessed
// (harmlessly, since the insert below is itself idempotent -- but wastefully, forever,
// growing every run) on every single tick. Paginates with Range until a page comes back
// smaller than PAGE_SIZE.
async function fetchCapturedClvKeys() {
  const PAGE_SIZE = 1000;
  const keys = new Set();
  let offset = 0;
  while (true) {
    const res = await supabaseFetch(`/clv_legs?select=desk_id,ticket_id,leg_index`, {
      headers: { Range: `${offset}-${offset + PAGE_SIZE - 1}` },
    });
    const rows = await res.json();
    for (const r of rows) keys.add(`${r.desk_id}:${r.ticket_id}:${r.leg_index}`);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return keys;
}

// leg.price is free text written by the builder, not always a clean number -- seen in real
// data: "", "-450 (est.)", etc. clv_legs.build_price is a numeric column, so this strips
// anything that isn't part of the number (same extraction americanToImplied already does)
// and returns null rather than ever sending Postgres a string it can't cast.
function toNumericPrice(price) {
  if (price == null) return null;
  const n = parseFloat(String(price).replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function insertClvRows(rows) {
  if (!rows.length) return;
  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    await supabaseFetch(`/clv_legs?on_conflict=desk_id,ticket_id,leg_index`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows.slice(i, i + BATCH)),
    });
  }
}

app.get("/internal/jobs/clv-capture", async (req, res) => {
  try {
    const dryRun = req.query.dryRun === "true";
    const already = await fetchCapturedClvKeys();
    const dateCache = new Map();
    const newRows = [];
    const perDesk = {};

    for (const desk of ["main", "steve"]) {
      perDesk[desk] = { ticketsScanned: 0, legsCaptured: 0 };
      const listRes = await supabaseFetch(
        `/docs?desk_id=eq.${desk}&collection=eq.parlays&select=doc_id,data`
      );
      const docs = await listRes.json();
      for (const doc of docs) {
        const data = doc.data || {};
        const src = (data.source || "").toLowerCase();
        if (!src.startsWith("claude")) continue; // Claude-built picks only
        const legs = Array.isArray(data.legs) ? data.legs : [];
        if (!legs.length) continue;
        perDesk[desk].ticketsScanned++;
        const sport = (data.league || "UNKNOWN").toUpperCase();
        const paper = data.played !== true;

        for (let i = 0; i < legs.length; i++) {
          const leg = legs[i];
          if (!["hit", "miss", "push"].includes(leg.status)) continue;
          if (already.has(`${desk}:${doc.doc_id}:${i}`)) continue;

          const safeCategory = () => {
            try {
              return parseLeg(leg.text, leg.type).category;
            } catch {
              return null;
            }
          };
          let clvInfo;
          try {
            const game = await findGameForLeg(leg, data.date, dateCache);
            clvInfo = game ? await computeLegClv(leg, game) : { betType: safeCategory(), clvType: "no-match" };
          } catch (err) {
            clvInfo = { betType: safeCategory(), clvType: "no-match" }; // don't half-process -- mark it processed, move on
          }

          newRows.push({
            desk_id: desk,
            ticket_id: doc.doc_id,
            leg_index: i,
            sport,
            bet_type: clvInfo.betType || null,
            paper,
            build_price: toNumericPrice(leg.price),
            closing_price: clvInfo.closingPrice ?? null,
            closing_line: clvInfo.closingLine ?? null,
            clv: clvInfo.clv ?? null,
            clv_type: clvInfo.clvType,
          });
          perDesk[desk].legsCaptured++;
        }
      }
    }

    if (!dryRun) await insertClvRows(newRows);
    res.json({ ok: true, dryRun, perDesk, legsCaptured: newRows.length, sample: newRows.slice(0, 20) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// CLV%-by-sport-and-bet-type rollup for the Monday recap routine to WebFetch (no Claude-run
// cost on this engine's side) -- see handbooks/phase2-log.md for why this is a stat endpoint
// rather than Seb editing the recap routine's prompt in-place. "beatClosePct" = share of
// clv-tagged legs with clv > 0 (push-the-number-around ties, clv === 0, count as neither).
// Reads straight from clv_legs -- real-money/paper split comes along for free via its own
// `paper` column, ready for a future "bet vs paper CLV" cut if Seb wants one later.
app.get("/internal/jobs/clv-summary", async (req, res) => {
  try {
    const days = req.query.days ? Number(req.query.days) : 7; // Monday recap's own window
    const dateFloor = new Date(etDateDaysAgo(days) + "T00:00:00Z").toISOString();
    const listRes = await supabaseFetch(
      `/clv_legs?select=sport,bet_type,clv,captured_at&captured_at=gte.${dateFloor}&clv=not.is.null`
    );
    const rows = await listRes.json();
    const buckets = {}; // "SPORT:TYPE" -> { legs, beat, clvSum }
    for (const r of rows) {
      const key = `${r.sport}:${r.bet_type}`;
      buckets[key] = buckets[key] || { legs: 0, beat: 0, clvSum: 0 };
      buckets[key].legs++;
      if (r.clv > 0) buckets[key].beat++;
      buckets[key].clvSum += Number(r.clv);
    }
    const out = {};
    for (const [key, b] of Object.entries(buckets)) {
      out[key] = {
        legs: b.legs,
        beatClosePct: Number(((b.beat / b.legs) * 100).toFixed(1)),
        avgClv: Number((b.clvSum / b.legs).toFixed(2)),
      };
    }
    res.json({ ok: true, days, buckets: out });
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

// --- League auto-tag for new bets (2026-11-04, Seb's ask) -----------------------------
// Only 16/152 of main's bets had a league field before the one-time backfill -- new bets
// keep arriving without one. This ports the SAME inference used for that backfill (linked
// request -> team/player names via live ESPN rosters -> leg wording) into the engine so
// every new pnlEntries doc gets tagged going forward, code-only, zero Claude runs. Piggy-
// backs on gradeCollectionForDesk's existing per-tick pass over pnlEntries rather than a
// new cron job. NEVER touches league/legLeagues once a doc already has one (even "MULTI"
// with legLeagues:null) -- a human or this backfill already decided it, so auto-tagging
// only fills in a true blank.
//
// NOTE -- Supabase-only (same residual risk as the grader's own writes): this cannot also
// write ArtifactData (that store is only reachable through Claude's own ArtifactData tool,
// never from this Node service), so it leans on the same "safe by construction" argument
// as the engine-only grader -- our write bumps the mirror's updated_at to now, so Post-
// Cutover Sync's Phase 1 push-up (desk-newer-than-mirror) skips it on its own UNLESS that
// same bet is edited again in the app/by a routine before this job's next tick, which
// would push the still-blank desk copy back over our tag. Low-probability (bets settle
// and then go quiet), but real -- flagging it rather than claiming zero drift risk.
const LEAGUE_TAG_NFL_TEAMS = ["49ers","bears","bengals","bills","broncos","browns","buccaneers","cardinals","chargers","chiefs","colts","cowboys","dolphins","eagles","falcons","giants","jaguars","jets","lions","packers","panthers","patriots","raiders","rams","ravens","saints","seahawks","steelers","texans","titans","vikings","commanders"];
const LEAGUE_TAG_NBA_TEAMS = ["hawks","celtics","nets","hornets","bulls","cavaliers","mavericks","nuggets","pistons","warriors","rockets","pacers","clippers","lakers","grizzlies","heat","bucks","timberwolves","pelicans","knicks","thunder","magic","76ers","sixers","suns","blazers","trail blazers","kings","spurs","raptors","jazz","wizards"];
const LEAGUE_TAG_NHL_TEAMS = ["bruins","sabres","red wings","panthers","canadiens","senators","lightning","maple leafs","hurricanes","blue jackets","devils","islanders","rangers","flyers","penguins","capitals","blackhawks","avalanche","stars","wild","predators","blues","jets","coyotes","ducks","flames","kings","oilers","sharks","kraken","canucks","golden knights"];
const LEAGUE_TAG_MLB_TEAMS = ["diamondbacks","braves","orioles","red sox","cubs","white sox","reds","guardians","rockies","tigers","astros","royals","angels","dodgers","marlins","brewers","twins","mets","yankees","athletics","phillies","pirates","padres","giants","mariners","cardinals","rays","rangers","blue jays","nationals"];
const LEAGUE_TAG_CFB_HINTS = ["alabama","georgia","ohio state","michigan","oklahoma","texas","clemson","lsu","oregon","notre dame","penn state","florida state","usc","ucla","auburn","tennessee","wisconsin","iowa","nebraska","miami hurricanes","college football"];
const LEAGUE_TAG_CBB_HINTS = ["duke","kansas","kentucky","gonzaga","unc","north carolina tar heels","villanova","march madness","ncaab","college basketball"];
const LEAGUE_TAG_SOCCER_HINTS = ["premier league","la liga","serie a","bundesliga","ligue 1","mls","champions league","uefa","epl","manchester","liverpool","arsenal","chelsea","real madrid","barcelona","juventus","psg","inter milan","ac milan","goalscorer","clean sheet","both teams to score"];
const LEAGUE_TAG_WORDING_HINTS = [
  { re: /\bpuck line\b|\bgoalie\b|\bsog\b|\bshots on goal\b/i, league: "NHL" },
  { re: /\bgoalscorer\b|\bclean sheet\b|\bboth teams to score\b|\banytime goalscorer\b/i, league: "SOCCER" },
  { re: /\banytime td\b|\bfirst td\b|\brushing yards\b|\breceiving yards\b|\bpassing yards\b|\bqb\b/i, league: "NFL" },
  { re: /\b3-pointer\b|\bpoints \+ rebounds\b|\brebounds \+ assists\b|\bpra\b/i, league: "NBA" },
];

function leagueTagEscapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function leagueTagMatchTeamList(text, list) {
  return list.some((t) => new RegExp(`\\b${leagueTagEscapeRe(t)}\\b`).test(text));
}

// Player-name index (NFL/NBA/NHL, via ESPN rosters -- ~94 team fetches) is expensive, so it
// is cached in-memory and rebuilt at most once every 12 hours. Deliberately excludes a bare-
// last-name fallback: the real backfill run hit a false positive ("Blake Snell", MLB) from
// an unrelated NHL player whose LAST name happened to be "Blake" -- full names only.
let leagueTagPlayerIndexCache = { builtAt: 0, byFullName: new Map() };
async function getLeagueTagPlayerIndex() {
  if (Date.now() - leagueTagPlayerIndexCache.builtAt < 12 * 60 * 60 * 1000) return leagueTagPlayerIndexCache.byFullName;
  const byFullName = new Map();
  const leagues = [
    { key: "NFL", sport: "football", league: "nfl" },
    { key: "NBA", sport: "basketball", league: "nba" },
    { key: "NHL", sport: "hockey", league: "nhl" },
  ];
  try {
    for (const cfg of leagues) {
      const teamsJson = await getJson(`${ESPN_BASE}/${cfg.sport}/${cfg.league}/teams`);
      const teamIds = teamsJson.sports[0].leagues[0].teams.map((t) => t.team.id);
      const CHUNK = 8;
      for (let i = 0; i < teamIds.length; i += CHUNK) {
        const batch = teamIds.slice(i, i + CHUNK);
        const results = await Promise.all(
          batch.map((id) => getJson(`${ESPN_BASE}/${cfg.sport}/${cfg.league}/teams/${id}/roster`).catch(() => null))
        );
        for (const r of results) {
          for (const group of r?.athletes || []) {
            const flat = Array.isArray(group.items) ? group.items : [group];
            for (const a of flat) {
              if (a.fullName) byFullName.set(normTeamName(a.fullName), cfg.key);
            }
          }
        }
      }
    }
  } catch (err) {
    // Network hiccup mid-build -- keep whatever was already collected this pass rather than
    // caching an empty index; next call (12h later, or sooner if this stays empty) retries.
  }
  if (byFullName.size > 0) leagueTagPlayerIndexCache = { builtAt: Date.now(), byFullName };
  return byFullName.size > 0 ? byFullName : leagueTagPlayerIndexCache.byFullName;
}

function leagueTagNormalizeRequestLeague(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toUpperCase();
  if (["NFL", "NBA", "NHL", "CFB", "CBB", "MLB", "SOCCER", "MULTI"].includes(s)) return s;
  if (/premier|la liga|serie a|bundesliga|ligue 1|mls|champions league|soccer/i.test(raw)) return "SOCCER";
  if (/college football|cfb|ncaaf/i.test(raw)) return "CFB";
  if (/college basketball|ncaab|cbb/i.test(raw)) return "CBB";
  if (/multi/i.test(raw)) return "MULTI";
  return s || null;
}

// One fetch of the desk's "requests" collection per grading pass (not per doc) -- mirrors
// the backfill's own linked-ticket lookup.
async function getLeagueTagRequestIndex(desk) {
  const byTicketId = new Map();
  try {
    const r = await supabaseFetch(`/docs?desk_id=eq.${encodeURIComponent(desk)}&collection=eq.requests&select=data`);
    const rows = await r.json();
    for (const row of rows) {
      const d = row.data?.data || row.data || {};
      const league = leagueTagNormalizeRequestLeague(d.league);
      if (!league) continue;
      const legLeagues =
        league === "MULTI" && Array.isArray(d.legs) && d.legs.every((l) => typeof l === "string")
          ? [...new Set(d.legs.map((l) => leagueTagNormalizeRequestLeague(l) || l.toUpperCase()))]
          : null;
      const ids = new Set([d.ticketId, ...(Array.isArray(d.ticketIds) ? d.ticketIds : [])].filter(Boolean));
      for (const id of ids) byTicketId.set(id, { league, legLeagues });
    }
  } catch (err) {
    // requests fetch failed -- inference still works via team/player/wording below.
  }
  return byTicketId;
}

function leagueTagIsBlank(l) {
  if (l === undefined || l === null) return true;
  const s = String(l).trim().toLowerCase();
  return s === "" || s === "unknown" || s === "n/a" || s === "none";
}

function inferLeagueForBet(data, requestIndex, playerIndex) {
  const reqMatch = data.ticketId ? requestIndex.get(data.ticketId) : null;
  if (reqMatch) return { league: reqMatch.league, legLeagues: reqMatch.legLeagues, confidence: reqMatch.league === "MULTI" && !reqMatch.legLeagues ? "low" : "high" };

  const text = normTeamName([(data.legs || []).map((l) => l.text).join(" | "), data.desc || ""].join(" "));
  const hits = [];
  if (leagueTagMatchTeamList(text, LEAGUE_TAG_NFL_TEAMS)) hits.push("NFL");
  if (leagueTagMatchTeamList(text, LEAGUE_TAG_NBA_TEAMS)) hits.push("NBA");
  if (leagueTagMatchTeamList(text, LEAGUE_TAG_NHL_TEAMS)) hits.push("NHL");
  if (leagueTagMatchTeamList(text, LEAGUE_TAG_MLB_TEAMS)) hits.push("MLB");
  if (leagueTagMatchTeamList(text, LEAGUE_TAG_CFB_HINTS)) hits.push("CFB");
  if (leagueTagMatchTeamList(text, LEAGUE_TAG_CBB_HINTS)) hits.push("CBB");
  if (leagueTagMatchTeamList(text, LEAGUE_TAG_SOCCER_HINTS)) hits.push("SOCCER");
  for (const w of LEAGUE_TAG_WORDING_HINTS) if (w.re.test(text) && !hits.includes(w.league)) hits.push(w.league);
  for (const [fullName, league] of playerIndex) {
    if (text.includes(fullName) && !hits.includes(league)) hits.push(league);
  }

  if (hits.length === 1) return { league: hits[0], legLeagues: null, confidence: "high" };
  if (hits.length > 1) return { league: "MULTI", legLeagues: [...new Set(hits)], confidence: "low" };
  return null; // undecided -- leave blank, same as the backfill
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
  // News cache for this call only (2026-11-04, Seb's ask -- newsFlag/newsTiming on a lost
  // leg): one read per distinct league across every doc graded this pass, never per-leg.
  const newsCacheByLeague = {};
  async function getCachedNewsForLeague(leagueRaw) {
    const key = (leagueRaw || "").toLowerCase();
    if (!NEWS_LEAGUES[key]) return null;
    if (!(key in newsCacheByLeague)) newsCacheByLeague[key] = await getNewsDocForLeague(key);
    return newsCacheByLeague[key];
  }
  // League auto-tag (2026-11-04, Seb's ask) -- built once per call, not per doc.
  const leagueTagRequestIndex = collection === "pnlEntries" ? await getLeagueTagRequestIndex(desk) : null;
  const leagueTagPlayerIndex = collection === "pnlEntries" ? await getLeagueTagPlayerIndex() : null;
  for (const doc of docs) {
    const data = doc.data;
    // League auto-tag: fills a genuinely blank league on any bet doc, independent of its
    // grading status -- a settled/protected/cashout bet still needs tagging, it just skips
    // every grading step below. Never touches a doc that already has a league (MULTI with
    // legLeagues:null included) -- that's a prior decision, not this pass's to make.
    if (collection === "pnlEntries" && data.type === "bet" && leagueTagIsBlank(data.league)) {
      const inferred = inferLeagueForBet(data, leagueTagRequestIndex, leagueTagPlayerIndex);
      if (inferred) {
        await upsertDoc(desk, collection, doc.doc_id, { ...data, league: inferred.league, legLeagues: inferred.legLeagues, leagueSource: "auto", leagueConfidence: inferred.confidence });
        data.league = inferred.league;
        data.legLeagues = inferred.legLeagues;
      }
    } else if (collection === "pnlEntries" && data.type === "bet" && typeof data.league === "string") {
      // Case normalization (2026-11-04, Seb's ask): the app sometimes writes a title-case
      // league (e.g. "Soccer") instead of the engine's uppercase convention. Uppercase an
      // existing value in place -- this never changes WHICH league is recorded, only its
      // casing, so it's safe even though the doc already "has" a league.
      const upperLeague = data.league.toUpperCase();
      const upperLegLeagues = Array.isArray(data.legLeagues) ? data.legLeagues.map((l) => (typeof l === "string" ? l.toUpperCase() : l)) : data.legLeagues;
      if (upperLeague !== data.league || JSON.stringify(upperLegLeagues) !== JSON.stringify(data.legLeagues)) {
        await upsertDoc(desk, collection, doc.doc_id, { ...data, league: upperLeague, legLeagues: upperLegLeagues });
        data.league = upperLeague;
        data.legLeagues = upperLegLeagues;
      }
    }
    // A protected (Early Exit / manually-locked) bet is permanent per Post-Cutover Sync's
    // own LOCK rule -- the engine must never re-grade it, in shadow OR live mode. Found
    // 2026-10-30: the shadow grader would have flipped a real protected win back to a
    // computed "lost" (and, in live mode, would have sent a wrong Telegram alert for it)
    // because this check didn't exist.
    if (data.protected === true) continue;
    // "cashout" is a terminal, manually-entered status with a real ret that is NEVER
    // derivable from the legs (see settlePnlRet's own comment) -- but its legs are
    // routinely still "pending"/"needs_review" (you cash out BEFORE the game naturally
    // finishes), so without this guard the pendingIdx loop below re-grades them for real,
    // rollUpTicketStatus computes a fresh (often WRONG, since it ignores the cash-out)
    // status, and that overwrites the real cashout the instant the games go final. Found
    // 2026-11-02: this engine-grader-cron (?mode=live, every 20 minutes) silently flipped a
    // real $135.07 cashout to "lost"/ret:0 in Supabase this way. Restored by hand; this
    // guard is the actual fix.
    if (data.status === "cashout") continue;
    // TERMINAL LOCK (2026-11-03, Seb's ask): once a ticket is already won/push -- by
    // this engine, the stuck-bet resolver, or a manual app edit -- never re-grade it again.
    // Before this, a ticket's CURRENT status being won/lost/push didn't exempt it: the
    // pendingIdx/rollUpTicketStatus pass below still ran every tick (intentionally, to catch
    // a stale ticket-level status behind already-graded legs), which is exactly how an
    // already-correct "lost" got silently flipped back to "won" by the vacuous-won bug in
    // rollUpTicketStatus on 2026-11-03. The only way back in is a manual "pending" app edit
    // (Post-Cutover Sync Phase 0b), which clears `status` and makes the doc eligible again
    // with no special-case needed here.
    //
    // EARLY-LOSS EXCEPTION (2026-11-05, Seb's ask): a "lost" ticket backed by a real
    // confirmed-miss leg (isEarlyLossBacked) is excluded from this lock on purpose -- see
    // the matching comment on the /internal/jobs/grader route above for why this can never
    // regress the status, only fill in the remaining legs' hit/miss/push as their games
    // finish.
    if (data.status === "won" || data.status === "push") continue;
    if (data.status === "lost" && !isEarlyLossBacked(data)) continue;
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
        // newsFlag/newsTiming (2026-11-04, Seb's ask): only on a leg that just became
        // LOST, and only when it matches a real Out/Doubtful injury or transaction news
        // item for its player/team -- split by whether that news predates the bet
        // (newsTiming "before_bet", a real foreseeable-miss case) or came in after the
        // bet was already placed ("after_bet", not foreseeable). Never touches a won/push
        // leg; never invents a match.
        if (graded.status === "lost") {
          const news = await getCachedNewsForLeague(data.league).catch(() => null);
          if (news) {
            let matchedDate = null;
            for (const inj of news.injuries || []) {
              if (!["out", "doubtful"].includes((inj.status || "").toLowerCase())) continue;
              if (matchLegToInjury(l.text, inj)) { matchedDate = inj.date; break; }
            }
            if (!matchedDate) {
              for (const txn of news.transactions || []) {
                if (matchLegToTransaction(l.text, txn)) { matchedDate = txn.date; break; }
              }
            }
            if (matchedDate) {
              const newsMs = new Date(matchedDate).getTime();
              const betMs = new Date(data.createdAt).getTime();
              const timing = Number.isFinite(newsMs) && Number.isFinite(betMs) && newsMs < betMs ? "before_bet" : "after_bet";
              newLegs[i] = { ...newLegs[i], newsFlag: true, newsTiming: timing };
            }
          }
        }
      }
    }
    const newTicketStatus = rollUpTicketStatus(newLegs);
    const prevStatus = data.status;

    // RET/PAYOUT (2026-10-30, Seb's request): on a pnlEntries doc settling to a terminal
    // status, always write a real ret -- never leave it null/missing, which is what was
    // silently breaking the app's displayed balance. Checked even when the status itself
    // didn't just change this run, so a bet that's ALREADY won/lost/push with a missing or
    // wrong ret gets backfilled the next time the grader touches it, not just on transition.
    let retPatch = {};
    if (collection === "pnlEntries" && ["won", "lost", "push"].includes(newTicketStatus)) {
      const correctRet = settlePnlRet(newTicketStatus, data);
      if (correctRet !== undefined && correctRet !== data.ret) {
        retPatch = { ret: correctRet, settledAt: data.settledAt || new Date().toISOString() };
        changed = true;
      }
    }

    // PAPER-TRADE TAG (2026-11-05, Seb's ask): a parlays/ftd doc with played !== true was
    // never actually bet -- it's a Claude recommendation that went ungraded/unlabeled
    // alongside real bets until now. Grading it was already happening (no played-check ever
    // existed above), it just wasn't marked -- this makes that explicit and queryable rather
    // than leaving callers to infer it from `played`. Never applied to pnlEntries, which by
    // definition only holds real placed bets (no pnlEntries doc exists for an unplaced pick).
    const paperPatch = collection === "pnlEntries" ? {} : { paper: data.played !== true };
    if (!changed && newTicketStatus === prevStatus && (collection === "pnlEntries" || data.paper === paperPatch.paper)) continue;
    const newData = { ...data, legs: newLegs, status: newTicketStatus, ...retPatch, ...paperPatch };
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

// Dry run for the league auto-tag (2026-11-04, Seb's ask, item 4): reports what WOULD be
// written for every CURRENTLY-blank-league bet dated within the last `days` (default 3,
// i.e. "today's bets" plus a little slack), on both desks. No writes.
app.get("/internal/jobs/league-autotag-test", async (req, res) => {
  try {
    const days = Number(req.query.days) || 3;
    const dateFloor = etDateDaysAgo(days);
    const playerIndex = await getLeagueTagPlayerIndex();
    const out = {};
    for (const desk of DESKS) {
      const requestIndex = await getLeagueTagRequestIndex(desk);
      const r = await supabaseFetch(`/docs?desk_id=eq.${encodeURIComponent(desk)}&collection=eq.pnlEntries&select=doc_id,data`);
      const docs = await r.json();
      const rows = [];
      for (const doc of docs) {
        const d = doc.data || {};
        if (d.type !== "bet" || !leagueTagIsBlank(d.league)) continue;
        if (!d.date || d.date < dateFloor) continue;
        const inferred = inferLeagueForBet(d, requestIndex, playerIndex);
        rows.push({ docId: doc.doc_id, date: d.date, ticket: (d.desc || d.ticketId || "").slice(0, 60), wouldSet: inferred || null });
      }
      out[desk] = rows;
    }
    res.json({ ok: true, dateFloor, playerIndexSize: playerIndex.size, ...out });
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

// Item 1 of the 2026-11-06 daily-data batch (Seb's request): per-player box-score logs for
// every final NBA game, upserted into nba_player_logs. Pure extraction/aggregation lives
// in jobs/nba-player-logs.js (unit-tested there); this wires in the real ESPN/Supabase
// calls. No ?date -> defaults to "yesterday" (ET) -- pulled by both the nightly cron and
// the 2 PM ET re-run (see sql/nba-player-logs-cron.sql); the upsert makes both idempotent.
app.get("/internal/jobs/nba-player-logs", async (req, res) => {
  try {
    const date =
      req.query.date ||
      new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
    const result = await trackNbaPlayerLogsForDate(date, {
      getJson,
      upsertRows: async (rows) => {
        await supabaseFetch(`/nba_player_logs?on_conflict=game_id,player_id`, {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(rows.map((r) => ({ ...r, updated_at: new Date().toISOString() }))),
        });
      },
    });
    res.json(result);
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

// --- beyondELO soccer ratings ingestion (2026-11-05, Seb's request) ---
// Official open data (CC BY 4.0, https://beyondelo.com). CSV endpoints only -- never
// scrapes beyondELO's website pages. No API key required. Piggybacked entirely on this
// nightly job (no separate cron): one club-ratings.csv call every night, plus a
// weekly-gated club-elo-history call for the current-season last-5 trend.
const BEYONDELO_BASE = "https://public-api.beyondelo.com/v1/datasets";
const BEYONDELO_SEASON = "2026-2027";

function parseCsv(text) {
  const lines = text.split("\n").filter((l) => l.trim().length);
  if (!lines.length) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(","); // beyondELO's own fields never contain embedded commas
    const row = {};
    headers.forEach((h, i) => (row[h] = cells[i]));
    return row;
  });
}

async function fetchBeyondEloCsv(path) {
  const res = await fetch(`${BEYONDELO_BASE}/${path}`, { headers: { "User-Agent": "sports-proxy/0.1" } });
  if (!res.ok) throw new Error(`beyondELO ${path} -> HTTP ${res.status}`);
  return parseCsv(await res.text());
}

// Normalizes a club display name the way ESPN/API-Football spell it, for matching against
// beyondELO's own `name` (and, via BEYONDELO_ALIASES below, its `slug`). Strips the common
// suffix/prefix tokens that differ by source ("AC Milan" vs "Milan", "AS Roma" vs "Roma").
function normClubName(name) {
  return norm(name || "")
    .replace(/\b(fc|cf|afc|sc|ac|as|club|calcio|cd|ud|sd|if|bk|fk|us)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Hand-checked aliases for cases plain normalization can't bridge (nicknames, desk
// shorthand, or beyondELO naming a club differently than ESPN/API-Football do). Extend
// this list as new unmatched names turn up in main/soccer/elo.unmatched.
const BEYONDELO_ALIASES = {
  "man city": "manchester-city", "man utd": "manchester-united", "man united": "manchester-united",
  "inter milan": "inter", "bayern munchen": "bayern-munich", "bayern munich": "bayern-munich",
  "vfb stuttgart": "vfb-stuttgart", "stuttgart": "vfb-stuttgart", "psg": "paris-saint-germain",
  "paris st germain": "paris-saint-germain", "sporting lisbon": "sporting-cp", "sporting": "sporting-cp",
  "dortmund": "borussia-dortmund", "monza brianza": "monza", "lecce": "us-lecce",
  "deportivo": "deportivo", "dep la coruna": "deportivo", "deportivo la coruna": "deportivo",
  "shakhtar": "shakhtar-donetsk", "elversberg": "sv-elversberg",
};

function resolveBeyondEloSlug(teamName, clubsByName) {
  const key = normClubName(teamName);
  if (!key) return null;
  if (BEYONDELO_ALIASES[key]) return BEYONDELO_ALIASES[key];
  if (clubsByName.has(key)) return clubsByName.get(key);
  for (const [nameKey, slug] of clubsByName) {
    if (key.length > 3 && (nameKey.includes(key) || key.includes(nameKey))) return slug;
  }
  return null;
}

function americanToProb(price) {
  const p = Number(price);
  if (!Number.isFinite(p)) return null;
  return p > 0 ? 100 / (p + 100) : -p / (-p + 100);
}

// Writes main/soccer/elo as ONE full doc (not one doc per club) -- elo/rd/hfa/rank/
// last5Trend per club, plus attribution + as_of, as Seb asked. Also reports which of our
// OWN tracked teams (soccerTeams) didn't resolve to a beyondELO club, so gaps are visible
// instead of silently missing an ELO number.
async function refreshSoccerElo() {
  const clubRows = await fetchBeyondEloCsv("club-ratings.csv");
  const clubsBySlug = {};
  const clubsByName = new Map();
  for (const r of clubRows) {
    if (!r.slug || !r.elo) continue;
    clubsBySlug[r.slug] = {
      slug: r.slug,
      name: r.name,
      countryCode: r.country_code,
      elo: Number(r.elo),
      rd: Number(r.rd),
      hfa: Number(r.hfa),
      rank: r.rank ? Number(r.rank) : null,
      asOf: r.as_of,
    };
    clubsByName.set(normClubName(r.name), r.slug);
  }

  // Weekly-gated history pull -> last-5-recorded-points trend per club. Same
  // once-per-cadence guard pattern as apiFootballGuardedCall/getSoccerCandidateFixtures.
  const historyState = await getDoc("main", "taskConfig", "beyondEloHistoryFetch");
  const todayStr = etDateDaysAgo(0);
  const lastFetched = historyState?.data?.lastFetchedAt;
  const needsHistory = !lastFetched || new Date(todayStr) - new Date(lastFetched) >= 7 * 24 * 60 * 60 * 1000;
  const trendErrors = [];
  if (needsHistory) {
    try {
      const histRows = await fetchBeyondEloCsv(`club-elo-history/${BEYONDELO_SEASON}.csv`);
      const bySlugHistory = {};
      for (const r of histRows) {
        if (!r.club || !r.elo) continue;
        (bySlugHistory[r.club] = bySlugHistory[r.club] || []).push({ date: r.date, elo: Number(r.elo) });
      }
      for (const slug of Object.keys(bySlugHistory)) {
        const recs = bySlugHistory[slug].sort((a, b) => (a.date < b.date ? -1 : 1));
        if (recs.length >= 2 && clubsBySlug[slug]) {
          const prior = recs[Math.max(0, recs.length - 5)];
          clubsBySlug[slug].last5Trend = Math.round((clubsBySlug[slug].elo - prior.elo) * 10) / 10;
        }
      }
      await upsertDoc("main", "taskConfig", "beyondEloHistoryFetch", { lastFetchedAt: new Date().toISOString(), season: BEYONDELO_SEASON });
    } catch (err) {
      trendErrors.push(err.message);
    }
  } else {
    // Didn't re-fetch history tonight (within the weekly gate) -- carry the last computed
    // last5Trend forward from the existing doc instead of silently dropping it. Without
    // this, every nightly run between weekly history pulls would overwrite `clubs` (a
    // mergeUpsertDoc shallow-merges at the top level, not per-club) with trend-less data,
    // found live on 2026-11-05 when two manual runs back-to-back wiped trend on the second.
    try {
      const existing = await getDoc("main", "soccer", "elo");
      const existingClubs = existing?.data?.clubs || {};
      for (const slug of Object.keys(clubsBySlug)) {
        if (existingClubs[slug]?.last5Trend != null) clubsBySlug[slug].last5Trend = existingClubs[slug].last5Trend;
      }
    } catch (err) {
      trendErrors.push(`trend-carryover: ${err.message}`);
    }
  }

  const tracked = await supabaseFetch(`/docs?desk_id=eq.main&collection=eq.soccerTeams&select=doc_id,data`);
  const trackedRows = await tracked.json();
  const unmatched = [];
  for (const row of trackedRows) {
    const teamName = row.data?.teamName;
    if (!teamName) continue;
    const slug = resolveBeyondEloSlug(teamName, clubsByName);
    if (!slug || !clubsBySlug[slug]) unmatched.push(teamName);
  }

  await mergeUpsertDoc("main", "soccer", "elo", {
    clubs: clubsBySlug,
    unmatched,
    attribution: "beyondELO (https://beyondelo.com), CC BY 4.0",
    asOf: clubRows[0]?.as_of || todayStr,
    lastUpdated: new Date().toISOString(),
    trendErrors,
  });
  return { clubCount: Object.keys(clubsBySlug).length, unmatchedCount: unmatched.length, historyRefreshed: needsHistory };
}

// --- soccer eloEdge fade-filter: log-only -> auto-activate (2026-11-05, Seb's request) ---
// Evaluates real, live-tagged results (not the backtest) exactly once after the rule doc's
// autoEvaluateAfter date: if negative-eloEdge legs are still hitting below their own average
// implied probability, flips rules/soccer-elo-fade-filter to a hard drop filter on both
// desks automatically. Either way Seb gets a Telegram DM -- no manual follow-up needed, and
// no Monday-recap routine prompt edit required.
async function evaluateSoccerEloFadeFilter() {
  const stateDoc = await getDoc("main", "rules", "soccer-elo-fade-filter");
  const state = stateDoc?.data;
  if (!state || state.mode !== "log_only") return { skipped: true, reason: "not in log_only mode" };
  const today = etDateDaysAgo(0);
  if (today < state.autoEvaluateAfter) return { skipped: true, reason: "before autoEvaluateAfter", today };
  if (state.lastEvaluation && state.lastEvaluation.decision !== "insufficient_sample") {
    return { skipped: true, reason: "already evaluated", prior: state.lastEvaluation };
  }

  const legs = [];
  for (const desk of ["main", "steve"]) {
    for (const collection of ["parlays", "pnlEntries"]) {
      const r = await supabaseFetch(`/docs?desk_id=eq.${desk}&collection=eq.${collection}&select=data`);
      const rows = await r.json();
      for (const row of rows) {
        for (const leg of row.data?.legs || []) {
          const league = leg.league || row.data?.league;
          if (league !== "SOCCER") continue;
          if (typeof leg.eloEdge !== "number") continue;
          if (!["hit", "miss"].includes(leg.status)) continue;
          if (leg.eloAsOf && leg.eloAsOf < state.logOnlySince) continue;
          legs.push(leg);
        }
      }
    }
  }

  const negative = legs.filter((l) => l.eloEdge < -0.02);
  const result = { n: negative.length, evaluatedAt: new Date().toISOString() };
  if (negative.length < 5) {
    result.decision = "insufficient_sample";
  } else {
    const hitRate = negative.filter((l) => l.status === "hit").length / negative.length;
    const implieds = negative.map((l) => americanToProb(l.price)).filter((v) => v != null);
    const avgImplied = implieds.length ? implieds.reduce((s, v) => s + v, 0) / implieds.length : null;
    result.hitRate = hitRate;
    result.avgImplied = avgImplied;
    result.decision = avgImplied != null && hitRate < avgImplied ? "activate" : "stay_log_only";
  }

  const newState = { ...state, lastEvaluation: result };
  if (result.decision === "activate") {
    newState.mode = "hard_filter";
    newState.on = true;
  }
  await mergeUpsertDoc("main", "rules", "soccer-elo-fade-filter", newState);
  await mergeUpsertDoc("steve", "rules", "soccer-elo-fade-filter", newState);

  if (TELEGRAM_SEB_CHAT_ID) {
    // Plain language only, Seb's private DM, no $ amounts or technical terms (percentages,
    // "eloEdge", "ROI", sample sizes) -- just what changed and why in a sentence or two.
    const message =
      result.decision === "activate"
        ? "Soccer picks: I turned on the ELO-based fade filter. Picks where the team-strength model disagreed with the posted odds have been losing more than they should, so those will now get dropped unless there's another strong reason to keep them."
        : result.decision === "insufficient_sample"
        ? "Soccer picks: checked the new ELO fade idea against real results, but there haven't been enough matching picks yet to decide. Leaving it as information-only for now and will check again soon."
        : "Soccer picks: checked the new ELO fade idea against real results. Those picks aren't actually underperforming yet, so I'm leaving it as information-only rather than turning it into a hard filter.";
    await sendTelegramRaw(TELEGRAM_SEB_CHAT_ID, `⚽ ${message}`).catch(() => {});
  }

  return result;
}

// Pulled nightly by a Supabase pg_cron job (see sql/soccer-tracker-cron.sql).
app.get("/internal/jobs/soccer-nightly-tracker", async (req, res) => {
  try {
    const result = await refreshSoccerTeams();
    let eloResult = null;
    try {
      eloResult = await refreshSoccerElo();
    } catch (err) {
      result.errors.push({ step: "beyondElo", error: err.message });
    }
    let fadeFilterEval = null;
    try {
      fadeFilterEval = await evaluateSoccerEloFadeFilter();
    } catch (err) {
      result.errors.push({ step: "eloFadeFilterEval", error: err.message });
    }
    res.json({ ok: true, ...result, elo: eloResult, fadeFilterEval });
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

// --- NHL starting-goalie tracker (2026-11-05, Seb's ask) -------------------------------
// nhl-model-spec's goalie-confirmation mandate was failing 100% of the time in practice --
// builders had no feed to actually check, just a disclosure tag to fall back on. This is an
// engine-only job (no Claude run) that fills Supabase nhl_goalies (see
// sql/nhl-goalies-table.sql) so pick-building routines have something real to read before
// tagging a leg "(backup goalie)" vs "(goalie unconfirmed)" vs building it plainly.
//
// Two tiers, both self-gated here by minutes-to-puck-drop rather than scheduled per-game --
// one frequent poll (sql/nhl-goalie-tracker-cron.sql) covers every game at whatever stage
// it's in:
//   projected (~90 min out): DraftKings' player_total_saves prop via the-odds-api. DK only
//     posts a goalie saves line for the goalie it expects to start, so whichever name shows
//     up there IS the projected starter -- verified live 2026-11-05 (DK had it posted hours
//     before puck drop for a real game). Official sportsbook data, not a scrape.
//   confirmed (~30 min out): the NHL's own api-web.nhle.com game-landing/boxscore endpoint,
//     which only carries a real per-game starter once gameState moves off "FUT" -- confirmed
//     empty hours out against a real game 2026-11-05, as expected. If it's still empty at
//     T-30 (lineup not locked yet), this tier just stays null until a later poll catches it.
// Explicitly NOT used: Daily Faceoff or any other scraped site (Seb's ask) -- only the NHL's
// own API and DraftKings' own posted odds.
const NHL_GOALIE_PROJECTED_WINDOW_MIN = [70, 110]; // ~90 min out, wide enough for a 10-min poll cadence
const NHL_GOALIE_CONFIRMED_WINDOW_MIN = [10, 50]; // ~30 min out, same cadence margin

function minutesUntil(iso) {
  return (new Date(iso).getTime() - Date.now()) / 60000;
}

// Season gamesStarted per goalie for one team, from the NHL's own club-stats endpoint --
// used only for backup_flag (a season-starts-rank proxy, not a lineup feed) and to resolve
// which team a bare player name from the odds API belongs to.
const nhlClubGoalieCache = new Map(); // team abbr -> {name,last,gamesStarted}[], cached per process run
async function nhlClubGoalies(teamAbbr) {
  if (nhlClubGoalieCache.has(teamAbbr)) return nhlClubGoalieCache.get(teamAbbr);
  let list = [];
  try {
    const data = await getJson(`https://api-web.nhle.com/v1/club-stats/${teamAbbr}/now`);
    list = (data.goalies || []).map((g) => ({
      name: `${g.firstName?.default || ""} ${g.lastName?.default || ""}`.trim(),
      last: (g.lastName?.default || "").toLowerCase(),
      gamesStarted: g.gamesStarted || 0,
    }));
  } catch {
    // Leave empty -- team assignment/backup_flag for this team just can't be resolved
    // this run, never a reason to fail the whole tracker.
  }
  nhlClubGoalieCache.set(teamAbbr, list);
  return list;
}

function isBackupStarter(depth, starterName) {
  if (!depth.length || !starterName) return null; // can't tell -- not the same as "false"
  const starterLast = starterName.trim().split(" ").pop().toLowerCase();
  const top = depth.reduce((a, b) => (b.gamesStarted > a.gamesStarted ? b : a), depth[0]);
  return top.last !== starterLast;
}

async function nhlProjectedStarterFromOdds(awayAbbr, homeAbbr, awayTeamName, homeTeamName) {
  // DK's own player_total_saves listing names a goalie with no team label -- resolve which
  // side it belongs to by checking both teams' own goalie rosters (never a guess: if the
  // name matches neither team's goalie list, or matches both, this leg is skipped).
  const [awayDepth, homeDepth] = await Promise.all([nhlClubGoalies(awayAbbr), nhlClubGoalies(homeAbbr)]);
  const out = { away: null, homeStarter: null };
  try {
    const eventsUrl = new URL(`${ODDS_BASE}/sports/icehockey_nhl/events`);
    eventsUrl.searchParams.set("apiKey", ODDS_API_KEY);
    const events = await getOddsJson(eventsUrl.toString());
    const norm = (s) => (s || "").toLowerCase();
    const match = events.find(
      (e) => norm(e.home_team).includes(norm(homeTeamName).split(" ").pop()) && norm(e.away_team).includes(norm(awayTeamName).split(" ").pop())
    );
    if (!match) return { away: null, home: null };
    const url = new URL(`${ODDS_BASE}/sports/icehockey_nhl/events/${match.id}/odds`);
    url.searchParams.set("apiKey", ODDS_API_KEY);
    url.searchParams.set("regions", "us");
    url.searchParams.set("markets", "player_total_saves");
    url.searchParams.set("oddsFormat", "american");
    url.searchParams.set("bookmakers", "draftkings");
    const data = await getOddsJson(url.toString());
    const names = new Set();
    for (const book of data.bookmakers || []) {
      for (const m of book.markets || []) {
        for (const o of m.outcomes || []) if (o.description) names.add(o.description);
      }
    }
    let away = null, home = null;
    for (const name of names) {
      const last = name.trim().split(" ").pop().toLowerCase();
      const onAway = awayDepth.some((g) => g.last === last);
      const onHome = homeDepth.some((g) => g.last === last);
      if (onAway && !onHome) away = name;
      else if (onHome && !onAway) home = name;
      // onAway && onHome (same surname on both sides) or neither -> skip, no guess
    }
    return { away, home };
  } catch {
    return { away: null, home: null };
  }
}

async function nhlConfirmedStarterFromApiWeb(gameId, awayAbbr, homeAbbr) {
  try {
    const landing = await getJson(`https://api-web.nhle.com/v1/gamecenter/${gameId}/landing`);
    if (landing.gameState === "FUT" || landing.gameState === "PRE") return { away: null, home: null }; // lineup not locked yet
    const box = await getJson(`https://api-web.nhle.com/v1/gamecenter/${gameId}/boxscore`);
    const pick = (teamStats) => {
      const goalies = teamStats?.goalies || [];
      const started = goalies.find((g) => Number(g.toi?.split(":")?.[0]) > 0 || g.starter);
      const g = started || goalies[0];
      return g ? `${g.name?.default || ""}`.trim() || null : null;
    };
    return {
      away: pick(box.playerByGameStats?.awayTeam),
      home: pick(box.playerByGameStats?.homeTeam),
    };
  } catch {
    return { away: null, home: null };
  }
}

app.get("/internal/jobs/nhl-goalie-tracker", async (req, res) => {
  try {
    const dateET = etDateDaysAgo(0);
    const schedule = await getJson(`https://api-web.nhle.com/v1/score/${dateET}`);
    const games = (schedule.games || []).filter((g) => !["OFF", "FINAL", "OVER"].includes(g.gameState));
    const results = [];
    for (const g of games) {
      const minsOut = minutesUntil(g.startTimeUTC);
      const inProjectedWindow = minsOut >= NHL_GOALIE_PROJECTED_WINDOW_MIN[0] && minsOut <= NHL_GOALIE_PROJECTED_WINDOW_MIN[1];
      const inConfirmedWindow = minsOut >= NHL_GOALIE_CONFIRMED_WINDOW_MIN[0] && minsOut <= NHL_GOALIE_CONFIRMED_WINDOW_MIN[1];
      if (!inProjectedWindow && !inConfirmedWindow) continue;

      const awayAbbr = g.awayTeam?.abbrev;
      const homeAbbr = g.homeTeam?.abbrev;
      if (!awayAbbr || !homeAbbr) continue;

      let projected = { away: null, home: null };
      let confirmed = { away: null, home: null };
      if (inProjectedWindow) {
        projected = await nhlProjectedStarterFromOdds(awayAbbr, homeAbbr, g.awayTeam?.name?.default || awayAbbr, g.homeTeam?.name?.default || homeAbbr);
      }
      if (inConfirmedWindow) {
        confirmed = await nhlConfirmedStarterFromApiWeb(g.id, awayAbbr, homeAbbr);
      }

      for (const [side, abbr, opp] of [["away", awayAbbr, homeAbbr], ["home", homeAbbr, awayAbbr]]) {
        const proj = side === "away" ? projected.away : projected.home;
        const conf = side === "away" ? confirmed.away : confirmed.home;
        if (!proj && !conf) continue; // nothing new to write for this side this run
        const depth = await nhlClubGoalies(abbr);
        const starterForFlag = conf || proj;
        const patch = {
          game_id: String(g.id),
          team: abbr,
          opponent: opp,
          is_home: side === "home",
          date: dateET,
          puck_drop_utc: g.startTimeUTC,
          backup_flag: isBackupStarter(depth, starterForFlag),
          updated_at: new Date().toISOString(),
        };
        if (proj) {
          patch.projected_starter = proj;
          patch.projected_source = "draftkings_player_total_saves";
          patch.projected_at = new Date().toISOString();
        }
        if (conf) {
          patch.confirmed_starter = conf;
          patch.confirmed_source = "api-web.nhle.com";
          patch.confirmed_at = new Date().toISOString();
        }
        await supabaseFetch(`/nhl_goalies?on_conflict=game_id,team`, {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify([patch]),
        });
        results.push({ gameId: g.id, team: abbr, ...patch });
      }
    }
    res.json({ ok: true, gamesChecked: games.length, rowsWritten: results.length, results });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Paper-vs-bet league summary (2026-11-05, Seb's ask) -------------------------------
// Read-only aggregation over the real parlays collection (both desks) -- feeds the Monday
// recap's "paper record vs bet record" line and the NHL/CBB "ready to bet?" check. Nothing
// here writes anything; it's pure math over whatever the grader has already written
// (paper:true/false, per the tagging added above).
function americanToImplied(price) {
  const n = typeof price === "number" ? price : parseFloat(String(price ?? "").replace(/[^0-9.+-]/g, ""));
  if (!Number.isFinite(n) || n === 0) return null;
  return n < 0 ? -n / (-n + 100) : 100 / (n + 100);
}

function emptyBucket() {
  return { legs: 0, hit: 0, miss: 0, push: 0, impliedSum: 0, impliedCount: 0 };
}

app.get("/internal/jobs/paper-vs-bet-summary", async (req, res) => {
  try {
    const days = req.query.days ? Number(req.query.days) : null; // omit for all-time
    const dateFloor = days ? etDateDaysAgo(days) : null;
    const byLeague = {};
    for (const desk of ["main", "steve"]) {
      const listRes = await supabaseFetch(
        `/docs?desk_id=eq.${desk}&collection=eq.parlays&select=doc_id,data`
      );
      const docs = await listRes.json();
      for (const doc of docs) {
        const d = doc.data || {};
        const src = (d.source || "").toLowerCase();
        if (!src.startsWith("claude")) continue; // Claude-built picks only -- never friends'/Seb's own logged bets
        if (dateFloor && d.date && d.date < dateFloor) continue;
        const league = (d.league || "UNKNOWN").toUpperCase();
        const bucket = d.played === true ? "real" : "paper";
        byLeague[league] = byLeague[league] || { real: emptyBucket(), paper: emptyBucket() };
        for (const leg of d.legs || []) {
          if (!["hit", "miss", "push"].includes(leg.status)) continue;
          const b = byLeague[league][bucket];
          b.legs++;
          b[leg.status]++;
          // Per-leg price only -- a ticket's combined parlay odds is NOT a per-leg implied
          // probability and must never be used as one (found doing the NHL leg audit).
          if (leg.price != null) {
            const imp = americanToImplied(leg.price);
            if (imp != null) {
              b.impliedSum += imp;
              b.impliedCount++;
            }
          }
        }
      }
    }
    const out = {};
    for (const [league, buckets] of Object.entries(byLeague)) {
      out[league] = {};
      for (const [bucket, b] of Object.entries(buckets)) {
        const graded = b.hit + b.miss; // push excluded from hit% denominator
        out[league][bucket] = {
          legs: b.legs,
          hit: b.hit,
          miss: b.miss,
          push: b.push,
          hitPct: graded ? Number(((b.hit / graded) * 100).toFixed(1)) : null,
          impliedPct: b.impliedCount ? Number(((b.impliedSum / b.impliedCount) * 100).toFixed(1)) : null,
          impliedSampleSize: b.impliedCount,
        };
      }
      // "ready to bet?" -- Seb's bar: 30+ graded paper legs AND paper hit% beats paper implied%.
      const p = out[league].paper;
      const gradedPaper = p.hit + p.miss;
      out[league].readyToBet =
        gradedPaper >= 30 && p.impliedPct != null ? p.hitPct > p.impliedPct : false;
      out[league].readyToBetNote =
        gradedPaper < 30
          ? `only ${gradedPaper} graded paper legs, need 30+`
          : p.impliedPct == null
            ? "no per-leg priced data to compare against yet"
            : `${p.hitPct}% hit vs ${p.impliedPct}% implied (n=${p.impliedSampleSize} priced legs)`;
    }
    res.json({ ok: true, generatedAt: new Date().toISOString(), days: days || "all-time", byLeague: out });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- NCAAB nightly tracker + engine-gated learning loop (2026-11-02, Seb's request) ---
// Same additive pattern as the NBA/NHL/soccer trackers above -- new tables, new endpoints,
// nothing existing touched. No player props (Seb's call: ML/spread/total only, full game
// AND halves) so there's no cbb_player_logs table -- player box scores are read live by
// pick builders for injury/minutes context, never stored here.
//
// Half scores: ESPN's scoreboard competitor objects already carry `linescores` with a
// `period` number (1 = first half, 2 = second half, 3+ = OT) -- see fetchGamesForDate
// above and halfAwareScore(), which is what actually grades "1st Half"/"2H" legs. This
// tracker stores the same two numbers (away_1h/away_2h, home_1h/home_2h) on every game log
// row so half tendencies (fast/slow starters, 2H comebacks) can be read back later.
//
// Team box-score stats (FG/3P/FT made-attempted, rebounds, ast/stl/blk/tov, fouls) come
// from ESPN's per-game summary (boxscore.teams) -- confirmed shape against a real final
// 2026-27 game (ND @ Villanova, event 401920982) on 2026-11-02: statistics are plain
// {name, displayValue} pairs, made-attempted stats render as a single "23-65" string that
// needs splitting, not two separate fields.
//
// NOT included, both checked live before writing any code:
//   - Bart Torvik (barttorvik.com): its robots.txt disallows "ClaudeBot" and "anthropic-ai"
//     by name (plus most other AI crawlers) site-wide. Respecting that -- no automated
//     reads of it, no exception. (KenPom was never in scope per Seb.)
//   - ESPN BPI: no working public site-API endpoint found for college BPI after trying the
//     standard site.api.espn.com and site.web.api.espn.com BPI paths (all 404). Left out
//     rather than faked. If Seb finds the real endpoint later, this is where it'd go.
// SOS is instead a disclosed in-house proxy (average win% of opponents actually played,
// from cbb_game_logs) -- same "approximate and say so" style as NBA's offRtg/defRtg.

function cbbDocId(team) {
  const base = team?.abbreviation || team?.displayName || String(team?.id || "");
  return base.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) || `T${team?.id}`;
}

// NCAAB season backfill (2026-11-02, Seb's request): "2025-26", "2026-27", etc. The
// season runs Nov-Apr, so Aug-Dec dates belong to the season STARTING that year and
// Jan-Jul dates belong to the season ENDING that year. Used to tag every cbb_game_logs
// row so last season's rows (different rosters -- heavy transfer-portal turnover every
// year) can be read for PATTERNS (tempo, half tendencies, tournament pace) without ever
// being averaged into this season's live team ratings.
function seasonForDate(yyyymmdd) {
  const year = Number(yyyymmdd.slice(0, 4));
  const month = Number(yyyymmdd.slice(4, 6));
  const startYear = month >= 8 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

// "23-65" -> { made: 23, att: 65, pct: 35.4 }. Returns nulls for anything unparseable.
function splitMadeAttempt(str) {
  const m = /^(\d+)-(\d+)$/.exec(str || "");
  if (!m) return { made: null, att: null, pct: null };
  const made = Number(m[1]);
  const att = Number(m[2]);
  return { made, att, pct: att > 0 ? Number(((made / att) * 100).toFixed(1)) : null };
}

function extractCbbTeamStats(teamBlock) {
  const stats = teamBlock?.statistics || [];
  const find = (name) => stats.find((s) => s.name === name)?.displayValue;
  const fg = splitMadeAttempt(find("fieldGoalsMade-fieldGoalsAttempted"));
  const three = splitMadeAttempt(find("threePointFieldGoalsMade-threePointFieldGoalsAttempted"));
  const ft = splitMadeAttempt(find("freeThrowsMade-freeThrowsAttempted"));
  const num = (name) => {
    const v = Number(find(name));
    return Number.isFinite(v) ? v : null;
  };
  return {
    fgMade: fg.made, fgAtt: fg.att, fgPct: fg.pct,
    threeMade: three.made, threeAtt: three.att, threePct: three.pct,
    ftMade: ft.made, ftAtt: ft.att, ftPct: ft.pct,
    oreb: num("offensiveRebounds"), dreb: num("defensiveRebounds"), reb: num("totalRebounds"),
    ast: num("assists"), stl: num("steals"), blk: num("blocks"), tov: num("turnovers"), fouls: num("fouls"),
  };
}

// Free closing-line proxy (2026-11-02, Seb's request, instead of the-odds-api's paid
// historical endpoint): ESPN's own game summary carries a "pickcenter" array of
// sportsbook lines. For a FINAL game this is frozen at whatever the book last quoted --
// effectively the closing line, at no cost. Prefers DraftKings (same book the live
// /odds proxy uses) and falls back to whichever provider ESPN ranks #1 (lowest
// `priority`) if DK isn't listed for that game. `spread`/`moneyLine` here are already
// HOME-team-signed (ESPN's own convention) -- homeTeamOdds.favorite is true when the
// home team is favored, so a negative `spread` means the home team is favored by that
// many points.
function extractCbbClosingLine(summary) {
  const books = summary?.pickcenter || [];
  if (!books.length) return { provider: null, homeSpread: null, total: null, homeMoneyline: null, awayMoneyline: null };
  const dk = books.find((b) => /draftkings/i.test(b.provider?.name || ""));
  const best = dk || books.slice().sort((a, b) => (a.provider?.priority ?? 99) - (b.provider?.priority ?? 99))[0];
  return {
    provider: best.provider?.name || null,
    homeSpread: Number.isFinite(best.spread) ? best.spread : null,
    total: Number.isFinite(best.overUnder) ? best.overUnder : null,
    homeMoneyline: Number.isFinite(best.homeTeamOdds?.moneyLine) ? best.homeTeamOdds.moneyLine : null,
    awayMoneyline: Number.isFinite(best.awayTeamOdds?.moneyLine) ? best.awayTeamOdds.moneyLine : null,
  };
}

// Cached per game (CLV capture, 2026-11-06) -- same lifetime/key pattern as boxScoreCache
// and scoringPlaysCache above, so a ticket with several legs on the same game only fetches
// its summary once per process lifetime.
const closingLineCache = new Map();
async function fetchClosingLineInfo(game) {
  const key = `${game.sport}/${game.league}/${game.id}`;
  if (closingLineCache.has(key)) return closingLineCache.get(key);
  const data = await getJson(`${ESPN_BASE}/${game.sport}/${game.league}/summary?event=${game.id}`);
  const info = { closing: extractCbbClosingLine(data) };
  closingLineCache.set(key, info);
  return info;
}

function cbbHalfScores(competitor) {
  const ls = competitor?.linescores || [];
  const h1 = ls.find((l) => l.period === 1);
  const h2 = ls.find((l) => l.period === 2);
  return {
    h1: h1 ? Number(h1.value ?? h1.displayValue) : null,
    h2: h2 ? Number(h2.value ?? h2.displayValue) : null,
  };
}

async function upsertCbbGameRow(row) {
  await supabaseFetch(`/cbb_game_logs?on_conflict=game_id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ ...row, updated_at: new Date().toISOString() }]),
  });
}

async function trackCbbForDate(yyyymmdd) {
  const result = { date: yyyymmdd, gamesFound: 0, gamesRecorded: 0, skipped: [] };
  let scoreboard;
  try {
    scoreboard = await getJson(`${ESPN_BASE}/basketball/mens-college-basketball/scoreboard?dates=${yyyymmdd}`);
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
      const awayAbbr = cbbDocId(away.team);
      const homeAbbr = cbbDocId(home.team);
      const awayHalves = cbbHalfScores(away);
      const homeHalves = cbbHalfScores(home);

      const summary = await getJson(`${ESPN_BASE}/basketball/mens-college-basketball/summary?event=${ev.id}`);
      const teamBlocks = summary.boxscore?.teams || [];
      const awayBlock = teamBlocks.find((tb) => cbbDocId(tb.team) === awayAbbr);
      const homeBlock = teamBlocks.find((tb) => cbbDocId(tb.team) === homeAbbr);
      if (!awayBlock || !homeBlock) {
        result.skipped.push({ id: ev.id, reason: "no boxscore.teams match for one side" });
        continue;
      }
      const awayStats = extractCbbTeamStats(awayBlock);
      const homeStats = extractCbbTeamStats(homeBlock);
      const closingLine = extractCbbClosingLine(summary);

      await upsertCbbGameRow({
        game_id: ev.id,
        date: isoDate,
        season: seasonForDate(yyyymmdd),
        away_team: awayAbbr,
        home_team: homeAbbr,
        away_score: Number(away.score),
        home_score: Number(home.score),
        away_1h: awayHalves.h1,
        away_2h: awayHalves.h2,
        home_1h: homeHalves.h1,
        home_2h: homeHalves.h2,
        line_provider: closingLine.provider,
        home_spread: closingLine.homeSpread,
        total_line: closingLine.total,
        home_moneyline: closingLine.homeMoneyline,
        away_moneyline: closingLine.awayMoneyline,
        away_fg_made: awayStats.fgMade, away_fg_att: awayStats.fgAtt, away_fg_pct: awayStats.fgPct,
        away_three_made: awayStats.threeMade, away_three_att: awayStats.threeAtt, away_three_pct: awayStats.threePct,
        away_ft_made: awayStats.ftMade, away_ft_att: awayStats.ftAtt, away_ft_pct: awayStats.ftPct,
        away_oreb: awayStats.oreb, away_dreb: awayStats.dreb, away_reb: awayStats.reb,
        away_ast: awayStats.ast, away_stl: awayStats.stl, away_blk: awayStats.blk, away_tov: awayStats.tov, away_fouls: awayStats.fouls,
        home_fg_made: homeStats.fgMade, home_fg_att: homeStats.fgAtt, home_fg_pct: homeStats.fgPct,
        home_three_made: homeStats.threeMade, home_three_att: homeStats.threeAtt, home_three_pct: homeStats.threePct,
        home_ft_made: homeStats.ftMade, home_ft_att: homeStats.ftAtt, home_ft_pct: homeStats.ftPct,
        home_oreb: homeStats.oreb, home_dreb: homeStats.dreb, home_reb: homeStats.reb,
        home_ast: homeStats.ast, home_stl: homeStats.stl, home_blk: homeStats.blk, home_tov: homeStats.tov, home_fouls: homeStats.fouls,
      });
      result.gamesRecorded++;
    } catch (err) {
      result.skipped.push({ id: ev.id, reason: err.message });
    }
    await sleep(200); // pace ESPN calls, esp. during a multi-night backfill
  }
  return result;
}

// Aggregates cbb_game_logs into per-team season numbers (own + allowed, home/away splits,
// last-5, half splits), merges in ESPN standings (record, conference) and the AP poll
// (best-effort -- no poll exists yet in the preseason/week-1 window, that's expected, not a
// bug), and computes a disclosed SOS proxy: the average current win% of every opponent this
// team has actually played so far (NOT a real strength-of-schedule formula like KenPom's --
// a plain, honestly-labeled approximation, same spirit as NBA's offRtg/defRtg estimate).
async function refreshCbbTeams() {
  // Current season only -- last season's backfilled rows (sql/cbb-tracker-cron.sql's
  // backfill) must never dilute THIS season's ratings; rosters turn over too much. Last
  // season's rows stay queryable by anyone who explicitly asks for them (e.g. the learning
  // loop pulling tournament-pace patterns), just never averaged in here.
  const currentSeason = seasonForDate(new Date().toISOString().slice(0, 10).replace(/-/g, ""));
  const standings = await getJson(`${ESPN_V2_BASE}/basketball/mens-college-basketball/standings?group=50`);
  const byTeam = {};
  const conferenceOf = {};
  for (const child of standings.children || []) {
    for (const e of child.standings?.entries || []) {
      const abbr = cbbDocId(e.team);
      if (!abbr) continue;
      conferenceOf[abbr] = child.name || null;
      const get = (name) => e.stats?.find((s) => s.name === name)?.value ?? null;
      const overall = e.stats?.find((s) => s.name === "overall")?.displayValue || null;
      byTeam[abbr] = {
        teamName: e.team?.displayName,
        record: overall,
        wins: get("wins"),
        losses: get("losses"),
      };
    }
  }

  let apRanks = {};
  try {
    const rankings = await getJson(`${ESPN_BASE}/basketball/mens-college-basketball/rankings`);
    const poll = (rankings.rankings || []).find((r) => /ap/i.test(r.name || r.shortName || ""));
    for (const r of poll?.ranks || []) {
      const abbr = cbbDocId(r.team);
      if (abbr) apRanks[abbr] = r.current;
    }
  } catch (err) {
    // No AP poll out yet (preseason/week 1) or shape differs from other sports' rankings
    // endpoint -- leave apRanks empty rather than guess.
  }

  const gamesRes = await supabaseFetch(
    `/cbb_game_logs?season=eq.${currentSeason}&select=away_team,home_team,away_score,home_score,away_1h,away_2h,home_1h,home_2h,away_fg_pct,home_fg_pct,away_fg_att,home_fg_att,away_three_pct,home_three_pct,away_three_att,home_three_att,away_ft_pct,home_ft_pct,away_reb,home_reb,away_tov,home_tov,date&order=date.asc&limit=5000`
  );
  const games = await gamesRes.json();

  const agg = {};
  const ensure = (abbr) =>
    (agg[abbr] ||= {
      played: 0, wins: 0, homeWins: 0, homePlayed: 0, awayWins: 0, awayPlayed: 0,
      ptsFor: 0, ptsAgainst: 0, ptsFor1h: 0, ptsAgainst1h: 0, ptsFor2h: 0, ptsAgainst2h: 0,
      fgPct: [], fgPctAllowed: [], threePct: [], threePctAllowed: [], reb: [], rebAllowed: [], tov: [], tovForced: [],
      ftPct: [], threeAtt: [], fgAtt: [],
      opponents: [], last5: [],
    });

  for (const g of games) {
    for (const side of ["away", "home"]) {
      const other = side === "away" ? "home" : "away";
      const abbr = g[`${side}_team`];
      const oppAbbr = g[`${other}_team`];
      if (!abbr) continue;
      const t = ensure(abbr);
      const my = g[`${side}_score`];
      const opp = g[`${other}_score`];
      if (my == null || opp == null) continue;
      t.played++;
      const won = my > opp;
      if (won) t.wins++;
      if (side === "home") { t.homePlayed++; if (won) t.homeWins++; } else { t.awayPlayed++; if (won) t.awayWins++; }
      t.ptsFor += my; t.ptsAgainst += opp;
      if (g[`${side}_1h`] != null) t.ptsFor1h += g[`${side}_1h`];
      if (g[`${other}_1h`] != null) t.ptsAgainst1h += g[`${other}_1h`];
      if (g[`${side}_2h`] != null) t.ptsFor2h += g[`${side}_2h`];
      if (g[`${other}_2h`] != null) t.ptsAgainst2h += g[`${other}_2h`];
      if (g[`${side}_fg_pct`] != null) t.fgPct.push(g[`${side}_fg_pct`]);
      if (g[`${other}_fg_pct`] != null) t.fgPctAllowed.push(g[`${other}_fg_pct`]);
      if (g[`${side}_three_pct`] != null) t.threePct.push(g[`${side}_three_pct`]);
      if (g[`${other}_three_pct`] != null) t.threePctAllowed.push(g[`${other}_three_pct`]);
      if (g[`${side}_reb`] != null) t.reb.push(g[`${side}_reb`]);
      if (g[`${other}_reb`] != null) t.rebAllowed.push(g[`${other}_reb`]);
      if (g[`${side}_tov`] != null) t.tov.push(g[`${side}_tov`]);
      if (g[`${other}_tov`] != null) t.tovForced.push(g[`${other}_tov`]);
      if (g[`${side}_ft_pct`] != null) t.ftPct.push(g[`${side}_ft_pct`]);
      if (g[`${side}_three_att`] != null) t.threeAtt.push(g[`${side}_three_att`]);
      if (g[`${side}_fg_att`] != null) t.fgAtt.push(g[`${side}_fg_att`]);
      if (oppAbbr) t.opponents.push(oppAbbr);
      t.last5.push({ date: g.date, win: won });
    }
  }

  const avg = (arr) => (arr.length ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)) : null);
  const winPct = (abbr) => {
    const bt = byTeam[abbr];
    if (bt?.wins != null && bt?.losses != null && bt.wins + bt.losses > 0) return bt.wins / (bt.wins + bt.losses);
    const a = agg[abbr];
    return a?.played ? a.wins / a.played : null;
  };

  const result = { teamsUpdated: 0, errors: [] };
  const abbrs = new Set([...Object.keys(byTeam), ...Object.keys(agg)]);
  for (const abbr of abbrs) {
    const bt = byTeam[abbr] || {};
    const a = agg[abbr];
    const patch = {
      teamName: bt.teamName ?? undefined,
      conference: conferenceOf[abbr] ?? undefined,
      record: bt.record ?? undefined,
      apRank: apRanks[abbr] ?? undefined,
      approxRatings: true,
    };
    if (a) {
      patch.ptsFor = a.played ? Number((a.ptsFor / a.played).toFixed(1)) : undefined;
      patch.ptsAgainst = a.played ? Number((a.ptsAgainst / a.played).toFixed(1)) : undefined;
      patch.ptsFor1h = a.played ? Number((a.ptsFor1h / a.played).toFixed(1)) : undefined;
      patch.ptsAgainst1h = a.played ? Number((a.ptsAgainst1h / a.played).toFixed(1)) : undefined;
      patch.ptsFor2h = a.played ? Number((a.ptsFor2h / a.played).toFixed(1)) : undefined;
      patch.ptsAgainst2h = a.played ? Number((a.ptsAgainst2h / a.played).toFixed(1)) : undefined;
      patch.fgPct = avg(a.fgPct) ?? undefined;
      patch.fgPctAllowed = avg(a.fgPctAllowed) ?? undefined;
      patch.threePct = avg(a.threePct) ?? undefined;
      patch.threePctAllowed = avg(a.threePctAllowed) ?? undefined;
      patch.rebPerGame = avg(a.reb) ?? undefined;
      patch.rebAllowedPerGame = avg(a.rebAllowed) ?? undefined;
      patch.tovPerGame = avg(a.tov) ?? undefined;
      patch.tovForcedPerGame = avg(a.tovForced) ?? undefined;
      patch.homeRecord = `${a.homeWins}-${a.homePlayed - a.homeWins}`;
      patch.awayRecord = `${a.awayWins}-${a.awayPlayed - a.awayWins}`;
      const last5 = a.last5.slice(-5);
      patch.last5 = last5.length ? `${last5.filter((g) => g.win).length}-${last5.filter((g) => !g.win).length}` : undefined;
      const oppWinPcts = a.opponents.map(winPct).filter((v) => v != null);
      patch.sosProxy = oppWinPcts.length ? Number((oppWinPcts.reduce((s, v) => s + v, 0) / oppWinPcts.length).toFixed(3)) : undefined;
      patch.sampleGames = a.played;

      // marchProfile (2026-11-04, Seb's request): the subset of season numbers most
      // predictive in tournament play -- free-throw reliability, 3PT shot-attempt share
      // (how much of the offense comes from deep), turnover rate, and what the defense
      // allows -- tracked all season, every night, same source data as the fields above.
      // "Experience" (returning-player seniority) is NOT included here -- no ESPN box
      // score or standings feed carries that; it would need a Claude routine's own
      // research, not a nightly engine job.
      const totalThreeAtt = a.threeAtt.reduce((s, v) => s + v, 0);
      const totalFgAtt = a.fgAtt.reduce((s, v) => s + v, 0);
      patch.marchProfile = {
        ftPct: avg(a.ftPct) ?? undefined,
        threePtReliance: totalFgAtt > 0 ? Number((totalThreeAtt / totalFgAtt).toFixed(3)) : undefined,
        toRate: avg(a.tov) ?? undefined,
        defenseAllowed: {
          fgPct: avg(a.fgPctAllowed) ?? undefined,
          threePct: avg(a.threePctAllowed) ?? undefined,
          tovForced: avg(a.tovForced) ?? undefined,
        },
      };
    }
    try {
      await mergeUpsertDoc("main", "cbbTeams", abbr, patch);
      result.teamsUpdated++;
    } catch (err) {
      result.errors.push({ abbr, error: err.message });
    }
  }

  await mergeUpsertDoc("main", "cbb", "meta", {
    lastUpdated: new Date().toISOString().slice(0, 10),
    apTop25Available: Object.keys(apRanks).length > 0,
    currentSeason,
  });
  return result;
}

// Pulled nightly by a Supabase pg_cron job (see sql/cbb-tracker-cron-run-me.sql). Same
// date/from/to backfill convention as the NHL tracker above -- the season started
// 2026-11-02, so the very first run only has that one night to cover; from/to exists for
// catching up after any outage, not an initial multi-week backfill.
app.get("/internal/jobs/cbb-nightly-tracker", async (req, res) => {
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
      results.push(await trackCbbForDate(d));
      await sleep(300);
    }
    const teamsResult = await refreshCbbTeams();
    res.json({
      ok: true,
      nights: results.length,
      gamesRecorded: results.reduce((s, r) => s + r.gamesRecorded, 0),
      results,
      cbbTeams: teamsResult,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

const CBB_LOOP_FIRE_URL = process.env.CBB_LOOP_FIRE_URL;
const CBB_LOOP_FIRE_TOKEN = process.env.CBB_LOOP_FIRE_TOKEN;
const CBB_LOOP_THRESHOLD = 10;

async function fireCbbLearningLoop() {
  if (!CBB_LOOP_FIRE_URL || !CBB_LOOP_FIRE_TOKEN) {
    throw new Error("CBB_LOOP_FIRE_URL/CBB_LOOP_FIRE_TOKEN not configured on the server.");
  }
  const fireRes = await fetch(CBB_LOOP_FIRE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CBB_LOOP_FIRE_TOKEN}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "experimental-cc-routine-2026-04-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  if (!fireRes.ok) {
    const body = await fireRes.text();
    throw new Error(`CBB loop fire -> HTTP ${fireRes.status}: ${body}`);
  }
}

// Pulled hourly by a Supabase pg_cron job (see sql/cbb-tracker-cron-run-me.sql). Reuses
// countNewGradedLegsByLeague() (defined above, in the NBA section) -- it's already
// league-parameterized, so "CBB" just needs that tag used consistently on graded legs.
app.get("/internal/jobs/cbb-learning-gate", async (req, res) => {
  try {
    const state = await getDoc("main", "taskConfig", "cbbLearningGate");
    const lastFiredAt = state?.data?.lastFiredAt || "1970-01-01T00:00:00Z";
    const { total, counts } = await countNewGradedLegsByLeague("CBB", lastFiredAt);
    if (total < CBB_LOOP_THRESHOLD) {
      return res.json({ ok: true, fired: false, total, threshold: CBB_LOOP_THRESHOLD, counts, lastFiredAt });
    }
    await fireCbbLearningLoop();
    const firedAt = new Date().toISOString();
    await upsertDoc("main", "taskConfig", "cbbLearningGate", { lastFiredAt: firedAt, lastFireTotal: total, lastFireCounts: counts });
    res.json({ ok: true, fired: true, total, threshold: CBB_LOOP_THRESHOLD, counts, firedAt });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- NCAA tournament (March Madness) historical backfill (2026-11-04, Seb's request,
// ONE-TIME job -- not nightly, not on a cron, no learning-loop fire. Call its endpoint
// once; re-running it is still safe (upserts on game_id), just unnecessary). ---
// A tournament game's own ESPN notes[].headline identifies it ("Men's Basketball
// Championship - <Region> Region - <Round>", or just "- Final Four"/"- National
// Championship" with no region) -- that's also where round and region come from. Seed is
// each competitor's own `seed.current`. Reuses cbbHalfScores/cbbDocId/
// extractCbbClosingLine as-is (none of them are regular-season-specific).
function parseCbbTournamentNote(notes) {
  const headline = notes?.[0]?.headline || "";
  if (!/Men's Basketball Championship/i.test(headline)) return null;
  const regionMatch = /-\s*([A-Za-z]+)\s+Region\s*-\s*(.+)$/.exec(headline);
  if (regionMatch) return { region: regionMatch[1], round: regionMatch[2].trim() };
  const tail = headline.replace(/^Men's Basketball Championship\s*-\s*/i, "").trim();
  return { region: null, round: tail || null };
}

async function upsertCbbTournamentGameRow(row) {
  await supabaseFetch(`/cbb_tournament_games?on_conflict=game_id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ ...row, updated_at: new Date().toISOString() }]),
  });
}

async function trackCbbTournamentForDate(yyyymmdd, season) {
  const result = { date: yyyymmdd, gamesFound: 0, gamesRecorded: 0, skipped: [] };
  let scoreboard;
  try {
    scoreboard = await getJson(`${ESPN_BASE}/basketball/mens-college-basketball/scoreboard?dates=${yyyymmdd}&limit=300`);
  } catch (err) {
    result.error = err.message;
    return result;
  }
  const isoDate = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

  for (const ev of scoreboard.events || []) {
    try {
      const comp = ev.competitions?.[0];
      const parsed = parseCbbTournamentNote(comp?.notes);
      if (!parsed) continue; // not an NCAA tournament game (regular season/NIT/other on this same date)
      if (ev.status?.type?.state !== "post") continue;

      const away = comp.competitors?.find((c) => c.homeAway === "away");
      const home = comp.competitors?.find((c) => c.homeAway === "home");
      if (!away || !home) {
        result.skipped.push({ id: ev.id, reason: "missing competitors" });
        continue;
      }
      const awayAbbr = cbbDocId(away.team);
      const homeAbbr = cbbDocId(home.team);
      const awayHalves = cbbHalfScores(away);
      const homeHalves = cbbHalfScores(home);

      const summaryEv = await getJson(`${ESPN_BASE}/basketball/mens-college-basketball/summary?event=${ev.id}`);
      const closingLine = extractCbbClosingLine(summaryEv);

      await upsertCbbTournamentGameRow({
        game_id: ev.id,
        date: isoDate,
        season: String(season),
        round: parsed.round,
        region: parsed.region,
        site: comp.venue?.fullName || null,
        site_city: comp.venue?.address?.city || null,
        site_state: comp.venue?.address?.state || null,
        away_team: awayAbbr,
        home_team: homeAbbr,
        away_seed: away.curatedRank?.current ?? null,
        home_seed: home.curatedRank?.current ?? null,
        away_score: Number(away.score),
        home_score: Number(home.score),
        away_1h: awayHalves.h1,
        away_2h: awayHalves.h2,
        home_1h: homeHalves.h1,
        home_2h: homeHalves.h2,
        line_provider: closingLine.provider,
        home_spread: closingLine.homeSpread,
        total_line: closingLine.total,
        home_moneyline: closingLine.homeMoneyline,
        away_moneyline: closingLine.awayMoneyline,
      });
      result.gamesFound++;
      result.gamesRecorded++;
    } catch (err) {
      result.skipped.push({ id: ev.id, reason: err.message });
    }
    await sleep(200);
  }
  return result;
}

// Last ~10 COMPLETED tournaments (2026 back through 2015), skipping 2020 (cancelled).
// Each window is generous (First Four through Championship plus a few days' padding) --
// trackCbbTournamentForDate() itself filters to real tournament games via the headline
// check above, so a day with no tournament games just records 0, cheaply.
const CBB_TOURNAMENT_WINDOWS = [
  { season: 2026, from: "20260317", to: "20260409" },
  { season: 2025, from: "20250317", to: "20250409" },
  { season: 2024, from: "20240317", to: "20240409" },
  { season: 2023, from: "20230313", to: "20230404" },
  { season: 2022, from: "20220314", to: "20220405" },
  { season: 2021, from: "20210314", to: "20210406" },
  { season: 2019, from: "20190317", to: "20190409" },
  { season: 2018, from: "20180311", to: "20180403" },
  { season: 2017, from: "20170312", to: "20170404" },
  { season: 2016, from: "20160313", to: "20160405" },
];

// One-time backfill endpoint (see sql/cbb-tournament-games-table.sql). Optional
// ?season=2024 restricts to one tournament (e.g. a retry after a partial failure);
// otherwise runs every window above. Not pulled by any cron job.
app.get("/internal/jobs/cbb-tournament-backfill", async (req, res) => {
  try {
    const onlySeason = req.query.season ? Number(req.query.season) : null;
    const windows = onlySeason ? CBB_TOURNAMENT_WINDOWS.filter((w) => w.season === onlySeason) : CBB_TOURNAMENT_WINDOWS;
    const results = [];
    for (const w of windows) {
      let d = new Date(Date.UTC(Number(w.from.slice(0, 4)), Number(w.from.slice(4, 6)) - 1, Number(w.from.slice(6, 8))));
      const end = new Date(Date.UTC(Number(w.to.slice(0, 4)), Number(w.to.slice(4, 6)) - 1, Number(w.to.slice(6, 8))));
      let seasonRecorded = 0;
      while (d <= end) {
        const yyyymmdd = d.toISOString().slice(0, 10).replace(/-/g, "");
        const r = await trackCbbTournamentForDate(yyyymmdd, w.season);
        seasonRecorded += r.gamesRecorded;
        d.setUTCDate(d.getUTCDate() + 1);
        await sleep(150);
      }
      results.push({ season: w.season, gamesRecorded: seasonRecorded });
    }
    res.json({ ok: true, seasons: results.length, totalGamesRecorded: results.reduce((s, r) => s + r.gamesRecorded, 0), results });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- CFB (FBS college football) engine tracker (2026-11-04, Seb's request, additive --
// same pattern as the NBA/NHL/NCAAB trackers above, nothing existing touched). ---
function cfbDocId(team) {
  const base = team?.abbreviation || team?.displayName || String(team?.id || "");
  return base.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) || `T${team?.id}`;
}

// FBS season runs Aug(camp)/Sep-Jan(playoff). Jul-Dec dates belong to the season STARTING
// that year; Jan-Jun dates (playoff/bowls) belong to the season that started the PREVIOUS
// year. Used to tag every cfb_game_logs row so last season's backfilled rows stay
// queryable for PATTERNS without ever being averaged into this season's live cfbTeams
// ratings (same purpose as CBB's seasonForDate()).
function seasonForCfbDate(yyyymmdd) {
  const year = Number(yyyymmdd.slice(0, 4));
  const month = Number(yyyymmdd.slice(4, 6));
  return String(month >= 7 ? year : year - 1);
}

function extractCfbTeamStats(teamBlock) {
  const stats = teamBlock?.statistics || [];
  const find = (name) => stats.find((s) => s.name === name)?.displayValue;
  const num = (name) => {
    const v = Number(find(name));
    return Number.isFinite(v) ? v : null;
  };
  return {
    totalYards: num("totalYards"),
    passYards: num("netPassingYards"),
    rushYards: num("rushingYards"),
    turnovers: num("turnovers"),
  };
}

async function upsertCfbGameRow(row) {
  await supabaseFetch(`/cfb_game_logs?on_conflict=game_id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ ...row, updated_at: new Date().toISOString() }]),
  });
}

async function trackCfbForDate(yyyymmdd) {
  const result = { date: yyyymmdd, gamesFound: 0, gamesRecorded: 0, skipped: [] };
  let scoreboard;
  try {
    scoreboard = await getJson(
      `${ESPN_BASE}/football/college-football/scoreboard?dates=${yyyymmdd}&groups=80&limit=200`
    );
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
      const awayAbbr = cfbDocId(away.team);
      const homeAbbr = cfbDocId(home.team);

      const summary = await getJson(`${ESPN_BASE}/football/college-football/summary?event=${ev.id}`);
      const teamBlocks = summary.boxscore?.teams || [];
      const awayBlock = teamBlocks.find((tb) => cfbDocId(tb.team) === awayAbbr);
      const homeBlock = teamBlocks.find((tb) => cfbDocId(tb.team) === homeAbbr);
      if (!awayBlock || !homeBlock) {
        result.skipped.push({ id: ev.id, reason: "no boxscore.teams match for one side" });
        continue;
      }
      const awayStats = extractCfbTeamStats(awayBlock);
      const homeStats = extractCfbTeamStats(homeBlock);
      const closingLine = extractCbbClosingLine(summary); // generic over summary.pickcenter, not basketball-specific

      await upsertCfbGameRow({
        game_id: ev.id,
        date: isoDate,
        season: seasonForCfbDate(yyyymmdd),
        away_team: awayAbbr,
        home_team: homeAbbr,
        away_score: Number(away.score),
        home_score: Number(home.score),
        line_provider: closingLine.provider,
        home_spread: closingLine.homeSpread,
        total_line: closingLine.total,
        home_moneyline: closingLine.homeMoneyline,
        away_moneyline: closingLine.awayMoneyline,
        away_total_yards: awayStats.totalYards,
        home_total_yards: homeStats.totalYards,
        away_pass_yards: awayStats.passYards,
        home_pass_yards: homeStats.passYards,
        away_rush_yards: awayStats.rushYards,
        home_rush_yards: homeStats.rushYards,
        away_turnovers: awayStats.turnovers,
        home_turnovers: homeStats.turnovers,
      });
      result.gamesRecorded++;
    } catch (err) {
      result.skipped.push({ id: ev.id, reason: err.message });
    }
    await sleep(200); // pace ESPN calls, esp. during the season-long backfill
  }
  return result;
}

// Aggregates cfb_game_logs into per-team season numbers (own + allowed yards/turnovers,
// home/away, last-3), merges in ESPN standings (overall record, conference, conference
// record -- via stat entries typed "total"/"homerecord"/"awayrecord"/"vsconf", each
// carrying a ready-made "W-L" `summary` string) and both polls available on the
// rankings endpoint (AP Top 25 + the CFP committee's "Playoff Committee Rankings", once
// it starts -- usually not until a few weeks into the season, same not-out-yet
// tolerance as CBB's AP poll before week 1). SOS proxy: same disclosed approximation as
// NBA/CBB (average current win% of opponents actually played), never a real formula.
async function refreshCfbTeams() {
  const currentSeason = seasonForCfbDate(new Date().toISOString().slice(0, 10).replace(/-/g, ""));
  const standings = await getJson(`${ESPN_V2_BASE}/football/college-football/standings?group=80`);
  const byTeam = {};
  const conferenceOf = {};
  for (const child of standings.children || []) {
    for (const e of child.standings?.entries || []) {
      const abbr = cfbDocId(e.team);
      if (!abbr) continue;
      conferenceOf[abbr] = child.name || null;
      const findSummary = (type) => e.stats?.find((s) => s.type === type)?.summary ?? null;
      byTeam[abbr] = {
        teamName: e.team?.displayName,
        record: findSummary("total"),
        confRecord: findSummary("vsconf"),
        homeRecord: findSummary("homerecord"),
        awayRecord: findSummary("awayrecord"),
      };
    }
  }

  let apRanks = {};
  let cfpRanks = {};
  try {
    const rankings = await getJson(`${ESPN_BASE}/football/college-football/rankings`);
    const apPoll = (rankings.rankings || []).find((r) => /ap top 25/i.test(r.name || r.shortName || ""));
    for (const r of apPoll?.ranks || []) {
      const abbr = cfbDocId(r.team);
      if (abbr) apRanks[abbr] = r.current;
    }
    const cfpPoll = (rankings.rankings || []).find((r) => /playoff committee/i.test(r.name || r.shortName || ""));
    for (const r of cfpPoll?.ranks || []) {
      const abbr = cfbDocId(r.team);
      if (abbr) cfpRanks[abbr] = r.current;
    }
  } catch (err) {
    // No poll out yet (early season, before the CFP committee starts ranking) or shape
    // differs -- leave empty rather than guess, same tolerance as CBB's AP poll.
  }

  const gamesRes = await supabaseFetch(
    `/cfb_game_logs?season=eq.${currentSeason}&select=away_team,home_team,away_score,home_score,away_total_yards,home_total_yards,away_pass_yards,home_pass_yards,away_rush_yards,home_rush_yards,away_turnovers,home_turnovers,date&order=date.asc&limit=5000`
  );
  const games = await gamesRes.json();

  const agg = {};
  const ensure = (abbr) =>
    (agg[abbr] ||= {
      played: 0, wins: 0,
      ptsFor: 0, ptsAgainst: 0,
      yardsFor: [], yardsAgainst: [], passYardsFor: [], rushYardsFor: [],
      turnoversFor: [], turnoversForced: [],
      opponents: [], last3: [],
    });

  for (const g of games) {
    for (const side of ["away", "home"]) {
      const other = side === "away" ? "home" : "away";
      const abbr = g[`${side}_team`];
      const oppAbbr = g[`${other}_team`];
      if (!abbr) continue;
      const t = ensure(abbr);
      const my = g[`${side}_score`];
      const opp = g[`${other}_score`];
      if (my == null || opp == null) continue;
      t.played++;
      const won = my > opp;
      if (won) t.wins++;
      t.ptsFor += my; t.ptsAgainst += opp;
      if (g[`${side}_total_yards`] != null) t.yardsFor.push(g[`${side}_total_yards`]);
      if (g[`${other}_total_yards`] != null) t.yardsAgainst.push(g[`${other}_total_yards`]);
      if (g[`${side}_pass_yards`] != null) t.passYardsFor.push(g[`${side}_pass_yards`]);
      if (g[`${side}_rush_yards`] != null) t.rushYardsFor.push(g[`${side}_rush_yards`]);
      if (g[`${side}_turnovers`] != null) t.turnoversFor.push(g[`${side}_turnovers`]);
      if (g[`${other}_turnovers`] != null) t.turnoversForced.push(g[`${other}_turnovers`]);
      if (oppAbbr) t.opponents.push(oppAbbr);
      t.last3.push({ date: g.date, win: won });
    }
  }

  const avg = (arr) => (arr.length ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)) : null);
  const winPct = (abbr) => {
    const bt = byTeam[abbr];
    const m = /^(\d+)-(\d+)/.exec(bt?.record || "");
    if (m) {
      const w = Number(m[1]), l = Number(m[2]);
      if (w + l > 0) return w / (w + l);
    }
    const a = agg[abbr];
    return a?.played ? a.wins / a.played : null;
  };

  // League-wide rank positions (2026-11-04, Seb's request, same spirit as NBA's offRank/
  // defRank -- matches the existing weekly Claude tracker's field semantics: offRank/
  // defRank by scoring (ptsFor/ptsAgainst), totalOffRank/totalDefRank by total yards
  // (yardsFor/yardsAgainst allowed), among every FBS team with at least one played game.
  const rankBy = (getter, ascending) => {
    const withValue = Object.keys(agg).filter((abbr) => agg[abbr].played > 0 && getter(agg[abbr]) != null);
    withValue.sort((x, y) => (ascending ? getter(agg[x]) - getter(agg[y]) : getter(agg[y]) - getter(agg[x])));
    const ranks = {};
    withValue.forEach((abbr, i) => (ranks[abbr] = i + 1));
    return ranks;
  };
  const offRanks = rankBy((a) => a.ptsFor / a.played, false);
  const defRanks = rankBy((a) => a.ptsAgainst / a.played, true);
  const totalOffRanks = rankBy((a) => avg(a.yardsFor), false);
  const totalDefRanks = rankBy((a) => avg(a.yardsAgainst), true);

  const result = { teamsUpdated: 0, errors: [] };
  const abbrs = new Set([...Object.keys(byTeam), ...Object.keys(agg)]);
  for (const abbr of abbrs) {
    const bt = byTeam[abbr] || {};
    const a = agg[abbr];
    const patch = {
      teamName: bt.teamName ?? undefined,
      conference: conferenceOf[abbr] ?? undefined,
      record: bt.record ?? undefined,
      confRecord: bt.confRecord ?? undefined,
      homeRecord: bt.homeRecord ?? undefined,
      awayRecord: bt.awayRecord ?? undefined,
      apRank: apRanks[abbr] ?? undefined,
      cfpRank: cfpRanks[abbr] ?? undefined,
      offRank: offRanks[abbr] ?? undefined,
      defRank: defRanks[abbr] ?? undefined,
      totalOffRank: totalOffRanks[abbr] ?? undefined,
      totalDefRank: totalDefRanks[abbr] ?? undefined,
      approxRatings: true,
    };
    if (a) {
      patch.ptsFor = a.played ? Number((a.ptsFor / a.played).toFixed(1)) : undefined;
      patch.ptsAgainst = a.played ? Number((a.ptsAgainst / a.played).toFixed(1)) : undefined;
      patch.yardsFor = avg(a.yardsFor) ?? undefined;
      patch.yardsAgainst = avg(a.yardsAgainst) ?? undefined;
      patch.passYardsFor = avg(a.passYardsFor) ?? undefined;
      patch.rushYardsFor = avg(a.rushYardsFor) ?? undefined;
      patch.turnoversPerGame = avg(a.turnoversFor) ?? undefined;
      patch.turnoversForcedPerGame = avg(a.turnoversForced) ?? undefined;
      const last3 = a.last3.slice(-3);
      patch.last3 = last3.length ? `${last3.filter((g) => g.win).length}-${last3.filter((g) => !g.win).length}` : undefined;
      const oppWinPcts = a.opponents.map(winPct).filter((v) => v != null);
      patch.sosProxy = oppWinPcts.length ? Number((oppWinPcts.reduce((s, v) => s + v, 0) / oppWinPcts.length).toFixed(3)) : undefined;
      patch.sampleGames = a.played;
    }
    try {
      await mergeUpsertDoc("main", "cfbTeams", abbr, patch);
      result.teamsUpdated++;
    } catch (err) {
      result.errors.push({ abbr, error: err.message });
    }
  }

  await mergeUpsertDoc("main", "cfb", "meta", {
    lastUpdated: new Date().toISOString().slice(0, 10),
    apTop25Available: Object.keys(apRanks).length > 0,
    cfpRankingsAvailable: Object.keys(cfpRanks).length > 0,
    currentSeason,
  });
  return result;
}

// Pulled nightly by a Supabase pg_cron job (see sql/cfb-tracker-cron-run-me.sql). Same
// date/from/to backfill convention as the CBB/NHL trackers above -- from/to here covers
// the one-time whole-2026-season backfill Seb asked for, run manually once.
app.get("/internal/jobs/cfb-nightly-tracker", async (req, res) => {
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
      results.push(await trackCfbForDate(d));
      await sleep(300);
    }
    const teamsResult = await refreshCfbTeams();
    res.json({
      ok: true,
      nights: results.length,
      gamesRecorded: results.reduce((s, r) => s + r.gamesRecorded, 0),
      results,
      cfbTeams: teamsResult,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- NCAAB daily check (2026-11-04, Seb's request, additive). Writes directly to
// Supabase (desk "main", collection "cbb", doc "today") -- this process has no
// ArtifactData access, and builders read team data from Supabase for this sport anyway.
// This doc is engine-owned end to end each day (full replace is safe here, unlike
// cfbTeams/cbbTeams which other writers also touch) -- the ONE exception is the busy-day
// Sonnet routine below, which reads the full doc, merges its own "notes" field in, and
// posts the full doc back, same WRITE-BODY SHAPE convention as every other merge-write on
// this server. ---
function normTeamName(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, "").trim();
}
function oddsTeamMatches(espnName, oddsName) {
  const a = normTeamName(espnName);
  const b = normTeamName(oddsName);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a) || a.split(" ").pop() === b.split(" ").pop();
}

const CBB_POWER_CONFERENCES = [
  "southeastern conference", "big ten conference", "big 12 conference", "atlantic coast conference", "big east conference",
];

async function fetchCbbTodayOddsGames() {
  if (!ODDS_API_KEY) return [];
  const markets = "h2h,spreads,totals,h2h_h1,spreads_h1,totals_h1,h2h_h2,spreads_h2,totals_h2";
  const url = new URL(`${ODDS_BASE}/sports/basketball_ncaab/odds/`);
  url.searchParams.set("apiKey", ODDS_API_KEY);
  url.searchParams.set("regions", "us");
  url.searchParams.set("markets", markets);
  url.searchParams.set("oddsFormat", "american");
  url.searchParams.set("bookmakers", "draftkings");
  try {
    return await getOddsJson(url.toString());
  } catch (err) {
    return []; // unpriced/unavailable -- callers treat an empty match as "no DK line yet"
  }
}

function extractDkLinesForGame(oddsGame) {
  const dk = (oddsGame.bookmakers || []).find((b) => /draftkings/i.test(b.title || ""));
  if (!dk) return null;
  const byKey = {};
  for (const m of dk.markets || []) byKey[m.key] = m.outcomes;
  const pack = (h2h, spreads, totals) => ({
    moneyline: byKey[h2h] || null,
    spread: byKey[spreads] || null,
    total: byKey[totals] || null,
  });
  return { full: pack("h2h", "spreads", "totals"), h1: pack("h2h_h1", "spreads_h1", "totals_h1"), h2: pack("h2h_h2", "spreads_h2", "totals_h2") };
}

async function buildCbbTodaySnapshot() {
  const todayYmd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const scoreboard = await getJson(`${ESPN_BASE}/basketball/mens-college-basketball/scoreboard?dates=${todayYmd}&limit=400`);
  const events = scoreboard.events || [];
  const oddsGames = await fetchCbbTodayOddsGames();

  let injuries = [];
  try {
    const injRes = await getJson(`${ESPN_BASE}/basketball/mens-college-basketball/injuries`);
    injuries = injRes.injuries || [];
  } catch (err) {
    injuries = [];
  }

  // Team profiles for everyone playing today, pulled from the engine's own Supabase mirror.
  const abbrsToday = new Set();
  for (const ev of events) {
    for (const c of ev.competitions?.[0]?.competitors || []) {
      const abbr = cbbDocId(c.team);
      if (abbr) abbrsToday.add(abbr);
    }
  }
  const profiles = {};
  if (abbrsToday.size) {
    const list = await supabaseFetch(
      `/docs?desk_id=eq.main&collection=eq.cbbTeams&doc_id=in.(${[...abbrsToday].join(",")})&select=doc_id,data`
    );
    for (const row of await list.json()) profiles[row.doc_id] = row.data;
  }

  let busyGameCount = 0;
  const games = events.map((ev) => {
    const comp = ev.competitions?.[0];
    const away = comp?.competitors?.find((c) => c.homeAway === "away");
    const home = comp?.competitors?.find((c) => c.homeAway === "home");
    const awayAbbr = cbbDocId(away?.team);
    const homeAbbr = cbbDocId(home?.team);
    const awayProfile = profiles[awayAbbr] || null;
    const homeProfile = profiles[homeAbbr] || null;
    const isTop25OrPower = (p) =>
      p && (p.apRank != null || CBB_POWER_CONFERENCES.includes((p.conference || "").toLowerCase()));
    if (isTop25OrPower(awayProfile) || isTop25OrPower(homeProfile)) busyGameCount++;

    const oddsMatch = oddsGames.find(
      (g) => oddsTeamMatches(away?.team?.displayName, g.away_team) && oddsTeamMatches(home?.team?.displayName, g.home_team)
    );
    const dkLines = oddsMatch ? extractDkLinesForGame(oddsMatch) : null;

    return {
      gameId: ev.id,
      matchup: ev.name,
      tipTime: comp?.date || ev.date,
      awayTeam: awayAbbr,
      homeTeam: homeAbbr,
      dkLines,
      awayProfile,
      homeProfile,
    };
  });

  return {
    date: `${todayYmd.slice(0, 4)}-${todayYmd.slice(4, 6)}-${todayYmd.slice(6, 8)}`,
    games,
    injuries,
    busyGameCount,
    generatedAt: new Date().toISOString(),
  };
}

app.get("/internal/jobs/cbb-daily-snapshot", async (req, res) => {
  try {
    const snapshot = await buildCbbTodaySnapshot();
    await upsertDoc("main", "cbb", "today", snapshot);

    const BUSY_THRESHOLD = 8;
    let fired = false;
    if (snapshot.busyGameCount >= BUSY_THRESHOLD) {
      fired = await triggerCbbDailyFire().catch((err) => {
        console.error("cbb-daily-snapshot: busy-day fire failed:", err.message);
        return false;
      });
    }
    res.json({ ok: true, gamesFound: snapshot.games.length, busyGameCount: snapshot.busyGameCount, fired });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

const CBB_DAILY_FIRE_URL = process.env.CBB_DAILY_FIRE_URL;
const CBB_DAILY_FIRE_TOKEN = process.env.CBB_DAILY_FIRE_TOKEN;

async function triggerCbbDailyFire(text) {
  if (!CBB_DAILY_FIRE_URL || !CBB_DAILY_FIRE_TOKEN) {
    throw new Error("CBB_DAILY_FIRE_URL/CBB_DAILY_FIRE_TOKEN not configured on the server.");
  }
  const fireRes = await fetch(CBB_DAILY_FIRE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CBB_DAILY_FIRE_TOKEN}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "experimental-cc-routine-2026-04-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(text ? { text } : {}),
  });
  if (!fireRes.ok) {
    const body = await fireRes.text();
    throw new Error(`CBB daily busy-day fire -> HTTP ${fireRes.status}: ${body}`);
  }
  return true;
}

// Diagnostic/manual test for the CBB_DAILY_FIRE_URL/TOKEN wiring (2026-11-04, Seb's
// request). GET with no params: reports whether both env vars are present, never their
// values, and fires nothing. GET ?fire=true: also sends ONE fire with the
// "BUSY_DAY_FIRE_TEST" marker -- the routine's own prompt branches on that marker to DM
// Seb only ("busy-day fire test OK", no group post) and make no desk/Supabase writes,
// skipping every real step.
app.get("/internal/jobs/cbb-daily-fire-test", async (req, res) => {
  const urlSet = !!CBB_DAILY_FIRE_URL;
  const tokenSet = !!CBB_DAILY_FIRE_TOKEN;
  if (req.query.fire !== "true") {
    return res.json({ ok: true, urlSet, tokenSet, fired: false });
  }
  if (!urlSet || !tokenSet) {
    return res.json({ ok: true, urlSet, tokenSet, fired: false, error: "CBB_DAILY_FIRE_URL/CBB_DAILY_FIRE_TOKEN not configured" });
  }
  try {
    await triggerCbbDailyFire("BUSY_DAY_FIRE_TEST");
    res.json({ ok: true, urlSet, tokenSet, fired: true });
  } catch (err) {
    res.status(502).json({ ok: false, urlSet, tokenSet, fired: false, error: err.message });
  }
});

// --- News layer (2026-11-04, Seb's request, additive, code-only -- fires no Claude
// routine, ever). Collections "news" and "news"/"notifiedState" are NOT in
// docs_app_insert_dispatch's collection whitelist ('requests'/'appUploads'/'appEdits')
// and NOT in sync-needed's SYNC_NEEDED_COLLECTIONS -- writing to them cannot trigger any
// wake/Claude run through any existing path. Soccer is intentionally excluded below --
// ESPN's injuries/transactions feeds are confirmed empty for soccer (2026-11-04); soccer
// injury context stays on the existing sofascore/fotmob Claude routine (rule
// soccer-stats-source), unaffected by any of this.
const NEWS_LEAGUES = {
  nfl: { sport: "football", league: "nfl", hasTransactions: true },
  nba: { sport: "basketball", league: "nba", hasTransactions: true },
  nhl: { sport: "hockey", league: "nhl", hasTransactions: true },
  cbb: { sport: "basketball", league: "mens-college-basketball", hasTransactions: true },
  cfb: { sport: "football", league: "college-football", hasTransactions: false }, // confirmed empty/non-existent for CFB
};

function extractInjuryItems(teamsBlock) {
  const items = [];
  for (const team of teamsBlock || []) {
    for (const inj of team.injuries || []) {
      const a = inj.athlete || {};
      items.push({
        player: a.displayName || null,
        lastName: a.lastName || null,
        team: { abbr: a.team?.abbreviation || null, location: a.team?.location || team.displayName || null, name: a.team?.name || null },
        position: a.position?.abbreviation || null,
        status: inj.status || null,
        date: inj.date || null,
        note: inj.shortComment || null,
      });
    }
  }
  return items;
}

// Transaction classification (2026-11-04, Seb's ask, tightened after the test run's 14
// false alarms were all roster noise): each description is one or more sentences, each
// naming at most one player and one action. Alert-worthy actions are trade/release/
// suspension/a NEW injured-reserve placement -- IGNORE wins when a sentence matches both
// (e.g. "Released ... from the practice squad" is a release, but practice-squad makes it
// noise, not a real roster move). Call-ups/send-downs/minors/waivers/practice-squad/an
// IR ACTIVATION (a player returning, not getting hurt)/reinstatement are all ignored for
// alerting purposes -- but every transaction, alert-worthy or not, still gets stored in
// news/<league> so builders can read the full feed regardless.
const TXN_ALERT_RE = /\btraded\b|\breleased\b|\bsuspended\b|\bplaced\b.*\binjured reserve\b/i;
const TXN_IGNORE_RE = /\brecalled\b|\bassigned\b.*\bminors\b|\bsent\b.*\bdown\b|\bwaivers\b|\bpractice squad\b|\bactivated\b.*\binjured reserve\b|\breinstated\b|\bdesignated\b.*\breturn\b/i;
const TXN_PLAYER_RE = /\b[A-Z]{1,3}\s+([A-Z][a-zA-Z'.-]+(?:\s+[A-Z][a-zA-Z'.-]+){0,3}?)(?=\s+(?:to|from|on|for|without|off|down|\d|\(|\.|$)|\.|$)/;

function classifyTransactionSentence(sentence) {
  const isIgnore = TXN_IGNORE_RE.test(sentence);
  const isAlertWorthy = !isIgnore && TXN_ALERT_RE.test(sentence);
  const m = TXN_PLAYER_RE.exec(sentence);
  const player = m ? m[1].replace(/\.$/, "").trim() : null;
  return { text: sentence.trim(), isAlertWorthy, player, lastName: player ? player.split(" ").pop() : null };
}

function extractTransactionItems(txns) {
  return (txns || []).map((t) => {
    const description = t.description || "";
    const sentences = description.split(/(?<=\.)\s+/).filter(Boolean);
    return {
      date: t.date || null,
      team: { abbr: t.team?.abbreviation || null, location: t.team?.location || null, name: t.team?.name || null },
      description,
      actions: sentences.map(classifyTransactionSentence),
    };
  });
}

async function fetchLeagueNewsRaw(key) {
  const cfg = NEWS_LEAGUES[key];
  const result = { injuries: null, injuriesError: null, transactions: null, transactionsError: null };
  try {
    const j = await getJson(`${ESPN_BASE}/${cfg.sport}/${cfg.league}/injuries`);
    result.injuries = extractInjuryItems(j.injuries);
  } catch (err) {
    result.injuriesError = err.message;
  }
  if (cfg.hasTransactions) {
    try {
      const j = await getJson(`${ESPN_BASE}/${cfg.sport}/${cfg.league}/transactions`);
      result.transactions = extractTransactionItems(j.transactions);
    } catch (err) {
      result.transactionsError = err.message;
    }
  } else {
    result.transactions = [];
  }
  return result;
}

// Stale-on-failure write (2026-11-04, Seb's ask): never silently wipes a league's news to
// empty just because one poll errored or regressed from real data to zero. Keeps the
// PREVIOUS sub-feed's items in that case and marks it stale -- CFB's always-empty
// transactions feed never trips this (it never "had items" to regress from).
async function writeLeagueNewsDoc(key) {
  const fresh = await fetchLeagueNewsRaw(key);
  const prevRes = await supabaseFetch(`/docs?desk_id=eq.main&collection=eq.news&doc_id=eq.${key}&select=data`);
  const prevRows = await prevRes.json();
  const prev = prevRows[0]?.data || {};

  function resolve(freshItems, freshError, prevItems) {
    if (freshError) return { items: prevItems || [], stale: true, reason: freshError };
    if ((freshItems || []).length === 0 && (prevItems || []).length > 0) {
      return { items: prevItems, stale: true, reason: "regressed to 0 items this run" };
    }
    return { items: freshItems || [], stale: false, reason: null };
  }

  const inj = resolve(fresh.injuries, fresh.injuriesError, prev.injuries);
  const tx = resolve(fresh.transactions, fresh.transactionsError, prev.transactions);
  const now = new Date().toISOString();
  const doc = {
    league: key,
    injuries: inj.items,
    injuriesStale: inj.stale,
    injuriesStaleReason: inj.reason,
    transactions: tx.items,
    transactionsStale: tx.stale,
    transactionsStaleReason: tx.reason,
    lastGoodInjuriesAt: inj.stale ? prev.lastGoodInjuriesAt || null : now,
    lastGoodTransactionsAt: tx.stale ? prev.lastGoodTransactionsAt || null : now,
    checkedAt: now,
  };
  await upsertDoc("main", "news", key, doc);
  return doc;
}

function newsTeamIdStrings(team) {
  return [team?.abbr, team?.location, team?.name].filter(Boolean).map(normTeamName);
}

// Matching requirement (2026-11-04, Seb's ask): a bare last name with no team confirmation
// anywhere in the leg text is NOT a match at all (too risky -- common surnames). A full
// player name is always a high-confidence match. Last name + team ABBREVIATION is also
// high-confidence; last name + team CITY/NICKNAME only is "ambiguous" -- still reported,
// but hedged as "may affect" rather than asserted, per Seb's explicit ask not to skip it.
// Shared by the injury matcher and the transaction matcher so both apply the same tiers.
function matchNameInLegText(normLegText, fullName, lastName, team) {
  if (!normLegText) return null;
  const full = fullName ? normTeamName(fullName) : null;
  if (full && normLegText.includes(full)) return { confidence: "high" };
  const last = lastName ? normTeamName(lastName) : null;
  if (!last || !normLegText.includes(last)) return null;
  const abbrNorm = team?.abbr ? normTeamName(team.abbr) : null;
  const abbrMatch = abbrNorm && normLegText.includes(abbrNorm);
  const anyTeamMatch = newsTeamIdStrings(team).some((t) => normLegText.includes(t));
  if (!anyTeamMatch) return null; // last name alone, zero team confirmation -- not a match
  return { confidence: abbrMatch ? "high" : "ambiguous" };
}

function matchLegToInjury(legText, injury) {
  const text = normTeamName(legText);
  if (!text || !injury?.player) return null;
  return matchNameInLegText(text, injury.player, injury.lastName, injury.team);
}

// Transaction matching requirement (2026-11-04, Seb's fix after the first live test run
// alerted on 14 false positives -- all team-only matches on roster noise like call-ups and
// IR activations). A transaction only ever matches a leg if: (a) at least one of its
// sentences classified as alert-worthy (trade/release/suspension/new IR placement, never
// roster noise), AND (b) that sentence named a player, AND (c) that player is also named in
// the leg text (full name, or last name + team -- same tiers as the injury matcher). A
// team mentioned anywhere in the transaction is never sufficient on its own.
function matchLegToTransaction(legText, txn) {
  const text = normTeamName(legText);
  if (!text || !Array.isArray(txn?.actions)) return null;
  for (const action of txn.actions) {
    if (!action.isAlertWorthy || !action.player) continue;
    const m = matchNameInLegText(text, action.player, action.lastName, txn.team);
    if (m) return { ...m, player: action.player };
  }
  return null;
}

async function getNewsDocForLeague(key) {
  const r = await supabaseFetch(`/docs?desk_id=eq.main&collection=eq.news&doc_id=eq.${key}&select=data`);
  const rows = await r.json();
  return rows[0]?.data || null;
}

async function getNotifiedState() {
  const r = await supabaseFetch(`/docs?desk_id=eq.main&collection=eq.news&doc_id=eq.notifiedState&select=data`);
  const rows = await r.json();
  return rows[0]?.data || { keys: {} };
}

// Steve's private-chat routing (2026-11-04, Seb's ask): hardcoded, with a startup assertion
// that it can never equal the group chat id -- same belt-and-suspenders pattern as the
// one-off Steve weekly-report endpoint already uses. A news alert also runs through the
// SAME dollar-amount guard the group-post path uses (GROUP_DOLLAR_AMOUNT_RE), even though
// these are private DMs never headed to the group -- this feature's own text generation
// should never produce a $ amount at all, so this is a safety net, not the primary control.
const NEWS_STEVE_CHAT_ID = "1294297670";
if (NEWS_STEVE_CHAT_ID === TELEGRAM_GROUP_CHAT_ID) {
  throw new Error("FATAL: NEWS_STEVE_CHAT_ID equals TELEGRAM_GROUP_CHAT_ID -- refusing to start.");
}

async function sendNewsAlertDm(desk, text) {
  if (GROUP_DOLLAR_AMOUNT_RE.test(text)) {
    console.error("news-check: DM blocked by $-guard, not sent. desk:", desk);
    return { sent: false, blocked: true };
  }
  const chatId = desk === "steve" ? NEWS_STEVE_CHAT_ID : TELEGRAM_SEB_CHAT_ID;
  if (!chatId) return { sent: false, error: "chat id not configured" };
  if (chatId === TELEGRAM_GROUP_CHAT_ID) throw new Error("news-check: refusing to send -- chat id resolved to the group.");
  await sendTelegramRaw(chatId, text, false);
  return { sent: true };
}

// Dedupe key = player + status + betId (2026-11-04, Seb's ask): a bet placed AFTER news
// already existed still gets its own alert, since it's a new key. One DM per owner still
// bundles every newly-affected ticket for that same underlying news, rather than one DM
// per ticket.
async function checkOpenBetsAgainstNews(newsByLeague, opts = {}) {
  const dryRun = !!opts.dryRun;
  const notified = await getNotifiedState();
  const newKeys = {};
  const dmsByDesk = {};

  for (const desk of ["main", "steve"]) {
    const r = await supabaseFetch(`/docs?desk_id=eq.${desk}&collection=eq.pnlEntries&select=doc_id,data`);
    const docs = await r.json();
    for (const doc of docs) {
      const d = doc.data || {};
      if (d.type !== "bet") continue;
      if (!["pending", "needs_review"].includes(d.status)) continue;
      const leagueKey = (d.league || "").toLowerCase();
      const news = newsByLeague[leagueKey];
      if (!news) continue;
      for (const leg of d.legs || []) {
        for (const inj of news.injuries || []) {
          if (!["out", "doubtful"].includes((inj.status || "").toLowerCase())) continue;
          const m = matchLegToInjury(leg.text, inj);
          if (!m) continue;
          const key = `inj|${normTeamName(inj.player)}|${(inj.status || "").toLowerCase()}|${doc.doc_id}`;
          if (notified.keys?.[key]) continue;
          newKeys[key] = { at: new Date().toISOString() };
          (dmsByDesk[desk] ||= []).push({ betLabel: d.desc || d.ticketId || doc.doc_id, player: inj.player, status: inj.status, confidence: m.confidence });
        }
        for (const txn of news.transactions || []) {
          const m2 = matchLegToTransaction(leg.text, txn);
          if (!m2) continue;
          const key = `txn|${normTeamName(m2.player)}|${txn.date}|${doc.doc_id}`;
          if (notified.keys?.[key]) continue;
          newKeys[key] = { at: new Date().toISOString() };
          (dmsByDesk[desk] ||= []).push({ betLabel: d.desc || d.ticketId || doc.doc_id, transaction: true, player: m2.player, team: txn.team?.abbr || txn.team?.name, confidence: m2.confidence });
        }
      }
    }
  }

  const sentSummary = { main: 0, steve: 0 };
  for (const desk of Object.keys(dmsByDesk)) {
    const items = dmsByDesk[desk];
    if (!items.length) continue;
    const lines = items.map((it) => {
      const hedge = it.confidence === "ambiguous" ? "may affect" : "affects";
      if (it.transaction) return `${it.player} (${it.team}) -- ${hedge}: ${it.betLabel}`;
      return `${it.player} now ${it.status} -- ${hedge}: ${it.betLabel}`;
    });
    const text = `\u{1F4F0} News check:\n${lines.join("\n")}`;
    if (dryRun) {
      sentSummary[desk] += items.length;
      continue;
    }
    const r = await sendNewsAlertDm(desk, text).catch((err) => ({ sent: false, error: err.message }));
    if (r.sent) sentSummary[desk] += items.length;
  }

  if (!dryRun && Object.keys(newKeys).length) {
    await upsertDoc("main", "news", "notifiedState", { keys: { ...(notified.keys || {}), ...newKeys } });
  }
  return { newAlerts: Object.keys(newKeys).length, sentSummary, dmsByDesk: dryRun ? dmsByDesk : undefined };
}

async function runNewsCheck(opts = {}) {
  const dryRun = !!opts.dryRun;
  const newsByLeague = {};
  const counts = {};
  for (const key of Object.keys(NEWS_LEAGUES)) {
    const doc = await writeLeagueNewsDoc(key);
    newsByLeague[key] = doc;
    counts[key] = { injuries: doc.injuries.length, transactions: doc.transactions.length, injuriesStale: doc.injuriesStale, transactionsStale: doc.transactionsStale };
  }
  const betCheck = await checkOpenBetsAgainstNews(newsByLeague, { dryRun });
  return { counts, ...betCheck };
}

// dryRun=true (manual verification only, never set by the cron SQL): still polls ESPN and
// writes news/<league> as normal, but skips sending any DM and skips writing notifiedState
// -- returns dmsByDesk so you can see exactly what WOULD have gone out.
app.get("/internal/jobs/news-check", async (req, res) => {
  try {
    const dryRun = req.query.dryRun === "true";
    const result = await runNewsCheck({ dryRun });
    res.json({ ok: true, dryRun, ...result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Read-only synthetic test for the injury matcher (Seb's ask, 2026-11-04): pulls today's
// real NFL injuries, picks one real Out player (full-name case) and one real Doubtful
// player (last-name+team case), plus a fabricated last-name-on-the-wrong-team case that
// must NOT match. No DMs, no Supabase writes.
app.get("/internal/jobs/news-matcher-test", async (req, res) => {
  try {
    const raw = await fetchLeagueNewsRaw("nfl");
    const injuries = raw.injuries || [];
    const outPlayer = injuries.find((i) => (i.status || "").toLowerCase() === "out");
    const doubtfulPlayer = injuries.find((i) => (i.status || "").toLowerCase() === "doubtful");
    const cases = [];
    if (outPlayer) {
      const legText = `${outPlayer.player} to score a TD`;
      cases.push({ case: "full_name_out", legText, player: outPlayer.player, status: outPlayer.status, result: matchLegToInjury(legText, outPlayer) });
    }
    if (doubtfulPlayer) {
      const teamTag = doubtfulPlayer.team?.abbr || doubtfulPlayer.team?.name || "";
      const legText = `${doubtfulPlayer.lastName} (${teamTag}) over 50 rush yards`;
      cases.push({ case: "lastname_plus_team_doubtful", legText, player: doubtfulPlayer.player, status: doubtfulPlayer.status, result: matchLegToInjury(legText, doubtfulPlayer) });
    }
    if (outPlayer) {
      // Same last name, but the leg names a DIFFERENT team than the player's real one
      // (outPlayer.team is left untouched) -- anyTeamMatch should fail, so this must be
      // null, never a match.
      const fakeOtherTeam = normTeamName(outPlayer.team?.abbr) === normTeamName("ZZZ") ? "YYY" : "ZZZ";
      const legText = `${outPlayer.lastName} (${fakeOtherTeam}) to score a TD`;
      cases.push({ case: "lastname_wrong_team_should_not_match", legText, player: outPlayer.player, status: outPlayer.status, realTeam: outPlayer.team, result: matchLegToInjury(legText, outPlayer) });
    }
    res.json({ ok: true, cases });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Fast path (2026-11-04, Seb's ask -- NFL inactives post ~90 min before kickoff): every 30
// min, but a cheap no-op unless an open bet (either desk) has a leg kicking off within the
// next 3 hours -- only then does it actually hit ESPN/run the full check. Still code-only,
// zero Claude usage either way.
app.get("/internal/jobs/news-check-fast", async (req, res) => {
  try {
    const now = Date.now();
    const horizon = now + 3 * 60 * 60 * 1000;
    let imminent = false;
    for (const desk of ["main", "steve"]) {
      const r = await supabaseFetch(`/docs?desk_id=eq.${desk}&collection=eq.pnlEntries&select=data`);
      const docs = await r.json();
      for (const doc of docs) {
        const d = doc.data || {};
        if (d.type !== "bet" || !["pending", "needs_review"].includes(d.status)) continue;
        const t = d.lastStart || d.firstStart;
        if (!t) continue;
        const ts = new Date(t).getTime();
        if (Number.isFinite(ts) && ts > now && ts <= horizon) {
          imminent = true;
          break;
        }
      }
      if (imminent) break;
    }
    if (!imminent) return res.json({ ok: true, action: "none", imminent: false });
    const result = await runNewsCheck();
    res.json({ ok: true, imminent: true, ...result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Ticket Gate (2026-11-05/06, Seb's request after the JAX@BAL sign-conversion bug and
// the MIA@GSW out-of-band 3u SGP) ------------------------------------------------------
// Code-level, deterministic validation of a single ticket -- see ticket-gate.js for the
// check definitions. Called by a builder (via WebFetch, same pattern as /odds) right
// after it writes a ticket and BEFORE it marks the request "answered": the builder reads
// this endpoint's pass/fail JSON and, on failure with retriesUsed < 2, fixes that
// specific ticket and calls this again (that retry loop lives in the builder's own
// prompt, since fixing a ticket needs real research -- this endpoint only ever judges,
// deterministically, never rewrites a ticket itself). After 2 real failures the builder
// still answers the request, but writes gateWarning on the ticket itself so the desk UI
// can flag it -- this endpoint doesn't need to do that write, it just tells the builder
// retriesUsed has reached the cap in its response.
//
// mode=shadow (default): judges for real and logs to gate_results, but is purely
// informational -- safe to call against live traffic while this is being proven out,
// same shadow-mode discipline as /internal/jobs/grade-and-alert. mode=live: identical
// judging and logging; the only difference is the response's `blocking` field, which a
// wired-in builder prompt would treat as true to actually gate on. No live builder prompt
// reads this endpoint yet (see the handoff note) -- mode=live does not change engine
// behavior until that prompt wiring ships.
//
// Params: desk (main|steve), requestId (for logging/attempt-counting), ticketId
// (required) OR a raw ticket body posted ad hoc for testing -- this route is GET-only
// (WebFetch-callable) and always resolves the ticket by reading it from Supabase's own
// "parlays" mirror, same source every other grading job already trusts.
async function fetchTicketGateNews(leagues) {
  const out = {};
  for (const lg of leagues) {
    const key = (lg || "").toLowerCase();
    if (!key || out[key] !== undefined) continue;
    out[key] = await getNewsDocForLeague(key).catch(() => null);
  }
  return out;
}

app.get("/internal/jobs/ticket-gate", async (req, res) => {
  const desk = req.query.desk;
  const requestId = req.query.requestId || null;
  const ticketId = req.query.ticketId;
  const mode = req.query.mode === "live" ? "live" : "shadow";
  if (!DESKS.includes(desk)) return res.status(404).json({ error: `unknown desk: ${desk}` });
  if (!ticketId) return res.status(400).json({ error: "ticketId is required" });
  try {
    const ticketDoc = await getDoc(desk, "parlays", ticketId);
    if (!ticketDoc) {
      return res.status(404).json({ error: `no parlays/${ticketId} found in Supabase for desk ${desk} yet -- the engine only gates what's already mirrored` });
    }
    const ticket = { id: ticketId, ...ticketDoc.data };

    const newsByLeague = await fetchTicketGateNews([ticket.league]);

    // Cross-desk contradiction check: the OTHER desk's ticket(s) for the same game + date, if any.
    const otherDesk = desk === "main" ? "steve" : desk === "steve" ? "main" : null;
    let otherDeskTickets = [];
    if (otherDesk && ticket.game && ticket.date) {
      const r = await supabaseFetch(
        `/docs?desk_id=eq.${otherDesk}&collection=eq.parlays&data->>game=eq.${encodeURIComponent(ticket.game)}&data->>date=eq.${encodeURIComponent(ticket.date)}&select=doc_id,data`
      );
      const rows = await r.json();
      otherDeskTickets = rows.map((row) => ({ id: row.doc_id, ...row.data }));
    }

    // Attempt number: how many times this exact ticket has already been gated.
    const priorRes = await supabaseFetch(
      `/gate_results?desk=eq.${desk}&ticket_id=eq.${encodeURIComponent(ticketId)}&select=id`
    ).catch(() => null);
    const priorCount = priorRes ? (await priorRes.json()).length : 0;
    const attempt = priorCount + 1;

    const result = runTicketGate(ticket, { newsByLeague, matchLegToInjury, otherDeskTickets, now: Date.now() });

    await supabaseFetch("/gate_results", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify([
        {
          desk,
          request_id: requestId,
          ticket_id: ticketId,
          attempt,
          mode,
          passed: result.passed,
          checks: result.checks,
          failures: result.failures,
        },
      ]),
    }).catch((err) => console.warn(`[ticket-gate] gate_results log failed: ${err.message}`));

    res.json({
      ok: true,
      desk,
      requestId,
      ticketId,
      mode,
      attempt,
      retriesUsed: attempt - 1,
      retriesExhausted: attempt - 1 >= 2,
      blocking: mode === "live",
      passed: result.passed,
      failures: result.failures,
      checks: result.checks,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Soccer data source swap -- read-only test (2026-11-04, Seb's request) ------------
// Nothing here is wired into anything live. Just proves out API-Football + Understat as
// potential replacements/supplements for the current sofascore/fotmob soccer source, and
// reports real call usage against the free-tier 100/day cap.
app.get("/internal/test/api-football-key", (req, res) => {
  res.json({ keySet: !!API_FOOTBALL_KEY });
});

const API_FOOTBALL_LEAGUE_IDS = {
  EPL: 39,
  LA_LIGA: 140,
  SERIE_A: 135,
  BUNDESLIGA: 78,
  LIGUE_1: 61,
  UCL: 2,
  MLS: 253,
};

// Diagnostic only (2026-11-04): the main swap test got 0 fixtures back for every league
// using ?league=X&next=3 with no season -- narrowing down why, EPL only, a handful of
// param variants.
app.get("/internal/test/api-football-diag", async (req, res) => {
  if (!API_FOOTBALL_KEY) return res.status(400).json({ error: "API_FOOTBALL_KEY not set" });
  const variants = {
    "league+next_no_season": "/fixtures?league=39&next=3",
    "league+season2026+next": "/fixtures?league=39&season=2026&next=3",
    "league+season2025+next": "/fixtures?league=39&season=2025&next=3",
    today_date: `/fixtures?date=${new Date().toISOString().slice(0, 10)}`,
    leagues_info: "/leagues?id=39",
  };
  const out = {};
  for (const [name, path] of Object.entries(variants)) {
    try {
      const j = await getApiFootballJson(path);
      out[name] = { results: j.results, errors: j.errors, sample: JSON.stringify(j.response).slice(0, 500) };
    } catch (err) {
      out[name] = { error: err.message };
    }
  }
  // Season-blocked on the free plan (confirmed above) -- but does date+league scoping
  // (no season param at all) work for a NAMED league, and do fixture-scoped lineups/
  // injuries work the same way (not season-blocked since they're tied to one match)?
  try {
    const today = new Date().toISOString().slice(0, 10);
    // date-only (no league, no season) is the one param shape that worked above --
    // pull today's full global slate and filter to our 7 target leagues client-side.
    const dateOnly = await getApiFootballJson(`/fixtures?date=${today}`);
    const targetIds = new Set(Object.values(API_FOOTBALL_LEAGUE_IDS));
    const todaysTargetMatches = (dateOnly.response || []).filter((f) => targetIds.has(f.league?.id));
    out.dateOnlyResultsTotal = dateOnly.results;
    out.todaysTargetLeagueMatches = todaysTargetMatches.map((f) => ({
      league: f.league?.name,
      leagueId: f.league?.id,
      fixtureId: f.fixture?.id,
      home: f.teams?.home?.name,
      away: f.teams?.away?.name,
      status: f.fixture?.status?.short,
    }));
    let probeFixtureId = todaysTargetMatches[0]?.fixture?.id;
    out.probeFixtureId = probeFixtureId || null;
    if (probeFixtureId) {
      const lu = await getApiFootballJson(`/fixtures/lineups?fixture=${probeFixtureId}`);
      out.lineupsByFixture = { results: lu.results, errors: lu.errors, hasLineups: (lu.response || []).length > 0 };
      const inj = await getApiFootballJson(`/injuries?fixture=${probeFixtureId}`);
      out.injuriesByFixture = { results: inj.results, errors: inj.errors, sample: (inj.response || []).slice(0, 3).map((i) => i.player?.name) };
    }
  } catch (err) {
    out.probeError = err.message;
  }
  // Team stats always requires league+season -- confirm the shape on an ALLOWED historical
  // season (free plan: 2022-2024) since the current season is blocked either way. Man City,
  // team id 50, is well-known and stable.
  try {
    const stats = await getApiFootballJson(`/teams/statistics?league=39&season=2024&team=50`);
    out.teamStatsHistoricalShape = {
      results: stats.results,
      errors: stats.errors,
      fieldsPresent: stats.response ? Object.keys(stats.response) : null,
      goalsShape: stats.response?.goals ? Object.keys(stats.response.goals) : null,
    };
  } catch (err) {
    out.teamStatsError = err.message;
  }
  res.json(out);
});

// One-off verification helper (2026-11-05): forces a fresh fixturesToday fetch (bypassing
// the once-a-day cache) so eloEdge/odds integration can be checked without waiting for the
// ET calendar date to roll over. Same diagnostic-route pattern as soccer-source-swap below.
app.get("/internal/test/soccer-fixtures-refresh", async (req, res) => {
  try {
    const fixtures = await fetchSoccerCandidateFixturesFresh();
    res.json({ ok: true, count: fixtures.length, fixtures });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Same verification, but re-attaches ELO/odds onto the ALREADY-CACHED fixturesToday list
// instead of calling API-Football again -- for days (like today, 2026-11-05) the daily
// API-Football cap is already hit and a fresh fixture pull isn't possible until it resets.
app.get("/internal/test/soccer-elo-reattach", async (req, res) => {
  try {
    const cached = await getDoc("main", "soccer", "fixturesToday");
    const fixtures = cached?.data?.fixtures || [];
    await attachSoccerEloAndOdds(fixtures);
    await upsertDoc("main", "soccer", "fixturesToday", { ...cached.data, fixtures, updatedAt: new Date().toISOString() });
    res.json({ ok: true, count: fixtures.length, fixtures });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/internal/test/soccer-source-swap", async (req, res) => {
  if (!API_FOOTBALL_KEY) return res.status(400).json({ error: "API_FOOTBALL_KEY not set" });
  const calls = [];
  const report = { apiFootball: {}, understat: {} };
  try {
    // 1 call: confirms the key works and shows the real plan/quota from api-sports itself.
    calls.push("status");
    report.apiFootball.status = await getApiFootballJson("/status");

    // Fixtures-only pass across all 7 competitions (1 call each) -- proves every league id
    // resolves and returns real upcoming fixtures.
    report.apiFootball.fixturesByLeague = {};
    for (const [key, id] of Object.entries(API_FOOTBALL_LEAGUE_IDS)) {
      calls.push(`fixtures:${key}`);
      try {
        const fx = await getApiFootballJson(`/fixtures?league=${id}&next=3`);
        report.apiFootball.fixturesByLeague[key] = {
          resultsCount: fx.results,
          sample: (fx.response || []).slice(0, 1).map((f) => ({
            fixtureId: f.fixture?.id,
            date: f.fixture?.date,
            home: f.teams?.home?.name,
            away: f.teams?.away?.name,
            season: f.league?.season,
          })),
        };
      } catch (err) {
        report.apiFootball.fixturesByLeague[key] = { error: err.message };
      }
    }

    // Full depth pass (lineups/injuries/team stats) for EPL only -- representative sample,
    // not every competition, to keep this test well under budget.
    const eplFixture = report.apiFootball.fixturesByLeague.EPL?.sample?.[0];
    if (eplFixture?.fixtureId) {
      calls.push("lineups:EPL");
      try {
        const lu = await getApiFootballJson(`/fixtures/lineups?fixture=${eplFixture.fixtureId}`);
        report.apiFootball.lineupsSample = { resultsCount: lu.results, hasLineups: (lu.response || []).length > 0 };
      } catch (err) {
        report.apiFootball.lineupsSample = { error: err.message };
      }
      calls.push("injuries:EPL");
      try {
        const inj = await getApiFootballJson(`/injuries?league=${API_FOOTBALL_LEAGUE_IDS.EPL}&season=${eplFixture.season}`);
        report.apiFootball.injuriesSample = {
          resultsCount: inj.results,
          sample: (inj.response || []).slice(0, 3).map((i) => ({ player: i.player?.name, type: i.player?.type, team: i.team?.name })),
        };
      } catch (err) {
        report.apiFootball.injuriesSample = { error: err.message };
      }
      calls.push("teamStats:EPL");
      try {
        const homeTeamId = (await getApiFootballJson(`/fixtures?id=${eplFixture.fixtureId}`)).response?.[0]?.teams?.home?.id;
        calls.push("fixtureDetail:EPL");
        if (homeTeamId) {
          const stats = await getApiFootballJson(`/teams/statistics?league=${API_FOOTBALL_LEAGUE_IDS.EPL}&season=${eplFixture.season}&team=${homeTeamId}`);
          report.apiFootball.teamStatsSample = {
            team: stats.response?.team?.name,
            fixturesPlayed: stats.response?.fixtures?.played?.total,
            goalsFor: stats.response?.goals?.for?.total?.total,
            goalsAgainst: stats.response?.goals?.against?.total?.total,
          };
        } else {
          report.apiFootball.teamStatsSample = { error: "no home team id from fixture detail" };
        }
      } catch (err) {
        report.apiFootball.teamStatsSample = { error: err.message };
      }
    }
    report.apiFootball.callsThisTest = calls.length;
    report.apiFootball.quota = report.apiFootball.status?.response?.requests;
  } catch (err) {
    report.apiFootball.fatalError = err.message;
  }

  // Understat has no official API -- scrape the league page's embedded JSON (same approach
  // every unofficial Understat client uses: a <script> tag assigns JSON.parse('...') to a
  // teamsData/datesData var). Tested here for EPL only as a viability check.
  try {
    const UNDERSTAT_LEAGUE_SLUGS = { EPL: "EPL", LA_LIGA: "La_liga", SERIE_A: "Serie_A", BUNDESLIGA: "Bundesliga", LIGUE_1: "Ligue_1" };
    const html = await (await fetch("https://understat.com/league/EPL/2025", { headers: { "User-Agent": "sports-proxy/0.1" } })).text();
    const m = html.match(/JSON\.parse\('(.+?)'\)/);
    if (m) {
      const decoded = m[1].replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      const parsed = JSON.parse(decoded);
      const firstTeam = Object.values(parsed)[0];
      report.understat = {
        scrapeWorked: true,
        teamCount: Object.keys(parsed).length,
        sampleTeam: firstTeam?.title,
        sampleFields: firstTeam?.history?.[0] ? Object.keys(firstTeam.history[0]) : null,
        leagueSlugsAvailable: UNDERSTAT_LEAGUE_SLUGS,
      };
    } else {
      report.understat = { scrapeWorked: false, reason: "no JSON.parse(...) block matched in page" };
    }
  } catch (err) {
    report.understat = { scrapeWorked: false, error: err.message };
  }

  res.json(report);
});

// =========================================================================================
// Soccer data source swap -- real build (2026-11-04, Seb's approval + 6 refinements)
// =========================================================================================
// API-Football free tier: 100 calls/day, 10 calls/minute (confirmed by the test endpoints
// above). This section is a hard-stop-at-80/day, >=7s-apart-paced wrapper around it, plus:
//   - fixtures for today+tomorrow ET (2 calls) -> filtered to the 7 target competitions,
//     Milan fixtures dropped before any further per-fixture call is ever made
//   - lineups+injuries per candidate fixture, ONLY once its kickoff is within 3 hours
//     (same cadence the NFL/NBA news layer already uses for inactives)
//   - a lineup-absence/injury check against every OPEN soccer leg on both desks, DMing
//     only the bet's own owner (same dollar-guard, Steve chat-id guard, and notifiedState
//     dedupe the existing News Layer already uses)
//   - a weekly Understat up/down check (no xG wiring yet -- that's explicitly deferred)
// No team-stats/xG fields are written anywhere here; the free tier can't supply current-
// season team stats and Understat itself is down, so sofascore/fotmob remains the only
// source for anything stats/xG-shaped until one of those changes.

const API_FOOTBALL_HARD_STOP_PER_DAY = 80; // Seb's ask: real cap is 100, stop well short so a manual test never gets locked out
const API_FOOTBALL_MIN_GAP_MS = 7000; // >=7s apart, well under the 10/min (6s) limit with margin

async function apiFootballGuardedCall(path) {
  const today = etDateDaysAgo(0);
  const usageDoc = await getDoc("main", "engineMeta", "apiFootballUsage");
  let usage = usageDoc?.data || { date: today, callsUsed: 0, lastCallAt: null };
  if (usage.date !== today) usage = { date: today, callsUsed: 0, lastCallAt: null };
  if (usage.callsUsed >= API_FOOTBALL_HARD_STOP_PER_DAY) {
    throw new Error(`API_FOOTBALL_HARD_STOP: ${usage.callsUsed}/${API_FOOTBALL_HARD_STOP_PER_DAY} used today`);
  }
  if (usage.lastCallAt) {
    const elapsed = Date.now() - new Date(usage.lastCallAt).getTime();
    if (elapsed < API_FOOTBALL_MIN_GAP_MS) await new Promise((r) => setTimeout(r, API_FOOTBALL_MIN_GAP_MS - elapsed));
  }
  const result = await getApiFootballJson(path);
  await upsertDoc("main", "engineMeta", "apiFootballUsage", { date: today, callsUsed: usage.callsUsed + 1, lastCallAt: new Date().toISOString() });
  return result;
}

async function getApiFootballUsageToday() {
  const today = etDateDaysAgo(0);
  const usageDoc = await getDoc("main", "engineMeta", "apiFootballUsage");
  const usage = usageDoc?.data;
  if (!usage || usage.date !== today) return { date: today, callsUsed: 0 };
  return usage;
}

// Exact-name match, not substring -- API-Football's own team.name for Internazionale is
// literally "Inter" (not "Inter Milan"), and a substring/word match on "inter" would wrongly
// catch "Inter Miami" (MLS, a real team Seb absolutely can bet on). "AC Milan" has no such
// collision risk but is kept as an exact match for the same reason/consistency.
function isMilanFixture(home, away) {
  return home === "Inter" || away === "Inter" || home === "AC Milan" || away === "AC Milan";
}

// --- eloEdge on fixturesToday (2026-11-05, Seb's request) ---
// the-odds-api sport_keys for the same 7 leagues API_FOOTBALL_LEAGUE_IDS already covers.
const ODDS_API_SOCCER_SPORT_KEYS = {
  EPL: "soccer_epl",
  LA_LIGA: "soccer_spain_la_liga",
  SERIE_A: "soccer_italy_serie_a",
  BUNDESLIGA: "soccer_germany_bundesliga",
  LIGUE_1: "soccer_france_ligue_one",
  UCL: "soccer_uefa_champs_league",
  MLS: "soccer_usa_mls",
};

// One the-odds-api call per league per day (7 calls total), through the existing
// quota-tracked getOddsJson wrapper -- recordOddsUsage() picks it up automatically, same as
// every other odds call on this server. Guarded so a given calendar day only ever fetches
// once, same pattern as apiFootballGuardedCall.
async function getDkSoccerMoneylinesToday() {
  const today = etDateDaysAgo(0);
  const cached = await getDoc("main", "taskConfig", "soccerOddsFetch");
  if (cached?.data?.date === today && Array.isArray(cached.data.games)) return cached.data.games;

  const games = [];
  for (const sportKey of Object.values(ODDS_API_SOCCER_SPORT_KEYS)) {
    try {
      const url = new URL(`${ODDS_BASE}/sports/${sportKey}/odds/`);
      url.searchParams.set("apiKey", ODDS_API_KEY);
      url.searchParams.set("regions", "us");
      url.searchParams.set("markets", "h2h");
      url.searchParams.set("oddsFormat", "american");
      url.searchParams.set("bookmakers", "draftkings");
      const data = await getOddsJson(url.toString());
      for (const g of data) {
        const dk = (g.bookmakers || []).find((b) => b.key === "draftkings");
        const h2h = dk?.markets?.find((m) => m.key === "h2h");
        if (!h2h) continue;
        const homePrice = h2h.outcomes?.find((o) => o.name === g.home_team)?.price;
        const awayPrice = h2h.outcomes?.find((o) => o.name === g.away_team)?.price;
        const leagueCode = Object.keys(ODDS_API_SOCCER_SPORT_KEYS).find((k) => ODDS_API_SOCCER_SPORT_KEYS[k] === sportKey);
        games.push({ homeTeam: g.home_team, awayTeam: g.away_team, commenceTime: g.commence_time, homePrice, awayPrice, league: leagueCode });
      }
    } catch (err) {
      console.error(`soccer odds fetch failed for ${sportKey}: ${err.message}`);
    }
  }
  await upsertDoc("main", "taskConfig", "soccerOddsFetch", { date: today, fetchedAt: new Date().toISOString(), games });
  return games;
}

// Adds homeElo/awayElo/eloWinProbHome/dk*/eloEdge* to each fixture in place. ELO has no
// draw model (noted to Seb and in the full-matchup-read soccer addendum) -- eloWinProbHome
// is a pure two-outcome win probability, compared against DK's own (3-way, vig-included)
// moneyline implied probability, so eloEdge is a directional signal, not a perfectly
// apples-to-apples one.
async function attachSoccerEloAndOdds(fixtures) {
  const eloDoc = await getDoc("main", "soccer", "elo");
  const clubsBySlug = eloDoc?.data?.clubs || {};
  const eloAsOf = eloDoc?.data?.asOf || null;
  const clubsByName = new Map();
  for (const slug of Object.keys(clubsBySlug)) clubsByName.set(normClubName(clubsBySlug[slug].name), slug);

  let games = [];
  try {
    games = await getDkSoccerMoneylinesToday();
  } catch (err) {
    console.error(`getDkSoccerMoneylinesToday failed: ${err.message}`);
  }

  for (const fixture of fixtures) {
    const homeSlug = resolveBeyondEloSlug(fixture.home, clubsByName);
    const awaySlug = resolveBeyondEloSlug(fixture.away, clubsByName);
    const homeClub = homeSlug ? clubsBySlug[homeSlug] : null;
    const awayClub = awaySlug ? clubsBySlug[awaySlug] : null;
    if (homeClub && awayClub) {
      fixture.homeElo = homeClub.elo;
      fixture.awayElo = awayClub.elo;
      fixture.eloAsOf = eloAsOf;
      const diff = homeClub.elo + (homeClub.hfa || 0) - awayClub.elo;
      fixture.eloWinProbHome = Math.round((1 / (1 + Math.pow(10, -diff / 400))) * 1000) / 1000;
    }
    const game = games.find(
      (g) => teamMatches(fixture.home, { displayName: g.homeTeam }) && teamMatches(fixture.away, { displayName: g.awayTeam })
    );
    if (game) {
      fixture.dkImpliedHome = americanToProb(game.homePrice);
      fixture.dkImpliedAway = americanToProb(game.awayPrice);
      if (fixture.eloWinProbHome != null && fixture.dkImpliedHome != null) {
        fixture.eloEdgeHome = Math.round((fixture.eloWinProbHome - fixture.dkImpliedHome) * 1000) / 1000;
      }
      if (fixture.eloWinProbHome != null && fixture.dkImpliedAway != null) {
        fixture.eloEdgeAway = Math.round((1 - fixture.eloWinProbHome - fixture.dkImpliedAway) * 1000) / 1000;
      }
    }
  }
  return fixtures;
}

// eloEdge fallback (2026-11-05, Seb's ask): builds a lighter fixture list straight from
// the DK odds events we fetch anyway, with no fixtureId, so ELO/eloEdge still fills in on a
// day API-Football is out of calls or returns nothing. The lineup/injury check still needs
// a real fixtureId and API-Football, so these fallback fixtures just won't get checked for
// lineups -- that's expected; this path exists for eloEdge continuity, not lineup alerts.
function buildFallbackFixturesFromDkOdds(games) {
  const byKey = new Map();
  for (const g of games) {
    if (isMilanFixture(g.homeTeam, g.awayTeam)) continue;
    const key = `${g.homeTeam}|${g.awayTeam}|${g.commenceTime}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      fixtureId: null,
      league: g.league || null,
      leagueId: null,
      kickoff: g.commenceTime,
      status: "NS",
      home: g.homeTeam,
      away: g.awayTeam,
      source: "dk-odds-fallback",
    });
  }
  return [...byKey.values()];
}

// The actual API-Football fetch (2 calls, today ET + tomorrow ET) -- ONLY called once per
// calendar day, never per-tick. Reduces each fixture to just the fields anything downstream
// needs, so the cached-from-Supabase path and the freshly-fetched path return the exact
// same shape and nothing downstream has to know which one it got.
async function fetchSoccerCandidateFixturesFresh() {
  const targetIds = new Set(Object.values(API_FOOTBALL_LEAGUE_IDS));
  const dates = [etDateDaysAgo(0), etDateDaysAgo(-1)]; // today ET, tomorrow ET
  const byId = new Map();
  let apiFootballFailed = false;
  try {
    for (const date of dates) {
      const j = await apiFootballGuardedCall(`/fixtures?date=${date}`);
      for (const f of j.response || []) {
        if (!targetIds.has(f.league?.id)) continue;
        const home = f.teams?.home?.name;
        const away = f.teams?.away?.name;
        if (isMilanFixture(home, away)) continue;
        byId.set(f.fixture.id, {
          fixtureId: f.fixture.id,
          league: f.league?.name,
          leagueId: f.league?.id,
          kickoff: f.fixture?.date,
          status: f.fixture?.status?.short,
          home,
          away,
        });
      }
    }
  } catch (err) {
    apiFootballFailed = true;
    console.error(`fetchSoccerCandidateFixturesFresh: API-Football unavailable (${err.message}), falling back to DK-odds fixture list for eloEdge`);
  }

  let fixtures = [...byId.values()];
  let usedFallback = false;
  if (!fixtures.length) {
    try {
      const games = await getDkSoccerMoneylinesToday();
      fixtures = buildFallbackFixturesFromDkOdds(games);
      usedFallback = fixtures.length > 0;
    } catch (err) {
      console.error(`DK-odds fixture fallback failed: ${err.message}`);
    }
  }

  try {
    await attachSoccerEloAndOdds(fixtures);
  } catch (err) {
    console.error(`attachSoccerEloAndOdds failed: ${err.message}`);
  }
  await upsertDoc("main", "soccer", "fixturesToday", {
    date: etDateDaysAgo(0),
    updatedAt: new Date().toISOString(),
    fixtures,
    apiFootballFailed,
    usedDkOddsFallback: usedFallback,
  });
  return fixtures;
}

// Quota guard (2026-11-04, Seb's catch): the 30-min cron must NOT re-fetch fixtures on
// every tick -- that's 48 ticks/day x 2 calls = 96, nearly the whole daily cap on fixtures
// alone. Reuses the Supabase-cached soccer/fixturesToday doc all day; only calls the real
// API when the cached date isn't today (first tick of the day, or the doc doesn't exist
// yet) -- i.e. actually 2 calls/day for this part, not 96.
async function getSoccerCandidateFixtures() {
  const today = etDateDaysAgo(0);
  const cached = await getDoc("main", "soccer", "fixturesToday");
  if (cached?.data?.date === today && Array.isArray(cached.data.fixtures)) return cached.data.fixtures;
  return fetchSoccerCandidateFixturesFresh();
}

function soccerPlayerTeamShape(teamName) {
  return { abbr: null, location: null, name: teamName };
}

// Cheap, zero-API-cost pre-filter: does ANY open leg's text plausibly reference one of
// this fixture's two teams? If not, there is nothing this fixture could ever alert on, so
// it's never worth spending a lineups+injuries call on it just because it's "a candidate
// fixture" -- that's the difference between ~2 calls/day (no open soccer bets) and
// burning the whole daily cap checking matches nobody has money on.
function fixtureHasOpenLegInterest(fixture, openLegs) {
  const homeNorm = normTeamName(fixture.home);
  const awayNorm = normTeamName(fixture.away);
  return openLegs.some((leg) => {
    const t = normTeamName(leg.legText);
    return (homeNorm && t.includes(homeNorm)) || (awayNorm && t.includes(awayNorm));
  });
}

// Builds matchable "status items" for one fixture: every starting-XI player (status
// "starting", informational only, never alerted on), every benched/unused-squad player
// (status "not_starting" -- this is what triggers a lineup-absence DM), and every injury
// list entry for either side (status taken from API-Football's own injury "type" field,
// e.g. "Missing Fixture", passed through as-is as the alert status).
function buildSoccerLineupStatusItems(lineupsResponse, injuriesResponse) {
  const items = [];
  for (const side of lineupsResponse || []) {
    const teamName = side.team?.name;
    const startingIds = new Set((side.startXI || []).map((p) => p.player?.id));
    for (const p of side.startXI || []) {
      items.push({ player: p.player?.name, lastName: (p.player?.name || "").split(" ").pop(), team: soccerPlayerTeamShape(teamName), status: "starting" });
    }
    for (const p of side.substitutes || []) {
      if (startingIds.has(p.player?.id)) continue;
      items.push({ player: p.player?.name, lastName: (p.player?.name || "").split(" ").pop(), team: soccerPlayerTeamShape(teamName), status: "not_starting" });
    }
  }
  for (const i of injuriesResponse || []) {
    items.push({ player: i.player?.name, lastName: (i.player?.name || "").split(" ").pop(), team: soccerPlayerTeamShape(i.team?.name), status: i.player?.type || "injured" });
  }
  return items;
}

// Pulls every OPEN ("pending"/"needs_review") leg on both desks whose bet doc is tagged
// SOCCER (single-league or inside a MULTI's legLeagues) -- the only legs this check can
// possibly match, so the only ones worth the matching work.
async function getOpenSoccerLegs() {
  const out = [];
  for (const desk of ["main", "steve"]) {
    const r = await supabaseFetch(`/docs?desk_id=eq.${desk}&collection=eq.pnlEntries&select=doc_id,data`);
    const docs = await r.json();
    for (const doc of docs) {
      const d = doc.data || {};
      if (d.type !== "bet" || !["pending", "needs_review"].includes(d.status)) continue;
      const isSoccer = d.league === "SOCCER" || (Array.isArray(d.legLeagues) && d.legLeagues.includes("SOCCER"));
      if (!isSoccer) continue;
      for (const leg of d.legs || []) {
        if (!leg.text || !["pending", "needs_review", undefined, null].includes(leg.status)) continue;
        out.push({ desk, betId: doc.doc_id, betLabel: d.desc || d.ticketId || doc.doc_id, legText: leg.text });
      }
    }
  }
  return out;
}

// Per-fixture lineups/injuries cache (2026-11-05, fix for the 2026-11-04 80/80
// API-Football exhaustion). Root cause: the 30-min lineup-check cron re-fetched BOTH
// lineups and injuries for every imminent fixture on EVERY tick for its whole ~3h
// pre-kickoff + 15-min-live window -- a single busy UCL night with several simultaneous
// kickoffs easily hit 2 calls x 6-7 ticks x several fixtures = the full daily cap. Once a
// fixture's lineups are officially announced (a non-empty response), they don't change, so
// that fixture is "confirmed" and never refetched again that day; until announced, it still
// retries every tick (lineups are usually released ~60 min before kickoff), just without the
// extra multiplier.
async function getSoccerLineupCache() {
  const doc = await getDoc("main", "engineMeta", "soccerLineupCache");
  return doc?.data?.entries || {};
}

async function saveSoccerLineupCache(entries) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000; // prune anything older than a day
  const pruned = {};
  for (const [fixtureId, entry] of Object.entries(entries)) {
    if (new Date(entry.fetchedAt).getTime() >= cutoff) pruned[fixtureId] = entry;
  }
  await upsertDoc("main", "engineMeta", "soccerLineupCache", { entries: pruned, updatedAt: new Date().toISOString() });
}

// One fixture's worth of the actual check -- shared by the live job and the dry-run
// endpoint (dryRun just skips the DM + notifiedState write at the end, same convention as
// the rest of the News Layer).
async function checkSoccerFixtureAgainstOpenBets(fixture, openLegs, notified, dmsByDesk, newKeys, lineupCache) {
  let lineups, injuries;
  const cached = lineupCache[fixture.fixtureId];
  if (cached?.confirmed) {
    lineups = cached.lineups;
    injuries = cached.injuries;
  } else {
    // Sequential, not Promise.all -- apiFootballGuardedCall already paces itself (>=7s apart),
    // so two calls "in parallel" here would just both wait on the same pacing gate anyway.
    // A HARD_STOP error is let through (not caught here) so the caller can break the whole
    // pass instead of silently limping through the remaining fixtures with empty data.
    lineups = await apiFootballGuardedCall(`/fixtures/lineups?fixture=${fixture.fixtureId}`)
      .then((j) => j.response)
      .catch((err) => {
        if (String(err.message).startsWith("API_FOOTBALL_HARD_STOP")) throw err;
        return [];
      });
    injuries = await apiFootballGuardedCall(`/injuries?fixture=${fixture.fixtureId}`)
      .then((j) => j.response)
      .catch((err) => {
        if (String(err.message).startsWith("API_FOOTBALL_HARD_STOP")) throw err;
        return [];
      });
    lineupCache[fixture.fixtureId] = {
      lineups,
      injuries,
      confirmed: Array.isArray(lineups) && lineups.length > 0,
      fetchedAt: new Date().toISOString(),
    };
  }
  const statusItems = buildSoccerLineupStatusItems(lineups, injuries);
  const alertable = statusItems.filter((i) => i.status !== "starting");
  if (!alertable.length) return;
  for (const leg of openLegs) {
    for (const item of alertable) {
      const m = matchNameInLegText(normTeamName(leg.legText), item.player, item.lastName, item.team);
      if (!m) continue;
      const key = `soccerlineup|${normTeamName(item.player)}|${item.status}|${leg.betId}`;
      if (notified.keys?.[key] || newKeys[key]) continue;
      newKeys[key] = { at: new Date().toISOString() };
      (dmsByDesk[leg.desk] ||= []).push({
        betLabel: leg.betLabel,
        player: item.player,
        status: item.status === "not_starting" ? "not in the starting XI" : item.status,
        confidence: m.confidence,
      });
    }
  }
}

async function runSoccerLineupCheck({ dryRun = false, forceFixtureId = null } = {}) {
  const fixtures = await getSoccerCandidateFixtures(); // cached all day -- real fetch only once/day

  const now = Date.now();
  const horizon = now + 3 * 60 * 60 * 1000;
  const openLegs = await getOpenSoccerLegs();

  let imminent = fixtures.filter((f) => {
    const ts = new Date(f.kickoff).getTime();
    return Number.isFinite(ts) && ts > now - 15 * 60 * 1000 && ts <= horizon; // kickoff within 3h, or just started (<=15 min ago)
  });
  // Quota guard (2026-11-04, Seb's catch): a candidate fixture is only worth an actual
  // lineups/injuries call if an open leg could possibly be about it -- checking every
  // imminent match in all 7 leagues regardless of whether Seb/Steve have money on it is
  // exactly what blows the daily cap on a busy UCL night. On a day with zero open soccer
  // bets this alone takes the per-fixture call count to zero.
  imminent = imminent.filter((f) => fixtureHasOpenLegInterest(f, openLegs));
  // DK-odds fallback fixtures (used when API-Football is unavailable, for eloEdge
  // continuity only) have no real fixtureId, so the lineups/injuries endpoints can't be
  // called on them -- skip rather than erroring on `fixture=null`.
  imminent = imminent.filter((f) => f.fixtureId != null);
  // Manual verification only (never set by the cron SQL): force-checks one specific
  // candidate fixture regardless of kickoff time or open-leg interest, so the matching
  // mechanism can be proven against real data without waiting for a real match/bet.
  if (forceFixtureId) {
    const forced = fixtures.find((f) => String(f.fixtureId) === String(forceFixtureId));
    if (forced && !imminent.some((f) => f.fixtureId === forced.fixtureId)) imminent = [forced];
  }

  const notified = await getNotifiedState();
  const lineupCache = await getSoccerLineupCache();
  const newKeys = {};
  const dmsByDesk = {};
  const checkedFixtures = [];
  for (const f of imminent) {
    checkedFixtures.push({ fixtureId: f.fixtureId, home: f.home, away: f.away, kickoff: f.kickoff });
    try {
      await checkSoccerFixtureAgainstOpenBets(f, openLegs, notified, dmsByDesk, newKeys, lineupCache);
    } catch (err) {
      if (String(err.message).startsWith("API_FOOTBALL_HARD_STOP")) break; // stop the whole pass, not just this fixture
    }
  }
  await saveSoccerLineupCache(lineupCache);

  const sentSummary = { main: 0, steve: 0 };
  for (const desk of Object.keys(dmsByDesk)) {
    const items = dmsByDesk[desk];
    if (!items.length) continue;
    const lines = items.map((it) => `${it.player} (${it.status}) -- may affect: ${it.betLabel}`);
    const text = `⚽ Soccer lineup check:\n${lines.join("\n")}`;
    if (dryRun) {
      sentSummary[desk] += items.length;
      continue;
    }
    const r = await sendNewsAlertDm(desk, text).catch((err) => ({ sent: false, error: err.message }));
    if (r.sent) sentSummary[desk] += items.length;
  }
  if (!dryRun && Object.keys(newKeys).length) {
    await upsertDoc("main", "news", "notifiedState", { keys: { ...(notified.keys || {}), ...newKeys } });
  }
  const usage = await getApiFootballUsageToday();
  return {
    totalCandidateFixtures: fixtures.length,
    imminentWithOpenLegInterest: imminent.length,
    imminentFixturesChecked: checkedFixtures,
    newAlerts: Object.keys(newKeys).length,
    sentSummary,
    dmsByDesk: dryRun ? dmsByDesk : undefined,
    apiFootballCallsUsedToday: usage.callsUsed,
  };
}

app.get("/internal/jobs/soccer-lineup-check", async (req, res) => {
  try {
    const result = await runSoccerLineupCheck({ dryRun: req.query.dryRun === "true", forceFixtureId: req.query.forceFixtureId || null });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Understat weekly up/down check (2026-11-04, Seb's ask) -- no xG wiring, just a status
// flag so a human (or a future build step) knows the moment it's viable again. DMs Seb
// directly rather than editing the live Monday-recap routine in place.
app.get("/internal/jobs/understat-weekly-check", async (req, res) => {
  try {
    const html = await (await fetch("https://understat.com/", { headers: { "User-Agent": "sports-proxy/0.1" } })).text();
    const isDown = /we will come back soon/i.test(html);
    const isUp = !isDown && /JSON\.parse\(/.test(html);
    const prev = await getDoc("main", "engineMeta", "understatStatus");
    const wasUp = prev?.data?.isUp === true;
    await upsertDoc("main", "engineMeta", "understatStatus", { isUp, checkedAt: new Date().toISOString() });
    if (isUp && !wasUp) {
      await sendTelegramRaw(TELEGRAM_SEB_CHAT_ID, "⚽ Understat is back up -- xG data could be added to the soccer build now.").catch(() => {});
    }
    res.json({ ok: true, isUp, wasUp, notifiedSeb: isUp && !wasUp });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`sports-proxy listening on ${PORT}`));
