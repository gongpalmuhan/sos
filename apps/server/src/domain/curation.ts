/**
 * Initial curation checks (확정서 §8.1). Automated checks produce evidence;
 * a human operator must still approve with a written reason.
 */
const DAY = 24 * 60 * 60 * 1000;
export const COMMIT_WINDOW_DAYS = 180;
export const MAINTAINER_WINDOW_DAYS = 90;
export const ALLOWED_LANGUAGES = ['JavaScript', 'TypeScript', 'Python'];

export interface CurationFacts {
  visibility: 'public' | 'private' | string;
  archived: boolean;
  disabled: boolean;
  license_spdx: string | null;
  contributing_url: string | null;
  readme_has_contributing_section: boolean;
  primary_language: string | null;
  last_commit_at: string | null;
  last_maintainer_activity_at: string | null;
  eligible_issue_count: number;
}

export interface CurationCheck {
  key: string;
  passed: boolean;
  detail: string;
}

export function runCurationChecks(f: CurationFacts, now: Date = new Date()): { passed: boolean; checks: CurationCheck[] } {
  const within = (iso: string | null, days: number) => iso !== null && now.getTime() - Date.parse(iso) <= days * DAY;
  const checks: CurationCheck[] = [
    { key: 'public_active', passed: f.visibility === 'public' && !f.archived && !f.disabled, detail: `visibility=${f.visibility}, archived=${f.archived}, disabled=${f.disabled}` },
    { key: 'license', passed: Boolean(f.license_spdx && f.license_spdx !== 'NOASSERTION'), detail: `license=${f.license_spdx ?? 'none'}` },
    { key: 'contribution_guide', passed: Boolean(f.contributing_url) || f.readme_has_contributing_section, detail: f.contributing_url ?? (f.readme_has_contributing_section ? 'README contributing section' : 'none') },
    { key: 'recent_commit_180d', passed: within(f.last_commit_at, COMMIT_WINDOW_DAYS), detail: `last_commit_at=${f.last_commit_at ?? 'unknown'}` },
    { key: 'maintainer_activity_90d', passed: within(f.last_maintainer_activity_at, MAINTAINER_WINDOW_DAYS), detail: `last_maintainer_activity_at=${f.last_maintainer_activity_at ?? 'unknown'}` },
    { key: 'has_eligible_issue', passed: f.eligible_issue_count >= 1, detail: `eligible_issues=${f.eligible_issue_count}` },
    { key: 'language_scope', passed: f.primary_language !== null && ALLOWED_LANGUAGES.includes(f.primary_language), detail: `language=${f.primary_language ?? 'unknown'}` },
  ];
  return { passed: checks.every((c) => c.passed), checks };
}
