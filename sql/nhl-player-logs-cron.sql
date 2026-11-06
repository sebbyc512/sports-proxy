-- NHL player game logs -- cron job (2026-11-06, daily-data batch item 3, Seb's request).
-- Run once in the Supabase SQL editor, AFTER nhl-player-logs-table.sql has been run and
-- the sports-proxy server.js hook has been deployed.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'nhl-player-logs-nightly';

select cron.schedule(
  'nhl-player-logs-nightly',
  '10 9 * * *',  -- 9:10 AM UTC = 4:10/5:10 AM ET
  $$
  select net.http_get(
    url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/nhl-player-logs?token=<PROXY_TOKEN from rule sports-proxy-source>'
  );
  $$
);

select jobid, jobname, schedule, active from cron.job where jobname = 'nhl-player-logs-nightly';
