-- NBA + CBB sides/totals engine projections -- table only (2026-11-06+, Seb's request,
-- phase 1 of the analytics-only NBA/CBB projection engine). Run this once in the Supabase
-- SQL editor for the project that holds the Parlay Desk's Supabase tables. Safe to re-run.
--
-- What it's for: jobs/projection-engine-sides-totals.js's buildSidesTotalsProjection()
-- output (wired into server.js, route NOT yet on any cron) -- one row per game, storing the
-- model's projected margin/total plus the DK line it was compared against and the edge on
-- each market. jobs/backtest-sides-totals.js joins this against nba_closing_lines /
-- cbb_closing_lines and final scores. DATA COLLECTION ONLY -- nothing reads this for live
-- picks or feeds the builders yet; that wiring is a separate, later, explicitly-approved step.

create table if not exists nba_projections (
  game_id text, -- nullable: a projection can be written before an ESPN game_id is known
  league text not null default 'NBA',
  date date not null,
  home_team text not null,
  away_team text not null,
  projected_margin numeric, -- positive = home favored
  projected_total numeric,
  dk_spread numeric,
  dk_total numeric,
  dk_ml_home integer,
  dk_ml_away integer,
  model_prob_home_ml numeric,
  edge_home_ml numeric,
  model_prob_home_spread numeric,
  edge_home_spread numeric,
  model_prob_total_over numeric,
  edge_total_over numeric,
  created_at timestamptz not null default now()
);

create table if not exists cbb_projections (
  game_id text,
  league text not null default 'CBB',
  date date not null,
  home_team text not null,
  away_team text not null,
  projected_margin numeric,
  projected_total numeric,
  dk_spread numeric,
  dk_total numeric,
  dk_ml_home integer,
  dk_ml_away integer,
  model_prob_home_ml numeric,
  edge_home_ml numeric,
  model_prob_home_spread numeric,
  edge_home_spread numeric,
  model_prob_total_over numeric,
  edge_total_over numeric,
  created_at timestamptz not null default now()
);

create index if not exists idx_nba_projections_date on nba_projections (date);
create index if not exists idx_nba_projections_teams on nba_projections (home_team, away_team, date);
create index if not exists idx_cbb_projections_date on cbb_projections (date);
create index if not exists idx_cbb_projections_teams on cbb_projections (home_team, away_team, date);

alter table nba_projections enable row level security;
alter table cbb_projections enable row level security;

-- Sanity check after running:
--   select date, count(*) from nba_projections group by date order by date desc limit 10;
