import type { EventName } from '@sos/shared';
import { adminDb } from './supabase';
import { logError } from './log';

export interface EventInput {
  userId: string;
  name: EventName;
  journeyId?: string | null;
  issueId?: number | null;
  repositoryId?: number | null;
  /** Limited, body-free properties only (확정서 §13.1). */
  properties?: Record<string, string | number | boolean | null>;
  dedupeKey?: string;
  eventId?: string;
}

/** Record a ledger event. Duplicate event_id / dedupe_key is silently ignored. */
export async function recordEvent(e: EventInput): Promise<boolean> {
  const { data, error } = await adminDb().rpc('record_event', {
    p_user_id: e.userId,
    p_event_name: e.name,
    p_journey_id: e.journeyId ?? null,
    p_issue_id: e.issueId ?? null,
    p_repository_id: e.repositoryId ?? null,
    p_properties: e.properties ?? {},
    p_dedupe_key: e.dedupeKey ?? null,
    p_event_id: e.eventId ?? null,
  });
  if (error) {
    logError('record_event_failed', error, { name: e.name });
    return false;
  }
  return Boolean(data);
}
