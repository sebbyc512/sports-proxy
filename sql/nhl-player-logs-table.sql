-- NHL player game logs (skaters) -- table only (2026-11-06, daily-data batch item 3,
-- Seb's request). Run once in the Supabase SQL editor. Safe to re-run.
--
-- What it's for: a nightly job (server.js's /internal/jobs/nhl-player-logs) records every
-- skater's box-score line from every FINAL NHL game: team, opponent, home/away, TOI,
-- goals/assists/points, shots, hits, blocked shots, giveaways/takeaways. Goalie stats
-- (GSAx) are covered separately by nhl_moneypuck_goalies (item 8), not here. One row per
-- (game_id, player_id).

create table if not exists nhl_player_logs (
  game_id text not null,
  player_id text not null,
  date date not null,
  season text,
  team text not null,
  opponent text,
  home_away text,
  player_name text,
  position text,
  toi_seconds integer,
  goals integer,
  assists integer,
  points integer,
  shots integer,
  hits integer,
  blocked_shots integer,
  giveaways integer,
  takeaways integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (game_id, player_id)
);

create index if not exists idx_nhl_player_logs_date on nhl_player_logs (date);
create index if not exists idx_nhl_player_logs_player on nhl_player_logs (player_id, date desc);
create index if not exists idx_nhl_player_logs_team on nhl_player_logs (team, date desc);

alter table nhl_player_logs enable row level security;

-- Sanity check after running:
--   select count(*), min(date), max(date) from nhl_player_logs;
