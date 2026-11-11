/** Usage limits & budget (확정서 §12 비용과 사용 제한). */
import { LIMITS } from '@sos/shared';
import { adminDb, maybe, countOf } from '@/lib/supabase';
import { env } from '@/lib/env';
import { logWarn } from '@/lib/log';
import { tooMany, unavailable } from '@/lib/http';

/** Start of the current day in Asia/Seoul, as an ISO string. */
export function startOfKstDay(now = new Date()): string {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  kst.setUTCHours(0, 0, 0, 0);
  return new Date(kst.getTime() - 9 * 3600_000).toISOString();
}

export function startOfMonthUtc(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Operator kill switch + monthly generation budget. Cached reads are never blocked by this. */
export async function assertGenerationAllowed(): Promise<void> {
  const db = adminDb();
  const setting = maybe(await db.from('app_settings').select('value').eq('key', 'generation_enabled').maybeSingle(), 'quota.ts:setting');
  if (setting && setting.value === false) {
    throw unavailable('generation_paused', '새 AI 생성이 일시 중단되었습니다. 저장된 결과와 원문 링크는 계속 볼 수 있습니다.');
  }
  const rows = maybe(await db.from('ai_runs').select('cost_usd').gte('created_at', startOfMonthUtc()), 'quota.ts:rows');
  const spent = (rows ?? []).reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
  const budget = env().AI_MONTHLY_BUDGET_USD;
  if (spent >= budget) {
    throw unavailable('budget_exhausted', '이번 달 AI 생성 예산을 모두 사용했습니다. 저장된 결과와 원문 링크는 계속 볼 수 있습니다.');
  }
  if (spent >= budget * 0.8) logWarn('ai_budget_80_percent', { spent: Number(spent.toFixed(4)), budget });
}

export async function assertAssistQuota(userId: string): Promise<void> {
  const count = countOf(await adminDb()
    .from('ai_runs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('quota_kind', 'assist')
    .gte('created_at', startOfKstDay()), 'quota.ts:count');
  if ((count ?? 0) >= LIMITS.assistsPerUserPerDay) {
    throw tooMany('assist_quota_exceeded', `초안·번역은 하루 ${LIMITS.assistsPerUserPerDay}회까지 생성할 수 있습니다.`);
  }
}

export async function assertReportQuota(userId: string): Promise<void> {
  const db = adminDb();
  const active = countOf(await db
    .from('reports')
    .select('id', { count: 'exact', head: true })
    .eq('requested_by', userId)
    .in('status', ['queued', 'running']), 'quota.ts:count');
  if ((active ?? 0) > 0) throw tooMany('report_in_progress', '이미 생성 중인 리포트가 있습니다. 완료 후 다시 요청하세요.');
  const count = countOf(await db
    .from('reports')
    .select('id', { count: 'exact', head: true })
    .eq('requested_by', userId)
    .gte('created_at', startOfKstDay()), 'quota.ts:count');
  if ((count ?? 0) >= LIMITS.reportsPerUserPerDay) {
    throw tooMany('report_quota_exceeded', `새 리포트는 하루 ${LIMITS.reportsPerUserPerDay}회까지 생성할 수 있습니다.`);
  }
}
