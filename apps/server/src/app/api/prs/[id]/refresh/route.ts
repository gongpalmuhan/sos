import { json, parseUuidParam, route } from '@/lib/http';
import { requireAuth } from '@/lib/auth';
import { refreshPr } from '@/services/prs';

export const POST = route<{ id: string }>(async (req, { id }) => json(await refreshPr(await requireAuth(req), parseUuidParam(id))));
