-- Parlay Desk App — Phase 3A, Session B2 (app can save)
-- Run once in Supabase SQL Editor (SQL Editor -> + -> Database -> paste -> Run).
--
-- ADDITIVE ONLY. Does NOT touch anything already live:
--   - the existing `profiles` table (user_id, display_name, desk_id, desk_name, role)
--   - the existing is_admin() / my_desk() functions
--   - the existing "read own desk" SELECT policy on `docs`
-- This file only adds: one new INSERT policy on `docs`, plus the private `slips`
-- storage bucket and its two policies. Safe to re-run (every object uses
-- `if exists` / `if not exists` / `on conflict`) -- re-running it never drops or
-- recreates `profiles` or any existing policy.
--
-- What it adds:
--   1. docs INSERT policy: a logged-in app user may insert a row into `docs` only
--      when collection is 'requests' / 'appUploads' / 'appEdits' and desk_id equals
--      their own desk (my_desk()). No update/delete policy is added for this role --
--      the app never edits or deletes a docs row directly, only inserts new ones;
--      edits to the real desk happen via the appEdits contract, applied server-side.
--   2. Private storage bucket 'slips', one folder per desk_id -- a user may upload to
--      / read from only their own desk_id/ folder (path '<desk_id>/<doc_id>-<n>.<ext>'
--      per the app contract). my_desk() must return the same desk_id values
--      ('main' / 'steve') already used by `docs.desk_id` and `profiles.desk_id`.
--
-- The engine (sports-proxy, using the SERVICE key, never the publishable key) is not
-- subject to RLS at all -- it already reads/writes every desk regardless of these
-- policies, same as it does for `docs` today.

drop policy if exists "docs_app_insert" on docs;
create policy "docs_app_insert" on docs
  for insert
  with check (
    collection in ('requests', 'appUploads', 'appEdits')
    and desk_id = my_desk()
  );

insert into storage.buckets (id, name, public)
values ('slips', 'slips', false)
on conflict (id) do nothing;

drop policy if exists "slips_own_folder_insert" on storage.objects;
create policy "slips_own_folder_insert" on storage.objects
  for insert
  with check (
    bucket_id = 'slips'
    and my_desk() = (storage.foldername(name))[1]
  );

drop policy if exists "slips_own_folder_select" on storage.objects;
create policy "slips_own_folder_select" on storage.objects
  for select
  using (
    bucket_id = 'slips'
    and my_desk() = (storage.foldername(name))[1]
  );
