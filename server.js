#!/usr/bin/env node
// Public HTTP proxy for ESPN + DraftKings odds data.
// The real ODDS_API_KEY lives only here (server-side env var) — callers never see it.
// Callers authenticate with PROXY_TOKEN instead: a separate, low-stakes token that
// only protects this proxy's own rate limit, not the real odds-api quota.

import express from "express";

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

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "sports-proxy/0.1" } });
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
    const data = await getJson(url.toString());
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
      const events = await getJson(eventsUrl.toString());
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
    const data = await getJson(url.toString());
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

async function upsertDoc(deskId, collection, docId, data) {
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

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`sports-proxy listening on ${PORT}`));
