/** F7 영어 초안 (첫 댓글·PR 설명). Never posted automatically; body is not stored. */
import type { Draft, DraftType, ReportResult } from '@sos/shared';
import { draftModelOutputSchema } from '@sos/shared';
import { adminDb, must, maybe } from '@/lib/supabase';
import { conflict, unavailable } from '@/lib/http';
import { recordEvent } from '@/lib/events';
import type { AuthContext } from '@/lib/auth';
import { resolveRefs, type SuppliedSource } from '@/domain/report-validation';
import { generateWithFallback } from '@/ai/generate';
import { draftPrompt, draftSystem, renderSources } from '@/ai/prompts';
import { refreshIssue } from '@/github/sync';
import { assertAssistQuota, assertGenerationAllowed } from './quota';
import { latestUsableReport, loadOwnJourney } from './reports';
import type { SourceDocumentRow } from './rows';

const DRAFT_SOURCE_BUDGET = 6_000;
/** Re-check the issue right before the user copies a draft (확정서 §8.4). */
const DRAFT_RECHECK_MS = 0;

export async function createDraft(auth: AuthContext, input: { journey_id: string; type: DraftType; intent: string }): Promise<Draft & { issue_warnings: { code: string; message: string; source_url?: string }[] }> {
  const journey = await loadOwnJourney(auth, input.journey_id);
  if (journey.status === 'abandoned') throw conflict('journey_abandoned', '중단한 여정입니다.');

  await assertGenerationAllowed();
  await assertAssistQuota(auth.userId);

  const { issue } = await refreshIssue(journey.issue_id, DRAFT_RECHECK_MS);
  const issueWarnings = [
    ...(issue.eligibility === 'excluded' ? issue.exclusion_reasons : []),
    ...(issue.work_claim_signals ?? []),
  ];

  const db = adminDb();
  const report = await latestUsableReport(journey.issue_id);
  const citedIds = new Set<number>();
  const r = report?.result as ReportResult | undefined;
  for (const item of r?.summary_items ?? []) for (const s of item.sources) citedIds.add(s.source_id);
  for (const item of r?.related_work ?? []) for (const s of item.sources) citedIds.add(s.source_id);

  const issueDoc = maybe(await db
    .from('source_documents')
    .select('id, kind, url, title, content')
    .eq('repository_id', journey.repository_id)
    .eq('github_ref', `issue:${issue.number}`)
    .limit(1)
    .maybeSingle(), 'drafts.ts:issueDoc');
  const extra = citedIds.size
    ? (must(await db.from('source_documents').select('id, kind, url, title, content').in('id', [...citedIds].slice(0, 10)), 'sources') as SourceDocumentRow[])
    : [];
  const docs = [issueDoc, ...extra].filter((d, i, arr): d is SourceDocumentRow => Boolean(d) && arr.findIndex((x) => x?.id === d?.id) === i);
  const supplied: SuppliedSource[] = docs.map((d, i) => ({ ref: `S${i + 1}`, source_id: d.id, kind: d.kind, url: d.url, title: d.title, content: d.content }));
  const { text, used } = renderSources(supplied, DRAFT_SOURCE_BUDGET);

  const gen = await generateWithFallback(
    draftModelOutputSchema,
    draftSystem(input.type),
    draftPrompt(input.intent, { title: issue.title, number: issue.number }, text),
    { userId: auth.userId, kind: 'draft', quotaKind: 'assist' },
    (value) => {
      const { links, invalid } = resolveRefs(value.source_ids, used);
      const result = { body: value.body.trim(), links };
      if (invalid > 0) return { accept: false, reason: 'invalid_sources', result };
      if (/https?:\/\//.test(value.body) && !value.body.split(/\s+/).filter((w) => /^https?:\/\//.test(w)).every((u) => used.some((s) => u.startsWith(s.url)))) {
        return { accept: false, reason: 'unverified_url_in_body', result };
      }
      return { accept: true, result };
    },
  );
  if (!gen.result || gen.reason) throw unavailable('draft_failed', '초안을 만들지 못했습니다. 잠시 후 다시 시도하세요.');

  await recordEvent({
    userId: auth.userId,
    name: 'contribution_intent_draft_generated',
    journeyId: journey.id,
    issueId: journey.issue_id,
    repositoryId: journey.repository_id,
    properties: { type: input.type },
  });

  return {
    type: input.type,
    body: gen.result.body,
    sources: gen.result.links,
    editable: true,
    auto_posted: false,
    notice: 'SOS는 이 초안을 게시하지 않습니다. 내용을 검토·수정한 뒤 GitHub에서 직접 게시하세요.',
    issue_warnings: issueWarnings,
  };
}
