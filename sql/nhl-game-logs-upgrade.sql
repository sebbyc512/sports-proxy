-- NHL tracker upgrade: team PP/PK + skater TOI/role fields (2026-10-29, Seb's request).
-- Run this once in the Supabase SQL editor, AFTER nhl-game-logs-table.sql has already been
-- run. No token in this file -- it's pure schema, safe to run as-is (not gitignored).
--
-- Adds, to nhl_game_logs: each team's power-play goals/opportunities for that game (team
-- PP% = pp_goals/pp_opportunities; a team's PK% for that game = 1 - the OPPONENT's PP%,
-- computed from these same four columns, no extra storage needed).
--
-- Adds, to nhl_skater_logs: time-on-ice, power-play TOI, shorthanded TOI and even-strength
-- TOI (all in seconds, converted from ESPN's "MM:SS" strings by the tracker). PP1 role
-- isn't a field ESPN exposes directly -- it's inferred downstream as "top ~5 pp_toi_seconds
-- on that team in that game," which these columns make possible without a separate flag.
--
-- Last-5/last-10 form, home/away splits and back-to-backs are NOT new columns -- they're
-- pure aggregations over date/home_team/away_team/scores, which nhl_game_logs already has.
-- See sql/nhl-team-form-endpoint.md (or server.js's /api/nhl/team-form) for how those are
-- computed on read, not stored.

alter table nhl_game_logs
  add column if not exists away_pp_goals integer,
  add column if not exists away_pp_opportunities integer,
  add column if not exists home_pp_goals integer,
  add column if not exists home_pp_opportunities integer;

alter table nhl_skater_logs
  add column if not exists toi_seconds integer,
  add column if not exists pp_toi_seconds integer,
  add column if not exists sh_toi_seconds integer,
  add column if not exists es_toi_seconds integer;

-- Sanity check after running:
--   select column_name from information_schema.columns where table_name = 'nhl_game_logs' order by ordinal_position;
--   select column_name from information_schema.columns where table_name = 'nhl_skater_logs' order by ordinal_position;
