/**
 * Collection & freshness (확정서 §8.4). Writes go through the service-role client only.
 */
import type { SourceKind } from '@sos/shared';
import { adminDb, must, maybe } from '@/lib/supabase';
import { logInfo, logWarn } from '@/lib/log';
import { evaluateIssue, type IssueFacts } from '@/domain/recommendation';
import { chunkText, sha256, clampTokens } from '@/domain/text';
import type { IssueRow, RepositoryRow } from '@/services/rows';
import { GitHubError, toGitHubError } from './client';
import {
  fetchContributing,
  fetchIndexCandidates,
  fetchIssue,
  fetchIssues,
  fetchLastCommitAt,
  fetchLastMaintainerActivity,
  fetchReadme,
  fetchRepo,
  type IssueSnapshot,
} from './fetchers';

const MONTH = 30 * 24 * 3600 * 1000;
export const INDEX_WINDOW_MS = 12 * MONTH;
export const MAX_INDEX_ISSUES = 500;
export const MAX_INDEX_PULLS = 300;
const MAX_SOURCE_TOKENS = 20_000;

// ---------------------------------------------------------------------------
// sync_runs bookkeeping
// ---------------------------------------------------------------------------
export async function withSyncRun<T extends Record<string, unknown>>(
  kind: string,
  target: string,
  jobId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const db = adminDb();
  const run = maybe(await db.from('sync_runs').insert({ kind, target, job_id: jobId ?? null }).select('id').single(), 'sync.ts:run');
  try {
    const stats = await fn();
    if (run) await db.from('sync_runs').update({ status: 'succeeded', stats, finished_at: new Date().toISOString() }).eq('id', run.id);
    return stats;
  } catch (err) {
    const ge = toGitHubError(err);
    if (run)
      await db.from('sync_runs').update({ status: 'failed', error_code: `${ge.kind}:${ge.status ?? ''}`, finished_at: new Date().toISOString() }).eq('id', run.id);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Source documents + chunks
// ---------------------------------------------------------------------------
export interface SourceInput {
  repository_id: number;
  issue_id?: number | null;
  kind: SourceKind;
  github_ref: string;
  url: string;
  title: string | null;
  content: string;
  author_login?: string | null;
  author_association?: string | null;
  commit_sha?: string | null;
  github_created_at?: string | null;
  github_updated_at?: string | null;
}

/** Upsert a source; re-chunk only when the content hash changed. Returns id and whether it changed. */
export async function upsertSource(input: SourceInput): Promise<{ id: number; changed: boolean }> {
  const db = adminDb();
  const clamped = clampTokens(input.content, MAX_SOURCE_TOKENS);
  const hash = sha256(clamped.text);
  const existing = maybe(await db
    .from('source_documents')
    .select('id, content_hash')
    .eq('repository_id', input.repository_id)
    .eq('kind', input.kind)
    .eq('github_ref', input.github_ref)
    .maybeSingle(), 'sync.ts:existing');

  const row = {
    repository_id: input.repository_id,
    issue_id: input.issue_id ?? null,
    kind: input.kind,
    github_ref: input.github_ref,
    url: input.url,
    title: input.title,
    content: clamped.text,
    content_hash: hash,
    truncated: clamped.truncated,
    author_login: input.author_login ?? null,
    author_association: input.author_association ?? null,
    commit_sha: input.commit_sha ?? null,
    github_created_at: input.github_created_at ?? null,
    github_updated_at: input.github_updated_at ?? null,
    fetched_at: new Date().toISOString(),
  };

  if (existing && existing.content_hash === hash) {
    await db.from('source_documents').update({ fetched_at: row.fetched_at, url: row.url, title: row.title, issue_id: row.issue_id }).eq('id', existing.id);
    return { id: existing.id as number, changed: false };
  }

  const saved = must(
    await db.from('source_documents').upsert(row, { onConflict: 'repository_id,kind,github_ref' }).select('id').single(),
    'upsert source_documents',
  ) as { id: number };

  const chunks = chunkText(`${input.title ? `${input.title}\n\n` : ''}${clamped.text}`);
  await db.from('document_chunks').delete().eq('source_id', saved.id);
  if (chunks.length) {
    must(
      await db
        .from('document_chunks')
        .insert(chunks.map((c) => ({ source_id: saved.id, repository_id: input.repository_id, chunk_index: c.index, content: c.content, content_hash: sha256(c.content), truncated: c.truncated || clamped.truncated })))
        .select('id'),
      'insert chunks',
    );
  }
  return { id: saved.id, changed: true };
}

// ---------------------------------------------------------------------------
// Repository metadata + contribution docs (24h)
// ---------------------------------------------------------------------------
export async function syncRepository(repo: Pick<RepositoryRow, 'id' | 'owner' | 'name'>) {
  const db = adminDb();
  try {
    const meta = await fetchRepo(repo.owner, repo.name);
    const [contributing, readme, lastCommit, lastMaintainer] = await Promise.all([
      fetchContributing(meta.owner, meta.name, meta.default_branch),
      fetchReadme(meta.owner, meta.name),
      fetchLastCommitAt(meta.owner, meta.name, meta.default_branch),
      fetchLastMaintainerActivity(meta.owner, meta.name),
    ]);
    let docsChanged = 0;
    if (contributing) {
      const r = await upsertSource({ repository_id: repo.id, kind: 'contributing', github_ref: contributing.path, url: contributing.html_url, title: contributing.path, content: contributing.content, commit_sha: contributing.sha });
      if (r.changed) docsChanged++;
    }
    if (readme) {
      const r = await upsertSource({ repository_id: repo.id, kind: 'readme', github_ref: readme.path, url: readme.html_url, title: readme.path, content: readme.content, commit_sha: readme.sha });
      if (r.changed) docsChanged++;
    }
    await db
      .from('repositories')
      .update({
        github_id: meta.github_id,
        html_url: meta.html_url,
        description: meta.description,
        primary_language: meta.primary_language,
        license_spdx: meta.license_spdx,
        default_branch: meta.default_branch,
        is_public: meta.visibility === 'public',
        archived: meta.archived,
        disabled: meta.disabled,
        stars: meta.stars,
        open_issues_count: meta.open_issues_count,
        contributing_url: contributing?.html_url ?? null,
        last_commit_at: lastCommit,
        last_maintainer_activity_at: lastMaintainer,
        last_synced_at: new Date().toISOString(),
        last_sync_error: null,
      })
      .eq('id', repo.id);
    return { repository_id: repo.id, docs_changed: docsChanged, archived: meta.archived };
  } catch (err) {
    const ge = toGitHubError(err);
    // keep last successful data; record failure separately
    await db.from('repositories').update({ last_sync_error: `${ge.kind}:${ge.status ?? ''}` }).eq('id', repo.id);
    throw ge;
  }
}

// ---------------------------------------------------------------------------
// Issues (6h incremental) + retrieval index
// ---------------------------------------------------------------------------
function issueFacts(s: IssueSnapshot, flags: IssueRow['operator_flags'] | undefined): IssueFacts {
  return {
    title: s.title,
    body: s.body,
    html_url: s.html_url,
    state: s.state,
    locked: s.locked,
    labels: s.labels,
    assignee_logins: s.assignee_logins,
    linked_open_prs: s.linked_open_prs,
    comments: s.recent_comments,
    operator_flags: flags ?? {},
  };
}

function issueRowFromSnapshot(repo: Pick<RepositoryRow, 'id' | 'contributing_url' | 'label_config'>, s: IssueSnapshot, flags: IssueRow['operator_flags'] | undefined, now: Date) {
  const ev = evaluateIssue(issueFacts(s, flags), { contributing_url: repo.contributing_url, label_config: repo.label_config ?? {} }, now);
  return {
    github_id: s.github_id,
    repository_id: repo.id,
    number: s.number,
    title: s.title,
    html_url: s.html_url,
    state: s.state,
    locked: s.locked,
    labels: s.labels,
    assignee_logins: s.assignee_logins,
    linked_open_prs: s.linked_open_prs,
    author_login: s.author_login,
    body_length: s.body.length,
    comments_count: s.comments_count,
    last_maintainer_comment_at: ev.last_maintainer_comment_at,
    work_claim_signals: ev.work_claim_signals,
    signals: ev.signals,
    signal_count: ev.signal_count,
    eligibility: ev.eligibility,
    exclusion_reasons: ev.exclusion_reasons,
    task_type: ev.task_type,
    burden: ev.burden,
    burden_reasons: ev.burden_reasons,
    rule_version: ev.rule_version,
    github_created_at: s.created_at,
    github_updated_at: s.updated_at,
    last_checked_at: now.toISOString(),
    last_check_error: null,
  };
}

async function existingFlags(repositoryId: number, githubIds: number[]): Promise<Map<number, IssueRow['operator_flags']>> {
  if (!githubIds.length) return new Map();
  const data = maybe(await adminDb().from('issues').select('github_id, operator_flags').eq('repository_id', repositoryId).in('github_id', githubIds), 'sync.ts:data');
  return new Map((data ?? []).map((r) => [r.github_id as number, r.operator_flags as IssueRow['operator_flags']]));
}

export async function syncIssues(repo: RepositoryRow, opts: { full?: boolean } = {}) {
  const db = adminDb();
  const now = new Date();
  const since = !opts.full && repo.issues_synced_at ? new Date(Date.parse(repo.issues_synced_at) - 5 * 60_000).toISOString() : undefined;

  const snapshots = await fetchIssues(repo.owner, repo.name, repo.github_id, { since, max: MAX_INDEX_ISSUES });
  const flags = await existingFlags(repo.id, snapshots.map((s) => s.github_id));
  const rows = snapshots.map((s) => issueRowFromSnapshot(repo, s, flags.get(s.github_id), now));
  for (let i = 0; i < rows.length; i += 100) {
    must(await db.from('issues').upsert(rows.slice(i, i + 100), { onConflict: 'github_id' }).select('id'), 'upsert issues');
  }
  // Issues not returned by an incremental sync did not change on GitHub: confirm them as checked now.
  if (since) {
    await db.from('issues').update({ last_checked_at: now.toISOString() }).eq('repository_id', repo.id).eq('state', 'open').lt('github_updated_at', since);
  }

  // Retrieval index: issues/PRs updated within 12 months (bounded).
  const indexSince = new Date(Math.max(now.getTime() - INDEX_WINDOW_MS, since ? Date.parse(since) : 0)).toISOString();
  const { issues, pulls } = await fetchIndexCandidates(repo.owner, repo.name, { since: indexSince, maxIssues: MAX_INDEX_ISSUES, maxPulls: MAX_INDEX_PULLS });
  let indexed = 0;
  for (const d of issues) {
    const r = await upsertSource({
      repository_id: repo.id,
      kind: d.state === 'open' ? 'issue' : 'closed_issue',
      github_ref: `issue:${d.number}`,
      url: d.url,
      title: `#${d.number} ${d.title}`,
      content: d.body,
      author_login: d.author_login,
      author_association: d.author_association,
      github_created_at: d.created_at,
      github_updated_at: d.updated_at,
    });
    if (r.changed) indexed++;
  }
  for (const d of pulls) {
    const r = await upsertSource({
      repository_id: repo.id,
      kind: 'pull_request',
      github_ref: `pr:${d.number}`,
      url: d.url,
      title: `PR #${d.number} ${d.title} [${d.state}]`,
      content: d.body,
      author_login: d.author_login,
      author_association: d.author_association,
      github_created_at: d.created_at,
      github_updated_at: d.updated_at,
    });
    if (r.changed) indexed++;
  }

  await db.from('repositories').update({ issues_synced_at: now.toISOString() }).eq('id', repo.id);
  logInfo('issues_synced', { repository_id: repo.id, issues: rows.length, indexed, incremental: Boolean(since) });
  return { repository_id: repo.id, issues: rows.length, eligible: rows.filter((r) => r.eligibility === 'eligible').length, indexed };
}

/**
 * Re-fetch a single issue when its last check is older than maxAgeMs (15 min before reports/journeys).
 * On failure the stored row is kept and the error recorded; callers decide whether stale data is acceptable.
 */
export async function refreshIssue(issueId: number, maxAgeMs: number): Promise<{ issue: IssueRow; snapshot: IssueSnapshot | null; error: GitHubError | null }> {
  const db = adminDb();
  const current = must(await db.from('issues').select('*').eq('id', issueId).single(), 'load issue') as IssueRow;
  const age = current.last_checked_at ? Date.now() - Date.parse(current.last_checked_at) : Infinity;
  if (age <= maxAgeMs) return { issue: current, snapshot: null, error: null };

  const repo = must(await db.from('repositories').select('*').eq('id', current.repository_id).single(), 'load repo') as RepositoryRow;
  try {
    const snap = await fetchIssue(repo.owner, repo.name, repo.github_id, current.number);
    const row = issueRowFromSnapshot(repo, snap, current.operator_flags, new Date());
    const updated = must(await db.from('issues').update(row).eq('id', issueId).select('*').single(), 'update issue') as IssueRow;
    return { issue: updated, snapshot: snap, error: null };
  } catch (err) {
    const ge = toGitHubError(err);
    logWarn('issue_refresh_failed', { issue_id: issueId, kind: ge.kind, status: ge.status });
    await db.from('issues').update({ last_check_error: `${ge.kind}:${ge.status ?? ''}` }).eq('id', issueId);
    return { issue: { ...current, last_check_error: ge.kind }, snapshot: null, error: ge };
  }
}

export async function approvedRepositories(): Promise<RepositoryRow[]> {
  return must(await adminDb().from('repositories').select('*').eq('status', 'approved').order('id'), 'list repos') as RepositoryRow[];
}
