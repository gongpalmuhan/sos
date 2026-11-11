import { reportRatingSchema } from '@sos/shared';
import { json, parseBody, parseUuidParam, route } from '@/lib/http';
import { requireAuth } from '@/lib/auth';
import { rateReport } from '@/services/events';

export const POST = route<{ id: string }>(async (req, { id }) => {
  const auth = await requireAuth(req);
  const body = await parseBody(req, reportRatingSchema);
  return json(await rateReport(auth, parseUuidParam(id), body.useful, body.error_reasons));
});
