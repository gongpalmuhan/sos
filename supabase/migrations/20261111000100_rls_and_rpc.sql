-- RLS policies, transactional RPCs (state change + event in one transaction), hybrid search.
-- Mutating RPCs take an explicit p_user_id and are executable only by service_role:
-- the API server authenticates the caller first, then calls these with the verified user id.

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.repositories enable row level security;
alter table public.issues enable row level security;
alter table public.source_documents enable row level security;
alter table public.document_chunks enable row level security;
alter table public.reports enable row level security;
alter table public.journeys enable row level security;
alter table public.checklist_items enable row level security;
alter table public.linked_prs enable row level security;
alter table public.product_events enable row level security;
alter table public.ai_runs enable row level security;
alter table public.sync_runs enable row level security;
alter table public.app_settings enable row level security;

create policy profiles_select_own on public.profiles
  for select to authenticated using ((select auth.uid()) = user_id);

create policy repositories_public_read on public.repositories
  for select to anon, authenticated using (status = 'approved');

create policy issues_public_read on public.issues
  for select to anon, authenticated using (
    exists (select 1 from public.repositories r where r.id = repository_id and r.status = 'approved')
  );

create policy source_documents_public_read on public.source_documents
  for select to anon, authenticated using (
    exists (select 1 from public.repositories r where r.id = repository_id and r.status = 'approved')
  );

create policy reports_read on public.reports
  for select to authenticated using (status in ('ready', 'insufficient_evidence'));

create policy journeys_select_own on public.journeys
  for select to authenticated using ((select auth.uid()) = user_id);

create policy checklist_select_own on public.checklist_items
  for select to authenticated using ((select auth.uid()) = user_id);

create policy linked_prs_select_own on public.linked_prs
  for select to authenticated using ((select auth.uid()) = user_id);

-- document_chunks, product_events, ai_runs, sync_runs, app_settings: no client policies (service role only).

