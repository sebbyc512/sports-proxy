-- NBA player game logs -- table only (2026-11-06, daily-data batch item 1, Seb's request).
-- Run this once in the Supabase SQL editor for the project that holds the Parlay Desk's
-- Supabase tables (see sports-proxy/.env's SUPABASE_URL). Safe to re-run (create if not
-- exists, no destructive drop -- same convention as cbb-game-logs-table.sql).
--
-- What it's for: a job (server.js's /internal/jobs/nba-player-logs, pulled nightly and
-- again at 2 PM ET) records every player's box-score line from every FINAL NBA game: team,
-- opponent, home/away, starter flag, minutes, pts/reb/ast/3pm/stl/blk/TO. One row per
-- (game_id, player_id). DNP players get a row with minutes=0 and did_not_play=true, not a
-- missing row, so last-5/last-10 averages computed from this table don't silently skip a
-- game a player was active but unused in.
--
-- Last-5/last-10 averages and the minutes trend are NOT stored here -- they're computed on
-- read (jobs/nba-player-logs.js's aggregateNbaPlayerForm(), same style as cbbTeams being
-- aggregated from cbb_game_logs) and cached into the generic docs store under collection
-- "nbaPlayerForm", one doc per team, by the same job run. This table only ever holds the
-- raw per-game rows.

create table if not exists nba_player_logs (
  game_id text not null,
  player_id text not null,
  date date not null,
  season text, -- "2025-26", "2026-27", etc. (jobs/util.js's seasonForDate())
  team text not null,
  opponent text,
  home_away text, -- "home" | "away"
  player_name text,
  position text,
  started boolean not null default false,
  did_not_play boolean not null default false,
  minutes numeric,
  points integer,
  rebounds integer,
  assists integer,
  three_pm integer,
  steals integer,
  blocks integer,
  turnovers integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (game_id, player_id)
);

create index if not exists idx_nba_player_logs_date on nba_player_logs (date);
create index if not exists idx_nba_player_logs_player on nba_player_logs (player_id, date desc);
create index if not exists idx_nba_player_logs_team on nba_player_logs (team, date desc);
create index if not exists idx_nba_player_logs_season on nba_player_logs (season);

alter table nba_player_logs enable row level security;
-- No policies yet, same as every other Phase 3 table: the engine writes with the secret
-- key, which bypasses RLS.

-- Sanity check after running:
--   select count(*), min(date), max(date) from nba_player_logs;
