-- Multi-season CBB historical betting lines from CollegeBasketballData (CBBD) -- table
-- only (2026-11-06+, Seb's request, once CFBD_API_KEY was added on Render). Run this once
-- in the Supabase SQL editor. Safe to re-run (create if not exists).
--
-- What it's for: jobs/cbbd-historical-lines.js's pullCbbdHistoricalLinesForSeason (wired
-- into server.js as /internal/jobs/cbbd-historical-lines, NOT on any cron -- Seb runs the
-- backfill manually) backfills closing lines for PAST seasons that the free
-- ESPN-pickcenter-based cbb_closing_lines job can't reach. Kept in its own table, never
-- merged with cbb_closing_lines, so the two sources (free ESPN vs CBBD) are never confused.
--
-- CAUTION: as of this table's creation, the CBBD endpoint/response field names this job
-- expects are an ASSUMPTION built from CBBD's docs/general knowledge, not a live-tested
-- response (no CFBD_API_KEY was available locally when this was written). Confirm a real
-- call's shape matches before trusting rows in this table for a backtest.

create table if not exists cbbd_historical_lines (
  game_id text primary key, -- "cbbd-<cbbd game id>", namespaced so it never collides with cbb_closing_lines' ESPN event ids
  source text not null default 'cbbd',
  season text, -- CBBD convention: year the season starts, e.g. "2025" for 2025-26
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

create index if not exists idx_cbbd_historical_lines_season on cbbd_historical_lines (season);
create index if not exists idx_cbbd_historical_lines_date on cbbd_historical_lines (date);

alter table cbbd_historical_lines enable row level security;
-- No policies yet, same as every other Phase 3+ table: the engine writes with the secret key.

-- Sanity check after a backfill run:
--   select season, count(*), min(date), max(date) from cbbd_historical_lines group by season;
