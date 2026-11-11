import { createJourneySchema } from '@sos/shared';
import { json, parseBody, route } from '@/lib/http';
import { requireAuth } from '@/lib/auth';
import { createJourney, listJourneys } from '@/services/journeys';

export const GET = route(async (req) => json({ items: await listJourneys(await requireAuth(req)) }));

export const POST = route(async (req) => {
  const auth = await requireAuth(req);
  const { issue_id } = await parseBody(req, createJourneySchema);
  const res = await createJourney(auth, issue_id);
  return json(res, res.created ? 201 : 200);
});
