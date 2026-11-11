import { checklistPatchSchema } from '@sos/shared';
import { json, parseBody, parseUuidParam, route } from '@/lib/http';
import { requireAuth } from '@/lib/auth';
import { setChecklistItem } from '@/services/journeys';

export const PATCH = route<{ id: string }>(async (req, { id }) => {
  const auth = await requireAuth(req);
  const { item_id, completed } = await parseBody(req, checklistPatchSchema);
  return json(await setChecklistItem(auth, parseUuidParam(id), item_id, completed));
});
