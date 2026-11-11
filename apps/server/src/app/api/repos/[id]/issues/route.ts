import { maybe } from '@/lib/supabase';
import { issueListQuerySchema } from '@sos/shared';
import { json, parseIntParam, parseQuery, route } from '@/lib/http';
import { getAuth } from '@/lib/auth';
import { recommendIssues } from '@/services/repos';

/** Up to 5 rule-based recommendations. Uses the saved stacks when logged in (unless any_stack=true). */
export const GET = route<{ id: string }>(async (req, { id }) => {
  const q = parseQuery(req, issueListQuerySchema);
  let stacks: string[] = [];
  if (q.any_stack !== 'true') {
    const auth = await getAuth(req);
    if (auth) {
      const data = maybe(await auth.db.from('profiles').select('stacks').eq('user_id', auth.userId).maybeSingle(), 'route.ts:data');
      stacks = (data?.stacks as string[] | undefined) ?? [];
    }
  }
  return json(await recommendIssues(parseIntParam(id), { stacks, type: q.type }));
});
