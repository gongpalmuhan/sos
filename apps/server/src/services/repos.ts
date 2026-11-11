/** F3 큐레이션 저장소 + F4 이슈 추천 (read side). */
import type { IssueRecommendation, IssueRecommendationList, RepoSummary, TaskType } from '@sos/shared';
import { adminDb, maybe } from '@/lib/supabase';
import { notFound } from '@/lib/http';
import { matchesStack } from '@/domain/stack';
import {
  MAINTAINER_RESPONSE_WINDOW_MS,
  RULE_VERSION,
  isStale,
  rankIssues,
  reasonsFromSignals,
  type IssueSignals,
} from '@/domain/recommendation';
import type { IssueRow, RepositoryRow } from './rows';

const REPO_COLUMNS = 'id, github_id, owner, name, html_url, description, primary_language, stack_tags, license_spdx, approval_reason, contributing_url, last_commit_at, last_maintainer_activity_at, open_issues_count, last_synced_at, issues_synced_at, label_config, default_branch, status';

async function eligibleCounts(repoIds: number[]): Promise<Map<number, number>> {
  if (!repoIds.length) return new Map();
  const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
  const data = maybe(await adminDb()
    .from('issues')
    .select('repository_id')
    .in('repository_id', repoIds)
    .eq('eligibility', 'eligible')
    .gte('last_checked_at', cutoff), 'repos.ts:data');
  const m = new Map<number, number>();
  for (const r of data ?? []) m.set(r.repository_id as number, (m.get(r.repository_id as number) ?? 0) + 1);
  return m;
}

function summary(r: RepositoryRow, eligible: number): RepoSummary {
  return {
    id: r.id,
    full_name: `${r.owner}/${r.name}`,
    html_url: r.html_url,
    description: r.description,
    primary_language: r.primary_language,
    stack_tags: r.stack_tags,
    license_spdx: r.license_spdx,
    approval_reason: r.approval_reason ?? '',
    contributing_url: r.contributing_url,
    signals: { last_commit_at: r.last_commit_at, last_maintainer_activity_at: r.last_maintainer_activity_at, open_issues_count: r.open_issues_count },
    eligible_issue_count: eligible,
    last_checked_at: r.last_synced_at,
  };
}

export async function listRepos(filter: { stacks?: string[]; language?: string }): Promise<{ items: RepoSummary[]; total_approved: number; empty_hint: string | null }> {
  const data = maybe(await adminDb().from('repositories').select(REPO_COLUMNS).eq('status', 'approved').order('owner').order('name'), 'repos.ts:data');
  const all = (data ?? []) as RepositoryRow[];
  const filtered = all.filter(
    (r) =>
      (!filter.language || r.primary_language?.toLowerCase() === filter.language.toLowerCase()) &&
      matchesStack(filter.stacks ?? [], r),
  );
  const counts = await eligibleCounts(filtered.map((r) => r.id));
  return {
    items: filtered.map((r) => summary(r, counts.get(r.id) ?? 0)),
    total_approved: all.length,
    empty_hint: filtered.length === 0 && all.length > 0 ? '조건에 맞는 저장소가 없습니다. 스택이나 언어 필터를 줄여 보세요.' : null,
  };
}

export async function getRepo(id: number): Promise<RepoSummary> {
  const data = maybe(await adminDb().from('repositories').select(REPO_COLUMNS).eq('id', id).eq('status', 'approved').maybeSingle(), 'repos.ts:data');
  if (!data) throw notFound('repository');
  const counts = await eligibleCounts([id]);
  return summary(data as RepositoryRow, counts.get(id) ?? 0);
}

/**
 * Up to 5 recommendations. The maintainer-response signal is re-derived from the stored
 * timestamp so the 30-day window stays correct between syncs.
 */
export async function recommendIssues(
  repositoryId: number,
  opts: { stacks: string[]; type?: TaskType },
  now = new Date(),
): Promise<IssueRecommendationList> {
  const db = adminDb();
  const repo = maybe(await db.from('repositories').select(REPO_COLUMNS).eq('id', repositoryId).eq('status', 'approved').maybeSingle(), 'repos.ts:repo');
  if (!repo) throw notFound('repository');
  const r = repo as RepositoryRow;

  if (!matchesStack(opts.stacks, r)) {
    return { repository_id: r.id, rule_version: RULE_VERSION, items: [], excluded_count: 0, needs_review_count: 0, stale_count: 0, empty_hint: '이 저장소는 저장한 스택과 맞지 않습니다. 스택을 수정하거나 전체 보기로 확인하세요.', checked_at: r.issues_synced_at };
  }

  const data = maybe(await db.from('issues').select('*').eq('repository_id', repositoryId).eq('state', 'open'), 'repos.ts:data');
  const issues = ((data ?? []) as IssueRow[]).map((i) => {
    const signals: IssueSignals = {
      beginner_label: Boolean(i.signals.beginner_label),
      expected_outcome_confirmed: Boolean(i.signals.expected_outcome_confirmed),
      contributing_guide: Boolean(r.contributing_url),
      recent_maintainer_response: i.last_maintainer_comment_at !== null && now.getTime() - Date.parse(i.last_maintainer_comment_at) <= MAINTAINER_RESPONSE_WINDOW_MS,
    };
    return { ...i, signals, signal_count: Object.values(signals).filter(Boolean).length };
  });

  const ranked = rankIssues(issues, { now, type: opts.type });
  const items: IssueRecommendation[] = ranked.items.map((i) => ({
    id: i.id,
    number: i.number,
    title: i.title,
    html_url: i.html_url,
    labels: i.labels,
    task_type: i.task_type,
    burden: i.burden,
    burden_reasons: i.burden_reasons,
    reasons: reasonsFromSignals(i.signals, i.html_url, r.contributing_url),
    cautions: i.work_claim_signals ?? [],
    signal_count: i.signal_count,
    github_updated_at: i.github_updated_at,
    last_checked_at: i.last_checked_at,
  }));

  let empty_hint: string | null = null;
  if (!items.length) {
    empty_hint = opts.type
      ? '이 작업 유형의 추천 후보가 없습니다. 유형 필터를 해제해 보세요.'
      : ranked.stale_count > 0
        ? '최근 확인되지 않은 이슈는 추천에서 제외했습니다. 잠시 후 다시 확인하세요.'
        : '지금 추천할 수 있는 이슈가 없습니다. 다른 저장소를 확인해 보세요.';
  }
  const fresh = issues.filter((i) => !isStale(i, now)).map((i) => i.last_checked_at!).sort();
  return {
    repository_id: r.id,
    rule_version: RULE_VERSION,
    items,
    excluded_count: ranked.excluded_count,
    needs_review_count: ranked.needs_review_count,
    stale_count: ranked.stale_count,
    empty_hint,
    checked_at: fresh[0] ?? r.issues_synced_at,
  };
}
