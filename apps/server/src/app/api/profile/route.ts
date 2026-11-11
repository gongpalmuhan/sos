import { profileUpdateSchema } from '@sos/shared';
import { json, parseBody, route } from '@/lib/http';
import { requireAuth } from '@/lib/auth';
import { getProfile, updateProfile } from '@/services/profile';

export const GET = route(async (req) => json(await getProfile(await requireAuth(req))));

export const PUT = route(async (req) => {
  const auth = await requireAuth(req);
  return json(await updateProfile(auth, await parseBody(req, profileUpdateSchema)));
});
