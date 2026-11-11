/**
 * Minimal structured logger. Never log tokens, draft/intent bodies, review text or emails
 * (확정서 §12: 오류·잡 로그는 비밀값·본문 제거).
 */
const REDACT_KEYS = /token|secret|key|authorization|password|body|intent|content|email|cookie/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

export function logInfo(event: string, data?: Record<string, unknown>) {
  console.log(JSON.stringify({ level: 'info', event, ...(redact(data ?? {}) as object) }));
}

export function logWarn(event: string, data?: Record<string, unknown>) {
  console.warn(JSON.stringify({ level: 'warn', event, ...(redact(data ?? {}) as object) }));
}

export function logError(event: string, err: unknown, data?: Record<string, unknown>) {
  const e = err instanceof Error ? { name: err.name, message: err.message.slice(0, 300) } : { message: String(err) };
  console.error(JSON.stringify({ level: 'error', event, error: e, ...(redact(data ?? {}) as object) }));
}
