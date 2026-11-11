import { json, route } from '@/lib/http';
import { requireAuth } from '@/lib/auth';
import { requestAccountDeletion } from '@/services/account';

export const DELETE = route(async (req) => json(await requestAccountDeletion(await requireAuth(req)), 202));
