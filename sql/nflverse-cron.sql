-- nflverse NFL data -- cron job (2026-11-06, daily-data batch item 9, Seb's explicit ask).
-- Run once in the Supabase SQL editor, AFTER nflverse-table.sql has been run and the
-- sports-proxy server.js hook has been deployed.
--
-- Daily during the season: injuries, snap counts, team EPA. nflverse's own data typically
-- updates a few times a day during the season (more often close to kickoff) -- once a day
-- is enough for pick-building context, not a live-injury feed.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'nflverse-nightly';

select cron.schedule(
  'nflverse-nightly',
  '20 9 * * *',  -- 9:20 AM UTC = 4:20/5:20 AM ET
  $$
  select net.http_get(
    url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/nflverse?token=<PROXY_TOKEN from rule sports-proxy-source>'
  );
  $$
);

select jobid, jobname, schedule, active from cron.job where jobname = 'nflverse-nightly';
