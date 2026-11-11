import { describe, expect, it } from 'vitest';
import { evaluateIssue, rankIssues, classifyTaskType, type IssueFacts, type RankableIssue } from '@/domain/recommendation';

const NOW = new Date('2026-11-11T00:00:00Z');
const longBody = 'The docs page for configuration is missing the `timeout` option. Expected: a new row in the table describing default and units.';

function issue(over: Partial<IssueFacts> = {}): IssueFacts {
  return {
    title: 'Document timeout option',
    body: longBody,
    html_url: 'https://github.com/acme/w/issues/1',
    state: 'open',
    locked: false,
    labels: ['good first issue', 'documentation'],
    assignee_logins: [],
    linked_open_prs: [],
    comments: [],
    operator_flags: {},
    ...over,
  };
}
const repo = { contributing_url: 'https://github.com/acme/w/blob/main/CONTRIBUTING.md', label_config: {} };

describe('evaluateIssue exclusions (§8.2)', () => {
  it('eligible beginner docs issue', () => {
    const e = evaluateIssue(issue(), repo, NOW);
    expect(e.eligibility).toBe('eligible');
    expect(e.task_type).toBe('docs');
    expect(e.burden).toBe('low_prerequisites');
    expect(e.signals.beginner_label).toBe(true);
    expect(e.signals.contributing_guide).toBe(true);
  });

  it.each([
    ['closed', { state: 'closed' }],
    ['locked', { locked: true }],
    ['assigned', { assignee_logins: ['bob'] }],
    ['linked_open_pr', { linked_open_prs: [42] }],
    ['in_progress_label', { labels: ['good first issue', 'status: in progress'] }],
    ['paused_label', { labels: ['wontfix'] }],
    ['security', { title: 'XSS in markdown renderer' }],
    ['security', { labels: ['security'] }],
    ['advanced_scope', { labels: ['RFC'] }],
    ['in_progress_flag', { operator_flags: { in_progress: { source_url: 'https://github.com/acme/w/issues/1#c1' } } }],
  ] as [string, Partial<IssueFacts>][])('excludes %s', (code, over) => {
    const e = evaluateIssue(issue(over), repo, NOW);
    expect(e.eligibility).toBe('excluded');
    expect(e.exclusion_reasons.map((r) => r.code)).toContain(code);
    for (const r of e.exclusion_reasons) expect(r.source_url).toBeTruthy();
  });

  it('short body → needs_review, unless operator confirmed expected outcome', () => {
    expect(evaluateIssue(issue({ body: 'fix it' }), repo, NOW).eligibility).toBe('needs_review');
    const confirmed = evaluateIssue(
      issue({ body: 'fix it', operator_flags: { expected_outcome_confirmed: { source_url: 'https://x/1' } } }),
      repo,
      NOW,
    );
    expect(confirmed.eligibility).toBe('eligible');
    expect(confirmed.signals.expected_outcome_confirmed).toBe(true);
  });

  it('work-claim comment is a caution, not an exclusion, and does not assume unclaimed', () => {
    const e = evaluateIssue(
      issue({ comments: [{ author_association: 'NONE', author_login: 'carol', created_at: '2026-11-01T00:00:00Z', body: "Hi, I'm working on this!", url: 'https://github.com/acme/w/issues/1#c2' }] }),
      repo,
      NOW,
    );
    expect(e.eligibility).toBe('eligible');
    expect(e.work_claim_signals).toHaveLength(1);
    expect(e.burden).toBe('needs_confirmation');
  });

  it('maintainer response within 30 days is a signal; older is not', () => {
    const recent = evaluateIssue(issue({ comments: [{ author_association: 'MEMBER', author_login: 'm', created_at: '2026-10-20T00:00:00Z', body: 'PR welcome', url: 'u' }] }), repo, NOW);
    const old = evaluateIssue(issue({ comments: [{ author_association: 'OWNER', author_login: 'm', created_at: '2026-09-01T00:00:00Z', body: 'PR welcome', url: 'u' }] }), repo, NOW);
    expect(recent.signals.recent_maintainer_response).toBe(true);
    expect(old.signals.recent_maintainer_response).toBe(false);
    expect(recent.signal_count).toBe(old.signal_count + 1);
  });

  it('repo label config extends defaults', () => {
    const e = evaluateIssue(issue({ labels: ['good first issue', 'taken'] }), { ...repo, label_config: { in_progress: ['taken'] } }, NOW);
    expect(e.eligibility).toBe('excluded');
  });
});

describe('classifyTaskType', () => {
  it('maps labels, falls back to unknown', () => {
    expect(classifyTaskType(['type: bug'], 'x')).toBe('bug');
    expect(classifyTaskType(['tests'], 'x')).toBe('test');
    expect(classifyTaskType(['enhancement'], 'x')).toBe('feature');
    expect(classifyTaskType([], 'docs: fix typo')).toBe('docs');
    expect(classifyTaskType([], 'Something odd')).toBe('unknown');
  });
});

describe('rankIssues (§8.3)', () => {
  const base = (over: Partial<RankableIssue>): RankableIssue => ({
    id: 1, github_id: 1, eligibility: 'eligible', signal_count: 1, task_type: 'docs',
    github_updated_at: '2026-11-01T00:00:00Z', last_checked_at: '2026-11-10T12:00:00Z', last_check_error: null, ...over,
  });

  it('sorts by signals desc, updated desc, github id asc; caps at 5', () => {
    const list = [
      base({ id: 1, github_id: 30, signal_count: 1 }),
      base({ id: 2, github_id: 20, signal_count: 3 }),
      base({ id: 3, github_id: 10, signal_count: 3, github_updated_at: '2026-11-05T00:00:00Z' }),
      base({ id: 4, github_id: 5, signal_count: 3 }),
      ...[5, 6, 7].map((id) => base({ id, github_id: 100 + id })),
    ];
    const r = rankIssues(list, { now: NOW });
    expect(r.items.map((i) => i.id)).toEqual([3, 4, 2, 1, 5]);
  });

  it('separates excluded, needs_review and stale (>24h unchecked) from recommendations', () => {
    const r = rankIssues(
      [
        base({ id: 1, eligibility: 'excluded' }),
        base({ id: 2, eligibility: 'needs_review' }),
        base({ id: 3, last_checked_at: '2026-11-09T00:00:00Z' }),
        base({ id: 4, last_checked_at: null }),
        base({ id: 5 }),
      ],
      { now: NOW },
    );
    expect(r.items.map((i) => i.id)).toEqual([5]);
    expect([r.excluded_count, r.needs_review_count, r.stale_count]).toEqual([1, 1, 2]);
  });

  it('returns the actual count when fewer than 5; empty when none', () => {
    expect(rankIssues([base({})], { now: NOW }).items).toHaveLength(1);
    expect(rankIssues([], { now: NOW }).items).toHaveLength(0);
    expect(rankIssues([base({ task_type: 'bug' })], { now: NOW, type: 'docs' }).items).toHaveLength(0);
  });
});
