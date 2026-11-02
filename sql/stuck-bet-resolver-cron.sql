-- Parlay Desk -- hourly stuck-bet resolver (2026-11-02, Seb's request, previously approved).
-- Run this once in the Supabase SQL Editor (SQL Editor -> + -> Database -> paste -> Run).
--
-- PREREQUISITE (not done by this file, and not something this session can do): set
-- ANTHROPIC_API_KEY on the sports-proxy Render service's environment. Until that's set,
-- the endpoint 500s cleanly on every call (same "not configured on the server" pattern as
-- every other missing-credential case in this project) -- scheduling this job is safe
-- either way, it just won't do anything useful until the key is there.
--
-- WHAT IT DOES: every hour, 24/7, calls sports-proxy's /internal/jobs/stuck-bet-resolver.
-- That endpoint is itself engine-gated -- it only ever looks at a pnlEntries doc that is
-- still pending/needs_review, has real stake > 0, and whose lastStart (or, if that's
-- missing, its ticket date) is at least 5 hours in the past (4h typical game length + 1h
-- buffer) -- so a bet is never touched by this before it has any business being resolved.
-- For each eligible leg the rule-based grader (grader.js) still can't read -- First TD
-- Scorer legs most of all, which need real scoring-play ORDER that grader.js doesn't have
-- at all by design -- it hands Sonnet real ESPN data (final score, box score, or the game's
-- full ordered touchdown list) and asks for a definitive grade or an explicit
-- "unresolvable", logging every attempt either way to the new stuckResolverLog collection.
-- After 3 failed attempts on the same ticket it stops and DMs Seb instead of retrying
-- forever.
--
-- Note: this is a BACKSTOP, not the primary fix for most of what piles up -- the hourly
-- self-heal watchdog (sql/self-heal-cron.sql) already wakes Post-Cutover Sync whenever
-- Supabase drifts from what real results say it should be, and that routine's own judgment
-- resolves most stuck legs (FTD included) once it's actually running. This only reaches a
-- ticket that's STILL stuck after that.
--
-- TOKEN: passed as ?token=... in the URL, same pattern as every other pg_net call in this
-- project.
--
-- FAIL-SAFE: plain net.http_get, same shape as every other cron job here -- a failed call
-- never blocks or breaks anything else in the database, it just shows up as a non-2xx row
-- in net._http_response.
--
-- Safe to re-run: unschedules any previous version of this exact job first.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid)
from cron.job
where jobname = 'parlay-desk-stuck-bet-resolver-hourly';

select cron.schedule(
  'parlay-desk-stuck-bet-resolver-hourly',
  '20 * * * *',  -- every hour at :20 (offset from self-heal's :05 so they don't collide), 24/7
  $$
  select net.http_get(
    url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/stuck-bet-resolver?token=<PROXY_TOKEN from rule sports-proxy-source>'
  );
  $$
);

-- Sanity check: confirm the job is scheduled.
select jobid, jobname, schedule, active from cron.job where jobname = 'parlay-desk-stuck-bet-resolver-hourly';

-- To check recent run results later:
--   select * from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'parlay-desk-stuck-bet-resolver-hourly')
--   order by start_time desc limit 10;
--
-- To see what the resolver has tried and what Sonnet said (every attempt, resolved or not):
--   select * from docs where collection = 'stuckResolverLog' order by updated_at desc limit 20;
