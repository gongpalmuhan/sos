import { createReportSchema } from '@sos/shared';
import { json, parseBody, route } from '@/lib/http';
import { requireAuth } from '@/lib/auth';
import { requestReport } from '@/services/reports';

export const POST = route(async (req) => {
  const auth = await requireAuth(req);
  const { journey_id } = await parseBody(req, createReportSchema);
  const res = await requestReport(auth, journey_id);
  return json(res, res.reused ? 200 : 202);
});
