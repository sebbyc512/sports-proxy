-- NCAA Division I Men's Basketball Championship (March Madness) historical games --
-- table only (2026-11-04, Seb's request). Run this once in the Supabase SQL editor.
-- Safe to re-run (create if not exists, no destructive drop).
--
-- What it's for: a one-time backfill (server.js's /internal/jobs/cbb-tournament-backfill)
-- pulls every tournament game from ESPN for the last ~10 completed tournaments (2025 back
-- through 2015, skipping 2020 -- cancelled), identified by each game's own ESPN
-- notes[].headline ("Men's Basketball Championship - <Region> Region - <Round>", or
-- "National Championship"/"Final Four" near the end), which also carries the round and
-- region. Seeds come from each competitor's own `seed.current` field; site from the
-- game's own venue. This is the raw data a future cbb-tournament-spec rule gets authored
-- from (seed-vs-seed ATS/ML/totals, neutral-site effects, pace/1H-2H totals).

create table if not exists cbb_tournament_games (
  game_id text primary key,
  date date not null,
  season text not null, -- the spring year the tournament was played, e.g. "2025"
  round text, -- "1st Round", "2nd Round", "Sweet 16", "Elite Eight", "Final Four", "National Championship"
  region text, -- "East"/"West"/"South"/"Midwest" etc.; null for Final Four/Championship (no region)
  site text, -- venue full name
  site_city text,
  site_state text,
  away_team text not null,
  home_team text not null,
  away_seed integer,
  home_seed integer,
  away_score integer,
  home_score integer,
  away_1h integer,
  away_2h integer,
  home_1h integer,
  home_2h integer,
  line_provider text,
  home_spread numeric,
  total_line numeric,
  home_moneyline integer,
  away_moneyline integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_cbb_tournament_games_season on cbb_tournament_games (season);
create index if not exists idx_cbb_tournament_games_away_team on cbb_tournament_games (away_team);
create index if not exists idx_cbb_tournament_games_home_team on cbb_tournament_games (home_team);

alter table cbb_tournament_games enable row level security;
-- No policies yet, same as every other Phase 3 table: the engine writes with the secret
-- key, which bypasses RLS.

-- Sanity check after running:
--   select season, count(*) from cbb_tournament_games group by season order by season desc;
