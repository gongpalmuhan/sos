import type { NextRequest } from 'next/server';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { userDbFromCookies, userDbFromToken } from './supabase';
import { unauthorized } from './http';

export interface AuthContext {
  user: User;
  userId: string;
  /** GitHub numeric user id from the OAuth identity (F8 author check). */
  githubId: number | null;
  /** RLS-scoped DB client acting as the user. */
  db: SupabaseClient;
}

function bearer(req: NextRequest): string | null {
  const h = req.headers.get('authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1] ?? null;
}

export function githubIdOf(user: User): number | null {
  const identity = user.identities?.find((i) => i.provider === 'github');
  const raw = identity?.id ?? (user.user_metadata?.provider_id as string | undefined);
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export async function getAuth(req: NextRequest): Promise<AuthContext | null> {
  const token = bearer(req);
  const db = token ? userDbFromToken(token) : await userDbFromCookies();
  // getUser() validates the JWT with the auth server (do not trust unverified session data).
  const { data, error } = token ? await db.auth.getUser(token) : await db.auth.getUser();
  if (error || !data.user) return null;
  return { user: data.user, userId: data.user.id, githubId: githubIdOf(data.user), db };
}

export async function requireAuth(req: NextRequest): Promise<AuthContext> {
  const ctx = await getAuth(req);
  if (!ctx) throw unauthorized();
  return ctx;
}
