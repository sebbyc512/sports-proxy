-- FBS college football tracker -- nightly pg_cron job (2026-11-04, Seb's request).
-- Run this once in the Supabase SQL editor, AFTER cfb-game-logs-table.sql has been run
-- and the sports-proxy server.js change (the /internal/jobs/cfb-nightly-tracker
-- endpoint) has been deployed -- same two-step pattern as cbb-tracker-cron.sql.
--
-- What it does: once a night, well after the day's last FBS game has gone final,
-- Postgres itself (via pg_cron + pg_net) makes an HTTP GET to sports-proxy's
-- /internal/jobs/cfb-nightly-tracker endpoint, which defaults to "yesterday" (ET). Pure
-- data collection -- no Claude usage, never fires anything by itself.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid)
from cron.job
where jobname = 'cfb-nightly-tracker-nightly';

select cron.schedule(
  'cfb-nightly-tracker-nightly',
  '40 9 * * *',  -- 9:40 AM UTC -- offset from NBA/NHL/soccer/CBB's own nightly slots
  $$
  do $do$
  begin
    perform net.http_get(
      url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/cfb-nightly-tracker?token=<PROXY_TOKEN from rule sports-proxy-source>'
    );
  exception when others then
    raise warning 'cfb-nightly-tracker-nightly: http_get failed: %', SQLERRM;
  end;
  $do$;
  $$
);

-- Sanity check: confirm the job is scheduled.
select jobid, jobname, schedule, active from cron.job where jobname = 'cfb-nightly-tracker-nightly';

-- To check recent run results later:
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'cfb-nightly-tracker-nightly') order by start_time desc limit 10;

-- ONE-TIME BACKFILL, whole 2026 season (run manually once, not part of the nightly
-- schedule). Safe to re-run; upserts on game_id. Do this from a browser/curl, not SQL,
-- since it's a plain GET -- the season started in late August, so from=20260820 covers
-- every game so far:
--   https://sports-proxy-nv9n.onrender.com/internal/jobs/cfb-nightly-tracker?from=20260820&to=20261103&token=<PROXY_TOKEN from rule sports-proxy-source>
-- then let the nightly job take over from there.