-- ---------------------------------------------------------------------------
-- Event helper (internal)
-- ---------------------------------------------------------------------------
create or replace function public.record_event(
  p_user_id uuid,
  p_event_name text,
  p_journey_id uuid default null,
  p_issue_id bigint default null,
  p_repository_id bigint default null,
  p_properties jsonb default '{}'::jsonb,
  p_dedupe_key text default null,
  p_event_id uuid default null
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted int;
begin
  insert into public.product_events (event_id, user_id, journey_id, issue_id, repository_id, event_name, dedupe_key, properties)
  values (coalesce(p_event_id, gen_random_uuid()), p_user_id, p_journey_id, p_issue_id, p_repository_id,
          p_event_name, p_dedupe_key, coalesce(p_properties, '{}'::jsonb))
  on conflict do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- Journeys
-- ---------------------------------------------------------------------------
create or replace function public.create_journey(
  p_user_id uuid,
  p_issue_id bigint,
  p_rule_version text,
  p_checklist jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_issue record;
  v_journey_id uuid;
  v_existing uuid;
  v_first_merge record;
begin
  select i.id, i.repository_id into v_issue
  from public.issues i
  join public.repositories r on r.id = i.repository_id and r.status = 'approved'
  where i.id = p_issue_id;
  if not found then
    raise exception 'issue_not_found' using errcode = 'P0002';
  end if;

  select j.id into v_existing from public.journeys j
  where j.user_id = p_user_id and j.issue_id = p_issue_id and j.status in ('selected', 'preparing', 'pr_linked');
  if found then
    return jsonb_build_object('journey_id', v_existing, 'created', false);
  end if;

  insert into public.journeys (user_id, issue_id, repository_id, rule_version)
  values (p_user_id, p_issue_id, v_issue.repository_id, p_rule_version)
  returning id into v_journey_id;

  insert into public.checklist_items (journey_id, user_id, item_key, position, stage, kind, text, command, source_id, source_url)
  select v_journey_id, p_user_id, c.item_key, c.position, c.stage::public.checklist_stage, c.kind::public.checklist_kind,
         c.text, c.command, c.source_id, c.source_url
  from jsonb_to_recordset(coalesce(p_checklist, '[]'::jsonb))
    as c(item_key text, position int, stage text, kind text, text text, command text, source_id bigint, source_url text);

  perform public.record_event(p_user_id, 'issue_selected', v_journey_id, p_issue_id, v_issue.repository_id,
    jsonb_build_object('rule_version', p_rule_version), 'issue_selected:' || v_journey_id::text);

  -- second contribution: a new journey on a different issue after the first SOS merge
  select e.occurred_at, e.issue_id into v_first_merge from public.product_events e
  where e.user_id = p_user_id and e.event_name = 'first_pr_merged';
  if found and v_first_merge.issue_id is distinct from p_issue_id then
    perform public.record_event(p_user_id, 'second_contribution_started', v_journey_id, p_issue_id, v_issue.repository_id);
  end if;

  return jsonb_build_object('journey_id', v_journey_id, 'created', true);
end;
$$;

create or replace function public.abandon_journey(
  p_user_id uuid,
  p_journey_id uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.journey_status;
begin
  select status into v_status from public.journeys
  where id = p_journey_id and user_id = p_user_id for update;
  if not found then
    raise exception 'journey_not_found' using errcode = 'P0002';
  end if;
  if v_status = 'abandoned' then
    return jsonb_build_object('status', 'abandoned', 'changed', false);
  end if;
  if v_status not in ('selected', 'preparing') then
    raise exception 'invalid_transition:%->abandoned', v_status using errcode = 'P0001';
  end if;
  update public.journeys
  set status = 'abandoned', abandoned_at = now(), abandon_reason = left(p_reason, 200)
  where id = p_journey_id;
  return jsonb_build_object('status', 'abandoned', 'changed', true);
end;
$$;

create or replace function public.set_checklist_item(
  p_user_id uuid,
  p_journey_id uuid,
  p_item_id uuid,
  p_completed boolean
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_journey record;
  v_item record;
begin
  select id, status, issue_id, repository_id into v_journey from public.journeys
  where id = p_journey_id and user_id = p_user_id for update;
  if not found then
    raise exception 'journey_not_found' using errcode = 'P0002';
  end if;
  if v_journey.status = 'abandoned' then
    raise exception 'journey_abandoned' using errcode = 'P0001';
  end if;

  select id, stage, kind, completed_at into v_item from public.checklist_items
  where id = p_item_id and journey_id = p_journey_id and user_id = p_user_id for update;
  if not found then
    raise exception 'checklist_item_not_found' using errcode = 'P0002';
  end if;

  update public.checklist_items
  set completed_at = case when p_completed then coalesce(completed_at, now()) else null end
  where id = p_item_id;

  if p_completed then
    if v_journey.status = 'selected' then
      update public.journeys set status = 'preparing', preparing_at = now() where id = p_journey_id;
    end if;
    perform public.record_event(p_user_id, 'checklist_item_completed', p_journey_id, v_journey.issue_id,
      v_journey.repository_id, jsonb_build_object('stage', v_item.stage, 'kind', v_item.kind),
      'checklist_item_completed:' || p_item_id::text);
  end if;

  return jsonb_build_object('item_id', p_item_id, 'completed', p_completed);
end;
$$;

-- ---------------------------------------------------------------------------
-- Linked PRs
-- ---------------------------------------------------------------------------
create or replace function public.journey_status_for_pr(p_status public.pr_status)
returns public.journey_status language sql immutable as $$
  select case p_status
    when 'open' then 'pr_linked'::public.journey_status
    when 'merged' then 'merged'::public.journey_status
    else 'closed_without_merge'::public.journey_status
  end;
$$;

create or replace function public.link_pr(
  p_user_id uuid,
  p_journey_id uuid,
  p_pr jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_journey record;
  v_existing record;
  v_status public.pr_status := (p_pr ->> 'status')::public.pr_status;
  v_pr_id bigint := (p_pr ->> 'github_pr_id')::bigint;
  v_linked_id uuid;
  v_first_merge record;
begin
  select id, status, issue_id, repository_id into v_journey from public.journeys
  where id = p_journey_id and user_id = p_user_id for update;
  if not found then
    raise exception 'journey_not_found' using errcode = 'P0002';
  end if;
  if v_journey.status = 'abandoned' then
    raise exception 'journey_abandoned' using errcode = 'P0001';
  end if;

  select id, journey_id into v_existing from public.linked_prs
  where user_id = p_user_id and github_pr_id = v_pr_id;
  if found then
    if v_existing.journey_id = p_journey_id then
      return jsonb_build_object('linked_pr_id', v_existing.id, 'created', false);
    end if;
    raise exception 'pr_linked_to_other_journey' using errcode = 'P0001';
  end if;

  if exists (select 1 from public.linked_prs where journey_id = p_journey_id) then
    raise exception 'journey_already_has_pr' using errcode = 'P0001';
  end if;

  insert into public.linked_prs (journey_id, user_id, github_pr_id, github_repo_id, number, author_github_id, url,
                                 title, status, merged_at, closed_at)
  values (p_journey_id, p_user_id, v_pr_id, (p_pr ->> 'github_repo_id')::bigint, (p_pr ->> 'number')::int,
          (p_pr ->> 'author_github_id')::bigint, p_pr ->> 'url', p_pr ->> 'title', v_status,
          (p_pr ->> 'merged_at')::timestamptz, (p_pr ->> 'closed_at')::timestamptz)
  returning id into v_linked_id;

  update public.journeys
  set status = public.journey_status_for_pr(v_status),
      completed_at = case when v_status = 'open' then null else now() end
  where id = p_journey_id;

  -- events: second_pr_connected is evaluated BEFORE a possible first merge from this PR
  select e.occurred_at into v_first_merge from public.product_events e
  where e.user_id = p_user_id and e.event_name = 'first_pr_merged';
  if found then
    perform public.record_event(p_user_id, 'second_pr_connected', p_journey_id, v_journey.issue_id, v_journey.repository_id);
  end if;

  perform public.record_event(p_user_id, 'pr_connected', p_journey_id, v_journey.issue_id, v_journey.repository_id,
    jsonb_build_object('status', v_status), 'pr_connected:' || v_linked_id::text);

  if v_status = 'merged' then
    perform public.record_event(p_user_id, 'first_pr_merged', p_journey_id, v_journey.issue_id, v_journey.repository_id,
      jsonb_build_object('linked_pr_id', v_linked_id));
  end if;

  return jsonb_build_object('linked_pr_id', v_linked_id, 'created', true);
end;
$$;

create or replace function public.apply_pr_status(
  p_linked_pr_id uuid,
  p_status public.pr_status,
  p_merged_at timestamptz,
  p_closed_at timestamptz,
  p_title text,
  p_manual boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pr record;
  v_journey record;
  v_new_version int;
begin
  select * into v_pr from public.linked_prs where id = p_linked_pr_id for update;
  if not found then
    raise exception 'linked_pr_not_found' using errcode = 'P0002';
  end if;

  if v_pr.status = p_status then
    update public.linked_prs
    set last_success_at = now(), fetch_error = null, fetch_error_at = null,
        title = coalesce(p_title, title), merged_at = coalesce(p_merged_at, merged_at), closed_at = p_closed_at,
        last_manual_refresh_at = case when p_manual then now() else last_manual_refresh_at end
    where id = p_linked_pr_id;
    return jsonb_build_object('status', p_status, 'changed', false);
  end if;

  v_new_version := v_pr.status_version + 1;
  update public.linked_prs
  set status = p_status, status_version = v_new_version, status_changed_at = now(),
      merged_at = p_merged_at, closed_at = p_closed_at, title = coalesce(p_title, title),
      last_success_at = now(), fetch_error = null, fetch_error_at = null,
      last_manual_refresh_at = case when p_manual then now() else last_manual_refresh_at end
  where id = p_linked_pr_id;

  select id, issue_id, repository_id, status into v_journey from public.journeys where id = v_pr.journey_id for update;
  update public.journeys
  set status = public.journey_status_for_pr(p_status),
      completed_at = case when p_status = 'open' then null else now() end
  where id = v_pr.journey_id;

  perform public.record_event(v_pr.user_id, 'pr_status_changed', v_pr.journey_id, v_journey.issue_id, v_journey.repository_id,
    jsonb_build_object('from', v_pr.status, 'to', p_status, 'status_version', v_new_version),
    'pr_status_changed:' || p_linked_pr_id::text || ':v' || v_new_version);

  if p_status = 'merged' then
    perform public.record_event(v_pr.user_id, 'first_pr_merged', v_pr.journey_id, v_journey.issue_id, v_journey.repository_id,
      jsonb_build_object('linked_pr_id', p_linked_pr_id));
  end if;

  return jsonb_build_object('status', p_status, 'changed', true, 'from', v_pr.status);
end;
$$;

create or replace function public.record_pr_fetch_error(
  p_linked_pr_id uuid,
  p_error text,
  p_manual boolean default false
) returns void
language sql
security definer
set search_path = ''
as $$
  update public.linked_prs
  set fetch_error = left(p_error, 200), fetch_error_at = now(),
      last_manual_refresh_at = case when p_manual then now() else last_manual_refresh_at end
  where id = p_linked_pr_id;
$$;

-- ---------------------------------------------------------------------------
-- Hybrid search: FTS top-N + vector top-N fused with Reciprocal Rank Fusion
-- ---------------------------------------------------------------------------
create or replace function public.hybrid_search_chunks(
  p_repository_id bigint,
  p_query_text text,
  p_query_embedding extensions.vector(1536),
  p_match_count int default 8,
  p_candidates int default 20,
  p_rrf_k int default 60
) returns table (chunk_id bigint, source_id bigint, content text, score double precision)
language sql
stable
set search_path = ''
as $$
  with fts as (
    select c.id, row_number() over (order by ts_rank_cd(c.fts, q) desc) as rank_ix
    from public.document_chunks c, websearch_to_tsquery('simple', p_query_text) q
    where c.repository_id = p_repository_id and c.fts @@ q
    order by rank_ix
    limit p_candidates
  ),
  semantic as (
    select c.id, row_number() over (order by c.embedding operator(extensions.<=>) p_query_embedding) as rank_ix
    from public.document_chunks c
    where c.repository_id = p_repository_id and c.embedding is not null and p_query_embedding is not null
    order by rank_ix
    limit p_candidates
  )
  select c.id, c.source_id, c.content,
         coalesce(1.0 / (p_rrf_k + fts.rank_ix), 0.0) + coalesce(1.0 / (p_rrf_k + semantic.rank_ix), 0.0) as score
  from fts
  full outer join semantic on fts.id = semantic.id
  join public.document_chunks c on c.id = coalesce(fts.id, semantic.id)
  order by score desc, c.id asc
  limit p_match_count;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: mutating RPCs are service_role only
-- ---------------------------------------------------------------------------
revoke execute on function public.record_event(uuid, text, uuid, bigint, bigint, jsonb, text, uuid) from public, anon, authenticated;
revoke execute on function public.create_journey(uuid, bigint, text, jsonb) from public, anon, authenticated;
revoke execute on function public.abandon_journey(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.set_checklist_item(uuid, uuid, uuid, boolean) from public, anon, authenticated;
revoke execute on function public.link_pr(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.apply_pr_status(uuid, public.pr_status, timestamptz, timestamptz, text, boolean) from public, anon, authenticated;
revoke execute on function public.record_pr_fetch_error(uuid, text, boolean) from public, anon, authenticated;
revoke execute on function public.hybrid_search_chunks(bigint, text, extensions.vector, int, int, int) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
