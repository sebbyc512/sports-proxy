-- CLV (closing-line value) capture -- hourly pg_cron job (2026-11-06, Seb's request, item 1
-- of the learning-data batch).
-- Run this once in the Supabase SQL editor, AFTER sql/clv-legs-table.sql has been run and the
-- sports-proxy server.js change (the /internal/jobs/clv-capture endpoint) has been deployed.
--
-- WHAT IT DOES: every hour, Postgres itself (via pg_cron + pg_net) makes an HTTP GET to
-- sports-proxy's /internal/jobs/clv-capture endpoint. That endpoint scans every Claude-built
-- "parlays" ticket (main + steve) for legs the grader has already settled (hit/miss/push) but
-- that don't have a clv_legs row yet, matches each to its ESPN game, and writes one row per
-- leg to clv_legs with the DK closing number vs. the price/line at build time -- see the
-- endpoint's own comment in server.js for exactly how. Idempotent and self-limiting: a leg
-- that's already captured (success OR a permanent "no data for this one" row) is never
-- re-processed, so this job's own cost shrinks to near-zero once it's caught up.
--
-- Safe to re-run: unschedules any previous version of this exact job first.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid)
from cron.job
where jobname = 'clv-capture-hourly';

select cron.schedule(
  'clv-capture-hourly',
  '20 * * * *',  -- every hour at :20, offset from self-heal's :05 and the goalie tracker's :00/:10/...
  $$
  select net.http_get(
    url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/clv-capture?token=<PROXY_TOKEN from rule sports-proxy-source>'
  );
  $$
);

-- Sanity check: confirm the job is scheduled.
select jobid, jobname, schedule, active from cron.job where jobname = 'clv-capture-hourly';

-- To check recent run results later:
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'clv-capture-hourly') order by start_time desc limit 10;
