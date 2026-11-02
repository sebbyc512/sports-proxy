-- Parlay Desk -- hourly stuck-bet resolver GATE (2026-11-02, Seb's request, previously approved).
-- Run this once in the Supabase SQL Editor (SQL Editor -> + -> Database -> paste -> Run).
--
-- PREREQUISITE (not done by this file, and not something this session can do -- these are
-- credentials, not code): set STUCK_RESOLVER_FIRE_URL / STUCK_RESOLVER_FIRE_TOKEN on the
-- sports-proxy Render service's environment, same shape as CLAUDE_FIRE_URL/TOKEN and
-- MAIN_BUILDER_FIRE_URL/TOKEN already are. These point at the ALREADY-BUILT claude.ai
-- routine "Parlay Desk Stuck Bet Resolver (engine-gated)"
-- (trig_01XucFaBvmZ4GpdqnTEELUVt, model Sonnet, enabled since 2026-10-30) -- that routine
-- does the real work (grades from real ESPN data, writes both the desk and the Supabase
-- mirror); this file only schedules the GATE that decides when to fire it. The trigger
-- currently has no API fire-token minted -- that mint is a credential-creation action and
-- needs your explicit go-ahead, not something done automatically.
--
-- WHAT IT DOES: every hour, 24/7, calls sports-proxy's /internal/jobs/stuck-bet-gate. That
-- endpoint finds every main/steve pnlEntries doc that's still pending/needs_review, has
-- real stake > 0, and whose lastStart (or firstStart, or end-of-day on its `date` when
-- neither is present) is at least 5 hours in the past (4h typical game length + 1h
-- buffer) -- so nothing is ever handed off before it has any business being resolved.
-- If it finds any, it fires the Sonnet routine above with EXACTLY that list of
-- {desk, docId, desc} to work on (never a blind scan on the routine's side). The routine
-- grades every unresolved leg from real sources only (final score for ML/spread/total,
-- the game's actual scoring-play order for First-TD-scorer legs, box score for
-- anytime-TD/triple-double/stat legs), skips anything `protected:true`, leaves anything it
-- genuinely can't confirm exactly as-is, writes the real desk then the Supabase mirror, and
-- sends ONE Telegram message to the group for the whole run (never one per bet).
--
-- Note: this is a BACKSTOP, not the primary fix for most of what piles up -- the hourly
-- self-heal watchdog (sql/self-heal-cron.sql) already wakes Post-Cutover Sync whenever
-- Supabase drifts from what real results say it should be, and that routine's own hourly
-- pass resolves most stuck legs on its own once it's actually running. This only reaches a
-- ticket that's STILL stuck after that -- confirmed 2026-11-02 against a real 13-ticket
-- backlog: by the time this gate was tested, self-heal + the grader.js ET-suffix fix (see
-- that commit) had already cleared all 13 on their own; only 3 unrelated tickets were left
-- for this gate to find.
--
-- COOLDOWN: one fire per hour max, tracked in a shared `stuckResolverState/_global` doc in
-- Supabase (survives a Render restart) -- same shape as self-heal's own wake cooldown.
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
where jobname = 'parlay-desk-stuck-bet-gate-hourly';

select cron.schedule(
  'parlay-desk-stuck-bet-gate-hourly',
  '20 * * * *',  -- every hour at :20 (offset from self-heal's :05 so they don't collide), 24/7
  $$
  select net.http_get(
    url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/stuck-bet-gate?token=<PROXY_TOKEN from rule sports-proxy-source>'
  );
  $$
);

-- Sanity check: confirm the job is scheduled.
select jobid, jobname, schedule, active from cron.job where jobname = 'parlay-desk-stuck-bet-gate-hourly';

-- To check recent run results later:
--   select * from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'parlay-desk-stuck-bet-gate-hourly')
--   order by start_time desc limit 10;
