import { json } from '@/lib/http';

export const dynamic = 'force-dynamic';

export function GET() {
  return json({ ok: true, service: 'sos-server', time: new Date().toISOString() });
}
