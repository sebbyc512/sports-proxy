-- First TD weekly archive -- Tuesday-morning pg_cron job (2026-10-28, Seb's request).
-- Run this once in the Supabase SQL editor, AFTER the sports-proxy server.js change (the
-- /internal/jobs/archive-ftd endpoint) has been deployed -- same two-step pattern as
-- sports-proxy/sql/nba-blowout-cron.sql and odds-usage-cron.sql.
--
-- What it does: once a week, well after the "Parlay Desk NFL TD weekly learning loop" trigger
-- has graded the week's First TD options (that trigger fires Tuesday ~9:06 AM ET per its own
-- cron, even though its name/description says 8 AM -- this job is scheduled with a 2-hour
-- buffer after that, not after the nominal 8 AM), Postgres itself (via pg_cron + pg_net) makes
-- an HTTP GET to sports-proxy's /internal/jobs/archive-ftd endpoint. With no ?desk param it
-- archives BOTH "main" and "steve" (Seb's desk and Steve's desk get the same First TD options
-- and the same archive treatment; Lela is not on this feature). The endpoint moves every doc
-- in collection "ftd" to collection "ftdHistory" (same doc_id) for each desk, then clears "ftd"
-- so the app's First TD tab starts the new week empty. Pure engine job, no Claude usage.
--
-- DST NOTE: this cron expression is in UTC and does not auto-adjust for US DST. 15:00 UTC is
-- 11:00 AM ET while EDT is in effect (through 2026-11-01), then 10:00 AM ET once EST starts.
-- Either way it still runs comfortably after the learning loop's ~9:06 AM ET fire -- no action
-- needed across the DST change, but if the gap ever feels too tight, re-run this file with an
-- adjusted schedule.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove any previous version of this job before (re-)scheduling, so re-running this file
-- is safe and never creates a duplicate weekly job.
select cron.unschedule(jobid)
from cron.job
where jobname = 'ftd-weekly-archive';

select cron.schedule(
  'ftd-weekly-archive',
  '0 15 * * 2',  -- 15:00 UTC Tuesday = 11:00 AM EDT / 10:00 AM EST -- after the learning loop
  $$
  select net.http_get(
    url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/archive-ftd?token=<PROXY_TOKEN from rule sports-proxy-source>'
  );
  $$
);

-- Sanity check: confirm the job is scheduled.
select jobid, jobname, schedule, active from cron.job where jobname = 'ftd-weekly-archive';

-- To check recent run results later:
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'ftd-weekly-archive') order by start_time desc limit 10;

-- To run it manually right now (e.g. to test before next Tuesday), from a browser/curl:
--   https://sports-proxy-nv9n.onrender.com/internal/jobs/archive-ftd?token=<PROXY_TOKEN from rule sports-proxy-source>
-- Or for just one desk:
--   https://sports-proxy-nv9n.onrender.com/internal/jobs/archive-ftd?desk=main&token=<PROXY_TOKEN from rule sports-proxy-source>
