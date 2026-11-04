-- Soccer lineup/injury pregame check -- pg_cron job (2026-11-04, Seb's approval + 6
-- refinements). Run this once in the Supabase SQL editor, AFTER the sports-proxy
-- server.js change (the /internal/jobs/soccer-lineup-check endpoint) has been deployed.
--
-- What it does, every 30 minutes: Postgres (via pg_cron + pg_net) hits sports-proxy's
-- /internal/jobs/soccer-lineup-check endpoint, which:
--   1. fetches today+tomorrow (ET) fixtures across EPL/La Liga/Serie A/Bundesliga/
--      Ligue 1/UCL/MLS from API-Football (2 calls), dropping any Inter/AC Milan fixture
--      before any further call is made, and writes the filtered list to Supabase
--      soccer/fixturesToday for builders to read;
--   2. for any of those fixtures whose kickoff is within the next 3 hours, fetches
--      lineups + injuries (API-Football, paced >=7s apart, hard-stopped at 80 calls/day
--      even though the real cap is 100/day + 10/min -- so a manual test never gets
--      locked out) and checks every OPEN soccer leg on both desks against the starting
--      XI / bench / injury list;
--   3. DMs ONLY the bet's own owner (never the group) on a real hit -- same dollar-
--      amount guard and Steve-chat-id guard the rest of the News Layer uses, same
--      player+status+betId dedupe (notifiedState), bundled into one DM per owner per run.
-- Pure engine job, zero Claude usage either way.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'soccer-lineup-check';

select cron.schedule(
  'soccer-lineup-check',
  '*/30 * * * *',
  $$
  do $do$
  begin
    perform net.http_get(
      url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/soccer-lineup-check?token=<PROXY_TOKEN from rule sports-proxy-source>'
    );
  exception when others then
    raise warning 'soccer-lineup-check: http_get failed: %', SQLERRM;
  end;
  $do$;
  $$
);

-- Sanity check: confirm the job is scheduled.
select jobid, jobname, schedule, active from cron.job where jobname = 'soccer-lineup-check';

-- To check recent run results later:
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'soccer-lineup-check') order by start_time desc limit 10;
