import { route, json } from '@/lib/http';
import { requireAuth } from '@/lib/auth';

export const POST = route(async (req) => {
  const auth = await requireAuth(req);
  await auth.db.auth.signOut({ scope: 'local' });
  return json({ signed_out: true });
});
