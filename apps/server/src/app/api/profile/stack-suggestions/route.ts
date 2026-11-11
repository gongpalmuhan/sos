import { json, route } from '@/lib/http';
import { requireAuth } from '@/lib/auth';
import { stackSuggestions } from '@/services/profile';

/** Optional public-profile inference; returns candidates with evidence, saves nothing. */
export const GET = route(async (req) => json({ items: await stackSuggestions(await requireAuth(req)), saved: false }));
