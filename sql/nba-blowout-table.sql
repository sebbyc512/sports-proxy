-- NBA blowout tracker -- table only (2026-10-24, Seb's request).
-- Run this once in the Supabase SQL editor for the project that holds the Parlay Desk's
-- Supabase tables (see sports-proxy/.env's SUPABASE_URL). Safe to re-run (create if not
-- exists, no destructive drop -- unlike schema.sql's own header, this file never touches
-- the shared `docs` table or the other Phase 3 tables).
--
-- What it's for: a nightly engine job (server.js's /internal/jobs/nba-blowout-tracker,
-- pulled by the cron job in nba-blowout-cron.sql) records, for every FINAL NBA game, the
-- score margin at the 4:00 mark of the 4th quarter (is_blowout = margin_at_4min >= 25),
-- the final margin, and both teams' starters' minutes for that game. See rule
-- nba-blowout-factor -- DATA COLLECTION ONLY, nothing reads this for picks yet.

create table if not exists nba_blowouts (
  game_id text primary key,
  date date not null,
  away_team text not null,
  home_team text not null,
  winner text not null,
  loser text not null,
  margin_at_4min integer not null,
  final_margin integer not null,
  is_blowout boolean not null,
  starters jsonb,  -- { "<TEAM_ABBR>": [{name, position, minutes}, ...], ... } for both teams
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_nba_blowouts_date on nba_blowouts (date);
create index if not exists idx_nba_blowouts_winner on nba_blowouts (winner);
create index if not exists idx_nba_blowouts_loser on nba_blowouts (loser);

alter table nba_blowouts enable row level security;
-- No policies yet, same as every other Phase 3 table: the engine writes with the secret
-- key, which bypasses RLS. Add a read-only policy here if a desk page ever reads this
-- table directly with the publishable key.

-- Sanity check after running:
--   select count(*), min(date), max(date) from nba_blowouts;
