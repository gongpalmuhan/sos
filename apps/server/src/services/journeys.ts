/** F9 개인 여정 + F6 체크리스트. Mutations via transactional RPCs (state + event). */
import type { ChecklistItem, Journey, LinkedPr, ReportResult } from '@sos/shared';
import { CHECKLIST_STAGES } from '@sos/shared';
import { adminDb, must, maybe } from '@/lib/supabase';
import { conflict, mapRpcError, notFound, unavailable } from '@/lib/http';
import type { AuthContext } from '@/lib/auth';
import { generalChecklist, progressOf, type ChecklistSeed } from '@/domain/checklist';
import { RULE_VERSION, STALE_AFTER_MS } from '@/domain/recommendation';
import { sha256 } from '@/domain/text';
import { refreshIssue } from '@/github/sync';
import { ISSUE_RECHECK_MS, latestUsableReport, loadOwnJourney } from './reports';
import type { IssueRow, JourneyRow, LinkedPrRow, RepositoryRow } from './rows';

/** POST /api/journeys — re-check the issue on the server, then create (idempotent). */
export async function createJourney(auth: AuthContext, issueId: number): Promise<{ journey: Journey; created: boolean; warnings: { code: string; message: string; source_url?: string }[] }> {
  const db = adminDb();
  const base = maybe(await db.from('issues').select('id, repository_id').eq('id', issueId).maybeSingle(), 'journeys.ts:base');
  if (!base) throw notFound('issue');
  const repo = maybe(await db.from('repositories').select('*').eq('id', base.repository_id).eq('status', 'approved').maybeSingle(), 'journeys.ts:repo');
  if (!repo) throw notFound('issue');

  const { issue, error } = await refreshIssue(issueId, ISSUE_RECHECK_MS);
  if (error) {
    const age = issue.last_checked_at ? Date.now() - Date.parse(issue.last_checked_at) : Infinity;
    if (error.kind === 'not_found' || age > STALE_AFTER_MS) {
      throw unavailable('issue_unverifiable', '이슈의 최신 상태를 확인할 수 없어 지금은 선택할 수 없습니다. GitHub 원문을 확인하세요.');
    }
  }
  if (issue.eligibility === 'excluded') {
    throw conflict('issue_not_recommendable', '추천 규칙상 지금 선택하기 어려운 이슈입니다.', { reasons: issue.exclusion_reasons });
  }

  const r = repo as RepositoryRow;
  const seeds = generalChecklist({ html_url: r.html_url, contributing_url: r.contributing_url }, issue.html_url);
  const { data, error: rpcErr } = await db.rpc('create_journey', {
    p_user_id: auth.userId,
    p_issue_id: issueId,
    p_rule_version: RULE_VERSION,
    p_checklist: seeds,
  });
  if (rpcErr) throw mapRpcError(rpcErr);
  const res = data as { journey_id: string; created: boolean };

  const warnings = [
    ...(issue.eligibility === 'needs_review' ? issue.exclusion_reasons : []),
    ...(issue.work_claim_signals ?? []),
  ];
  return { journey: await getJourney(auth, res.journey_id), created: res.created, warnings };
}

/** Add repository-rule checklist items from the latest validated report (idempotent). */
async function materializeRepoRules(journey: JourneyRow): Promise<void> {
  const report = await latestUsableReport(journey.issue_id);
  const steps = (report?.result as ReportResult | null)?.contributing_steps ?? [];
  if (!steps.length) return;
  const stageBase: Record<string, number> = { env: 1000, work: 2000, test: 3000, pre_pr: 4000 };
  const rows: (ChecklistSeed & { journey_id: string; user_id: string })[] = steps.map((s, i) => ({
    journey_id: journey.id,
    user_id: journey.user_id,
    item_key: `r_${sha256(`${s.stage}:${s.text}:${s.command ?? ''}`).slice(0, 16)}`,
    position: (stageBase[s.stage] ?? 5000) + i,
    stage: s.stage,
    kind: 'repo_rule',
    text: s.text,
    command: s.command,
    source_id: s.sources[0]?.source_id ?? null,
    source_url: s.sources[0]?.url ?? null,
  }));
  await adminDb().from('checklist_items').upsert(rows, { onConflict: 'journey_id,item_key', ignoreDuplicates: true });
}

