-- SOS MVP v1.0 initial schema
-- Source of truth: Notion "SOS MVP 확정서" §10 (data structure) / §8 (rules) / §12 (privacy)

create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.experience_level as enum ('none', 'pr_only', 'merged');
create type public.task_type as enum ('docs', 'test', 'bug', 'feature', 'unknown');
create type public.task_burden as enum ('low_prerequisites', 'needs_confirmation', 'advanced');
create type public.issue_eligibility as enum ('eligible', 'excluded', 'needs_review');
create type public.repo_status as enum ('candidate', 'approved', 'rejected', 'retired');
create type public.source_kind as enum (
  'issue', 'closed_issue', 'pull_request', 'comment', 'review_comment', 'contributing', 'readme'
);
create type public.report_status as enum ('queued', 'running', 'ready', 'insufficient_evidence', 'failed');
create type public.journey_status as enum (
  'selected', 'preparing', 'pr_linked', 'merged', 'closed_without_merge', 'abandoned'
);
create type public.checklist_stage as enum ('env', 'work', 'test', 'pre_pr');
create type public.checklist_kind as enum ('general', 'repo_rule');
create type public.pr_status as enum ('open', 'merged', 'closed_without_merge');
create type public.run_status as enum ('running', 'succeeded', 'failed');

-- ---------------------------------------------------------------------------
-- Profiles (personal)
-- ---------------------------------------------------------------------------
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  github_id bigint unique,
  github_login text,
  stacks text[] not null default '{}',
  experience_level public.experience_level,
  interested_task_types public.task_type[] not null default '{}',
  onboarding_confirmed_at timestamptz,
  consent_version text,
  analytics_consent boolean not null default false,
  analytics_consent_at timestamptz,
  public_inference_consent boolean not null default false,
  public_inference_consent_at timestamptz,
  deletion_requested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stacks_limit check (cardinality(stacks) <= 20)
);

-- Create profile row from GitHub identity metadata on sign-up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, github_id, github_login)
  values (
    new.id,
    nullif(new.raw_user_meta_data ->> 'provider_id', '')::bigint,
    coalesce(new.raw_user_meta_data ->> 'user_name', new.raw_user_meta_data ->> 'preferred_username')
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Public collected data
-- ---------------------------------------------------------------------------
create table public.repositories (
  id bigint generated always as identity primary key,
  github_id bigint not null unique,
  owner text not null,
  name text not null,
  html_url text not null,
  description text,
  primary_language text,
  stack_tags text[] not null default '{}',
  license_spdx text,
  default_branch text,
  is_public boolean not null default true,
  archived boolean not null default false,
  disabled boolean not null default false,
  status public.repo_status not null default 'candidate',
  approval_reason text,
  approved_by text,
  approved_at timestamptz,
  curation_checks jsonb not null default '{}',
  contributing_url text,
  label_config jsonb not null default '{}',
  last_commit_at timestamptz,
  last_maintainer_activity_at timestamptz,
  stars integer,
  open_issues_count integer,
  last_synced_at timestamptz,
  last_sync_error text,
  issues_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner, name),
  constraint approved_needs_reason check (status <> 'approved' or length(coalesce(approval_reason, '')) >= 10)
);

create table public.issues (
  id bigint generated always as identity primary key,
  github_id bigint not null unique,
  repository_id bigint not null references public.repositories (id) on delete cascade,
  number integer not null,
  title text not null,
  html_url text not null,
  state text not null,
  locked boolean not null default false,
  labels text[] not null default '{}',
  assignee_logins text[] not null default '{}',
  linked_open_prs integer[] not null default '{}',
  author_login text,
  body_length integer not null default 0,
  comments_count integer not null default 0,
  last_maintainer_comment_at timestamptz,
  work_claim_signals jsonb not null default '[]',
  operator_flags jsonb not null default '{}',
  signals jsonb not null default '{}',
  signal_count smallint not null default 0,
  eligibility public.issue_eligibility not null default 'needs_review',
  exclusion_reasons jsonb not null default '[]',
  task_type public.task_type not null default 'unknown',
  burden public.task_burden not null default 'needs_confirmation',
  burden_reasons jsonb not null default '[]',
  rule_version text,
  github_created_at timestamptz,
  github_updated_at timestamptz,
  last_checked_at timestamptz,
  last_check_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (repository_id, number)
);
create index issues_reco_idx on public.issues (repository_id, eligibility, signal_count desc, github_updated_at desc);

create table public.source_documents (
  id bigint generated always as identity primary key,
  repository_id bigint not null references public.repositories (id) on delete cascade,
  issue_id bigint references public.issues (id) on delete set null,
  kind public.source_kind not null,
  github_ref text not null,
  url text not null,
  title text,
  author_login text,
  author_association text,
  content text not null,
  content_hash text not null,
  commit_sha text,
  truncated boolean not null default false,
  github_created_at timestamptz,
  github_updated_at timestamptz,
  fetched_at timestamptz not null default now(),
  last_referenced_at timestamptz,
  unique (repository_id, kind, github_ref)
);
create index source_documents_issue_idx on public.source_documents (issue_id);

