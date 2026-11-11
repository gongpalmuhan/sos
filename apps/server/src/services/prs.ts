/** F8 PR 연결·상태 추적 + F7 리뷰 해석. */
import type { LinkedPr, ReviewInterpretation } from '@sos/shared';
import { LIMITS, reviewInterpretationModelOutputSchema } from '@sos/shared';
import { adminDb, must, maybe } from '@/lib/supabase';
import { badRequest, conflict, forbidden, HttpError, mapRpcError, notFound, tooMany, unavailable } from '@/lib/http';
import { logWarn } from '@/lib/log';
import type { AuthContext } from '@/lib/auth';
import { checkPrOwnership, derivePrStatus, parsePrUrl, secondsUntilRefreshAllowed } from '@/domain/pr';
import { resolveRefs, type SuppliedSource } from '@/domain/report-validation';
import { GitHubError, toGitHubError } from '@/github/client';
import { fetchPull, fetchPullReviewTexts } from '@/github/fetchers';
import { generateWithFallback } from '@/ai/generate';
import { REVIEW_SYSTEM, SOURCE_BUDGET_TOKENS, renderSources, reviewPrompt } from '@/ai/prompts';
import { assertAssistQuota, assertGenerationAllowed } from './quota';
import { loadOwnJourney } from './reports';
import type { LinkedPrRow, RepositoryRow } from './rows';

const OWNERSHIP_MESSAGES = {
  no_github_identity: 'GitHub 계정 정보를 확인할 수 없습니다. 다시 로그인하세요.',
  not_author: '본인이 작성한 PR만 연결할 수 있습니다.',
  wrong_repository: '선택한 이슈의 저장소에 열린 PR만 연결할 수 있습니다.',
} as const;

function githubHttpError(e: GitHubError): HttpError {
  if (e.kind === 'not_found') return notFound('pull request (공개 PR만 연결할 수 있습니다)');
  if (e.kind === 'rate_limited') return tooMany('github_rate_limited', 'GitHub 조회 한도에 도달했습니다. 잠시 후 다시 시도하세요.', e.retryAfterSeconds);
  return unavailable('github_unavailable', 'GitHub에서 PR을 조회하지 못했습니다.');
}

async function loadOwnLinkedPr(auth: AuthContext, linkedPrId: string): Promise<LinkedPrRow> {
  const data = maybe(await auth.db.from('linked_prs').select('*').eq('id', linkedPrId).maybeSingle(), 'prs.ts:data');
  if (!data) throw notFound('linked pr');
  return data as LinkedPrRow;
}

function dto(p: LinkedPrRow): LinkedPr {
  return { id: p.id, url: p.url, number: p.number, title: p.title, status: p.status, status_changed_at: p.status_changed_at, merged_at: p.merged_at, last_success_at: p.last_success_at, fetch_error: p.fetch_error };
}

/** POST /api/journeys/:id/pr */
export async function linkPr(auth: AuthContext, journeyId: string, url: string): Promise<{ linked_pr: LinkedPr; created: boolean }> {
  const parsed = parsePrUrl(url);
  if (!parsed) throw badRequest('https://github.com/{owner}/{repo}/pull/{번호} 형식의 공개 PR URL만 연결할 수 있습니다.');
  const journey = await loadOwnJourney(auth, journeyId);
  if (journey.status === 'abandoned') throw conflict('journey_abandoned', '중단한 여정입니다.');
  const repo = must(await adminDb().from('repositories').select('github_id, owner, name').eq('id', journey.repository_id).single(), 'repo') as Pick<RepositoryRow, 'github_id' | 'owner' | 'name'>;

  let pr;
  try {
    pr = await fetchPull(parsed.owner, parsed.repo, parsed.number);
  } catch (err) {
    throw githubHttpError(toGitHubError(err));
  }
  const ownership = checkPrOwnership({ prAuthorId: pr.author_id, prBaseRepoId: pr.base_repo_id, userGithubId: auth.githubId, journeyRepoGithubId: repo.github_id });
  if (ownership) throw forbidden(OWNERSHIP_MESSAGES[ownership]);

  const { data, error } = await adminDb().rpc('link_pr', {
    p_user_id: auth.userId,
    p_journey_id: journeyId,
    p_pr: {
      github_pr_id: pr.github_id,
      github_repo_id: pr.base_repo_id,
      number: pr.number,
      author_github_id: pr.author_id,
      url: pr.html_url,
      title: pr.title,
      status: derivePrStatus(pr),
      merged_at: pr.merged_at,
      closed_at: pr.closed_at,
    },
  });
  if (error) throw mapRpcError(error);
  const res = data as { linked_pr_id: string; created: boolean };
  return { linked_pr: dto(await loadOwnLinkedPr(auth, res.linked_pr_id)), created: res.created };
}

