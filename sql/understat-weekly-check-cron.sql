-- Understat weekly up/down check -- pg_cron job (2026-11-04, Seb's ask, item 5 of the
-- soccer data-source swap). Run this once in the Supabase SQL editor, AFTER the
-- sports-proxy server.js change (the /internal/jobs/understat-weekly-check endpoint) has
-- been deployed.
--
-- What it does, once a week: checks whether understat.com is back up (it currently shows
-- "We will come back soon" -- confirmed 2026-11-04). Writes the result to Supabase
-- engineMeta/understatStatus. If it just came back up (was down last check, is up now),
-- DMs Seb directly -- it does NOT edit the live Monday-recap routine to add this, per
-- Seb's "no live routine edited in place" rule. No xG wiring here or anywhere yet; this
-- is purely a status flag for a future build step. Pure engine job, zero Claude usage.
--
-- DST NOTE: this cron expression is in UTC and does not auto-adjust for US DST, same as
-- every other time-of-day job here. 12:00 UTC = 7:00 AM EST (current) / 8:00 AM EDT --
-- deliberately ahead of the 8:30am ET Monday recap routine.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'understat-weekly-check';

select cron.schedule(
  'understat-weekly-check',
  '0 12 * * 1',
  $$
  do $do$
  begin
    perform net.http_get(
      url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/understat-weekly-check?token=<PROXY_TOKEN from rule sports-proxy-source>'
    );
  exception when others then
    raise warning 'understat-weekly-check: http_get failed: %', SQLERRM;
  end;
  $do$;
  $$
);

-- Sanity check: confirm the job is scheduled.
select jobid, jobname, schedule, active from cron.job where jobname = 'understat-weekly-check';

-- To check recent run results later:
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'understat-weekly-check') order by start_time desc limit 10;
