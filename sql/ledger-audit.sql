-- Parlay Desk -- ledger baseline + change log (2026-11-06, Seb's request).
-- Documented/committed copy -- no secrets in this file. The run-me version with the real
-- cron URL/token lives at sql/ledger-audit-run-me.sql (gitignored, same as every other
-- *-run-me.sql here).
--
-- WHAT THIS ADDS:
--   1. ledger_snapshots / ledger_snapshot_runs -- a labeled, point-in-time copy of every
--      main/steve pnlEntries doc + the pnl/settings doc, plus that snapshot's computed
--      balance. Taken by sports-proxy's /internal/jobs/ledger-snapshot (manual, e.g. the
--      baseline) and /internal/jobs/ledger-nightly-snapshot (automatic, 4 AM ET, only when
--      the balance guard shows a clean read -- see the cron job below).
--   2. ledger_audit + a trigger on public.docs -- fires on every insert/update/delete to a
--      main or steve pnlEntries row and records desk/doc/op/before/after/who/when. The
--      trigger function wraps its own insert in a nested BEGIN/EXCEPTION block, so a
--      logging failure (bad data, a full disk, anything) can NEVER roll back or block the
--      real write to `docs` -- it just raises a warning and lets the write through.
--   3. /internal/jobs/ledger-diff (sports-proxy) -- compares the live desk to its latest
--      "good" snapshot and labels every change NORMAL or SUSPICIOUS; &repair=true restores
--      only the SUSPICIOUS ones. See server.js's "Ledger baseline + change log" section for
--      the actual classification logic -- this file is schema + trigger only.
--
-- Safe to re-run: every create is "if not exists", the trigger is dropped and recreated.

create table if not exists ledger_snapshots (
  id bigint generated always as identity primary key,
  label text not null,
  desk_id text not null,
  collection text not null,
  doc_id text not null,
  data jsonb not null,
  version integer not null default 1,
  snapshot_at timestamptz not null default now()
);
create index if not exists idx_ledger_snapshots_label_desk on ledger_snapshots (label, desk_id, collection);
alter table ledger_snapshots enable row level security;

-- One row per (label, desk) -- the snapshot's own summary (doc count + the computed
-- balance at that moment, via the SAME computeDeskBalance formula balance-guard uses).
-- `good` marks a snapshot as a valid diff/restore baseline; a label is never reused once
-- written (on_conflict on label+desk_id just lets a retried snapshot call overwrite its
-- own summary row, not create a duplicate).
create table if not exists ledger_snapshot_runs (
  id bigint generated always as identity primary key,
  label text not null,
  desk_id text not null,
  doc_count integer not null,
  balance numeric not null,
  anchored boolean not null default false,
  anchor_date timestamptz,
  good boolean not null default true,
  created_at timestamptz not null default now(),
  unique (label, desk_id)
);
create index if not exists idx_ledger_snapshot_runs_desk_good on ledger_snapshot_runs (desk_id, good, created_at desc);
alter table ledger_snapshot_runs enable row level security;

create table if not exists ledger_audit (
  id bigint generated always as identity primary key,
  desk_id text not null,
  collection text not null,
  doc_id text not null,
  op text not null, -- INSERT / UPDATE / DELETE
  before jsonb,
  after jsonb,
  who text,
  at timestamptz not null default now()
);
create index if not exists idx_ledger_audit_desk_doc on ledger_audit (desk_id, doc_id, at desc);
alter table ledger_audit enable row level security;

-- NOTE on "who": every write from sports-proxy goes through the single Supabase service-
-- role key, so there is no per-caller identity to recover here beyond "service_role" (or
-- "unknown" for a raw psql/SQL-editor edit). This still distinguishes an engine/app write
-- from a direct manual database edit, which is the main case worth telling apart.
-- The collection/desk filter has to live INSIDE the function body, not in a trigger WHEN
-- clause: Postgres rejects "coalesce(new.x, old.x)" in a WHEN clause on a trigger that
-- covers DELETE (42P17, "DELETE trigger's WHEN condition cannot reference NEW values"),
-- because WHEN is evaluated before the per-operation row shape is settled. Inside the
-- function body NEW/OLD are just ordinary (possibly-null) record variables, so the same
-- coalesce works fine there -- this trigger fires on every docs row and filters itself.
create or replace function ledger_audit_pnlentries() returns trigger as $$
declare
  v_desk text := coalesce(new.desk_id, old.desk_id);
  v_collection text := coalesce(new.collection, old.collection);
  v_doc_id text := coalesce(new.doc_id, old.doc_id);
begin
  if v_collection <> 'pnlEntries' or v_desk not in ('main', 'steve') then
    return coalesce(new, old);
  end if;
  begin
    insert into ledger_audit (desk_id, collection, doc_id, op, before, after, who)
    values (
      v_desk,
      v_collection,
      v_doc_id,
      TG_OP,
      case when TG_OP = 'INSERT' then null else to_jsonb(old) end,
      case when TG_OP = 'DELETE' then null else to_jsonb(new) end,
      coalesce(current_setting('request.jwt.claim.role', true), current_setting('role', true), session_user)
    );
  exception when others then
    -- NEVER let a logging failure block or roll back the real write.
    raise warning 'ledger_audit_pnlentries: logging failed for %/%/% (%): %', v_desk, v_collection, v_doc_id, TG_OP, SQLERRM;
  end;
  return coalesce(new, old);
end;
$$ language plpgsql;

drop trigger if exists trg_ledger_audit_pnlentries on public.docs;
create trigger trg_ledger_audit_pnlentries
after insert or update or delete on public.docs
for each row
execute function ledger_audit_pnlentries();

-- Sanity checks:
--   select * from ledger_snapshot_runs order by created_at desc limit 10;
--   select * from ledger_audit order by at desc limit 20;
