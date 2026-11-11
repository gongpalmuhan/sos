import { json, parseIntParam, route } from '@/lib/http';
import { getRepo } from '@/services/repos';

export const GET = route<{ id: string }>(async (_req, { id }) => json(await getRepo(parseIntParam(id))));
