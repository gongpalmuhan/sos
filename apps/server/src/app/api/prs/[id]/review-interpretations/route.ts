import { json, parseUuidParam, route } from '@/lib/http';
import { requireAuth } from '@/lib/auth';
import { interpretReviews } from '@/services/prs';

export const POST = route<{ id: string }>(async (req, { id }) => json(await interpretReviews(await requireAuth(req), parseUuidParam(id))));
