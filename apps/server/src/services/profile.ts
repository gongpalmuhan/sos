/** F2 스택 온보딩 + 동의 설정. */
import type { Profile, ProfileUpdate, StackSuggestion } from '@sos/shared';
import { CONSENT_VERSION } from '@sos/shared';
import { adminDb, must, maybe } from '@/lib/supabase';
import { forbidden, notFound, unavailable } from '@/lib/http';
import { recordEvent } from '@/lib/events';
import type { AuthContext } from '@/lib/auth';
import { suggestStacks } from '@/domain/stack';
import { fetchUserPublicRepos } from '@/github/fetchers';

const COLUMNS = 'user_id, github_id, github_login, stacks, experience_level, interested_task_types, onboarding_confirmed_at, analytics_consent, public_inference_consent';

export async function getProfile(auth: AuthContext): Promise<Profile> {
  const data = maybe(await auth.db.from('profiles').select(COLUMNS).eq('user_id', auth.userId).maybeSingle(), 'profile.ts:data');
  if (!data) throw notFound('profile');
  return data as Profile;
}

/** Only allowed fields; saved only with explicit confirmation (schema enforces confirmed: true). */
export async function updateProfile(auth: AuthContext, input: ProfileUpdate): Promise<Profile> {
  const current = await getProfile(auth);
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    stacks: [...new Set(input.stacks)],
    experience_level: input.experience_level,
    interested_task_types: [...new Set(input.interested_task_types)],
    onboarding_confirmed_at: now,
    consent_version: CONSENT_VERSION,
  };
  if (input.analytics_consent !== undefined && input.analytics_consent !== current.analytics_consent) {
    patch.analytics_consent = input.analytics_consent;
    patch.analytics_consent_at = now;
  }
  if (input.public_inference_consent !== undefined && input.public_inference_consent !== current.public_inference_consent) {
    patch.public_inference_consent = input.public_inference_consent;
    patch.public_inference_consent_at = now;
  }
  const saved = must(await adminDb().from('profiles').update(patch).eq('user_id', auth.userId).select(COLUMNS).single(), 'update profile') as Profile;
  await recordEvent({
    userId: auth.userId,
    name: 'onboarding_stack_confirmed',
    properties: { stack_count: saved.stacks.length, experience_level: saved.experience_level, first_time: current.onboarding_confirmed_at === null },
  });
  return saved;
}

/** Optional: candidates from the user's public repos, only with consent. Not saved. */
export async function stackSuggestions(auth: AuthContext): Promise<StackSuggestion[]> {
  const profile = await getProfile(auth);
  if (!profile.public_inference_consent) throw forbidden('공개 프로필 기반 추천에 동의한 경우에만 사용할 수 있습니다.');
  if (!profile.github_login) throw unavailable('no_github_login', 'GitHub 계정 정보를 확인할 수 없습니다. 직접 선택하세요.');
  try {
    return suggestStacks(await fetchUserPublicRepos(profile.github_login));
  } catch {
    // Inference failure must not block manual onboarding.
    return [];
  }
}
