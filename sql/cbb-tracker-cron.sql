-- NCAAB tracker + engine-gated learning loop -- two pg_cron jobs (2026-11-02, Seb's
-- request). Run the "-run-me" version of this file (real token baked in, gitignored) in
-- the Supabase SQL editor, AFTER the sports-proxy server.js change (the
-- /internal/jobs/cbb-nightly-tracker and /internal/jobs/cbb-learning-gate endpoints) has
-- been deployed -- same two-step pattern as nhl-tracker-cron.sql/nba-tracker-cron.sql.
--
-- JOB 1 -- cbb-nightly-tracker-nightly: once a night, well after the last NCAAB game has
-- gone final, a plain GET to /internal/jobs/cbb-nightly-tracker. No date param -- pulls
-- yesterday in ET by default, same convention as the NHL/blowout trackers. Records every
-- final game's full+half scores and team box score into cbb_game_logs, then re-aggregates
-- every team's cbbTeams doc (record, conference, pts/FG%/3P%/rebounds/TOV for and against,
-- home/away + half splits, last-5, SOS proxy, AP rank if the poll is out). Pure data
-- collection -- no Claude usage, never fires anything by itself.
--
-- JOB 2 -- cbb-learning-gate-hourly: every hour, a plain GET to
-- /internal/jobs/cbb-learning-gate. That endpoint counts newly graded CBB legs across MAIN
-- and Steve's desks since the last time it actually fired the CBB learning loop, and ONLY
-- fires the routine (via CBB_LOOP_FIRE_URL/CBB_LOOP_FIRE_TOKEN, set on Render -- see the
-- routine's own trigger settings on claude.ai) once that count reaches 10.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'cbb-nightly-tracker-nightly';
select cron.unschedule(jobid) from cron.job where jobname = 'cbb-learning-gate-hourly';

select cron.schedule(
  'cbb-nightly-tracker-nightly',
  '35 9 * * *',  -- 9:35 AM UTC = ~4:35/5:35 AM ET -- offset from NBA's :05 and NHL's :00 slots
  $$
  do $do$
  begin
    perform net.http_get(
      url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/cbb-nightly-tracker?token=<PROXY_TOKEN from rule sports-proxy-source>'
    );
  exception when others then
    raise warning 'cbb-nightly-tracker-nightly: http_get failed: %', SQLERRM;
  end;
  $do$;
  $$
);

select cron.schedule(
  'cbb-learning-gate-hourly',
  '25 * * * *',  -- hourly, offset from the other sports' gate jobs
  $$
  do $do$
  begin
    perform net.http_get(
      url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/cbb-learning-gate?token=<PROXY_TOKEN from rule sports-proxy-source>'
    );
  exception when others then
    raise warning 'cbb-learning-gate-hourly: http_get failed: %', SQLERRM;
  end;
  $do$;
  $$
);

-- Sanity check: confirm both jobs are scheduled.
select jobid, jobname, schedule, active from cron.job where jobname in ('cbb-nightly-tracker-nightly', 'cbb-learning-gate-hourly');

-- To check recent run results later:
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'cbb-nightly-tracker-nightly') order by start_time desc limit 10;
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'cbb-learning-gate-hourly') order by start_time desc limit 10;

-- The season started 2026-11-02 -- no multi-week backfill needed. Run this once manually
-- to populate Supabase before relying on the nightly cron:
--   https://sports-proxy-nv9n.onrender.com/internal/jobs/cbb-nightly-tracker?token=<PROXY_TOKEN from rule sports-proxy-source>
