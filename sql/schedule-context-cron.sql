-- Rest & schedule context -- cron job (2026-11-06, daily-data batch item 2, Seb's request).
-- Run once in the Supabase SQL editor, AFTER schedule-context-table.sql has been run and
-- the sports-proxy server.js hook (the /internal/jobs/schedule-context endpoint) has been
-- deployed.
--
-- What it does: once a day at 9 AM ET, Postgres makes one HTTP GET per league (?league=NBA,
-- then NHL, then CBB -- three separate calls, since each league's own scoreboard pulls take
-- a few seconds and pg_net's own call timeout is tighter than doing all three in one hit)
-- to /internal/jobs/schedule-context. The endpoint pulls each league's trailing ~10-day
-- schedule plus today+tomorrow, computes rest/back-to-back/3-in-4/road-trip-length/travel-
-- miles for every team playing today or tomorrow, and upserts into schedule_context.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'schedule-context-nba';
select cron.unschedule(jobid) from cron.job where jobname = 'schedule-context-nhl';
select cron.unschedule(jobid) from cron.job where jobname = 'schedule-context-cbb';

select cron.schedule(
  'schedule-context-nba',
  '0 14 * * *',  -- 2:00 PM UTC = 9:00 AM ET
  $$ select net.http_get(url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/schedule-context?league=NBA&token=<PROXY_TOKEN from rule sports-proxy-source>'); $$
);

select cron.schedule(
  'schedule-context-nhl',
  '1 14 * * *',
  $$ select net.http_get(url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/schedule-context?league=NHL&token=<PROXY_TOKEN from rule sports-proxy-source>'); $$
);

select cron.schedule(
  'schedule-context-cbb',
  '2 14 * * *',
  $$ select net.http_get(url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/schedule-context?league=CBB&token=<PROXY_TOKEN from rule sports-proxy-source>'); $$
);

select jobid, jobname, schedule, active from cron.job where jobname like 'schedule-context-%';
