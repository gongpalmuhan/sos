import { createDraftSchema } from '@sos/shared';
import { json, parseBody, route } from '@/lib/http';
import { requireAuth } from '@/lib/auth';
import { createDraft } from '@/services/drafts';

export const POST = route(async (req) => {
  const auth = await requireAuth(req);
  return json(await createDraft(auth, await parseBody(req, createDraftSchema)));
});
