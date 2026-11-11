/**
 * F5 근거 리포트. Request (quota/cache) is synchronous; generation runs as an Inngest job.
 */
import type { Report, ReportResult, SourceKind } from '@sos/shared';
import { reportModelOutputSchema } from '@sos/shared';
import { adminDb, must, maybe } from '@/lib/supabase';
import { conflict, notFound, unavailable, mapRpcError } from '@/lib/http';
import { logInfo } from '@/lib/log';
import type { AuthContext } from '@/lib/auth';
import { sha256 } from '@/domain/text';
import { validateReportOutput, type SuppliedSource } from '@/domain/report-validation';
import { refreshIssue, upsertSource } from '@/github/sync';
import { fetchIssue, fetchIssueCommentsHeadTail, fetchPull } from '@/github/fetchers';
import { embedTexts, toVector } from '@/ai/embeddings';
import { generateWithFallback } from '@/ai/generate';
import { PROMPT_VERSION, SCHEMA_VERSION, chatModel } from '@/ai/models';
import { REPORT_SYSTEM, SOURCE_BUDGET_TOKENS, renderSources, reportPrompt } from '@/ai/prompts';
import { inngest, EVENTS } from '@/inngest/client';
import { assertGenerationAllowed, assertReportQuota } from './quota';
import type { IssueRow, JourneyRow, ReportRow, RepositoryRow } from './rows';

export const ISSUE_RECHECK_MS = 15 * 60_000;
export const REPORT_DELAY_NOTICE_MS = 120_000;
const MAX_RETRIEVED_CHUNKS = 8;
const MAX_LINKED_REFS = 5;
const SEARCH_SCOPE = '동일 저장소의 최근 12개월 이슈(최대 500건)·PR(최대 300건), CONTRIBUTING·README, 선택 이슈 댓글(처음 20개 + 최근 80개)';

export async function loadOwnJourney(auth: AuthContext, journeyId: string): Promise<JourneyRow> {
  const data = maybe(await auth.db.from('journeys').select('*').eq('id', journeyId).maybeSingle(), 'reports.ts:data');
  if (!data) throw notFound('journey');
  return data as JourneyRow;
}

async function cacheKeyFor(issue: IssueRow): Promise<{ key: string; hashes: Record<string, string> }> {
  const db = adminDb();
  const docs = maybe(await db
    .from('source_documents')
    .select('kind, content_hash')
    .eq('repository_id', issue.repository_id)
    .in('kind', ['contributing', 'readme']), 'reports.ts:docs');
  const hashes: Record<string, string> = {
    issue: sha256(`${issue.github_id}:${issue.github_updated_at}:${issue.comments_count}:${issue.state}`),
    ...Object.fromEntries((docs ?? []).map((d) => [d.kind as string, d.content_hash as string])),
  };
  const key = sha256(JSON.stringify({ hashes, model: chatModel('default').id, PROMPT_VERSION, SCHEMA_VERSION }));
  return { key, hashes };
}

export function toReportDto(r: ReportRow, now = new Date()): Report {
  const pending = r.status === 'queued' || r.status === 'running';
  return {
    id: r.id,
    issue_id: r.issue_id,
    status: r.status,
    result: r.status === 'ready' ? (r.result as ReportResult) : null,
    failure_reason: r.status === 'failed' ? r.failure_reason : null,
    insufficient_items: r.status === 'insufficient_evidence' ? r.insufficient_items : null,
    delayed: pending && now.getTime() - Date.parse(r.created_at) > REPORT_DELAY_NOTICE_MS,
    created_at: r.created_at,
    completed_at: r.completed_at,
  };
}

