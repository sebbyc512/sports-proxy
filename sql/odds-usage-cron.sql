-- Odds API credit alert -- daily pg_cron check.
-- Run this once in the Supabase SQL editor (Project > SQL Editor) for the project that
-- holds the Parlay Desk's Supabase tables (see sports-proxy/.env's SUPABASE_URL).
--
-- What it does: once a day, Postgres itself (via pg_cron + pg_net) makes an HTTP GET to
-- sports-proxy's /internal/jobs/odds-usage-check endpoint. That endpoint reads the real
-- the-odds-api.com usage sports-proxy has been recording on every odds call (requests
-- used/remaining, straight from the-odds-api's own response headers), and DMs Seb on
-- Telegram the first time usage crosses 75% or 90% of the CURRENT cycle's quota --
-- quota is used+remaining, so this adjusts itself automatically if/when Seb upgrades
-- his the-odds-api plan, no code or SQL change needed here.
--
-- Prerequisite: deploy the sports-proxy server.js change that adds this endpoint
-- (recordOddsUsage + /internal/jobs/odds-usage-check) before this cron job can do
-- anything useful -- until then the endpoint will just report "no usage recorded yet".

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove any previous version of this job before (re-)scheduling, so re-running this
-- file is safe and never creates a duplicate daily job.
select cron.unschedule(jobid)
from cron.job
where jobname = 'odds-usage-daily-check';

select cron.schedule(
  'odds-usage-daily-check',
  '0 13 * * *',  -- 1:00 PM UTC = 9:00 AM ET / 8:00 AM CT -- once a day, well ahead of evening slates
  $$
  select net.http_get(
    url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/odds-usage-check?token=defbfd82060d8e73195d0bdcc91083e5cf1dbe2e0ce3f2eb92e6c4ce2089ab88'
  );
  $$
);

-- Sanity check: confirm the job is scheduled.
select jobid, jobname, schedule, active from cron.job where jobname = 'odds-usage-daily-check';

-- To check recent run results later:
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'odds-usage-daily-check') order by start_time desc limit 10;
