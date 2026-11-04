-- News layer -- two pg_cron jobs (2026-11-04, Seb's request). Run this once in the
-- Supabase SQL editor, AFTER the sports-proxy server.js change (the
-- /internal/jobs/news-check and /internal/jobs/news-check-fast endpoints) has been
-- deployed.
--
-- JOB 1 -- news-check-3h: every 3 hours, Postgres itself (via pg_cron + pg_net) makes an
-- HTTP GET to sports-proxy's /internal/jobs/news-check endpoint, which pulls ESPN
-- injuries/transactions for NFL/NBA/NHL/CBB/CFB (soccer excluded -- ESPN exposes nothing
-- usable for it; soccer injury context stays on the existing sofascore/fotmob Claude
-- routine), writes Supabase news/<league> (stale-on-failure guard, never wipes real data
-- on a bad poll), and DMs the bet's own owner (never the group) on a new Out/Doubtful/
-- transaction hit against an open bet. Pure engine job, zero Claude usage.
--
-- JOB 2 -- news-check-fast-30min: every 30 minutes, same endpoint logic but gated --
-- /internal/jobs/news-check-fast only actually runs the full check (and hits ESPN) when
-- an open bet (either desk) has a leg kicking off within the next 3 hours; otherwise it's
-- a cheap no-op. NFL inactives post ~90 minutes before kickoff, so this catches that
-- window without running every 30 minutes all day for no reason.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'news-check-3h';
select cron.unschedule(jobid) from cron.job where jobname = 'news-check-fast-30min';

select cron.schedule(
  'news-check-3h',
  '0 */3 * * *',
  $$
  do $do$
  begin
    perform net.http_get(
      url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/news-check?token=<PROXY_TOKEN from rule sports-proxy-source>'
    );
  exception when others then
    raise warning 'news-check-3h: http_get failed: %', SQLERRM;
  end;
  $do$;
  $$
);

select cron.schedule(
  'news-check-fast-30min',
  '*/30 * * * *',
  $$
  do $do$
  begin
    perform net.http_get(
      url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/news-check-fast?token=<PROXY_TOKEN from rule sports-proxy-source>'
    );
  exception when others then
    raise warning 'news-check-fast-30min: http_get failed: %', SQLERRM;
  end;
  $do$;
  $$
);

-- Sanity check: confirm both jobs are scheduled.
select jobid, jobname, schedule, active from cron.job where jobname in ('news-check-3h', 'news-check-fast-30min');

-- To check recent run results later:
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'news-check-3h') order by start_time desc limit 10;
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'news-check-fast-30min') order by start_time desc limit 10;
