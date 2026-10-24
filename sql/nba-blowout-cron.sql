-- NBA blowout tracker -- nightly pg_cron job (2026-10-24, Seb's request).
-- Run this once in the Supabase SQL editor, AFTER nba-blowout-table.sql has been run and
-- the sports-proxy server.js change (the /internal/jobs/nba-blowout-tracker endpoint) has
-- been deployed -- same two-step pattern as sports-proxy/sql/odds-usage-cron.sql.
--
-- What it does: once a night, well after the day's last NBA tip, Postgres itself (via
-- pg_cron + pg_net) makes an HTTP GET to sports-proxy's /internal/jobs/nba-blowout-tracker
-- endpoint with no date param, which defaults to "yesterday" (ET) -- i.e. it records the
-- games that finished that evening. The endpoint fetches each final game's ESPN play-by-play
-- and box score, computes the margin at the 4:00 mark of the 4th quarter plus both teams'
-- starters' minutes, and upserts one row per game into nba_blowouts (keyed on game_id, so a
-- re-run of the same night never duplicates).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove any previous version of this job before (re-)scheduling, so re-running this file
-- is safe and never creates a duplicate nightly job.
select cron.unschedule(jobid)
from cron.job
where jobname = 'nba-blowout-tracker-nightly';

select cron.schedule(
  'nba-blowout-tracker-nightly',
  '0 9 * * *',  -- 9:00 AM UTC = 4:00/5:00 AM ET -- well after every NBA game that night has gone final
  $$
  select net.http_get(
    url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/nba-blowout-tracker?token=<PROXY_TOKEN from rule sports-proxy-source>'
  );
  $$
);

-- Sanity check: confirm the job is scheduled.
select jobid, jobname, schedule, active from cron.job where jobname = 'nba-blowout-tracker-nightly';

-- To check recent run results later:
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'nba-blowout-tracker-nightly') order by start_time desc limit 10;

-- ONE-TIME BACKFILL (run manually once, not part of the nightly schedule -- the season
-- started 2026-10-20, so this covers every game so far). Safe to re-run; upserts on
-- game_id. Do this from a browser/curl, not SQL, since it's a plain GET:
--   https://sports-proxy-nv9n.onrender.com/internal/jobs/nba-blowout-tracker?from=20261020&to=20261024&token=<PROXY_TOKEN from rule sports-proxy-source>
-- then keep extending `to` (or just let the nightly job take over) as more games are played.
