import { json, parseUuidParam, route } from '@/lib/http';
import { requireAuth } from '@/lib/auth';
import { getReport } from '@/services/reports';

export const GET = route<{ id: string }>(async (req, { id }) => {
  await requireAuth(req);
  return json(await getReport(parseUuidParam(id)));
});
