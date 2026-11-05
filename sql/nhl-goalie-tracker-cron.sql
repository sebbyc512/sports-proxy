-- NHL starting-goalie tracker -- pg_cron job (2026-11-05, Seb's ask).
-- Run this once in the Supabase SQL editor, AFTER nhl-goalies-table.sql has been run and
-- the sports-proxy server.js change (the /internal/jobs/nhl-goalie-tracker endpoint) has
-- been deployed -- same two-step pattern as sports-proxy/sql/nba-blowout-cron.sql.
--
-- What it does: every 10 minutes, all day, Postgres itself (via pg_cron + pg_net) makes an
-- HTTP GET to sports-proxy's /internal/jobs/nhl-goalie-tracker endpoint. The endpoint reads
-- today's full NHL schedule from the NHL's own api-web.nhle.com, and for every game that's
-- currently 70-110 minutes from puck drop ("projected", ~90 min) or 10-50 minutes out
-- ("confirmed", ~30 min) it writes that tier's starter into nhl_goalies -- a 10-minute poll
-- comfortably covers both windows without any per-game scheduling. See the endpoint's own
-- comment block in server.js for exactly which sources back each tier (DraftKings'
-- player_total_saves listing for projected, api-web.nhle.com's own game-landing/boxscore for
-- confirmed -- no scraped sites).
--
-- Safe to re-run: unschedules any previous version of this exact job first. Also safe on an
-- empty slate (no NHL games that day) -- the endpoint just reports 0 games checked.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid)
from cron.job
where jobname = 'nhl-goalie-tracker';

select cron.schedule(
  'nhl-goalie-tracker',
  '*/10 * * * *',
  $$
  select net.http_get(
    url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/nhl-goalie-tracker?token=<PROXY_TOKEN from rule sports-proxy-source>'
  );
  $$
);

-- Sanity check: confirm the job is scheduled.
select jobid, jobname, schedule, active from cron.job where jobname = 'nhl-goalie-tracker';

-- To check recent run results later:
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'nhl-goalie-tracker') order by start_time desc limit 10;