/** Sync one linked PR. Fetch failures never turn into closed_without_merge. */
export async function syncLinkedPr(p: LinkedPrRow, manual: boolean): Promise<{ changed: boolean; error: GitHubError | null }> {
  const db = adminDb();
  const repo = must(await db.from('journeys').select('repositories(owner, name)').eq('id', p.journey_id).single(), 'journey repo') as unknown as { repositories: { owner: string; name: string } };
  try {
    const pr = await fetchPull(repo.repositories.owner, repo.repositories.name, p.number);
    if (pr.github_id !== p.github_pr_id) throw new GitHubError('not_found', 404, 'pr id mismatch');
    const { data, error } = await db.rpc('apply_pr_status', {
      p_linked_pr_id: p.id,
      p_status: derivePrStatus(pr),
      p_merged_at: pr.merged_at,
      p_closed_at: pr.closed_at,
      p_title: pr.title,
      p_manual: manual,
    });
    if (error) throw mapRpcError(error);
    return { changed: Boolean((data as { changed: boolean }).changed), error: null };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const ge = toGitHubError(err);
    logWarn('pr_sync_failed', { linked_pr_id: p.id, kind: ge.kind, status: ge.status });
    await db.rpc('record_pr_fetch_error', { p_linked_pr_id: p.id, p_error: ge.kind === 'not_found' ? 'unavailable_on_github' : ge.kind, p_manual: manual });
    return { changed: false, error: ge };
  }
}

/** POST /api/prs/:id/refresh — 60s per-PR throttle. */
export async function refreshPr(auth: AuthContext, linkedPrId: string): Promise<LinkedPr> {
  const p = await loadOwnLinkedPr(auth, linkedPrId);
  const wait = secondsUntilRefreshAllowed(p.last_manual_refresh_at, new Date(), LIMITS.prManualRefreshSeconds);
  if (wait > 0) throw tooMany('refresh_too_soon', `${wait}초 후에 다시 새로고침할 수 있습니다.`, wait);
  const { error } = await syncLinkedPr(p, true);
  if (error?.kind === 'rate_limited') throw githubHttpError(error);
  return dto(await loadOwnLinkedPr(auth, linkedPrId));
}

/** Hourly job: open PRs, plus recently closed ones (to catch reopen). */
export async function syncTrackedPrs(): Promise<{ checked: number; changed: number; failed: number }> {
  const db = adminDb();
  const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  const data = maybe(await db
    .from('linked_prs')
    .select('*')
    .or(`status.eq.open,and(status.eq.closed_without_merge,status_changed_at.gte.${since})`)
    .limit(1000), 'prs.ts:data');
  let changed = 0;
  let failed = 0;
  for (const p of (data ?? []) as LinkedPrRow[]) {
    const r = await syncLinkedPr(p, false);
    if (r.changed) changed++;
    if (r.error) {
      failed++;
      if (r.error.kind === 'rate_limited') break; // resume next hour
    }
  }
  return { checked: data?.length ?? 0, changed, failed };
}

/** POST /api/prs/:id/review-interpretations — Korean interpretation with source links; not stored. */
export async function interpretReviews(auth: AuthContext, linkedPrId: string): Promise<ReviewInterpretation> {
  const p = await loadOwnLinkedPr(auth, linkedPrId);
  const repo = must(await adminDb().from('journeys').select('repositories(id, owner, name)').eq('id', p.journey_id).single(), 'repo') as unknown as { repositories: { id: number; owner: string; name: string } };
  let texts;
  try {
    texts = await fetchPullReviewTexts(repo.repositories.owner, repo.repositories.name, p.number);
  } catch (err) {
    throw githubHttpError(toGitHubError(err));
  }
  if (!texts.length) return { pr_url: p.url, items: [], fetched_comments: 0, total_comments: 0 };

  await assertGenerationAllowed();
  await assertAssistQuota(auth.userId);

  const supplied: SuppliedSource[] = texts.map((t, i) => ({ ref: `S${i + 1}`, source_id: i + 1, kind: 'review_comment', url: t.url, title: t.author_login, content: t.body }));
  const { text, used } = renderSources(supplied, SOURCE_BUDGET_TOKENS);
  const byRef = new Map(used.map((s, i) => [s.ref, { src: s, raw: texts[i]! }]));

  const gen = await generateWithFallback(
    reviewInterpretationModelOutputSchema,
    REVIEW_SYSTEM,
    reviewPrompt(text),
    { userId: auth.userId, kind: 'review_interpretation', quotaKind: 'assist' },
    (value) => {
      const { invalid } = resolveRefs(value.items.map((i) => i.source_id), used);
      const items = value.items
        .filter((i) => byRef.has(i.source_id))
        .map((i) => {
          const hit = byRef.get(i.source_id)!;
          return { comment_url: hit.src.url, author_login: hit.raw.author_login, original: hit.raw.body, interpretation_ko: i.interpretation_ko, unclear_points: i.unclear_points };
        });
      return invalid > 0 ? { accept: false, reason: 'invalid_sources', result: items } : { accept: true, result: items };
    },
  );
  if (!gen.result?.length) throw unavailable('interpretation_failed', '리뷰 해석을 만들지 못했습니다. 원문 링크에서 직접 확인하세요.');
  return { pr_url: p.url, items: gen.result, fetched_comments: used.length, total_comments: texts.length };
}
