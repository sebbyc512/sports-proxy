# sports-proxy

Public HTTPS proxy for ESPN + DraftKings odds data, so the **automated** Parlay Desk
routines (which run in Anthropic's cloud, not on this machine) can reach real data
via a plain `WebFetch` call. The real `ODDS_API_KEY` lives only here, server-side —
callers authenticate with a separate, low-stakes `PROXY_TOKEN` instead, which only
protects this proxy's own rate limit, not the real odds-api quota.

Tested locally and confirmed working 2026-10-19 (real ESPN + DraftKings data).

## Endpoints

All require `?token=<PROXY_TOKEN>` (or an `x-proxy-token` header).

- `GET /espn/scoreboard?sport=football&league=nfl&date=20261018`
- `GET /espn/team?sport=football&league=nfl&team=KC`
- `GET /odds?sport_key=americanfootball_nfl&markets=h2h,spreads,totals`
- `GET /odds/props?sport_key=americanfootball_nfl&home_team=49ers&away_team=Commanders&markets=player_1st_td,player_anytime_td`
- `GET /health` — no data, just confirms the server + token are working

## Run locally

```bash
npm install
PROXY_TOKEN=your-own-token ODDS_API_KEY=your-odds-api-key npm start
```

## Deploy (Render.com — free tier)

1. Push this folder to a GitHub repo (can be a new one, or a subfolder of an
   existing repo — Render supports a "root directory" setting for monorepos).
2. At https://render.com: **New → Web Service**, connect the repo.
3. **Build command:** `npm install`  **Start command:** `node server.js`
4. Under **Environment**, add:
   - `ODDS_API_KEY` = your real the-odds-api.com key
   - `PROXY_TOKEN` = a new random string you generate (NOT the odds-api key —
     this one only protects the proxy itself, e.g. `openssl rand -hex 32`)
5. Deploy. Render gives you a URL like `https://sebas-sports-proxy.onrender.com`.

**Free tier note:** it spins down after ~15 min idle, so the first request after
a quiet spell takes 30-60s (cold start) while it wakes back up. Fine for a
background routine that isn't racing a clock.

## After deploying

Give Claude the deployed URL and the `PROXY_TOKEN` (not the odds-api key) — those
go into the Parlay Desk's `rules` collection so every pick-building routine (not
just live chat) can call `/odds` and `/odds/props` for real DraftKings data.
