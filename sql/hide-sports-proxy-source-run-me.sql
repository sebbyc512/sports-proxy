-- Cutover step 5, token-rotation follow-up (2026-11-03): hide the sports-proxy-source
-- rule doc (which holds the literal PROXY_TOKEN) from every RLS-bound app login,
-- admin included -- the app never needs this doc, only the engine (service key) and
-- the builders (which read it straight from ArtifactData, never via Supabase/RLS).
--
-- RESTRICTIVE, not a replacement for the existing "read own desk" policy: a restrictive
-- policy's USING clause is ANDed with every permissive SELECT policy on the table
-- regardless of that policy's name or definition, so this blocks the one row for any
-- RLS-bound role without touching (or needing to know) the existing policy at all.
-- The engine's service-role key bypasses RLS entirely and is unaffected.
--
-- Safe to re-run (drop-if-exists then create).

drop policy if exists "docs_hide_sports_proxy_source" on docs;
create policy "docs_hide_sports_proxy_source" on docs
  as restrictive
  for select
  using (
    not (collection = 'rules' and doc_id = 'sports-proxy-source')
  );

-- Verify: confirm the restrictive policy is attached.
select polname, polcmd, polpermissive
from pg_policy
where polrelid = 'docs'::regclass and polname = 'docs_hide_sports_proxy_source';