/** POST /api/reports — permission, quota, cache reuse, enqueue. */
export async function requestReport(auth: AuthContext, journeyId: string): Promise<{ report: Report; reused: boolean }> {
  const journey = await loadOwnJourney(auth, journeyId);
  if (journey.status === 'abandoned') throw conflict('journey_abandoned', '중단한 여정입니다.');

  const { issue, error } = await refreshIssue(journey.issue_id, ISSUE_RECHECK_MS);
  if (error && error.kind === 'not_found') throw conflict('issue_unavailable', '이슈를 GitHub에서 조회할 수 없습니다. 원문을 직접 확인하세요.');

  const db = adminDb();
  const { key, hashes } = await cacheKeyFor(issue);
  const existing = maybe(await db.from('reports').select('*').eq('cache_key', key).maybeSingle(), 'reports.ts:existing');
  if (existing && existing.status !== 'failed') {
    return { report: toReportDto(existing as ReportRow), reused: true };
  }

  await assertGenerationAllowed();
  await assertReportQuota(auth.userId);

  let row: ReportRow;
  if (existing) {
    row = must(
      await db.from('reports').update({ status: 'queued', failure_reason: null, requested_by: auth.userId, created_at: new Date().toISOString(), completed_at: null }).eq('id', existing.id).select('*').single(),
      'requeue report',
    ) as ReportRow;
  } else {
    const ins = await db
      .from('reports')
      .insert({ issue_id: issue.id, cache_key: key, source_hashes: hashes, prompt_version: PROMPT_VERSION, schema_version: SCHEMA_VERSION, requested_by: auth.userId })
      .select('*')
      .single();
    if (ins.error?.code === '23505') {
      // A concurrent request created the same report: reuse it (single job per source version).
      const again = must(await db.from('reports').select('*').eq('cache_key', key).single(), 'load report') as ReportRow;
      return { report: toReportDto(again), reused: true };
    }
    if (ins.error) throw mapRpcError(ins.error);
    row = ins.data as ReportRow;
  }

  try {
    await inngest.send({ name: EVENTS.reportRequested, data: { reportId: row.id, userId: auth.userId } });
  } catch {
    await db.from('reports').update({ status: 'failed', failure_reason: 'enqueue_failed' }).eq('id', row.id);
    throw unavailable('enqueue_failed', '리포트 작업을 접수하지 못했습니다. 잠시 후 다시 시도하세요.');
  }
  return { report: toReportDto(row), reused: false };
}

export async function getReport(reportId: string): Promise<Report> {
  const db = adminDb();
  const data = maybe(await db.from('reports').select('*').eq('id', reportId).maybeSingle(), 'reports.ts:data');
  if (!data) throw notFound('report');
  await db.from('reports').update({ last_viewed_at: new Date().toISOString() }).eq('id', reportId);
  return toReportDto(data as ReportRow);
}

export async function latestUsableReport(issueId: number): Promise<ReportRow | null> {
  const data = maybe(await adminDb()
    .from('reports')
    .select('*')
    .eq('issue_id', issueId)
    .eq('status', 'ready')
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle(), 'reports.ts:data');
  return (data as ReportRow) ?? null;
}

// ---------------------------------------------------------------------------
// Job: generate a report
// ---------------------------------------------------------------------------

interface SourceRowLite { id: number; kind: SourceKind; url: string; title: string | null; content: string }

