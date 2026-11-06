-- CFB game-level betting lines from CollegeFootballData (CFBD) -- table only (2026-11-06+,
-- Seb's explicit ask: "plus CFB data, isolated in their own tables"). Run this once in the
-- Supabase SQL editor. Safe to re-run.
--
-- What it's for: jobs/cfbd-game-lines.js's pullCfbdGameLines (wired into server.js as
-- /internal/jobs/cfbd-game-lines, NOT on any cron). DATA LANDING ONLY -- no CFB projection
-- model exists, nothing reads this table for picks, CFB stays out of this engine's scope
-- beyond storing this data. See jobs/cfbd-game-lines.js's top comment for the "field names
-- are an assumption, not confirmed" caveat (no live CFBD_API_KEY was available locally when
-- this was written).

create table if not exists cfbd_game_lines (
  game_id text primary key, -- "cfbd-<cfbd game id>"
  season text,
  week integer,
  date date,
  home_team text,
  away_team text,
  home_spread numeric, -- home-signed: negative = home favored (ASSUMPTION -- see caveat above)
  total numeric,
  home_moneyline integer,
  away_moneyline integer,
  provider text,
  captured_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_cfbd_game_lines_season_week on cfbd_game_lines (season, week);
create index if not exists idx_cfbd_game_lines_date on cfbd_game_lines (date);

alter table cfbd_game_lines enable row level security;
-- No policies yet, same as every other Phase 3+ table: the engine writes with the secret key.

-- Sanity check after a pull:
--   select season, week, count(*) from cfbd_game_lines group by season, week order by season, week;
