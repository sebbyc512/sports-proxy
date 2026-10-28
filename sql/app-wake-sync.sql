-- Parlay Desk App -- instant-wake dispatch + atomic row claim (2026-10-28)
-- Run once in Supabase SQL Editor (SQL Editor -> + -> Database -> paste -> Run).
--
-- PART 1 -- INSTANT WAKE: the moment the APP inserts a new row into `docs` for collection
-- 'requests' / 'appUploads' / 'appEdits' on desk 'main' or 'steve', with that row's own
-- data.source = 'app' and data.status in ('queued','pending') (i.e. a brand-new,
-- not-yet-processed row the app itself created), Postgres calls sports-proxy's
-- /internal/jobs/wake-sync endpoint via pg_net. That endpoint fires Post-Cutover Sync
-- directly via its own "API" trigger (claude.ai/code routine Fire URL + token), with an
-- appended turn telling the routine's prompt to run its FAST PATH (Phase 0 + 1 + 1c only)
-- instead of waiting for the hourly cron.
--
-- TOKEN: passed as ?token=... in the URL, same as every other pg_net call in this project
-- (odds-usage-cron.sql, nba-blowout-cron.sql) -- NOT as a custom header. An earlier version
-- of this file sent it via an x-proxy-token header on net.http_post and got a 401 back
-- (net._http_response showed "Missing or invalid token" even though the token value was
-- right) -- query-string is the pattern actually proven to work against this server's
-- requireToken middleware, so that's what every call here uses now.
--
-- AFTER INSERT ONLY, never AFTER UPDATE: the app's RLS policy (docs_app_insert, see
-- app-rls.sql) only ever lets the app insert new rows, never update existing ones -- so a
-- row's INSERT *is* "the app created this." The sync engine's own writes to these same rows
-- (stamping realRequestId / status "sent"/"applied"/"read"/"answered") are all UPDATEs,
-- which this trigger never fires on -- that is what keeps this from looping back on itself.
-- The data.source/data.status check inside the function is a second, belt-and-suspenders
-- guard for the same reason, in case anything ever inserts on the sync's behalf.
--
-- FAIL-SAFE: the net.http_post call is wrapped in its own begin/exception block. A failed
-- wake (bad URL, sports-proxy down, network hiccup, anything) must NEVER block the app's
-- insert -- the hourly run is always the backup -- so any error in there is caught, logged
-- as a warning (visible later via Postgres logs), and swallowed; the function always falls
-- through to `return NEW` regardless.
--
-- PART 2 -- ATOMIC CLAIM: the generic `docs` table only ever supported a blind upsert
-- (POST .../docs/:collection/:docId), no compare-and-swap -- fine for one writer, but with
-- the fast-path run and the hourly run now both able to touch the same pending appUpload/
-- appEdit/request at once, two overlapping runs could both see "pending" and both process
-- the same row (double BET PLACED, worst case). claim_doc_status() is a single UPDATE
-- statement with the expected-current-status check in its own WHERE clause -- Postgres's
-- normal row-level locking means two concurrent calls on the same row serialize, and only
-- the first one actually matching `data->>'status' = p_expected` updates anything; the
-- loser gets back `false` and must skip that row. Post-Cutover Sync's Phase 0 calls this
-- (via the new POST /api/:desk/docs/:collection/:docId/claim endpoint) before doing any
-- real work on a row, not just before the final write.
--
-- PART 3 -- STUCK-CLAIM RECOVERY: if a run dies right after claiming a row (crash, killed
-- task, lost connection) before it finishes, that row sits at status "processing" forever --
-- nothing would ever touch it again. claim_doc_status now also stamps `claimedAt` on every
-- successful claim. reclaim_stuck_doc() lets the HOURLY FULL run only (never the fast path --
-- see Post-Cutover Sync's own prompt) sweep for rows still "processing" with a `claimedAt`
-- older than its staleness threshold (20 minutes) and take them over -- same
-- WHERE-clause-does-the-locking pattern as claim_doc_status, so two callers racing to reclaim
-- the same stuck row still only let one through.
--
-- NOTE FOR LATER: the dispatch trigger's desk list below is ('main','steve') only -- when
-- Lela/Uli get app access, add them there too.
--
-- This file only ever touches these three functions and this one trigger -- nothing else on
-- `docs` or any other table. Safe to re-run.

create extension if not exists pg_net;

-- Defensive drop of anything from an earlier naming (never actually run, but cheap insurance).
drop trigger if exists docs_github_dispatch on docs;
drop function if exists notify_github_dispatch() cascade;

create or replace function notify_app_insert_dispatch() returns trigger as $$
begin
  if coalesce(NEW.data->>'source', '') = 'app'
     and coalesce(NEW.data->>'status', '') in ('queued', 'pending')
  then
    begin
      perform net.http_post(
        url := 'https://sports-proxy-nv9n.onrender.com/internal/jobs/wake-sync?token=<PROXY_TOKEN from rule sports-proxy-source>',
        headers := '{"Content-Type": "application/json"}'::jsonb,
        body := '{}'::jsonb
      );
    exception when others then
      raise warning 'notify_app_insert_dispatch: wake-sync call failed: %', SQLERRM;
    end;
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

create or replace function claim_doc_status(
  p_desk_id text, p_collection text, p_doc_id text, p_expected text, p_next text
) returns boolean as $$
declare
  n int;
begin
  update docs
    set data = jsonb_set(jsonb_set(data, '{status}', to_jsonb(p_next)), '{claimedAt}', to_jsonb(now()::text)),
        updated_at = now()
    where desk_id = p_desk_id
      and collection = p_collection
      and doc_id = p_doc_id
      and data->>'status' = p_expected;
  get diagnostics n = row_count;
  return n > 0;
end;
$$ language plpgsql security definer;

create or replace function reclaim_stuck_doc(
  p_desk_id text, p_collection text, p_doc_id text, p_stale_minutes int default 20
) returns boolean as $$
declare
  n int;
begin
  update docs
    set data = jsonb_set(data, '{claimedAt}', to_jsonb(now()::text)),
        updated_at = now()
    where desk_id = p_desk_id
      and collection = p_collection
      and doc_id = p_doc_id
      and data->>'status' = 'processing'
      and (data->>'claimedAt') is not null
      and (data->>'claimedAt')::timestamptz < now() - make_interval(mins => p_stale_minutes);
  get diagnostics n = row_count;
  return n > 0;
end;
$$ language plpgsql security definer;

-- Sanity check: list every trigger actually attached to `docs` (confirm there is exactly
-- one dispatch trigger, named docs_app_insert_dispatch, and nothing stray left over).
select tgname, tgenabled, pg_get_triggerdef(oid) as definition
from pg_trigger
where tgrelid = 'docs'::regclass and not tgisinternal;

-- To check recent pg_net call results later (useful while testing the real app upload/request):
--   select * from net._http_response order by created desc limit 10;
