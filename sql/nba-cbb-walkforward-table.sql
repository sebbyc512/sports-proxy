-- Point-in-time walk-forward backtest results (2026-11-06+, Seb's request, after the first
-- backtest was flagged for look-ahead bias). Run this once in the Supabase SQL editor.
-- Safe to re-run.
--
-- One row per game, written by scripts/walkforward-validate.mjs. Unlike nba_projections /
-- cbb_projections (which store the LIVE engine's current-moment projection), these rows are
-- historical reconstructions: the projection for date D was built using ONLY each team's
-- own games strictly before D (see jobs/walkforward-backtest.js's buildPointInTimeRating),
-- so this table is safe to aggregate into real calibration/ATS%/ROI numbers without the
-- circularity the first backtest had.

create table if not exists nba_walkforward_backtest (
  game_id text primary key,
  league text not null default 'NBA',
  date date not null,
  home_team text not null,
  away_team text not null,
  home_games_used integer, -- how many prior games fed the home team's point-in-time rating
  away_games_used integer,
  projected_margin numeric,
  projected_total numeric,
  closing_home_spread numeric,
  closing_total numeric,
  closing_home_ml integer,
  closing_away_ml integer,
  actual_home_score integer,
  actual_away_score integer,
  ats_hit boolean, -- null = push or no gradable spread line
  edge_spread_pts numeric,
  total_hit boolean,
  edge_total_pts numeric,
  ml_hit boolean,
  ml_pick text, -- 'home' | 'away'
  created_at timestamptz not null default now()
);

create table if not exists cbb_walkforward_backtest (
  game_id text primary key,
  league text not null default 'CBB',
  date date not null,
  home_team text not null,
  away_team text not null,
  home_games_used integer,
  away_games_used integer,
  projected_margin numeric,
  projected_total numeric,
  closing_home_spread numeric,
  closing_total numeric,
  closing_home_ml integer,
  closing_away_ml integer,
  actual_home_score integer,
  actual_away_score integer,
  ats_hit boolean,
  edge_spread_pts numeric,
  total_hit boolean,
  edge_total_pts numeric,
  ml_hit boolean,
  ml_pick text,
  created_at timestamptz not null default now()
);
