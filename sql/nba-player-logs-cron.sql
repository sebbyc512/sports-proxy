-- NBA player game logs -- cron job (2026-11-06, daily-data batch item 1, Seb's request).
-- Run this once in the Supabase SQL editor, AFTER nba-player-logs-table.sql has been run
-- and the sports-proxy server.js hook (the /internal/jobs/nba-player-logs endpoint) has
-- been deployed -- same two-step pattern as sports-proxy/sql/nba-blowout-cron.sql.
--
-- What it does: twice a day, Postgres itself (via pg_cron + pg_net) makes an HTTP GET to
-- sports-proxy's /internal/jobs/nba-player-logs endpoint with no date param, which defaults
-- to "yesterday" (ET). The endpoint pulls every final NBA game from that date, records
-- every player's box-score line into nba_player_logs (upserted on game_id+player_id, so
-- re-running the same night never duplicates), then refreshes the nbaPlayerForm docs
-- (last-5/last-10 averages + minutes trend) for every team that played.
--
-- Two schedules, both calling the same endpoint with no params: the nightly run (well
-- after every NBA game that night has gone final) catches the normal case, and the 2 PM ET
-- re-run recovers anything that was still "in progress"/delayed (OT, data lag) when the
-- nightly run hit it -- the upsert makes this idempotent, so there's no harm in both firing.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'nba-player-logs-nightly';
select cron.unschedule(jobid) from cron.job where jobname = 'nba-player-logs-2pm-refresh';

select cron.schedule(
  'nba-player-logs-nightly',
  '0 9 * * *',  -- 9:00 AM UTC = 4:00/5:00 AM ET -- well after every NBA game that night has gone final
  $$
  select net.http_get(
    url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/nba-player-logs?token=<PROXY_TOKEN from rule sports-proxy-source>'
  );
  $$
);

select cron.schedule(
  'nba-player-logs-2pm-refresh',
  '0 19 * * *',  -- 7:00 PM UTC = 2:00/3:00 PM ET
  $$
  select net.http_get(
    url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/nba-player-logs?token=<PROXY_TOKEN from rule sports-proxy-source>'
  );
  $$
);

-- Sanity check: confirm both jobs are scheduled.
select jobid, jobname, schedule, active from cron.job where jobname in ('nba-player-logs-nightly', 'nba-player-logs-2pm-refresh');

-- To check recent run results later:
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'nba-player-logs-nightly') order by start_time desc limit 10;

-- ONE-TIME BACKFILL (run manually once, not part of either schedule -- adjust the date
-- range to the current season so far). Safe to re-run; upserts on game_id+player_id. Do
-- this from a browser/curl, not SQL, since it's a plain GET, one date per call (no
-- from/to range support on this endpoint, unlike nba-blowout-tracker):
--   https://sports-proxy-nv9n.onrender.com/internal/jobs/nba-player-logs?date=20261020&token=<PROXY_TOKEN from rule sports-proxy-source>
