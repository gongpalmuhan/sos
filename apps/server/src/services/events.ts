/** POST /api/events — client-reportable events only, idempotent by event_id. */
import type { ClientEvent } from '@sos/shared';
import { adminDb, maybe } from '@/lib/supabase';
import { badRequest, notFound } from '@/lib/http';
import { recordEvent } from '@/lib/events';
import type { AuthContext } from '@/lib/auth';
import { loadOwnJourney } from './reports';

export async function recordClientEvent(auth: AuthContext, e: ClientEvent): Promise<{ recorded: boolean }> {
  let journey: { id: string; issue_id: number; repository_id: number } | null = null;
  if (e.journey_id) journey = await loadOwnJourney(auth, e.journey_id);

  let dedupeKey: string | undefined;
  switch (e.name) {
    case 'repo_selected': {
      if (!e.repository_id) throw badRequest('repository_id가 필요합니다.');
      const data = maybe(await adminDb().from('repositories').select('id').eq('id', e.repository_id).eq('status', 'approved').maybeSingle(), 'events.ts:data');
      if (!data) throw notFound('repository');
      break;
    }
    case 'context_report_viewed': {
      if (!e.report_id) throw badRequest('report_id가 필요합니다.');
      const data = maybe(await adminDb().from('reports').select('id, status').eq('id', e.report_id).maybeSingle(), 'events.ts:data');
      if (!data) throw notFound('report');
      if (data.status !== 'ready') throw badRequest('검증된 리포트만 열람으로 기록합니다.');
      dedupeKey = `context_report_viewed:${auth.userId}:${e.report_id}`;
      break;
    }
    case 'draft_copied':
    case 'contribution_intent_marked_posted': {
      if (!journey) throw badRequest('journey_id가 필요합니다.');
      if (e.name === 'contribution_intent_marked_posted') dedupeKey = `intent_posted:${journey.id}`;
      break;
    }
  }

  const recorded = await recordEvent({
    userId: auth.userId,
    name: e.name,
    eventId: e.event_id,
    journeyId: journey?.id ?? null,
    issueId: journey?.issue_id ?? null,
    repositoryId: journey?.repository_id ?? e.repository_id ?? null,
    properties: {
      ...(e.draft_type ? { draft_type: e.draft_type } : {}),
      ...(e.report_id ? { report_id: e.report_id } : {}),
      ...(e.name === 'contribution_intent_marked_posted' ? { self_reported: true } : {}),
    },
    dedupeKey,
  });
  return { recorded };
}

export async function rateReport(auth: AuthContext, reportId: string, useful: boolean, reasons: string[]): Promise<{ recorded: boolean }> {
  const data = maybe(await adminDb().from('reports').select('id, issue_id').eq('id', reportId).maybeSingle(), 'events.ts:data');
  if (!data) throw notFound('report');
  const recorded = await recordEvent({
    userId: auth.userId,
    name: 'report_rated',
    issueId: data.issue_id as number,
    properties: { report_id: reportId, useful, reasons: reasons.join(',') },
    dedupeKey: `report_rated:${auth.userId}:${reportId}`,
  });
  return { recorded };
}
