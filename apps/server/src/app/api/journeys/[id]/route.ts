import { patchJourneySchema } from '@sos/shared';
import { json, parseBody, parseUuidParam, route } from '@/lib/http';
import { requireAuth } from '@/lib/auth';
import { abandonJourney, getJourney } from '@/services/journeys';

export const GET = route<{ id: string }>(async (req, { id }) => json(await getJourney(await requireAuth(req), parseUuidParam(id))));

export const PATCH = route<{ id: string }>(async (req, { id }) => {
  const auth = await requireAuth(req);
  const body = await parseBody(req, patchJourneySchema);
  return json(await abandonJourney(auth, parseUuidParam(id), body.reason));
});
