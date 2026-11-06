-- MoneyPuck NHL data -- tables only (2026-11-06, daily-data batch item 8, Seb's request).
-- Run once in the Supabase SQL editor. Safe to re-run (create if not exists).
--
-- Source: https://moneypuck.com/data.htm (free for non-commercial use -- credit
-- "MoneyPuck.com" wherever this data is shown). ONLY these four files, nothing else on the
-- site: careers/gameByGame/all_teams.csv (teams), seasonPlayersSummary/goalies/<season>.zip,
-- seasonPlayersSummary/skaters/<season>.zip, downloads/shots_<season>.zip. One download per
-- file per night (server.js's /internal/jobs/nhl-moneypuck, jobs/moneypuck.js).
--
-- Four tables, one per entity type (team/goalie/skater schemas don't share columns; shots
-- keeps only the fields a builder plausibly needs out of MoneyPuck's own 124).

create table if not exists nhl_moneypuck_teams (
  game_id text not null,
  team text not null,
  date date not null,
  season text not null,
  opponent text,
  home_away text,
  xgf numeric,
  xga numeric,
  high_danger_shots_for integer,
  high_danger_shots_against integer,
  shots_for integer,
  goals_for integer,
  updated_at timestamptz not null default now(),
  primary key (game_id, team)
);

create table if not exists nhl_moneypuck_goalies (
  game_id text not null,
  player_id text not null,
  date date not null,
  season text not null,
  team text,
  opponent text,
  home_away text,
  player_name text,
  icetime numeric,
  x_goals_against numeric,
  goals_against numeric,
  gsax numeric,
  high_danger_shots_faced numeric,
  high_danger_goals_allowed numeric,
  updated_at timestamptz not null default now(),
  primary key (game_id, player_id)
);

create table if not exists nhl_moneypuck_skaters (
  game_id text not null,
  player_id text not null,
  date date not null,
  season text not null,
  team text,
  opponent text,
  home_away text,
  player_name text,
  position text,
  icetime numeric,
  xg numeric,
  goals numeric,
  shots_on_goal numeric,
  shot_attempts numeric,
  updated_at timestamptz not null default now(),
  primary key (game_id, player_id)
);

create table if not exists nhl_moneypuck_shots (
  shot_id text primary key,
  game_id text,
  season text not null,
  event text,
  period integer,
  time integer,
  team text,
  shooter_player_id text,
  shooter_name text,
  shot_type text,
  x_cord numeric,
  y_cord numeric,
  distance numeric,
  x_goal numeric,
  goal boolean,
  on_goal boolean,
  updated_at timestamptz not null default now()
);

create index if not exists idx_mp_teams_date on nhl_moneypuck_teams (date);
create index if not exists idx_mp_goalies_date on nhl_moneypuck_goalies (date);
create index if not exists idx_mp_goalies_player on nhl_moneypuck_goalies (player_id, date desc);
create index if not exists idx_mp_skaters_date on nhl_moneypuck_skaters (date);
create index if not exists idx_mp_skaters_player on nhl_moneypuck_skaters (player_id, date desc);
create index if not exists idx_mp_shots_game on nhl_moneypuck_shots (game_id);

alter table nhl_moneypuck_teams enable row level security;
alter table nhl_moneypuck_goalies enable row level security;
alter table nhl_moneypuck_skaters enable row level security;
alter table nhl_moneypuck_shots enable row level security;
-- No policies yet, same as every other Phase 3 table: the engine writes with the secret key.

-- Sanity check after running:
--   select count(*) from nhl_moneypuck_teams; select count(*) from nhl_moneypuck_goalies;
--   select count(*) from nhl_moneypuck_skaters; select count(*) from nhl_moneypuck_shots;
