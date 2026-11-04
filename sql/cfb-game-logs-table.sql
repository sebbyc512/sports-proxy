-- FBS college football game logs -- table only (2026-11-04, Seb's request).
-- Run this once in the Supabase SQL editor for the project that holds the Parlay Desk's
-- Supabase tables (see sports-proxy/.env's SUPABASE_URL). Safe to re-run (create if not
-- exists, no destructive drop -- same convention as cbb-game-logs-table.sql).
--
-- What it's for: a nightly engine job (server.js's /internal/jobs/cfb-nightly-tracker,
-- pulled by the cron job in cfb-tracker-cron-run-me.sql) records, for every FINAL FBS
-- (ESPN group=80) game, both teams' score, total/passing/rushing yards, and turnovers.
-- This is the raw data refreshCfbTeams() (server.js) aggregates into the cfbTeams docs:
-- season PF/PA, yards for/against, turnovers, last-3 form, and the disclosed SOS proxy
-- (average win% of opponents actually played) -- same pattern as refreshCbbTeams().
--
-- line_provider/home_spread/total_line/home_moneyline/away_moneyline: same free
-- ESPN-pickcenter closing-line proxy as cbb_game_logs -- reuses extractCbbClosingLine()
-- as-is (it's generic over summary.pickcenter, not basketball-specific).

create table if not exists cfb_game_logs (
  game_id text primary key,
  date date not null,
  season text, -- "2026", "2027", etc. (server.js's seasonForCfbDate()) -- lets last
               -- season's backfilled rows stay queryable for PATTERNS without ever being
               -- averaged into this season's live cfbTeams ratings (refreshCfbTeams()
               -- filters to the current season only).
  away_team text not null,
  home_team text not null,
  away_score integer,
  home_score integer,
  line_provider text,
  home_spread numeric,
  total_line numeric,
  home_moneyline integer,
  away_moneyline integer,
  away_total_yards integer, home_total_yards integer,
  away_pass_yards integer, home_pass_yards integer,
  away_rush_yards integer, home_rush_yards integer,
  away_turnovers integer, home_turnovers integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_cfb_game_logs_date on cfb_game_logs (date);
create index if not exists idx_cfb_game_logs_season on cfb_game_logs (season);
create index if not exists idx_cfb_game_logs_away_team on cfb_game_logs (away_team);
create index if not exists idx_cfb_game_logs_home_team on cfb_game_logs (home_team);

alter table cfb_game_logs enable row level security;
-- No policies yet, same as every other Phase 3 table: the engine writes with the secret
-- key, which bypasses RLS. Add a read-only policy here if a desk page ever reads this
-- table directly with the publishable key.

-- Sanity check after running:
--   select count(*), min(date), max(date) from cfb_game_logs;
