import type { PrStatus } from '@sos/shared';

export interface ParsedPrUrl {
  owner: string;
  repo: string;
  number: number;
}

const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

/** Accept only https://github.com/{owner}/{repo}/pull/{n}[/...] — no other hosts. */
export function parsePrUrl(input: string): ParsedPrUrl | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || (url.hostname !== 'github.com' && url.hostname !== 'www.github.com')) return null;
  if (url.username || url.password || url.port) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 4 || parts[2] !== 'pull') return null;
  const [owner, repo, , num] = parts as [string, string, string, string];
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) return null;
  if (!/^\d{1,9}$/.test(num)) return null;
  const number = Number(num);
  if (number <= 0) return null;
  return { owner, repo, number };
}

/** Derive the 3-state PR status. merged is decided by merged_at, never by state alone. */
export function derivePrStatus(pr: { state: string; merged_at: string | null; merged?: boolean | null }): PrStatus {
  if (pr.merged_at) return 'merged';
  if (pr.state === 'open') return 'open';
  return 'closed_without_merge';
}

export interface PrOwnershipInput {
  prAuthorId: number | null | undefined;
  prBaseRepoId: number;
  userGithubId: number | null;
  journeyRepoGithubId: number;
}

export type PrOwnershipError = 'no_github_identity' | 'not_author' | 'wrong_repository';

export function checkPrOwnership(i: PrOwnershipInput): PrOwnershipError | null {
  if (!i.userGithubId) return 'no_github_identity';
  if (!i.prAuthorId || i.prAuthorId !== i.userGithubId) return 'not_author';
  if (i.prBaseRepoId !== i.journeyRepoGithubId) return 'wrong_repository';
  return null;
}

export function secondsUntilRefreshAllowed(lastManual: string | null, now: Date, windowSeconds: number): number {
  if (!lastManual) return 0;
  const elapsed = (now.getTime() - Date.parse(lastManual)) / 1000;
  return elapsed >= windowSeconds ? 0 : Math.ceil(windowSeconds - elapsed);
}
