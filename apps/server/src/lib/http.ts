import { NextResponse, type NextRequest } from 'next/server';
import type { z } from 'zod';
import type { ApiError } from '@sos/shared';
import { logError } from './log';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'bad_request', message, details);
export const unauthorized = () => new HttpError(401, 'unauthorized', '로그인이 필요합니다.');
export const forbidden = (message = '권한이 없습니다.') => new HttpError(403, 'forbidden', message);
export const notFound = (what = 'resource') => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new HttpError(409, code, message, details);
export const tooMany = (code: string, message: string, retryAfterSeconds?: number) =>
  new HttpError(429, code, message, retryAfterSeconds ? { retry_after_seconds: retryAfterSeconds } : undefined);
export const unavailable = (code: string, message: string) => new HttpError(503, code, message);

export function json<T>(data: T, init?: number | ResponseInit): NextResponse<T> {
  return NextResponse.json(data, typeof init === 'number' ? { status: init } : init);
}

function errorResponse(err: unknown): NextResponse<ApiError> {
  if (err instanceof HttpError) {
    const headers: Record<string, string> = {};
    const retry = (err.details as { retry_after_seconds?: number } | undefined)?.retry_after_seconds;
    if (retry) headers['Retry-After'] = String(retry);
    return NextResponse.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      { status: err.status, headers },
    );
  }
  logError('unhandled_route_error', err);
  return NextResponse.json(
    { error: { code: 'internal_error', message: '요청을 처리하지 못했습니다.' } },
    { status: 500 },
  );
}

type Ctx<P> = { params: Promise<P> };

/** Wrap a route handler with uniform error handling. */
export function route<P = Record<string, never>>(
  handler: (req: NextRequest, params: P) => Promise<Response>,
) {
  return async (req: NextRequest, ctx: Ctx<P>) => {
    try {
      return await handler(req, (await ctx?.params) ?? ({} as P));
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw badRequest('JSON 본문이 필요합니다.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw badRequest('요청 값이 올바르지 않습니다.', parsed.error.issues);
  return parsed.data;
}

export function parseQuery<S extends z.ZodType>(req: NextRequest, schema: S): z.infer<S> {
  const parsed = schema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) throw badRequest('쿼리 값이 올바르지 않습니다.', parsed.error.issues);
  return parsed.data;
}

export function parseIntParam(value: string, name = 'id'): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw badRequest(`${name}가 올바르지 않습니다.`);
  return n;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseUuidParam(value: string, name = 'id'): string {
  if (!UUID_RE.test(value)) throw badRequest(`${name}가 올바르지 않습니다.`);
  return value;
}

/** Map Postgres RPC exceptions raised by our functions to HTTP errors. */
export function mapRpcError(error: { code?: string; message: string }): HttpError {
  const msg = error.message;
  if (error.code === 'P0002') return notFound(msg.replace(/_not_found$/, ''));
  if (error.code === 'P0001') return conflict(msg.split(':')[0] ?? 'conflict', msg);
  if (error.code === '23505') return conflict('duplicate', '이미 존재합니다.');
  return new HttpError(500, 'db_error', '데이터 처리 중 오류가 발생했습니다.');
}
