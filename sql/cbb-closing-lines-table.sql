-- Season-wide CBB closing lines -- table only (2026-11-06+, Seb's request, phase 1 of the
-- analytics-only NBA/CBB projection engine). Same purpose/shape as nba-closing-lines-table.sql
-- -- see that file's header for the full rationale. Separate table (not a shared one with
-- NBA) to keep each league's backfill/cleanup independent.

create table if not exists cbb_closing_lines (
  game_id text primary key,
  league text not null default 'CBB',
  date date not null,
  home_team text not null,
  away_team text not null,
  home_spread numeric,
  total numeric,
  home_moneyline integer,
  away_moneyline integer,
  provider text,
  captured_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_cbb_closing_lines_date on cbb_closing_lines (date);

alter table cbb_closing_lines enable row level security;

-- Sanity check after running:
--   select count(*), min(date), max(date) from cbb_closing_lines;
