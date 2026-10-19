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

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`sports-proxy listening on ${PORT}`));
