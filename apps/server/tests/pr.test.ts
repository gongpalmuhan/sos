import { describe, expect, it } from 'vitest';
import { parsePrUrl, derivePrStatus, checkPrOwnership, secondsUntilRefreshAllowed } from '@/domain/pr';

describe('parsePrUrl', () => {
  it('accepts canonical PR urls', () => {
    expect(parsePrUrl('https://github.com/acme/widget/pull/42')).toEqual({ owner: 'acme', repo: 'widget', number: 42 });
    expect(parsePrUrl('https://github.com/acme/widget.js/pull/7/files')).toEqual({ owner: 'acme', repo: 'widget.js', number: 7 });
  });
  it.each([
    'http://github.com/acme/widget/pull/42',
    'https://gitlab.com/acme/widget/pull/42',
    'https://github.com.evil.io/acme/widget/pull/42',
    'https://user:pw@github.com/acme/widget/pull/42',
    'https://github.com/acme/widget/issues/42',
    'https://github.com/acme/widget/pull/0',
    'https://github.com/acme/widget/pull/abc',
    'https://github.com/acme/widget/pull/',
    'not a url',
  ])('rejects %s', (u) => expect(parsePrUrl(u)).toBeNull());
});

describe('derivePrStatus', () => {
  it('uses merged_at for merged; never infers merged from closed', () => {
    expect(derivePrStatus({ state: 'closed', merged_at: '2026-11-01T00:00:00Z' })).toBe('merged');
    expect(derivePrStatus({ state: 'closed', merged_at: null })).toBe('closed_without_merge');
    expect(derivePrStatus({ state: 'open', merged_at: null })).toBe('open');
  });
});

describe('checkPrOwnership', () => {
  const ok = { prAuthorId: 7, prBaseRepoId: 100, userGithubId: 7, journeyRepoGithubId: 100 };
  it('passes when author and repo match', () => expect(checkPrOwnership(ok)).toBeNull());
  it('blocks other authors', () => expect(checkPrOwnership({ ...ok, prAuthorId: 8 })).toBe('not_author'));
  it('blocks other repos (e.g. PR on a fork)', () => expect(checkPrOwnership({ ...ok, prBaseRepoId: 101 })).toBe('wrong_repository'));
  it('requires a GitHub identity', () => expect(checkPrOwnership({ ...ok, userGithubId: null })).toBe('no_github_identity'));
});

describe('refresh throttle', () => {
  const now = new Date('2026-11-11T00:01:00Z');
  it('enforces 60s', () => {
    expect(secondsUntilRefreshAllowed(null, now, 60)).toBe(0);
    expect(secondsUntilRefreshAllowed('2026-11-11T00:00:30Z', now, 60)).toBe(30);
    expect(secondsUntilRefreshAllowed('2026-11-11T00:00:00Z', now, 60)).toBe(0);
  });
});