function linkedPrDto(p: LinkedPrRow): LinkedPr {
  return {
    id: p.id,
    url: p.url,
    number: p.number,
    title: p.title,
    status: p.status,
    status_changed_at: p.status_changed_at,
    merged_at: p.merged_at,
    last_success_at: p.last_success_at,
    fetch_error: p.fetch_error,
  };
}

const stageOrder = (s: string) => CHECKLIST_STAGES.indexOf(s as (typeof CHECKLIST_STAGES)[number]);

export async function getJourney(auth: AuthContext, journeyId: string): Promise<Journey> {
  const j = await loadOwnJourney(auth, journeyId);
  if (j.status !== 'abandoned') await materializeRepoRules(j);

  const [issueRes, repoRes, itemsRes, prRes, reportRes] = await Promise.all([
    adminDb().from('issues').select('id, number, title, html_url, eligibility').eq('id', j.issue_id).single(),
    adminDb().from('repositories').select('id, owner, name, html_url').eq('id', j.repository_id).single(),
    auth.db.from('checklist_items').select('*').eq('journey_id', j.id),
    auth.db.from('linked_prs').select('*').eq('journey_id', j.id).maybeSingle(),
    adminDb().from('reports').select('id').eq('issue_id', j.issue_id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  const issue = must(issueRes, 'issue') as Pick<IssueRow, 'id' | 'number' | 'title' | 'html_url' | 'eligibility'>;
  const repo = must(repoRes, 'repo') as Pick<RepositoryRow, 'id' | 'owner' | 'name' | 'html_url'>;
  const items = ((itemsRes.data ?? []) as (ChecklistItem & { stage: string })[])
    .map((i) => ({ id: i.id, position: i.position, stage: i.stage, kind: i.kind, text: i.text, command: i.command, source_url: i.source_url, completed_at: i.completed_at }))
    .sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage) || a.position - b.position);

  return {
    id: j.id,
    status: j.status,
    issue: { id: issue.id, number: issue.number, title: issue.title, html_url: issue.html_url, eligibility: issue.eligibility },
    repository: { id: repo.id, full_name: `${repo.owner}/${repo.name}`, html_url: repo.html_url },
    selected_at: j.selected_at,
    abandoned_at: j.abandoned_at,
    completed_at: j.completed_at,
    progress: progressOf(items),
    checklist: items,
    linked_pr: prRes.data ? linkedPrDto(prRes.data as LinkedPrRow) : null,
    latest_report_id: (reportRes.data?.id as string | undefined) ?? null,
  };
}

export async function listJourneys(auth: AuthContext): Promise<Journey[]> {
  const data = maybe(await auth.db.from('journeys').select('id').order('created_at', { ascending: false }).limit(50), 'journeys.ts:data');
  return Promise.all((data ?? []).map((r) => getJourney(auth, r.id as string)));
}

export async function abandonJourney(auth: AuthContext, journeyId: string, reason?: string): Promise<Journey> {
  const { error } = await adminDb().rpc('abandon_journey', { p_user_id: auth.userId, p_journey_id: journeyId, p_reason: reason ?? null });
  if (error) throw mapRpcError(error);
  return getJourney(auth, journeyId);
}

export async function setChecklistItem(auth: AuthContext, journeyId: string, itemId: string, completed: boolean): Promise<Journey> {
  const { error } = await adminDb().rpc('set_checklist_item', { p_user_id: auth.userId, p_journey_id: journeyId, p_item_id: itemId, p_completed: completed });
  if (error) throw mapRpcError(error);
  return getJourney(auth, journeyId);
}
