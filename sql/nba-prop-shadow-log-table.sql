-- NBA player-prop shadow-mode log -- table only (2026-11-06+, Seb's request, phase 1 of
-- the analytics-only NBA/CBB projection engine). Run this once in the Supabase SQL editor
-- for the project that holds the Parlay Desk's Supabase tables. Safe to re-run.
--
-- What it's for: jobs/projection-engine-props.js's buildPropShadowRow() output, written by
-- server.js's /internal/jobs/nba-props-shadow route (NOT on any cron, NOT invoked
-- automatically -- Seb fires it manually once reviewed, since each run calls the metered
-- /odds/props route for current DK lines). One row per (date, player, market) logged the
-- night/day of the game; actual_result and graded get filled in later, once the game is
-- final, by a separate (not-yet-built) grading pass. No historical closing-line source
-- exists for props, so this is log-and-grade-forward, not a retroactive backtest -- see
-- jobs/projection-engine-props.js's header comment.

create table if not exists nba_prop_shadow_log (
  date date not null,
  player text not null,
  player_id text,
  team text,
  opponent text,
  market text not null, -- "points" | "rebounds" | "assists"
  model_projection numeric,
  model_prob_over numeric,
  dk_line numeric,
  dk_over_price integer,
  dk_under_price integer,
  edge_over numeric,
  edge_under numeric,
  actual_result numeric, -- filled in once the game is final
  graded boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (date, player_id, market)
);

create index if not exists idx_nba_prop_shadow_log_date on nba_prop_shadow_log (date);
create index if not exists idx_nba_prop_shadow_log_graded on nba_prop_shadow_log (graded) where graded = false;

alter table nba_prop_shadow_log enable row level security;

-- Sanity check after running:
--   select date, count(*) from nba_prop_shadow_log group by date order by date desc limit 10;
