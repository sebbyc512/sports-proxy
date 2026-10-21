-- Parlay Desk Phase 2 — shared Supabase schema (v2, simplified)
-- Mirrors ArtifactData's own shape (collection/doc_id/data/version) in ONE shared table,
-- with desk_id added so MAIN/Steve/Lela/UAT/future friends all live in one database
-- and the cross-desk sync task goes away. This avoids hand-modeling a bespoke relational
-- table per ArtifactData collection (rules, parlays, pnlEntries, nflTeams, lessons,
-- liveScores, taskConfig, steve/lela peer mirrors, requests, nbaFbmTeams, etc.) --
-- they all just become rows here with collection = that collection's name.

drop table if exists rules, parlays, pnl_entries, team_trackers, league_meta,
  fbm_tracking, foul_trouble_log, lessons, live_scores, task_config, peer_bets cascade;

create table if not exists docs (
  desk_id text not null,
  collection text not null,
  doc_id text not null,
  data jsonb not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (desk_id, collection, doc_id)
);

create index if not exists idx_docs_desk_collection on docs (desk_id, collection);
create index if not exists idx_docs_data_gin on docs using gin (data);

alter table docs enable row level security;

-- Phase 3 prep (per the PDF): new concepts with no ArtifactData equivalent, so these
-- stay as their own proper tables rather than going into the generic docs blob.
create table if not exists model_versions (
  id uuid primary key default gen_random_uuid(),
  spec text,
  version text,
  what_changed text,
  date timestamptz default now()
);
alter table model_versions enable row level security;

create table if not exists learning_log (
  id uuid primary key default gen_random_uuid(),
  task text,
  what_it_learned text,
  data_used text,
  hit_rate_before numeric,
  hit_rate_after numeric,
  created_at timestamptz default now()
);
alter table learning_log enable row level security;

create table if not exists pick_sources (
  id uuid primary key default gen_random_uuid(),
  pick_id text,
  source_type text,
  url_or_ref text,
  created_at timestamptz default now()
);
alter table pick_sources enable row level security;
