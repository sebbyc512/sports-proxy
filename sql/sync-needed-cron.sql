-- Engine-gated sync wake -- pg_cron job, every 10 minutes (2026-11-04, Seb's request).
-- Replaces hourly Post-Cutover Sync polling: this cheap, read-only check catches the gap
-- between instant app-action wakes and the daily 6:00 AM ET backup sweep -- a request/
-- appUpload/appEdit sitting queued/pending for a while, or a claim stuck in "processing"
-- after a crash. Run this once in the Supabase SQL editor, AFTER the sports-proxy
-- server.js change (the /internal/jobs/sync-needed endpoint) has been deployed.
--
-- What it does: calls GET /internal/jobs/sync-needed. That endpoint checks main+steve's
-- requests/appUploads/appEdits in Supabase (read-only, no ArtifactData access from this
-- process): backlog pending >5 min fires the existing fast-path wake (Phase 0+1+1c);
-- a claim stuck "processing" >20 min fires a NEW full, markerless wake (its own 1-hour
-- cooldown) so the hourly-only stuck-claim-recovery step still runs even on the now-daily
-- schedule. Finds nothing -> does nothing, no log write. Any finding is logged to
-- selfHealLog.
--
-- Safe to re-run: unschedules any previous version of this exact job first.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid)
from cron.job
where jobname = 'parlay-desk-sync-needed';

select cron.schedule(
  'parlay-desk-sync-needed',
  '*/10 * * * *',  -- every 10 minutes, 24/7
  $$
  select net.http_get(
    url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/sync-needed?token=<PROXY_TOKEN from rule sports-proxy-source>'
  );
  $$
);

-- Sanity check: confirm the job is scheduled.
select jobid, jobname, schedule, active from cron.job where jobname = 'parlay-desk-sync-needed';

-- To check recent run results later:
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'parlay-desk-sync-needed') order by start_time desc limit 10;
--
-- To see what recent checks actually found (only written when something was found -- a
-- clean check leaves no row here):
--   select * from docs where collection = 'selfHealLog' and data->>'source' = 'sync-needed' order by updated_at desc limit 20;
