-- Scenario checks for journey / PR RPCs. Run against a migrated database (service role).
-- Fails with an exception on the first broken assertion.
\set ON_ERROR_STOP on
begin;

insert into auth.users (id, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000001', '{"provider_id":"101","user_name":"alice"}'),
  ('00000000-0000-0000-0000-000000000002', '{"provider_id":"202","user_name":"bob"}');

do $$ begin
  assert (select github_id from public.profiles where github_login = 'alice') = 101, 'profile trigger';
end $$;

insert into public.repositories (github_id, owner, name, html_url, status, approval_reason)
values (1, 'acme', 'widget', 'https://github.com/acme/widget', 'approved', 'Clear CONTRIBUTING and active maintainers');
insert into public.issues (github_id, repository_id, number, title, html_url, state)
select g, (select id from public.repositories where github_id = 1), g, 'Issue ' || g, 'https://github.com/acme/widget/issues/' || g, 'open'
from generate_series(11, 13) g;

do $$
declare
  u uuid := '00000000-0000-0000-0000-000000000001';
  i1 bigint := (select id from public.issues where github_id = 11);
  i2 bigint := (select id from public.issues where github_id = 12);
  r jsonb; j1 uuid; j2 uuid; item uuid; lp uuid;
begin
  -- create journey + checklist + issue_selected event
  r := public.create_journey(u, i1, 'v1', '[{"item_key":"fork","position":1,"stage":"env","kind":"general","text":"Fork"}]');
  j1 := (r ->> 'journey_id')::uuid;
  assert (r ->> 'created')::boolean, 'journey created';
  -- idempotent: same active journey returned
  r := public.create_journey(u, i1, 'v1', '[]');
  assert (r ->> 'journey_id')::uuid = j1 and not (r ->> 'created')::boolean, 'journey idempotent';
  assert (select count(*) from public.product_events where event_name = 'issue_selected') = 1, 'issue_selected once';

  -- checklist completion moves to preparing, event deduped
  item := (select id from public.checklist_items where journey_id = j1);
  perform public.set_checklist_item(u, j1, item, true);
  perform public.set_checklist_item(u, j1, item, false);
  perform public.set_checklist_item(u, j1, item, true);
  assert (select status from public.journeys where id = j1) = 'preparing', 'preparing';
  assert (select count(*) from public.product_events where event_name = 'checklist_item_completed') = 1, 'checklist event once';

  -- other user cannot touch journey
  begin
    perform public.set_checklist_item('00000000-0000-0000-0000-000000000002', j1, item, true);
    assert false, 'other user should fail';
  exception when sqlstate 'P0002' then null;
  end;

  -- link PR (open), idempotent
  r := public.link_pr(u, j1, '{"github_pr_id":900,"github_repo_id":1,"number":5,"author_github_id":101,"url":"https://github.com/acme/widget/pull/5","status":"open"}');
  lp := (r ->> 'linked_pr_id')::uuid;
  r := public.link_pr(u, j1, '{"github_pr_id":900,"github_repo_id":1,"number":5,"author_github_id":101,"url":"https://github.com/acme/widget/pull/5","status":"open"}');
  assert not (r ->> 'created')::boolean, 'link idempotent';
  assert (select status from public.journeys where id = j1) = 'pr_linked', 'pr_linked';

  -- open -> closed -> reopened -> merged
  r := public.apply_pr_status(lp, 'closed_without_merge', null, now(), null);
  assert (select status from public.journeys where id = j1) = 'closed_without_merge', 'closed';
  r := public.apply_pr_status(lp, 'closed_without_merge', null, now(), null);
  assert not (r ->> 'changed')::boolean, 'same status no change';
  r := public.apply_pr_status(lp, 'open', null, null, null);
  assert (select status from public.journeys where id = j1) = 'pr_linked', 'reopen -> pr_linked';
  r := public.apply_pr_status(lp, 'merged', now(), now(), null);
  assert (select status from public.journeys where id = j1) = 'merged', 'merged';
  assert (select count(*) from public.product_events where event_name = 'pr_status_changed') = 3, 'three transitions';
  assert (select count(*) from public.product_events where event_name = 'first_pr_merged') = 1, 'first merge once';

  -- abandon not allowed after merge
  begin
    perform public.abandon_journey(u, j1, 'x');
    assert false, 'abandon after merge should fail';
  exception when sqlstate 'P0001' then null;
  end;

  -- second contribution: new journey on another issue after first merge
  r := public.create_journey(u, i2, 'v1', '[]');
  j2 := (r ->> 'journey_id')::uuid;
  assert (select count(*) from public.product_events where event_name = 'second_contribution_started') = 1, 'second contribution';

  -- same PR cannot be linked to a different journey
  begin
    perform public.link_pr(u, j2, '{"github_pr_id":900,"github_repo_id":1,"number":5,"author_github_id":101,"url":"https://github.com/acme/widget/pull/5","status":"merged"}');
    assert false, 'pr reuse should fail';
  exception when sqlstate 'P0001' then null;
  end;

  -- second PR connected; already-merged PR does not create a second first_pr_merged
  perform public.link_pr(u, j2, '{"github_pr_id":901,"github_repo_id":1,"number":6,"author_github_id":101,"url":"https://github.com/acme/widget/pull/6","status":"merged","merged_at":"2026-11-01T00:00:00Z"}');
  assert (select count(*) from public.product_events where event_name = 'second_pr_connected') = 1, 'second pr connected';
  assert (select count(*) from public.product_events where event_name = 'first_pr_merged') = 1, 'still one first merge';

  -- abandon flow
  r := public.create_journey(u, (select id from public.issues where github_id = 13), 'v1', '[]');
  perform public.abandon_journey(u, (r ->> 'journey_id')::uuid, 'not a fit');
  assert (select status from public.journeys where id = (r ->> 'journey_id')::uuid) = 'abandoned', 'abandoned';
  -- re-select after abandon creates a new journey
  r := public.create_journey(u, (select id from public.issues where github_id = 13), 'v1', '[]');
  assert (r ->> 'created')::boolean, 'reselect after abandon';
end $$;

-- RLS: authenticated user sees only own journeys; cannot execute mutating RPCs
grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
do $$ begin
  assert (select count(*) from public.journeys) = 0, 'bob sees no journeys';
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
do $$ begin
  assert (select count(*) from public.journeys) = 4, 'alice sees her journeys';
  begin
    perform public.abandon_journey('00000000-0000-0000-0000-000000000001', gen_random_uuid(), 'x');
    assert false, 'authenticated must not execute RPC';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

select 'ALL RPC SCENARIOS PASSED' as result;
rollback;