async function collectSources(issue: IssueRow, repo: RepositoryRow) {
  const db = adminDb();
  const snap = await fetchIssue(repo.owner, repo.name, repo.github_id, issue.number);
  const issueSrc = await upsertSource({
    repository_id: repo.id, issue_id: issue.id, kind: snap.state === 'open' ? 'issue' : 'closed_issue', github_ref: `issue:${snap.number}`,
    url: snap.html_url, title: `#${snap.number} ${snap.title}`, content: snap.body, author_login: snap.author_login,
    github_created_at: snap.created_at, github_updated_at: snap.updated_at,
  });

  const comments = await fetchIssueCommentsHeadTail(repo.owner, repo.name, snap.number, snap.comments_count);
  const commentIds: number[] = [];
  for (const c of comments.comments) {
    const r = await upsertSource({
      repository_id: repo.id, issue_id: issue.id, kind: 'comment', github_ref: `comment:${c.id}`, url: c.url,
      title: `${c.author_login ?? 'unknown'} (${c.author_association}) ${c.created_at.slice(0, 10)}`, content: c.body,
      author_login: c.author_login, author_association: c.author_association, github_created_at: c.created_at,
    });
    commentIds.push(r.id);
  }

  // Explicitly linked PRs/issues, even outside the 12-month window.
  const linkedIds: number[] = [];
  for (const ref of snap.linked_refs.slice(0, MAX_LINKED_REFS)) {
    const githubRef = ref.kind === 'pull_request' ? `pr:${ref.number}` : `issue:${ref.number}`;
    const have = maybe(await db.from('source_documents').select('id').eq('repository_id', repo.id).eq('github_ref', githubRef).limit(1).maybeSingle(), 'reports.ts:have');
    if (have) { linkedIds.push(have.id as number); continue; }
    if (ref.kind === 'pull_request') {
      const pr = await fetchPull(repo.owner, repo.name, ref.number);
      const st = pr.merged_at ? 'merged' : pr.state;
      const r = await upsertSource({ repository_id: repo.id, kind: 'pull_request', github_ref: githubRef, url: pr.html_url, title: `PR #${pr.number} ${pr.title} [${st}]`, content: pr.body, author_login: pr.author_login, github_created_at: pr.created_at, github_updated_at: pr.updated_at });
      linkedIds.push(r.id);
    } else {
      const li = await fetchIssue(repo.owner, repo.name, repo.github_id, ref.number);
      const r = await upsertSource({ repository_id: repo.id, kind: li.state === 'open' ? 'issue' : 'closed_issue', github_ref: githubRef, url: li.html_url, title: `#${li.number} ${li.title}`, content: li.body, github_created_at: li.created_at, github_updated_at: li.updated_at });
      linkedIds.push(r.id);
    }
  }

  // Hybrid retrieval (FTS + vector, RRF k=60) within the same repository.
  const query = `${snap.title}\n${snap.body.slice(0, 1500)}`;
  const [queryVec] = await embedTexts([query]);
  const { data: hits, error } = await db.rpc('hybrid_search_chunks', {
    p_repository_id: repo.id,
    p_query_text: snap.title.replace(/[^\p{L}\p{N}_ .-]+/gu, ' ').slice(0, 300),
    p_query_embedding: queryVec ? toVector(queryVec) : null,
    p_match_count: 20,
    p_candidates: 20,
    p_rrf_k: 60,
  });
  if (error) throw new Error(`hybrid_search_failed: ${error.message}`);
  const exclude = new Set<number>([issueSrc.id, ...commentIds]);
  const retrieved: { source_id: number; content: string }[] = [];
  const seenSources = new Set<number>();
  for (const h of (hits ?? []) as { source_id: number; content: string }[]) {
    if (exclude.has(h.source_id) || seenSources.has(h.source_id)) continue;
    seenSources.add(h.source_id);
    retrieved.push(h);
    if (retrieved.length >= MAX_RETRIEVED_CHUNKS) break;
  }

  const ruleDocs = maybe(await db.from('source_documents').select('id').eq('repository_id', repo.id).in('kind', ['contributing', 'readme']), 'reports.ts:ruleDocs');
  const allIds = [...new Set([issueSrc.id, ...(ruleDocs ?? []).map((d) => d.id as number), ...linkedIds, ...commentIds, ...retrieved.map((r) => r.source_id)])];
  const rows = maybe(await db.from('source_documents').select('id, kind, url, title, content').in('id', allIds), 'reports.ts:rows');
  const byId = new Map(((rows ?? []) as SourceRowLite[]).map((r) => [r.id, r]));

  // Priority order for the token budget: issue → rules → linked → retrieved → comments.
  const ordered: { row: SourceRowLite; content: string }[] = [];
  const push = (id: number, content?: string) => { const r = byId.get(id); if (r) ordered.push({ row: r, content: content ?? r.content }); };
  push(issueSrc.id);
  for (const d of ruleDocs ?? []) push(d.id as number);
  for (const id of linkedIds) push(id);
  for (const r of retrieved) if (!linkedIds.includes(r.source_id)) push(r.source_id, r.content);
  for (const id of commentIds) push(id);

  const supplied: SuppliedSource[] = ordered.map((o, i) => ({ ref: `S${i + 1}`, source_id: o.row.id, kind: o.row.kind, url: o.row.url, title: o.row.title, content: o.content }));
  await db.from('source_documents').update({ last_referenced_at: new Date().toISOString() }).in('id', allIds);

  return {
    snap,
    supplied,
    retrieval: {
      issue_comments_fetched: comments.comments.length,
      issue_comments_total: comments.total,
      comments_middle_omitted: comments.middleOmitted,
      chunks_used: retrieved.length,
      searched_scope: SEARCH_SCOPE,
      checked_at: new Date().toISOString(),
    },
  };
}

