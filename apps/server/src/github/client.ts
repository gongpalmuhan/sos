import { Octokit } from 'octokit';
import { env } from '@/lib/env';
import { logWarn } from '@/lib/log';

let client: Octokit | undefined;

/**
 * Operator-token Octokit (read-only fine-grained token, public data only).
 * Built-in throttling + retry plugins follow GitHub's retry-after / x-ratelimit-reset.
 */
export function gh(): Octokit {
  if (!client) {
    client = new Octokit({
      auth: env().GITHUB_TOKEN,
      userAgent: 'sos-server',
      throttle: {
        onRateLimit: (retryAfter: number, options: { method: string; url: string }, _o: unknown, retryCount: number) => {
          logWarn('github_rate_limited', { retryAfter, url: options.url, retryCount });
          return retryCount < 2 && retryAfter <= 120;
        },
        onSecondaryRateLimit: (retryAfter: number, options: { method: string; url: string }, _o: unknown, retryCount: number) => {
          logWarn('github_secondary_rate_limited', { retryAfter, url: options.url, retryCount });
          return retryCount < 1 && retryAfter <= 120;
        },
      },
      retry: { doNotRetry: [400, 401, 403, 404, 410, 422, 451] },
    });
  }
  return client;
}

export type GitHubErrorKind = 'not_found' | 'rate_limited' | 'forbidden' | 'unavailable';

export class GitHubError extends Error {
  constructor(
    public readonly kind: GitHubErrorKind,
    public readonly status: number | undefined,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/** Normalize Octokit errors into 404 / 403 / 429 / other. */
export function toGitHubError(err: unknown): GitHubError {
  if (err instanceof GitHubError) return err;
  const e = err as { status?: number; message?: string; response?: { headers?: Record<string, string> } };
  const status = e?.status;
  const headers = e?.response?.headers ?? {};
  const retryAfter = Number(headers['retry-after']) || undefined;
  const reset = Number(headers['x-ratelimit-reset']);
  const remaining = headers['x-ratelimit-remaining'];
  const msg = (e?.message ?? 'GitHub request failed').slice(0, 200);
  if (status === 404 || status === 410 || status === 451) return new GitHubError('not_found', status, msg);
  if (status === 429 || (status === 403 && (remaining === '0' || retryAfter))) {
    const wait = retryAfter ?? (reset ? Math.max(1, reset - Math.floor(Date.now() / 1000)) : 60);
    return new GitHubError('rate_limited', status, msg, wait);
  }
  if (status === 403) return new GitHubError('forbidden', status, msg);
  return new GitHubError('unavailable', status, msg);
}

export async function ghCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toGitHubError(err);
  }
}
