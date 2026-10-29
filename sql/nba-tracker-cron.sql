-- NBA tracker + engine-gated learning loop -- two pg_cron jobs (2026-10-29, Seb's
-- request). Run this once in the Supabase SQL editor, AFTER the sports-proxy server.js
-- change (the /internal/jobs/nba-nightly-tracker and /internal/jobs/nba-learning-gate
-- endpoints) has been deployed -- same two-step pattern as nhl-tracker-cron.sql.
--
-- Replaces the Claude "NBA Tracker refresh" (8:30 AM ET) and "NBA Team Tracker — daily
-- learning" (9:00 AM ET) triggers' NUMERIC/structural work (record, ptsFor/ptsAgainst,
-- pace, offRtg/defRtg, offRank/defRank, identity, merged blowout-risk fields) with a pure
-- engine job. Prose (nbaTeams' "note", nba/meta's openingGames/injuries) and lessons stay
-- Claude-side, now only refreshed when the gated learning loop below actually fires --
-- not every morning. Both old triggers get paused (not deleted) once this is verified.
--
-- JOB 1 -- nba-nightly-tracker-nightly: once a night, well after the last NBA game has
-- gone final, Postgres itself (via pg_cron + pg_net) makes an HTTP GET to sports-proxy's
-- /internal/jobs/nba-nightly-tracker. No date param -- unlike NHL's game-log tracker,
-- this one pulls live current-season STANDINGS (always up to date, nothing to backfill
-- by date), so every run is a full current-state refresh. Pure data collection -- no
-- Claude usage, never fires anything by itself.
--
-- JOB 2 -- nba-learning-gate-hourly: every hour, a plain GET to
-- /internal/jobs/nba-learning-gate. That endpoint counts newly graded NBA legs across
-- MAIN and Steve's desks (tagged claude/seb/steve/tail) since the last time it actually
-- fired the NBA learning loop, and ONLY fires the routine (via NBA_LOOP_FIRE_URL/
-- NBA_LOOP_FIRE_TOKEN, set on Render -- see the routine's own trigger settings on
-- claude.ai) once that count reaches 10. Below that, it's a cheap read-only count against
-- the existing Supabase docs mirror and does nothing else -- no Claude run, no no-op
-- session. Hourly (not nightly) so a threshold crossing is caught same-day.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove any previous version of either job before (re-)scheduling, so re-running this
-- file is safe and never creates a duplicate job.
select cron.unschedule(jobid) from cron.job where jobname = 'nba-nightly-tracker-nightly';
select cron.unschedule(jobid) from cron.job where jobname = 'nba-learning-gate-hourly';

select cron.schedule(
  'nba-nightly-tracker-nightly',
  '5 9 * * *',  -- 9:05 AM UTC = ~4:05/5:05 AM ET -- well after every NBA game that night has gone final, offset from NHL's :00 slot
  $$
  do $do$
  begin
    perform net.http_get(
      url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/nba-nightly-tracker?token=<PROXY_TOKEN from rule sports-proxy-source>'
    );
  exception when others then
    raise warning 'nba-nightly-tracker-nightly: http_get failed: %', SQLERRM;
  end;
  $do$;
  $$
);

select cron.schedule(
  'nba-learning-gate-hourly',
  '20 * * * *',  -- hourly, offset from NHL's :15 and other jobs' :00 slots
  $$
  do $do$
  begin
    perform net.http_get(
      url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/nba-learning-gate?token=<PROXY_TOKEN from rule sports-proxy-source>'
    );
  exception when others then
    raise warning 'nba-learning-gate-hourly: http_get failed: %', SQLERRM;
  end;
  $do$;
  $$
);

-- Sanity check: confirm both jobs are scheduled.
select jobid, jobname, schedule, active from cron.job where jobname in ('nba-nightly-tracker-nightly', 'nba-learning-gate-hourly');

-- To check recent run results later:
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'nba-nightly-tracker-nightly') order by start_time desc limit 10;
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'nba-learning-gate-hourly') order by start_time desc limit 10;

-- No date-range backfill needed -- the standings endpoint always reflects the season to
-- date, so the very first run of nba-nightly-tracker-nightly already has every game played
-- so far baked in. Just run it once manually to populate Supabase before relying on it:
--   https://sports-proxy-nv9n.onrender.com/internal/jobs/nba-nightly-tracker?token=<PROXY_TOKEN from rule sports-proxy-source>
