import { linkPrSchema } from '@sos/shared';
import { json, parseBody, parseUuidParam, route } from '@/lib/http';
import { requireAuth } from '@/lib/auth';
import { linkPr } from '@/services/prs';

export const POST = route<{ id: string }>(async (req, { id }) => {
  const auth = await requireAuth(req);
  const { url } = await parseBody(req, linkPrSchema);
  const res = await linkPr(auth, parseUuidParam(id), url);
  return json(res, res.created ? 201 : 200);
});
