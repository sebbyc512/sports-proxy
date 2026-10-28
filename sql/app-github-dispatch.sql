-- Parlay Desk App -- instant-wake dispatch (2026-10-28)
-- Run once in Supabase SQL Editor (SQL Editor -> + -> Database -> paste -> Run).
--
-- What it does: the moment the APP inserts a new row into `docs` for collection
-- 'requests' / 'appUploads' / 'appEdits' on desk 'main' or 'steve', with that row's own
-- data.source = 'app' and data.status in ('queued','pending') (i.e. a brand-new,
-- not-yet-processed row the app itself created), Postgres calls sports-proxy's
-- /internal/jobs/github-dispatch endpoint via pg_net. That endpoint fires a GitHub
-- repository_dispatch event, which a Claude Code webhook trigger is wired to pick up and
-- fire Post-Cutover Sync's fast-path routine within seconds -- instead of waiting for the
-- hourly cron.
--
-- AFTER INSERT ONLY, never AFTER UPDATE: the app's RLS policy (docs_app_insert, see
-- app-rls.sql) only ever lets the app insert new rows, never update existing ones -- so a
-- row's INSERT *is* "the app created this." The sync engine's own writes to these same rows
-- (stamping realRequestId / status "sent"/"applied"/"read"/"answered") are all UPDATEs,
-- which this trigger never fires on -- that is what keeps this from looping back on itself.
-- The data.source/data.status check inside the function is a second, belt-and-suspenders
-- guard for the same reason, in case anything ever inserts on the sync's behalf.
--
-- Safe to re-run: only drops and recreates this one function and this one trigger, nothing
-- else on `docs` or any other table is touched.

create extension if not exists pg_net;

create or replace function notify_app_insert_dispatch() returns trigger as $$
begin
  if coalesce(NEW.data->>'source', '') = 'app'
     and coalesce(NEW.data->>'status', '') in ('queued', 'pending')
  then
    perform net.http_post(
      url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/github-dispatch',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-proxy-token', '<PROXY_TOKEN from rule sports-proxy-source>'
      ),
      body := jsonb_build_object(
        'collection', NEW.collection,
        'desk', NEW.desk_id,
        'doc_id', NEW.doc_id
      )
    );
  end if;
  return NEW;
end;
$$ language plpgsql security definer;

drop trigger if exists docs_app_insert_dispatch on docs;
create trigger docs_app_insert_dispatch
  after insert on docs
  for each row
  when (NEW.collection in ('requests', 'appUploads', 'appEdits') and NEW.desk_id in ('main', 'steve'))
  execute function notify_app_insert_dispatch();

-- Sanity check: confirm the trigger is attached.
select tgname, tgenabled from pg_trigger where tgname = 'docs_app_insert_dispatch';

-- To check recent pg_net call results later (useful while testing the real app upload/request):
--   select * from net._http_response order by created desc limit 10;
