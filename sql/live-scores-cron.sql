-- Parlay Desk live scores -- pg_cron job (built 2026-10-24, Phase 2 engine).
-- This job was originally scheduled directly in the Supabase SQL editor and never
-- committed to this repo -- recreated here from the live cron.job row (jobid 1) so it
-- stops being an undocumented gap (found 2026-11-03 during the PROXY_TOKEN rotation,
-- when it was missed from the first inventory pass precisely because no file here
-- described it). Run the matching *-run-me.sql copy in the Supabase SQL editor.
--
-- What it does: every 2 minutes, during active hours only, Postgres itself (via pg_cron +
-- pg_net) makes an HTTP GET to sports-proxy's /internal/jobs/live-scores endpoint, which
-- pulls ESPN scoreboards (NFL, CFB, NBA, NHL, MLB, 8 soccer leagues) and upserts
-- `liveScores/now` for all 4 desks. Pure data collection, no Claude usage.
--
-- SCHEDULE is DST-proof: */2 0-6,11-23 * * * (UTC) excludes only UTC 7-10, the quiet
-- window under both EDT and EST (the intersection of "2-7am ET" at UTC-4 and UTC-5) --
-- needs zero maintenance across DST changes.
--
-- Safe to re-run: unschedules any previous version of this exact job first.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid)
from cron.job
where jobname = 'parlay-desk-live-scores';

select cron.schedule(
  'parlay-desk-live-scores',
  '*/2 0-6,11-23 * * *',
  $$
  select net.http_get(
    url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/live-scores?token=<PROXY_TOKEN from rule sports-proxy-source>'
  );
  $$
);

-- Sanity check: confirm the job is scheduled.
select jobid, jobname, schedule, active from cron.job where jobname = 'parlay-desk-live-scores';

-- To check recent run results later:
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'parlay-desk-live-scores') order by start_time desc limit 10;
