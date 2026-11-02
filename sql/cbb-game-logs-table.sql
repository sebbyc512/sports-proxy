-- NCAAB (mens-college-basketball) game logs -- table only (2026-11-02, Seb's request).
-- Run this once in the Supabase SQL editor for the project that holds the Parlay Desk's
-- Supabase tables (see sports-proxy/.env's SUPABASE_URL). Safe to re-run (create if not
-- exists, no destructive drop -- same convention as nhl-game-logs-table.sql).
--
-- What it's for: a nightly engine job (server.js's /internal/jobs/cbb-nightly-tracker,
-- pulled by the cron job in cbb-tracker-cron-run-me.sql) records, for every FINAL NCAAB
-- game, both teams' full-game AND half (1H/2H) scores plus the full team box-score line
-- (FG/3P/FT made-attempted, rebounds, ast/stl/blk/tov, fouls). No player-level table --
-- Seb's call: ML/spread/total only (full game and halves), no props, so there's no need to
-- store individual box scores -- a builder reads those live, per pick, for injury/minutes
-- context instead.
--
-- This is the raw data refreshCbbTeams() (server.js) aggregates into the cbbTeams docs:
-- season/home/away/last-5 splits, half splits, and the disclosed SOS proxy (average win%
-- of opponents actually played, computed from this table's away_team/home_team pairs).
--
-- line_provider/home_spread/total_line/home_moneyline/away_moneyline (2026-11-02): a FREE
-- alternative to the-odds-api's paid historical-odds endpoint -- ESPN's own game summary
-- carries a "pickcenter" sportsbook line that's frozen at whatever was last quoted once the
-- game is final, which is effectively the closing line. Paid historical DK data (the real
-- thing, not an ESPN-sourced proxy) stays a later, tournament-only option per Seb (~670
-- games, revisit in February).

create table if not exists cbb_game_logs (
  game_id text primary key,
  date date not null,
  season text, -- "2025-26", "2026-27", etc. (server.js's seasonForDate()) -- lets last
               -- season's backfilled rows stay queryable for PATTERNS without ever being
               -- averaged into this season's live cbbTeams ratings (refreshCbbTeams()
               -- filters to the current season only).
  away_team text not null,
  home_team text not null,
  away_score integer,
  home_score integer,
  away_1h integer,
  away_2h integer,
  home_1h integer,
  home_2h integer,
  line_provider text, -- which sportsbook ESPN's pickcenter line came from (DraftKings preferred)
  home_spread numeric, -- home-team-signed closing spread (negative = home favored)
  total_line numeric, -- closing game total
  home_moneyline integer,
  away_moneyline integer,
  away_fg_made integer, away_fg_att integer, away_fg_pct numeric,
  away_three_made integer, away_three_att integer, away_three_pct numeric,
  away_ft_made integer, away_ft_att integer, away_ft_pct numeric,
  away_oreb integer, away_dreb integer, away_reb integer,
  away_ast integer, away_stl integer, away_blk integer, away_tov integer, away_fouls integer,
  home_fg_made integer, home_fg_att integer, home_fg_pct numeric,
  home_three_made integer, home_three_att integer, home_three_pct numeric,
  home_ft_made integer, home_ft_att integer, home_ft_pct numeric,
  home_oreb integer, home_dreb integer, home_reb integer,
  home_ast integer, home_stl integer, home_blk integer, home_tov integer, home_fouls integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Defensive: in case this file already ran on disk before these columns existed.
alter table cbb_game_logs add column if not exists season text;
alter table cbb_game_logs add column if not exists line_provider text;
alter table cbb_game_logs add column if not exists home_spread numeric;
alter table cbb_game_logs add column if not exists total_line numeric;
alter table cbb_game_logs add column if not exists home_moneyline integer;
alter table cbb_game_logs add column if not exists away_moneyline integer;

create index if not exists idx_cbb_game_logs_date on cbb_game_logs (date);
create index if not exists idx_cbb_game_logs_season on cbb_game_logs (season);
create index if not exists idx_cbb_game_logs_away_team on cbb_game_logs (away_team);
create index if not exists idx_cbb_game_logs_home_team on cbb_game_logs (home_team);

alter table cbb_game_logs enable row level security;
-- No policies yet, same as every other Phase 3 table: the engine writes with the secret
-- key, which bypasses RLS. Add a read-only policy here if a desk page ever reads this
-- table directly with the publishable key.

-- Sanity check after running:
--   select count(*), min(date), max(date) from cbb_game_logs;
