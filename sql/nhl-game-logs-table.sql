-- NHL game/skater logs -- tables only (2026-10-29, Seb's request).
-- Run this once in the Supabase SQL editor for the project that holds the Parlay Desk's
-- Supabase tables (see sports-proxy/.env's SUPABASE_URL). Safe to re-run (create if not
-- exists, no destructive drop -- same convention as nba-blowout-table.sql, never touches
-- the shared `docs` table or the other Phase 3 tables).
--
-- What it's for: a nightly engine job (server.js's /internal/jobs/nhl-nightly-tracker,
-- pulled by the cron job in nhl-tracker-cron.sql) records, for every FINAL NHL game, both
-- teams' starting goalie (name + whether ESPN's own box score flags them a starter),
-- team shots/saves, and final score into nhl_game_logs, plus one row per skater
-- (goals/assists/points/shots-on-goal) into nhl_skater_logs. See rule nhl-model-spec --
-- this is the raw data the engine-gated NHL learning loop (trig_013nPeQ8Sk74619muX8a2f8k)
-- reads from, by way of the Supabase-mirrored parlays/pnlEntries docs, not from these
-- tables directly (these two tables are reference data a future rule could read, same
-- staged approach as nba_blowouts).

create table if not exists nhl_game_logs (
  game_id text primary key,
  date date not null,
  away_team text not null,
  home_team text not null,
  away_score integer,
  home_score integer,
  away_goalie text,
  home_goalie text,
  away_goalie_confirmed_starter boolean not null default false,
  home_goalie_confirmed_starter boolean not null default false,
  away_shots integer,
  home_shots integer,
  away_saves integer,
  home_saves integer,
  raw jsonb,  -- full goalie detail objects, in case the SA/SV label guess needs fixing later
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_nhl_game_logs_date on nhl_game_logs (date);

create table if not exists nhl_skater_logs (
  game_id text not null,
  player text not null,
  date date not null,
  team text not null,
  goals integer not null default 0,
  assists integer not null default 0,
  points integer not null default 0,
  shots_on_goal integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (game_id, player)
);

create index if not exists idx_nhl_skater_logs_date on nhl_skater_logs (date);
create index if not exists idx_nhl_skater_logs_player on nhl_skater_logs (player);

alter table nhl_game_logs enable row level security;
alter table nhl_skater_logs enable row level security;
-- No policies yet, same as every other Phase 3 table: the engine writes with the secret
-- key, which bypasses RLS. Add a read-only policy here if a desk page ever reads these
-- tables directly with the publishable key.

-- Sanity check after running:
--   select count(*), min(date), max(date) from nhl_game_logs;
--   select count(*), min(date), max(date) from nhl_skater_logs;
