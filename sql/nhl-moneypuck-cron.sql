-- MoneyPuck NHL data -- cron job (2026-11-06, daily-data batch item 8, Seb's request).
-- Run once in the Supabase SQL editor, AFTER nhl-moneypuck-table.sql has been run and the
-- sports-proxy server.js hook (the /internal/jobs/nhl-moneypuck endpoint) has been deployed.
--
-- What it does: once a night, Postgres makes one HTTP GET to /internal/jobs/nhl-moneypuck,
-- which downloads the four MoneyPuck files (one download per file, per data.htm's terms),
-- parses/filters them to the current season, and upserts into the four nhl_moneypuck_*
-- tables. Timed well after nba-player-logs' own nightly run so the two don't compete for
-- Render's outbound bandwidth at the same minute.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'nhl-moneypuck-nightly';

select cron.schedule(
  'nhl-moneypuck-nightly',
  '15 9 * * *',  -- 9:15 AM UTC = 4:15/5:15 AM ET
  $$
  select net.http_get(
    url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/nhl-moneypuck?token=<PROXY_TOKEN from rule sports-proxy-source>'
  );
  $$
);

select jobid, jobname, schedule, active from cron.job where jobname = 'nhl-moneypuck-nightly';
