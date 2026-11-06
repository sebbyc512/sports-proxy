-- nflverse NFL data -- tables only (2026-11-06, daily-data batch item 9, Seb's explicit
-- ask). Run once in the Supabase SQL editor. Safe to re-run.
--
-- Source: github.com/nflverse/nflverse-data/releases (CC-BY-4.0 -- credit "nflverse").
-- Seb's priority: injuries, snap counts, and team EPA live before Sunday's games.
-- Deliberately NOT included: schedules-with-lines, weekly player stats, depth charts --
-- depth_charts_2026.csv alone is 68MB (checked live 2026-11-06); downloading/parsing a
-- file that size in one request risks the same OOM crash item 8 (MoneyPuck) caused.
-- Those stay off until there's a streaming approach for the big ones (Tuesday+).

create table if not exists nfl_nflverse_injuries (
  season text not null,
  week integer not null,
  team text not null,
  gsis_id text not null,
  player_name text,
  position text,
  report_status text,
  report_primary_injury text,
  report_secondary_injury text,
  practice_status text,
  updated_at timestamptz not null default now(),
  primary key (season, week, team, gsis_id)
);

create table if not exists nfl_nflverse_snap_counts (
  game_id text not null,
  season text not null,
  week integer not null,
  team text not null,
  opponent text,
  player_name text not null,
  pfr_player_id text,
  position text,
  offense_snaps numeric,
  offense_pct numeric,
  defense_snaps numeric,
  defense_pct numeric,
  st_snaps numeric,
  st_pct numeric,
  updated_at timestamptz not null default now(),
  primary key (game_id, team, player_name)
);

create table if not exists nfl_nflverse_team_epa (
  season text not null,
  week integer not null,
  game_id text not null,
  team text not null,
  opponent text,
  offense_epa_per_play numeric,
  offense_plays integer,
  defense_epa_per_play numeric,
  defense_plays integer,
  updated_at timestamptz not null default now(),
  primary key (game_id, team)
);

create index if not exists idx_nflverse_injuries_team_week on nfl_nflverse_injuries (team, week);
create index if not exists idx_nflverse_snaps_team_week on nfl_nflverse_snap_counts (team, week);
create index if not exists idx_nflverse_team_epa_team_week on nfl_nflverse_team_epa (team, week desc);

alter table nfl_nflverse_injuries enable row level security;
alter table nfl_nflverse_snap_counts enable row level security;
alter table nfl_nflverse_team_epa enable row level security;

-- Sanity check after running:
--   select count(*) from nfl_nflverse_injuries; select count(*) from nfl_nflverse_snap_counts;
--   select count(*) from nfl_nflverse_team_epa;
