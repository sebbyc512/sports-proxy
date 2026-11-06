-- Point-in-time NBA player-props walk-forward backtest results -- table only (2026-11-06+,
-- Seb's explicit request after flagging look-ahead bias in the first sides/totals backtest;
-- same discipline applied to props). Run once in the Supabase SQL editor. Safe to re-run.
--
-- What it's for: jobs/props-walkforward-backtest.js's gradeWalkForwardProp() output, one row
-- per (date, player, market) graded against a REAL historical DK line
-- (nba_prop_historical_lines) and a REAL actual result (nba_player_logs) -- nothing in this
-- table is simulated. jobs/props-walkforward-backtest.js's summarizePropsBacktest() reads
-- these rows to produce hit%/ROI overall, by probability-edge bucket, and by market.

create table if not exists nba_props_walkforward_results (
  date date not null,
  player text not null,
  market text not null, -- "points" | "rebounds" | "assists"
  projection numeric,
  model_prob_over numeric,
  dk_line numeric,
  dk_over_price integer,
  dk_under_price integer,
  pick text, -- "over" | "under" | null (no pick made)
  edge_abs_pp numeric, -- probability-point edge of the pick taken, NOT a point-margin edge
  actual_result numeric,
  hit boolean, -- null = push or ungradable
  roi_units numeric,
  created_at timestamptz not null default now(),
  primary key (date, player, market)
);

create index if not exists idx_nba_props_walkforward_results_date on nba_props_walkforward_results (date);

alter table nba_props_walkforward_results enable row level security;

-- Sanity check after running:
--   select date, count(*) from nba_props_walkforward_results group by date order by date desc limit 10;