create table public.document_chunks (
  id bigint generated always as identity primary key,
  source_id bigint not null references public.source_documents (id) on delete cascade,
  repository_id bigint not null references public.repositories (id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  content_hash text not null,
  truncated boolean not null default false,
  fts tsvector generated always as (to_tsvector('simple', content)) stored,
  embedding extensions.vector(1536),
  embedding_model text,
  embedding_dimensions integer,
  embedded_at timestamptz,
  unique (source_id, chunk_index)
);
create index document_chunks_fts_idx on public.document_chunks using gin (fts);
create index document_chunks_repo_idx on public.document_chunks (repository_id);
create index document_chunks_embedding_idx on public.document_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  issue_id bigint not null references public.issues (id) on delete cascade,
  cache_key text not null unique,
  source_hashes jsonb not null default '{}',
  status public.report_status not null default 'queued',
  result jsonb,
  failure_reason text,
  insufficient_items jsonb,
  model text,
  prompt_version text not null,
  schema_version text not null,
  retrieval_scope jsonb,
  requested_by uuid references auth.users (id) on delete set null,
  job_started_at timestamptz,
  completed_at timestamptz,
  last_viewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index reports_issue_idx on public.reports (issue_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Personal journey data
-- ---------------------------------------------------------------------------
create table public.journeys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  issue_id bigint not null references public.issues (id) on delete restrict,
  repository_id bigint not null references public.repositories (id) on delete restrict,
  status public.journey_status not null default 'selected',
  selected_at timestamptz not null default now(),
  preparing_at timestamptz,
  abandoned_at timestamptz,
  abandon_reason text,
  completed_at timestamptz,
  rule_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One active journey per user per issue.
create unique index journeys_active_unique on public.journeys (user_id, issue_id)
  where status in ('selected', 'preparing', 'pr_linked');
create index journeys_user_idx on public.journeys (user_id, created_at desc);

create table public.checklist_items (
  id uuid primary key default gen_random_uuid(),
  journey_id uuid not null references public.journeys (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  item_key text not null,
  position integer not null,
  stage public.checklist_stage not null,
  kind public.checklist_kind not null,
  text text not null,
  command text,
  source_id bigint references public.source_documents (id) on delete set null,
  source_url text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (journey_id, item_key),
  constraint repo_rule_needs_source check (kind <> 'repo_rule' or source_url is not null)
);

create table public.linked_prs (
  id uuid primary key default gen_random_uuid(),
  journey_id uuid not null references public.journeys (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  github_pr_id bigint not null,
  github_repo_id bigint not null,
  number integer not null,
  author_github_id bigint not null,
  url text not null,
  title text,
  status public.pr_status not null,
  status_version integer not null default 1,
  status_changed_at timestamptz not null default now(),
  merged_at timestamptz,
  closed_at timestamptz,
  fetch_error text,
  fetch_error_at timestamptz,
  last_success_at timestamptz not null default now(),
  last_manual_refresh_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, github_pr_id)
);
create index linked_prs_open_idx on public.linked_prs (status) where status = 'open';

-- ---------------------------------------------------------------------------
-- Ledger / operations
-- ---------------------------------------------------------------------------
create table public.product_events (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null unique,
  user_id uuid references auth.users (id) on delete cascade,
  journey_id uuid references public.journeys (id) on delete set null,
  issue_id bigint,
  repository_id bigint,
  event_name text not null,
  dedupe_key text unique,
  properties jsonb not null default '{}',
  occurred_at timestamptz not null default now(),
  constraint event_name_format check (event_name ~ '^[a-z_]{3,64}$')
);
create index product_events_user_idx on public.product_events (user_id, event_name, occurred_at);
-- Per-user once-only milestones
create unique index product_events_once_per_user on public.product_events (user_id, event_name)
  where event_name in ('first_pr_merged', 'second_contribution_started', 'second_pr_connected');

create table public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  kind text not null,               -- report | draft | review_interpretation | embedding | query_assist
  quota_kind text,                  -- report | assist | null (not counted)
  idempotency_key text unique,
  job_id text,
  model text,
  status public.run_status not null default 'running',
  attempt integer not null default 1,
  input_tokens integer,
  output_tokens integer,
  reasoning_tokens integer,
  cost_usd numeric(12, 6) not null default 0,
  latency_ms integer,
  error_code text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index ai_runs_quota_idx on public.ai_runs (user_id, quota_kind, created_at);
create index ai_runs_month_idx on public.ai_runs (created_at);

create table public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  target text,
  idempotency_key text unique,
  job_id text,
  status public.run_status not null default 'running',
  attempt integer not null default 1,
  stats jsonb not null default '{}',
  error_code text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
insert into public.app_settings (key, value) values ('generation_enabled', 'true'::jsonb);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger repositories_touch before update on public.repositories for each row execute function public.touch_updated_at();
create trigger issues_touch before update on public.issues for each row execute function public.touch_updated_at();
create trigger reports_touch before update on public.reports for each row execute function public.touch_updated_at();
create trigger journeys_touch before update on public.journeys for each row execute function public.touch_updated_at();
