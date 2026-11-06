-- CBB adjusted efficiency/tempo ratings from CollegeBasketballData (CBBD) -- table only
-- (2026-11-06+, Seb's request). Run this once in the Supabase SQL editor. Safe to re-run.
--
-- What it's for: jobs/cbbd-team-ratings.js's pullCbbdTeamRatingsForSeason (wired into
-- server.js as /internal/jobs/cbbd-team-ratings, NOT on any cron). Landing spot for real
-- adjusted-efficiency/tempo data so the CBB sides/totals margin model can eventually move
-- off its honest-but-simple points-average fallback -- that wiring is a deliberate
-- follow-up, NOT done in this migration. See jobs/cbbd-team-ratings.js's top comment for
-- the "field names are an assumption, not confirmed" caveat.

create table if not exists cbbd_team_ratings (
  team text not null,
  season text not null, -- CBBD convention: year the season starts, e.g. "2025" for 2025-26
  conference text,
  off_rtg numeric, -- points per 100 possessions, offense
  def_rtg numeric, -- points per 100 possessions allowed, defense
  net_rtg numeric, -- off_rtg - def_rtg (computed here if CBBD doesn't supply it directly)
  tempo numeric, -- possessions per 40 minutes
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (team, season)
);

create index if not exists idx_cbbd_team_ratings_season on cbbd_team_ratings (season);

alter table cbbd_team_ratings enable row level security;
-- No policies yet, same as every other Phase 3+ table: the engine writes with the secret key.

-- Sanity check after a pull:
--   select season, count(*) from cbbd_team_ratings group by season;
