import type { StackSuggestion } from '@sos/shared';

const LANGUAGE_TO_STACK: Record<string, string> = {
  JavaScript: 'javascript',
  TypeScript: 'typescript',
  Python: 'python',
  'Jupyter Notebook': 'python',
};

/** Whether a repository matches any of the user's stacks. Empty user stacks match everything. */
export function matchesStack(userStacks: string[], repo: { primary_language: string | null; stack_tags: string[] }): boolean {
  if (userStacks.length === 0) return true;
  const repoTags = new Set(repo.stack_tags.map((t) => t.toLowerCase()));
  const lang = repo.primary_language ? LANGUAGE_TO_STACK[repo.primary_language] ?? repo.primary_language.toLowerCase() : null;
  if (lang) repoTags.add(lang);
  // TS and JS ecosystems overlap enough to be treated as one family for matching.
  if (repoTags.has('typescript')) repoTags.add('javascript');
  if (repoTags.has('javascript')) repoTags.add('typescript');
  return userStacks.some((s) => repoTags.has(s.toLowerCase()));
}

/** Stack candidates from public, non-fork repositories with evidence links (F2, optional). */
export function suggestStacks(
  repos: { full_name: string; html_url: string; language: string | null; fork: boolean; archived?: boolean }[],
  maxEvidence = 3,
): StackSuggestion[] {
  const map = new Map<string, StackSuggestion>();
  for (const r of repos) {
    if (r.fork || !r.language) continue;
    const stack = LANGUAGE_TO_STACK[r.language] ?? r.language.toLowerCase();
    const s = map.get(stack) ?? { stack, evidence: [] };
    if (s.evidence.length < maxEvidence) s.evidence.push({ repo: r.full_name, url: r.html_url, language: r.language });
    map.set(stack, s);
  }
  return [...map.values()].sort((a, b) => b.evidence.length - a.evidence.length || a.stack.localeCompare(b.stack));
}
