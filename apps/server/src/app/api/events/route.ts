import { clientEventSchema } from '@sos/shared';
import { json, parseBody, route } from '@/lib/http';
import { requireAuth } from '@/lib/auth';
import { recordClientEvent } from '@/services/events';

export const POST = route(async (req) => {
  const auth = await requireAuth(req);
  return json(await recordClientEvent(auth, await parseBody(req, clientEventSchema)), 202);
});
