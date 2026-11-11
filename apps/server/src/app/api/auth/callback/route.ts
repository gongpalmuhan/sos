import { NextResponse, type NextRequest } from 'next/server';
import { userDbFromCookies } from '@/lib/supabase';
import { env } from '@/lib/env';
import { recordEvent } from '@/lib/events';
import { logWarn } from '@/lib/log';

/** Supabase GitHub OAuth (PKCE) callback: exchange code for a cookie session. */
export async function GET(req: NextRequest) {
  const appUrl = env().APP_URL;
  const code = req.nextUrl.searchParams.get('code');
  const nextParam = req.nextUrl.searchParams.get('next') ?? '/';
  // Only same-app relative paths: never redirect to attacker-controlled URLs.
  const next = nextParam.startsWith('/') && !nextParam.startsWith('//') && !nextParam.startsWith('/\\') ? nextParam : '/';

  if (!code) return NextResponse.redirect(new URL('/login?error=missing_code', appUrl));
  const db = await userDbFromCookies();
  const { data, error } = await db.auth.exchangeCodeForSession(code);
  if (error || !data.user) {
    logWarn('oauth_exchange_failed', { code: error?.code });
    return NextResponse.redirect(new URL('/login?error=login_failed', appUrl));
  }
  const isNew = Date.now() - Date.parse(data.user.created_at) < 5 * 60_000;
  await recordEvent({ userId: data.user.id, name: 'github_login_completed', properties: { new_user: isNew } });
  return NextResponse.redirect(new URL(next, appUrl));
}
