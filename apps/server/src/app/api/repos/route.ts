import { repoListQuerySchema } from '@sos/shared';
import { json, parseQuery, route } from '@/lib/http';
import { listRepos } from '@/services/repos';

/** Public: approved repositories (logged-out browsing is allowed). */
export const GET = route(async (req) => {
  const q = parseQuery(req, repoListQuerySchema);
  const stacks = q.stack ? q.stack.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
  return json(await listRepos({ stacks, language: q.language }));
});
