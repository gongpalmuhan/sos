import { describe, expect, it } from 'vitest';
import { chunkText, rrfFuse, headTail, clampTokens, estimateTokens } from '@/domain/text';
import { runCurationChecks } from '@/domain/curation';
import { matchesStack, suggestStacks } from '@/domain/stack';

describe('chunkText', () => {
  it('splits long text with overlap and bounded size', () => {
    const para = 'word '.repeat(400).trim();
    const text = Array.from({ length: 10 }, () => para).join('\n\n');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(estimateTokens(c.content)).toBeLessThanOrEqual(800);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });
  it('marks truncation when capped', () => {
    const chunks = chunkText('x'.repeat(100_000), { maxChunks: 3 });
    expect(chunks).toHaveLength(3);
    expect(chunks[2]?.truncated).toBe(true);
  });
  it('empty → no chunks', () => expect(chunkText('   ')).toEqual([]));
});

describe('rrfFuse', () => {
  it('rewards items present in both lists', () => {
    const fused = rrfFuse([[1, 2, 3], [3, 4]]);
    expect(fused[0]?.id).toBe(3);
  });
});

describe('headTail', () => {
  it('keeps first 20 and last 80 and flags omission', () => {
    const r = headTail(Array.from({ length: 150 }, (_, i) => i));
    expect(r.items).toHaveLength(100);
    expect(r.items[19]).toBe(19);
    expect(r.items[20]).toBe(70);
    expect(r.middleOmitted).toBe(true);
    expect(headTail([1, 2]).middleOmitted).toBe(false);
  });
});

describe('clampTokens', () => {
  it('cuts to budget', () => {
    const r = clampTokens('a'.repeat(4000), 100);
    expect(r.truncated).toBe(true);
    expect(estimateTokens(r.text)).toBeLessThanOrEqual(100);
  });
});

describe('curation checks (§8.1)', () => {
  const now = new Date('2026-11-11T00:00:00Z');
  const good = {
    visibility: 'public', archived: false, disabled: false, license_spdx: 'MIT',
    contributing_url: 'https://x/CONTRIBUTING.md', readme_has_contributing_section: false, primary_language: 'TypeScript',
    last_commit_at: '2026-10-01T00:00:00Z', last_maintainer_activity_at: '2026-10-15T00:00:00Z', eligible_issue_count: 2,
  };
  it('passes a healthy repo', () => expect(runCurationChecks(good, now).passed).toBe(true));
  it('fails archived / old / out-of-scope language', () => {
    expect(runCurationChecks({ ...good, archived: true }, now).passed).toBe(false);
    expect(runCurationChecks({ ...good, last_commit_at: '2026-01-01T00:00:00Z' }, now).passed).toBe(false);
    expect(runCurationChecks({ ...good, primary_language: 'Rust' }, now).passed).toBe(false);
    expect(runCurationChecks({ ...good, license_spdx: null }, now).passed).toBe(false);
  });
});

describe('stack', () => {
  it('matches by language and tags, JS/TS family', () => {
    expect(matchesStack(['javascript'], { primary_language: 'TypeScript', stack_tags: [] })).toBe(true);
    expect(matchesStack(['django'], { primary_language: 'Python', stack_tags: ['django'] })).toBe(true);
    expect(matchesStack(['python'], { primary_language: 'TypeScript', stack_tags: ['react'] })).toBe(false);
    expect(matchesStack([], { primary_language: 'Go', stack_tags: [] })).toBe(true);
  });
  it('suggests from non-fork repos with evidence', () => {
    const s = suggestStacks([
      { full_name: 'u/a', html_url: 'https://github.com/u/a', language: 'Python', fork: false },
      { full_name: 'u/b', html_url: 'https://github.com/u/b', language: 'Python', fork: false },
      { full_name: 'u/c', html_url: 'https://github.com/u/c', language: 'TypeScript', fork: true },
    ]);
    expect(s).toEqual([{ stack: 'python', evidence: [expect.objectContaining({ repo: 'u/a' }), expect.objectContaining({ repo: 'u/b' })] }]);
  });
});
