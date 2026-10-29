-- Soccer tracker + engine-gated learning loop -- two pg_cron jobs (2026-10-29, Seb's
-- request). Run this once in the Supabase SQL editor, AFTER the sports-proxy server.js
-- change (the /internal/jobs/soccer-nightly-tracker and /internal/jobs/soccer-learning-gate
-- endpoints) has been deployed -- same two-step pattern as nhl-tracker-cron.sql.
--
-- Replaces the Claude "Soccer Tracker daily refresh" (8:00 AM ET) trigger's
-- NUMERIC/structural work (domestic comp/rank/rec/gf/ga/gd/pts, European
-- euroComp/euroRank/..., identity) with a pure engine job across 10 competitions (EPL, La
-- Liga, Serie A, Bundesliga, Ligue 1, MLS, Liga Argentina, FPC, Champions League, Europa
-- League). soccerTeams/soccer-meta did NOT exist in Supabase before this -- this job
-- creates them fresh; doc ids are freshly assigned, not required to match whatever ids
-- the old Claude-maintained ArtifactData docs used.
--
-- NOT engine-automatable, confirmed live (plain fetches to sofascore.com return HTTP 403
-- from this server; fotmob disallows scraping per its own footer): Sofascore ASR/xG
-- notes, fotmob/Sofascore lineup+injury checks, and the Libertadores/Sudamericana
-- knockout bracket. Those stay on a separate LIGHT weekly Claude trigger (Mondays 7:00 AM
-- ET, see the routine's own trigger settings on claude.ai) that reads/writes these same
-- Supabase docs via sports-proxy's GET/POST /api/main/docs/soccerTeams routes.
--
-- JOB 1 -- soccer-nightly-tracker-nightly: once a night, well after that day's matches
-- have gone final across all time zones in scope, an HTTP GET to
-- /internal/jobs/soccer-nightly-tracker. No date param -- pulls live current standings
-- (always up to date), so every run is a full current-state refresh. Pure data
-- collection -- no Claude usage, never fires anything by itself.
--
-- JOB 2 -- soccer-learning-gate-hourly: every hour, a plain GET to
-- /internal/jobs/soccer-learning-gate. Counts newly graded Soccer legs across MAIN and
-- Steve's desks (tagged claude/seb/steve/tail) since the last fire, and ONLY fires the
-- routine (via SOCCER_LOOP_FIRE_URL/SOCCER_LOOP_FIRE_TOKEN, set on Render) once that count
-- reaches 10. Below that, cheap read-only count, no Claude run, no no-op session.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'soccer-nightly-tracker-nightly';
select cron.unschedule(jobid) from cron.job where jobname = 'soccer-learning-gate-hourly';

select cron.schedule(
  'soccer-nightly-tracker-nightly',
  '10 9 * * *',  -- 9:10 AM UTC -- offset from NHL's :00 and NBA's :05 slots
  $$
  do $do$
  begin
    perform net.http_get(
      url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/soccer-nightly-tracker?token=<PROXY_TOKEN from rule sports-proxy-source>'
    );
  exception when others then
    raise warning 'soccer-nightly-tracker-nightly: http_get failed: %', SQLERRM;
  end;
  $do$;
  $$
);

select cron.schedule(
  'soccer-learning-gate-hourly',
  '25 * * * *',  -- hourly, offset from NHL's :15 and NBA's :20 slots
  $$
  do $do$
  begin
    perform net.http_get(
      url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/soccer-learning-gate?token=<PROXY_TOKEN from rule sports-proxy-source>'
    );
  exception when others then
    raise warning 'soccer-learning-gate-hourly: http_get failed: %', SQLERRM;
  end;
  $do$;
  $$
);

-- Sanity check: confirm both jobs are scheduled.
select jobid, jobname, schedule, active from cron.job where jobname in ('soccer-nightly-tracker-nightly', 'soccer-learning-gate-hourly');

-- To check recent run results later:
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'soccer-nightly-tracker-nightly') order by start_time desc limit 10;
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'soccer-learning-gate-hourly') order by start_time desc limit 10;

-- No date-range backfill needed -- standings always reflect the season to date. Just run
-- it once manually to populate Supabase before relying on it:
--   https://sports-proxy-nv9n.onrender.com/internal/jobs/soccer-nightly-tracker?token=<PROXY_TOKEN from rule sports-proxy-source>
