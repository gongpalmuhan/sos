import { NextResponse, type NextRequest } from 'next/server';

/**
 * CORS for the separate client app (apps/web). Only origins listed in CORS_ORIGINS are allowed.
 * /api/inngest is excluded (server-to-server, signed by Inngest).
 */
function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  const list = (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}

export function proxy(req: NextRequest) {
  const origin = allowedOrigin(req.headers.get('origin'));
  const headers: Record<string, string> = origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization,Content-Type',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      }
    : { Vary: 'Origin' };

  if (req.method === 'OPTIONS') return new NextResponse(null, { status: origin ? 204 : 403, headers });
  const res = NextResponse.next();
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

export const config = { matcher: ['/api/((?!inngest).*)'] };
