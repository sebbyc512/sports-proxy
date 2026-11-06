-- Historical NBA player-prop DK lines -- table only (2026-11-06+, Seb's explicit approval:
-- 3 markets, US region, one closing snapshot per game, ~4,500 credits, stay above 8,000
-- remaining for the month). Run once in the Supabase SQL editor. Safe to re-run.
--
-- What it's for: jobs/nba-props-historical-pull.js's output, written by server.js's
-- /internal/jobs/nba-props-historical-pull route (NOT on any cron -- the parent session
-- fires it once per date, manually, checking quota between calls). This is the real DK
-- prop line at/near tip-off for a past game, pulled via The Odds API's historical endpoint
-- -- separate from nba_prop_shadow_log (which is forward-looking, log-only, no historical
-- source). jobs/props-walkforward-backtest.js joins these rows against nba_player_logs'
-- real actual results to grade a point-in-time backtest.

create table if not exists nba_prop_historical_lines (
  date date not null,
  player text not null,
  home_team text not null,
  away_team text not null,
  market text not null, -- "points" | "rebounds" | "assists"
  dk_line numeric not null,
  dk_over_price integer,
  dk_under_price integer,
  snapshot_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (date, player, market)
);

create index if not exists idx_nba_prop_historical_lines_date on nba_prop_historical_lines (date);

alter table nba_prop_historical_lines enable row level security;

-- Sanity check after running:
--   select date, count(*) from nba_prop_historical_lines group by date order by date desc limit 10;
