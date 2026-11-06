-- CLV (closing-line value) capture -- dedicated table (2026-11-06, Seb's request, item 1 of
-- the learning-data batch, v2: Seb asked for its own table instead of writing onto parlays
-- docs, so Post-Cutover Sync's cross-desk mirror sync can never wipe it and the real ticket
-- docs stay byte-for-byte untouched by this engine-only job).
--
-- One row per (desk, ticket, leg) that the grader has already settled to hit/miss/push.
-- clv/clv_type/closing_price/closing_line are null when that leg has no free closing-data
-- source (a prop/FTD/anytime-scorer/stat leg, or a game ESPN's pickcenter never carried) --
-- the row still gets written (clv_type = 'unsupported' / 'no-closing-data' / 'no-match') so
-- the capture job never retries the same dead end on every run. See
-- /internal/jobs/clv-capture's own comment in server.js for exactly how clv is computed.
--
-- Run this once in the Supabase SQL editor, BEFORE deploying the sports-proxy server.js
-- change that writes to this table.

create table if not exists clv_legs (
  desk_id text not null,
  ticket_id text not null,
  leg_index integer not null,
  sport text,
  bet_type text,              -- "ml" | "spread" | "total" | "unsupported"
  paper boolean,
  build_price numeric,        -- leg's own American-odds price at build time, if any
  closing_price numeric,      -- DK closing American-odds price (ml legs only)
  closing_line numeric,       -- DK closing spread/total number, signed for this leg's side (spread/total legs only)
  clv numeric,                -- positive = beat the close; implied-%-pts for ml, points for spread/total
  clv_type text,              -- "implied % pts" | "points" | "unsupported" | "no-closing-data" | "no-match"
  captured_at timestamptz not null default now(),
  primary key (desk_id, ticket_id, leg_index)
);

create index if not exists idx_clv_legs_sport_type on clv_legs (sport, bet_type);
create index if not exists idx_clv_legs_captured_at on clv_legs (captured_at);

alter table clv_legs enable row level security;
