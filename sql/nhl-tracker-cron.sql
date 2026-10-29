-- NHL tracker + engine-gated learning loop -- two pg_cron jobs (2026-10-29, Seb's
-- request). Run this once in the Supabase SQL editor, AFTER nhl-game-logs-table.sql has
-- been run and the sports-proxy server.js change (the /internal/jobs/nhl-nightly-tracker
-- and /internal/jobs/nhl-learning-gate endpoints) has been deployed -- same two-step
-- pattern as nba-blowout-cron.sql.
--
-- JOB 1 -- nhl-nightly-tracker-nightly: once a night, well after the last NHL game has
-- gone final, Postgres itself (via pg_cron + pg_net) makes an HTTP GET to sports-proxy's
-- /internal/jobs/nhl-nightly-tracker with no date param, which defaults to "yesterday"
-- (ET). Pure data collection -- no Claude usage, never fires anything by itself.
--
-- JOB 2 -- nhl-learning-gate-hourly: every hour, a plain GET to
-- /internal/jobs/nhl-learning-gate. That endpoint counts newly graded NHL legs across
-- MAIN and Steve's desks (tagged claude/seb/steve/tail) since the last time it actually
-- fired the NHL learning loop, and ONLY fires the routine (via NHL_LOOP_FIRE_URL/
-- NHL_LOOP_FIRE_TOKEN, set on Render -- see the routine's own trigger settings on
-- claude.ai for trig_013nPeQ8Sk74619muX8a2f8k) once that count reaches 10. Below that,
-- it's a cheap read-only count against the existing Supabase docs mirror and does
-- nothing else -- no Claude run, no no-op session. Hourly (not nightly) so a threshold
-- crossing is caught same-day rather than waiting for the next 5 AM tick.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove any previous version of either job before (re-)scheduling, so re-running this
-- file is safe and never creates a duplicate job.
select cron.unschedule(jobid) from cron.job where jobname = 'nhl-nightly-tracker-nightly';
select cron.unschedule(jobid) from cron.job where jobname = 'nhl-learning-gate-hourly';

select cron.schedule(
  'nhl-nightly-tracker-nightly',
  '0 9 * * *',  -- 9:00 AM UTC = 4:00/5:00 AM ET -- well after every NHL game that night has gone final
  $$
  select net.http_get(
    url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/nhl-nightly-tracker?token=<PROXY_TOKEN from rule sports-proxy-source>'
  );
  $$
);

select cron.schedule(
  'nhl-learning-gate-hourly',
  '15 * * * *',  -- hourly, offset from the top of the hour so it doesn't collide with other jobs' :00 schedules
  $$
  select net.http_get(
    url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/nhl-learning-gate?token=<PROXY_TOKEN from rule sports-proxy-source>'
  );
  $$
);

-- Sanity check: confirm both jobs are scheduled.
select jobid, jobname, schedule, active from cron.job where jobname in ('nhl-nightly-tracker-nightly', 'nhl-learning-gate-hourly');

-- To check recent run results later:
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'nhl-nightly-tracker-nightly') order by start_time desc limit 10;
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'nhl-learning-gate-hourly') order by start_time desc limit 10;

-- ONE-TIME BACKFILL (run manually once, not part of the nightly schedule -- covers
-- however far back Seb wants game logs to start). Safe to re-run; upserts on game_id. Do
-- this from a browser/curl, not SQL, since it's a plain GET:
--   https://sports-proxy-nv9n.onrender.com/internal/jobs/nhl-nightly-tracker?from=20261013&to=20261028&token=<PROXY_TOKEN from rule sports-proxy-source>
-- then let the nightly job take over from there.