/** Executed inside the Inngest job. Never exposes unvalidated output. */
export async function runReportGeneration(reportId: string, jobId?: string): Promise<{ status: string }> {
  const db = adminDb();
  const report = must(await db.from('reports').select('*').eq('id', reportId).single(), 'load report') as ReportRow;
  if (report.status === 'ready' || report.status === 'insufficient_evidence') return { status: report.status };
  await db.from('reports').update({ status: 'running', job_started_at: new Date().toISOString() }).eq('id', reportId);

  const issue = must(await db.from('issues').select('*').eq('id', report.issue_id).single(), 'load issue') as IssueRow;
  const repo = must(await db.from('repositories').select('*').eq('id', issue.repository_id).single(), 'load repo') as RepositoryRow;

  const { snap, supplied, retrieval } = await collectSources(issue, repo);
  const { text, used } = renderSources(supplied, SOURCE_BUDGET_TOKENS);
  const note = `${retrieval.searched_scope}. 댓글 ${retrieval.issue_comments_fetched}/${retrieval.issue_comments_total}개${retrieval.comments_middle_omitted ? ' (중간 생략)' : ''}.`;

  const gen = await generateWithFallback(
    reportModelOutputSchema,
    REPORT_SYSTEM,
    reportPrompt({ title: snap.title, url: snap.html_url, number: snap.number }, text, note),
    { userId: report.requested_by, kind: 'report', quotaKind: 'report', jobId, idempotencyKey: `report:${reportId}:${jobId ?? ''}` },
    (value) => {
      const v = validateReportOutput(value, used);
      if (v.shouldRetry) return { accept: false, reason: `invalid_sources:${v.problems.join(',')}`, result: v };
      if (v.insufficient) return { accept: false, reason: 'insufficient_evidence', result: v };
      return { accept: true, result: v };
    },
  );

  const now = new Date().toISOString();
  if (gen.result && !gen.reason) {
    const result: ReportResult = { ...gen.result.result, retrieval };
    await db.from('reports').update({ status: 'ready', result, model: gen.model, retrieval_scope: retrieval, completed_at: now }).eq('id', reportId);
    logInfo('report_ready', { report_id: reportId, attempts: gen.attempts, dropped: gen.result.dropped });
    return { status: 'ready' };
  }
  if (gen.reason?.startsWith('generation_failed')) {
    // Model unavailable twice: surface as failed (retry + 원문 확인 경로는 클라이언트가 안내).
    await db.from('reports').update({ status: 'failed', failure_reason: 'generation_failed', completed_at: now }).eq('id', reportId);
    return { status: 'failed' };
  }
  const items = describeProblems(gen.result?.problems ?? []);
  await db.from('reports').update({ status: 'insufficient_evidence', insufficient_items: items, model: gen.model, retrieval_scope: retrieval, completed_at: now }).eq('id', reportId);
  return { status: 'insufficient_evidence' };
}

const PROBLEM_MESSAGES: Record<string, string> = {
  claim_without_source: '원문 근거가 없는 주장이 있어 제외했습니다.',
  unknown_source: '수집하지 않은 출처를 인용한 항목이 있어 제외했습니다.',
  step_without_rule_source: 'CONTRIBUTING·README에 근거하지 않은 절차가 있어 제외했습니다.',
  fabricated_command: '원문에 없는 명령어가 있어 제외했습니다.',
};

/** User-facing Korean descriptions of why evidence was insufficient (no internal codes). */
export function describeProblems(problems: string[]): string[] {
  const out = new Set<string>(['근거가 확인된 사실·해석 항목이 없습니다. 원문 링크에서 직접 확인하세요.']);
  for (const p of problems) {
    const msg = PROBLEM_MESSAGES[p.split(':')[0] ?? ''];
    if (msg) out.add(msg);
  }
  return [...out];
}

export async function markReportFailed(reportId: string, reason: string) {
  await adminDb().from('reports').update({ status: 'failed', failure_reason: reason.slice(0, 100), completed_at: new Date().toISOString() }).eq('id', reportId).in('status', ['queued', 'running']);
}
