-- Season-wide NBA closing lines -- table only (2026-11-06+, Seb's request, phase 1 of the
-- analytics-only NBA/CBB projection engine). Run this once in the Supabase SQL editor for
-- the project that holds the Parlay Desk's Supabase tables. Safe to re-run (create if not
-- exists, no destructive drop -- same convention as every other Phase 3+ table).
--
-- What it's for: jobs/closing-lines.js's pullClosingLinesForDate/pullClosingLinesForDateRange
-- (wired into server.js as /internal/jobs/closing-lines, NOT yet on any cron) pulls the free
-- ESPN-pickcenter closing line for EVERY final NBA game, not just ones Seb bet on -- that's
-- the difference from clv_legs, which only covers bet-on legs. This is the backtest sample
-- for jobs/backtest-sides-totals.js. DATA COLLECTION ONLY -- nothing reads this for live
-- picks, and this route is not scheduled yet; Seb runs the backfill manually.

create table if not exists nba_closing_lines (
  game_id text primary key,
  league text not null default 'NBA',
  date date not null,
  home_team text not null,
  away_team text not null,
  home_spread numeric, -- home-signed: negative = home favored by that many points
  total numeric,
  home_moneyline integer,
  away_moneyline integer,
  provider text, -- which sportsbook ESPN's pickcenter attributed this line to (DraftKings preferred)
  captured_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_nba_closing_lines_date on nba_closing_lines (date);

alter table nba_closing_lines enable row level security;
-- No policies yet, same as every other Phase 3+ table: the engine writes with the secret key.

-- Sanity check after running:
--   select count(*), min(date), max(date) from nba_closing_lines;
