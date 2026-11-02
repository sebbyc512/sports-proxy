-- Parlay Desk -- hourly engine self-heal watchdog (2026-11-01, Seb's request).
-- Run this once in the Supabase SQL Editor (SQL Editor -> + -> Database -> paste -> Run).
--
-- WHAT IT DOES: every hour, 24/7, Postgres itself (via pg_cron + pg_net) makes an HTTP GET
-- to sports-proxy's /internal/jobs/self-heal endpoint. That endpoint re-grades every open
-- main/steve pnlEntries doc against real ESPN results (same shadow-grade logic
-- /internal/jobs/grade-and-alert already uses) and compares the result to what's
-- currently stored in Supabase:
--   - any pnlEntries doc whose status/ret/stake isn't what it should be given real game
--     results (this is what catches "open bet whose game already went final but never
--     got graded" too -- that's just a stuck-open mismatch),
--   - the balance swing those corrections would cause (computed balance vs. what the
--     entries currently say it is).
-- If EITHER shows a mismatch, on either desk, it wakes Post-Cutover Sync once (the same
-- /internal/jobs/wake-sync used for app-triggered wakes) and, if the mismatch is on
-- Steve's desk specifically, also re-fires his pick-request builder
-- (/internal/jobs/fire-builder?desk=steve), since his pipeline couples sync+builder.
-- Finds nothing -> does nothing, no log write, no wake.
--
-- COOLDOWN: self-heal's own hourly cadence already caps this at once/hour, but the
-- endpoint also tracks its own 1-hour wake cooldown in Supabase (selfHealState/_global),
-- so a manual re-run of this endpoint can't spam wake-sync either.
--
-- NO-LOOP GUARD: if the SAME mismatch (same doc ids + same balance delta) is still there
-- on the very next hourly run, the endpoint stops calling wake-sync/fire-builder (that
-- would just loop forever) and instead sends Seb a direct Telegram DM flagging it for a
-- manual look. State for this lives in the new selfHealState collection, per desk.
--
-- NEW COLLECTIONS this creates data in (no new SQL tables -- same generic `docs` table as
-- everything else; collections are just a value in that table, nothing to migrate):
--   selfHealLog    -- one doc per hourly run that found a mismatch (never written when clean)
--   selfHealState  -- small rolling state per desk (signature/consecutiveCount) + one
--                     shared `_global` doc for the wake cooldown
--
-- PREREQUISITE: deploy the sports-proxy server.js change that adds
-- /internal/jobs/self-heal (and the triggerSyncWake/triggerBuilderFire refactor it reuses)
-- before scheduling this -- until then the endpoint 404s and pg_net just logs a failed
-- call (see the fail-safe note below).
--
-- TOKEN: passed as ?token=... in the URL, same pattern as every other pg_net call in this
-- project (odds-usage-cron.sql, app-wake-sync.sql, nba-blowout-cron.sql) -- NOT a custom
-- header.
--
-- FAIL-SAFE: this is a plain net.http_get call, same shape as odds-usage-cron.sql -- a
-- failed call (server down, bad token, network hiccup) just shows up as a non-2xx row in
-- net._http_response; it never blocks or breaks anything else in the database.
--
-- Safe to re-run: unschedules any previous version of this exact job first, so re-running
-- this file never creates a duplicate.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid)
from cron.job
where jobname = 'parlay-desk-self-heal-hourly';

select cron.schedule(
  'parlay-desk-self-heal-hourly',
  '5 * * * *',  -- every hour at :05, 24/7
  $$
  select net.http_get(
    url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/self-heal?token=<PROXY_TOKEN from rule sports-proxy-source>'
  );
  $$
);

-- Sanity check: confirm the job is scheduled.
select jobid, jobname, schedule, active from cron.job where jobname = 'parlay-desk-self-heal-hourly';

-- To check recent run results later:
--   select * from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'parlay-desk-self-heal-hourly')
--   order by start_time desc limit 10;
--
-- To see what the last few hourly runs actually found (only written when a mismatch was
-- caught -- a clean desk leaves no row here):
--   select * from docs where collection = 'selfHealLog' order by updated_at desc limit 20;
