-- Balance guard hourly cron (2026-11-05, Seb's request)
-- TEMPLATE -- replace <PROXY_TOKEN> below with the current token (see rule
-- sports-proxy-source on the MAIN desk, or sql/balance-guard-cron-run-me.sql, gitignored,
-- for the filled-in version) before running this in the Supabase SQL Editor. Never commit a
-- filled-in copy of this file with the real token -- see .gitignore.
--
-- Runs /internal/jobs/balance-guard every hour at :45 (offset from every other hourly job --
-- self-heal :05, stuck-bet-gate :20, nhl-learning-gate :15, nba-learning-gate :20,
-- soccer/cbb-learning-gate :25 -- so none of them collide). Pure engine code, no Claude
-- usage at all: watches each desk's real balance (start + deposits/withdrawals/DK-match
-- adjustments + settled-bet net) and DMs Seb immediately, in plain language, the moment it
-- moves more than $50 in a way no bet settling / deposit / withdrawal / DK match explains.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'parlay-desk-balance-guard-hourly';

select cron.schedule(
  'parlay-desk-balance-guard-hourly',
  '45 * * * *',
  $$
  select net.http_get(
    url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/balance-guard?token=<PROXY_TOKEN, see rule sports-proxy-source>',
    timeout_milliseconds := 30000
  );
  $$
);

-- Sanity check: confirm the job is scheduled.
select jobid, jobname, schedule, active from cron.job where jobname = 'parlay-desk-balance-guard-hourly';

-- To check recent run results later:
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'parlay-desk-balance-guard-hourly') order by start_time desc limit 10;
--
-- To see what a run actually found (only written when an unexplained move triggered an
-- alert -- a clean check leaves no row here):
--   select * from docs where collection = 'balanceGuardLog' order by updated_at desc limit 20;
--
-- To run it manually right now (dry run first, no DM sent, no state moved):
--   https://sports-proxy-nv9n.onrender.com/internal/jobs/balance-guard?dryRun=true&token=<PROXY_TOKEN, see rule sports-proxy-source>
