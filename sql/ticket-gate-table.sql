-- Ticket Gate results log -- table only (2026-11-05/06, Seb's request after the JAX@BAL
-- sign-conversion bug and the MIA@GSW out-of-band SGP incident).
-- Run this once in the Supabase SQL editor for the project that holds the Parlay Desk's
-- Supabase tables (see sports-proxy/.env's SUPABASE_URL). Safe to re-run (create if not
-- exists, no destructive drop -- additive only, never touches the shared `docs` table).
--
-- What it's for: every /internal/jobs/ticket-gate run (shadow or live) writes one row here
-- per ticket checked, so a future "Monday recap" routine can show pass/fail counts and
-- which checks are failing most, without re-deriving it from ticket text each time. See
-- server.js's runTicketGate()/ticket-gate.js for the check definitions.

create table if not exists gate_results (
  id bigserial primary key,
  desk text not null,
  request_id text,
  ticket_id text not null,
  attempt integer not null default 1,
  mode text not null default 'shadow',  -- 'shadow' | 'live'
  passed boolean not null,
  checks jsonb not null,      -- { checkName: { pass: bool, detail: string, ... } }
  failures text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists idx_gate_results_request on gate_results (request_id);
create index if not exists idx_gate_results_desk_created on gate_results (desk, created_at desc);
create index if not exists idx_gate_results_ticket on gate_results (ticket_id);

alter table gate_results enable row level security;
-- No policies yet, same as every other Phase 3 table (e.g. nba_blowouts): the engine
-- writes with the secret key, which bypasses RLS. Add a read-only policy here if a desk
-- page or the Monday recap routine ever reads this table directly with the publishable key.

-- Sanity check after running:
--   select mode, passed, count(*) from gate_results group by 1, 2 order by 1, 2;
--   select desk, count(*) filter (where not passed) as fails, count(*) as total
--     from gate_results group by 1;
