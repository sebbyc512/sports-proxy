-- NCAAB daily check -- pg_cron job (2026-11-04, Seb's request). Run this once in the
-- Supabase SQL editor, AFTER the sports-proxy server.js change (the
-- /internal/jobs/cbb-daily-snapshot endpoint) has been deployed.
--
-- What it does: once a morning, Postgres itself (via pg_cron + pg_net) makes an HTTP GET
-- to sports-proxy's /internal/jobs/cbb-daily-snapshot endpoint, which pulls today's NCAAB
-- slate (matchups, tip times), DK full-game + 1H/2H lines, the ESPN injuries feed, and
-- each playing team's cbbTeams profile -- writes it all directly to Supabase (desk main,
-- cbb/today), free, no Claude usage. If 8+ of today's games involve an AP Top 25 or
-- power-conference team, it also fires the "NCAAB Daily Busy-Day Notes (engine-gated)"
-- Sonnet routine (CBB_DAILY_FIRE_URL/TOKEN, set on Render -- mint from that routine's own
-- settings page first) for short qualitative notes on just those games.
--
-- DST NOTE: this cron expression is in UTC and does not auto-adjust for US DST, same as
-- every other time-of-day job here. 13:45 UTC = 8:45 AM EST (current) / 9:45 AM EDT.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid)
from cron.job
where jobname = 'cbb-daily-snapshot';

select cron.schedule(
  'cbb-daily-snapshot',
  '45 13 * * *',
  $$
  do $do$
  begin
    perform net.http_get(
      url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/cbb-daily-snapshot?token=<PROXY_TOKEN from rule sports-proxy-source>'
    );
  exception when others then
    raise warning 'cbb-daily-snapshot: http_get failed: %', SQLERRM;
  end;
  $do$;
  $$
);

-- Sanity check: confirm the job is scheduled.
select jobid, jobname, schedule, active from cron.job where jobname = 'cbb-daily-snapshot';

-- To check recent run results later:
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'cbb-daily-snapshot') order by start_time desc limit 10;
