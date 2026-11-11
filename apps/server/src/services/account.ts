/** 계정 삭제 (확정서 §12): accept → end session → background job deletes the auth user (cascade). */
import { adminDb } from '@/lib/supabase';
import { logInfo } from '@/lib/log';
import type { AuthContext } from '@/lib/auth';
import { inngest, EVENTS } from '@/inngest/client';

export async function requestAccountDeletion(auth: AuthContext): Promise<{ accepted: true; deadline_days: 7 }> {
  await adminDb().from('profiles').update({ deletion_requested_at: new Date().toISOString() }).eq('user_id', auth.userId);
  await inngest.send({ name: EVENTS.accountDeletionRequested, data: { userId: auth.userId } });
  // Revoke all refresh tokens for this user; cookie session is cleared by the route.
  await auth.db.auth.signOut({ scope: 'global' }).catch(() => undefined);
  return { accepted: true, deadline_days: 7 };
}

/** Job: deleting auth.users cascades profiles, journeys, checklist, linked PRs, events. */
export async function deleteAccountData(userId: string): Promise<void> {
  const db = adminDb();
  const { error } = await db.auth.admin.deleteUser(userId);
  if (error && !/not.*found/i.test(error.message)) throw new Error(`delete_user_failed: ${error.message}`);
  // reports/ai_runs keep no personal content; detach any remaining reference defensively
  await db.from('reports').update({ requested_by: null }).eq('requested_by', userId);
  await db.from('ai_runs').update({ user_id: null }).eq('user_id', userId);
  logInfo('account_deleted', { user_ref: userId.slice(0, 8) });
}
