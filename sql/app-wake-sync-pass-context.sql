-- Pass desk/collection/docId to wake-sync on the app-insert dispatch trigger (2026-11-05)
-- TEMPLATE -- replace <PROXY_TOKEN> below with the current token (see rule sports-proxy-source
-- on the MAIN desk, or sql/app-wake-sync-pass-context-run-me.sql, gitignored, for the filled-in
-- version) before running this in the Supabase SQL Editor (SQL Editor -> + -> Database -> paste
-- -> Run). Never commit a filled-in copy of this file with the real token -- that run-me
-- filename pattern is gitignored on purpose; see .gitignore.
--
-- WHY: a request submitted from the app sat at Supabase status "queued" for ~10 minutes on
-- 2026-11-05 even though this trigger fired correctly within 16s of the insert -- the
-- Post-Cutover Sync fast-path run it woke up skipped its own Phase 0a-i copy-up step for
-- that row on that one run (a model miss, not a wiring bug), and nothing else was in a
-- position to notice until sync-needed's own 10-minute backstop caught it on its next tick.
--
-- FIX (one of three layers, see the other two: the two pick-request builders now also check
-- the Supabase mirror themselves and can self-serve an app-sourced row PCS hasn't copied up
-- yet; PCS's own Phase 0a-i instruction was tightened to put its Supabase GET first,
-- unmissably, instead of buried mid-paragraph): this trigger now also tells wake-sync WHICH
-- desk/collection/doc just got inserted, so wake-sync can fire that desk's own builder
-- directly (same relay + 90s cooldown sync-needed already uses) in addition to the existing
-- PCS fast-path wake -- the builder no longer has to wait on PCS at all to notice a fresh
-- app request. Only server.js's /internal/jobs/wake-sync behavior changes; this file only
-- changes the one trigger function below, same as app-wake-sync.sql originally created it.
--
-- Safe to re-run; only touches notify_app_insert_dispatch(), nothing else.

create or replace function notify_app_insert_dispatch() returns trigger as $$
begin
  if coalesce(NEW.data->>'source', '') = 'app'
     and coalesce(NEW.data->>'status', '') in ('queued', 'pending')
  then
    begin
      perform net.http_post(
        url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/wake-sync?token=<PROXY_TOKEN, see rule sports-proxy-source>',
        headers := '{"Content-Type": "application/json"}'::jsonb,
        body := jsonb_build_object('desk', NEW.desk_id, 'collection', NEW.collection, 'docId', NEW.doc_id),
        timeout_milliseconds := 30000
      );
    exception when others then
      raise warning 'notify_app_insert_dispatch: wake-sync call failed: %', SQLERRM;
    end;
  end if;
  return NEW;
end;
$$ language plpgsql security definer;

-- Sanity check: confirm the trigger is still attached, unchanged (this file never touches
-- the trigger itself, only the function it calls).
select tgname, tgenabled, pg_get_triggerdef(oid) as definition
from pg_trigger
where tgrelid = 'docs'::regclass and not tgisinternal;
