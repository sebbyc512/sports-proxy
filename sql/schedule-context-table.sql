-- Rest & schedule context for NBA, NHL, CBB -- table only (2026-11-06, daily-data batch
-- item 2, Seb's request). Run this once in the Supabase SQL editor for the project that
-- holds the Parlay Desk's Supabase tables. Safe to re-run (create if not exists).
--
-- What it's for: a daily job (server.js's /internal/jobs/schedule-context, run once at
-- 9 AM ET across all three leagues) computes, for every team playing today OR tomorrow:
-- days of rest, back-to-back flag, 3-games-in-4-nights flag, current road-trip length, and
-- travel miles since the team's previous game (home-arena-to-home-arena haversine distance;
-- NULL for CBB, where a full D1 arena-coordinate table isn't maintained -- see
-- sports-proxy/jobs/arenas.js). One row per (league, team, date) -- a team playing both
-- today and tomorrow gets two rows, upserted independently.

create table if not exists schedule_context (
  league text not null, -- "NBA" | "NHL" | "CBB"
  team text not null,
  date date not null,
  opponent text,
  home_away text, -- "home" | "away"
  days_of_rest integer, -- NULL if this is the team's first known game in the lookback window
  back_to_back boolean not null default false,
  three_in_four boolean not null default false,
  road_trip_length integer not null default 0, -- 0 if this game is at home
  travel_miles integer, -- NULL for CBB, or when there's no prior game to measure from
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (league, team, date)
);

create index if not exists idx_schedule_context_date on schedule_context (date);
create index if not exists idx_schedule_context_league on schedule_context (league);

alter table schedule_context enable row level security;
-- No policies yet, same as every other Phase 3 table: the engine writes with the secret key.

-- Sanity check after running:
--   select league, count(*), min(date), max(date) from schedule_context group by league;
