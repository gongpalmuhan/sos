import { describe, expect, it } from 'vitest';
import { validateReportOutput, type SuppliedSource } from '@/domain/report-validation';

const sources: SuppliedSource[] = [
  { ref: 'S1', source_id: 11, kind: 'issue', url: 'https://github.com/a/b/issues/1', title: 'Issue', content: 'The table is missing timeout.' },
  { ref: 'S2', source_id: 12, kind: 'contributing', url: 'https://github.com/a/b/blob/main/CONTRIBUTING.md', title: 'CONTRIBUTING', content: 'Run `pnpm   test` before opening a PR.' },
  { ref: 'S3', source_id: 13, kind: 'pull_request', url: 'https://github.com/a/b/pull/9', title: 'Old PR', content: 'Attempted fix, closed.' },
];

describe('validateReportOutput', () => {
  it('resolves URLs server-side and keeps sourced claims', () => {
    const v = validateReportOutput(
      {
        summary_items: [{ claim: 'Timeout is undocumented', kind: 'fact', source_ids: ['S1', 'S1'] }],
        related_work: [{ claim: 'A previous PR was closed', source_ids: ['S3'] }],
        contributing_steps: [{ stage: 'test', text: 'Run tests', command: 'pnpm test', source_ids: ['S2'] }],
        unknowns: ['Whether maintainers want a new table column'],
      },
      sources,
    );
    expect(v.insufficient).toBe(false);
    expect(v.dropped).toBe(0);
    expect(v.result.summary_items[0]?.sources).toEqual([{ source_id: 11, kind: 'issue', url: 'https://github.com/a/b/issues/1', title: 'Issue' }]);
    expect(v.result.contributing_steps[0]?.command).toBe('pnpm test');
  });

  it('drops claims with no/invalid sources and fabricated commands', () => {
    const v = validateReportOutput(
      {
        summary_items: [
          { claim: 'Maintainer approved this', kind: 'fact', source_ids: ['S9'] },
          { claim: 'No info about ETA', kind: 'unknown', source_ids: [] },
          { claim: 'Timeout is undocumented', kind: 'interpretation', source_ids: ['S1'] },
        ],
        related_work: [{ claim: 'x', source_ids: ['S42'] }],
        contributing_steps: [
          { stage: 'test', text: 'Run e2e', command: 'pnpm e2e', source_ids: ['S2'] },
          { stage: 'env', text: 'Use docker', command: null, source_ids: ['S1'] },
        ],
        unknowns: [],
      },
      sources,
    );
    expect(v.result.summary_items.map((i) => i.claim)).toEqual(['No info about ETA', 'Timeout is undocumented']);
    expect(v.result.related_work).toHaveLength(0);
    expect(v.result.contributing_steps).toHaveLength(0);
    expect(v.problems).toEqual(expect.arrayContaining(['unknown_source:S9', 'fabricated_command', 'step_without_rule_source']));
    expect(v.shouldRetry).toBe(true);
  });

  it('flags insufficient evidence when only unknowns remain', () => {
    const v = validateReportOutput(
      { summary_items: [{ claim: 'unclear', kind: 'unknown', source_ids: [] }], related_work: [], contributing_steps: [], unknowns: [] },
      sources,
    );
    expect(v.insufficient).toBe(true);
  });
});
