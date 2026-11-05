-- NHL starting-goalie tracker table (2026-11-05, Seb's ask, nhl-model-spec 3-state rule).
-- One row per team per game (game_id, team), written by the
-- /internal/jobs/nhl-goalie-tracker endpoint -- see sql/nhl-goalie-tracker-cron.sql for the
-- pg_cron job that drives it, and nhl-goalies-table-run-me.sql for the one-time setup to run
-- in the Supabase SQL editor.
--
-- Two tiers, both self-gated by minutes-to-puck-drop inside the endpoint (no per-game
-- scheduling needed -- one frequent poll covers every game at whatever stage it's in):
--   projected (~90 min out): DraftKings' own player_total_saves prop listing via
--     the-odds-api -- DK only posts a goalie saves line for the goalie it expects to start,
--     so whichever name appears there IS the projected starter. Verified live 2026-11-05
--     against a real game (Columbus @ Dallas): DK had posted Columbus's own goalie's saves
--     line ~6.5 hours before puck drop, so the window catches it comfortably by T-90.
--   confirmed (~30 min out): the NHL's own api-web.nhle.com game-landing/boxscore endpoint,
--     which only carries a real starter once the game moves off gameState "FUT" -- confirmed
--     against the real NHL API 2026-11-05 (still empty hours out, as expected).
-- backup_flag: true when the identified starter is NOT that team's highest-gamesStarted
-- goalie this season, per api-web.nhle.com's own /v1/club-stats/{team}/now -- a season-starts
-- proxy, not a true depth-chart feed (no such flag exists on either source). Verified live
-- 2026-11-05: Dallas's Oettinger (12 starts) vs DeSmith (3) is a clean case; Columbus's
-- Talbot (6) vs Greaves (7) is a near-even one -- expect some borderline calls early in a
-- season, tightens up as gamesStarted totals grow.

create table if not exists nhl_goalies (
  game_id text not null,
  team text not null,
  opponent text not null,
  is_home boolean not null,
  date date not null,
  puck_drop_utc timestamptz not null,
  projected_starter text,
  projected_source text,
  projected_at timestamptz,
  confirmed_starter text,
  confirmed_source text,
  confirmed_at timestamptz,
  backup_flag boolean,
  updated_at timestamptz not null default now(),
  primary key (game_id, team)
);

create index if not exists idx_nhl_goalies_date on nhl_goalies (date);
alter table nhl_goalies enable row level security;
