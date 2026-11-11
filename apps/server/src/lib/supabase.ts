import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { env } from './env';

let admin: SupabaseClient | undefined;

/**
 * Service-role client. Server-only: jobs and verified mutations through RPC.
 * Never expose to the browser bundle.
 */
export function adminDb(): SupabaseClient {
  if (!admin) {
    const e = env();
    admin = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return admin;
}

/** RLS-scoped client acting as the caller, from a bearer token. */
export function userDbFromToken(accessToken: string): SupabaseClient {
  const e = env();
  return createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/** RLS-scoped client using the Supabase SSR cookie session (same-site web app). */
export async function userDbFromCookies(): Promise<SupabaseClient> {
  const e = env();
  const store = await cookies();
  return createServerClient(e.NEXT_PUBLIC_SUPABASE_URL, e.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // called from a context where cookies are read-only; session refresh happens elsewhere
        }
      },
    },
  });
}

/** Unwrap a Supabase result or throw. */
export function must<T>(res: { data: T | null; error: { message: string; code?: string } | null }, what: string): T {
  if (res.error) throw Object.assign(new Error(`${what}: ${res.error.message}`), { code: res.error.code });
  if (res.data === null) throw new Error(`${what}: no data`);
  return res.data;
}

/** Unwrap a read that may legitimately return no row; throws on query errors (never treat failure as empty). */
export function maybe<R extends { data: unknown; error: { message: string; code?: string } | null }>(res: R, what: string): R['data'] | null {
  if (res.error) throw Object.assign(new Error(`${what}: ${res.error.message}`), { code: res.error.code });
  return res.data;
}

/** Unwrap a head/count query; throws on error instead of returning 0. */
export function countOf(res: { count: number | null; error: { message: string; code?: string } | null }, what: string): number {
  if (res.error) throw Object.assign(new Error(`${what}: ${res.error.message}`), { code: res.error.code });
  return res.count ?? 0;
}
