/**
 * Operator curation CLI (확정서 §8.1). Automated checks gather evidence; a human approves with a reason.
 *
 *   pnpm --filter @sos/server curate check <owner/name> [--stack react,node]
 *   pnpm --filter @sos/server curate approve <owner/name> --reason "..." [--by name] [--force]
 *   pnpm --filter @sos/server curate reject <owner/name> --reason "..."
 *   pnpm --filter @sos/server curate list
 *   pnpm --filter @sos/server curate flag <owner/name#123> <flag> <source_url> [note]
 *   pnpm --filter @sos/server curate labels <owner/name> <in_progress|paused|security|advanced|beginner|needs_review> <label,...>
 *   pnpm --filter @sos/server curate generation <on|off>
 */
import { adminDb, must, maybe } from '@/lib/supabase';
import { runCurationChecks } from '@/domain/curation';
import { evaluateIssue, type OperatorFlags } from '@/domain/recommendation';
import { fetchReadme, fetchRepo, readmeHasContributingSection } from '@/github/fetchers';
import { syncIssues, syncRepository } from '@/github/sync';
import type { IssueRow, RepositoryRow } from '@/services/rows';

const FLAGS: (keyof OperatorFlags)[] = ['expected_outcome_confirmed', 'in_progress', 'contribution_paused', 'core_redesign', 'security'];
const LABEL_KEYS = ['in_progress', 'paused', 'security', 'advanced', 'beginner', 'needs_review'];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function parseRepo(s: string | undefined): { owner: string; name: string } {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(s ?? '');
  if (!m) throw new Error('expected <owner/name>');
  return { owner: m[1]!, name: m[2]! };
}
async function loadRepo(owner: string, name: string): Promise<RepositoryRow> {
  const data = maybe(await adminDb().from('repositories').select('*').eq('owner', owner).eq('name', name).maybeSingle(), 'curate.ts:data');
  if (!data) throw new Error(`${owner}/${name} is not registered; run "check" first`);
  return data as RepositoryRow;
}

async function check(target: string | undefined) {
  const { owner, name } = parseRepo(target);
  const db = adminDb();
  const meta = await fetchRepo(owner, name);
  const stack = arg('stack')?.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const existing = maybe(await db.from('repositories').select('id, status').eq('github_id', meta.github_id).maybeSingle(), 'curate.ts:existing');
  const base = { github_id: meta.github_id, owner: meta.owner, name: meta.name, html_url: meta.html_url, primary_language: meta.primary_language, ...(stack ? { stack_tags: stack } : {}) };
  const repoId = existing
    ? (await db.from('repositories').update(base).eq('id', existing.id), existing.id as number)
    : (must(await db.from('repositories').insert({ ...base, status: 'candidate' }).select('id').single(), 'insert repo') as { id: number }).id;

  await syncRepository({ id: repoId, owner: meta.owner, name: meta.name });
  const repo = must(await db.from('repositories').select('*').eq('id', repoId).single(), 'repo') as RepositoryRow;
  const sync = await syncIssues(repo, { full: true });
  const readme = await fetchReadme(meta.owner, meta.name);

  const result = runCurationChecks({
    visibility: meta.visibility,
    archived: meta.archived,
    disabled: meta.disabled,
    license_spdx: meta.license_spdx,
    contributing_url: repo.contributing_url,
    readme_has_contributing_section: readmeHasContributingSection(readme?.content ?? null),
    primary_language: meta.primary_language,
    last_commit_at: repo.last_commit_at,
    last_maintainer_activity_at: repo.last_maintainer_activity_at,
    eligible_issue_count: sync.eligible,
  });
  await db.from('repositories').update({ curation_checks: { ...result, checked_at: new Date().toISOString() } }).eq('id', repoId);

  console.log(`\n${meta.owner}/${meta.name} (id=${repoId}, status=${existing?.status ?? 'candidate'})`);
  for (const c of result.checks) console.log(`  ${c.passed ? 'PASS' : 'FAIL'}  ${c.key.padEnd(24)} ${c.detail}`);
  console.log(`  issues synced: ${sync.issues}, eligible: ${sync.eligible}, indexed docs changed: ${sync.indexed}`);
  console.log(result.passed ? '\nAll automated checks passed. Review the eligible issues, then run "approve" with a written reason.' : '\nSome checks failed.');
}

async function setStatus(target: string | undefined, status: 'approved' | 'rejected') {
  const { owner, name } = parseRepo(target);
  const reason = arg('reason');
  if (!reason || reason.trim().length < 10) throw new Error('--reason (10+ chars, human-written) is required');
  const repo = await loadRepo(owner, name);
  const checks = (repo as unknown as { curation_checks?: { passed?: boolean } }).curation_checks;
  if (status === 'approved' && !checks?.passed && !process.argv.includes('--force')) {
    throw new Error('automated checks have not all passed; re-run "check" or use --force with a reason explaining why');
  }
  await adminDb()
    .from('repositories')
    .update({
      status,
      approval_reason: reason.trim(),
      approved_by: arg('by') ?? process.env.USER ?? 'operator',
      approved_at: status === 'approved' ? new Date().toISOString() : null,
    })
    .eq('id', repo.id);
  console.log(`${owner}/${name} → ${status}`);
}

async function list() {
  const data = maybe(await adminDb().from('repositories').select('id, owner, name, status, primary_language, stack_tags, last_synced_at, curation_checks').order('status').order('owner'), 'curate.ts:data');
  const rows = (data ?? []) as { id: number; owner: string; name: string; status: string; primary_language: string | null; stack_tags: string[]; last_synced_at: string | null; curation_checks: { passed?: boolean } }[];
  const approved = rows.filter((r) => r.status === 'approved');
  const by = (lang: string[]) => approved.filter((r) => r.primary_language && lang.includes(r.primary_language)).length;
  for (const r of rows)
    console.log(`${String(r.id).padStart(4)}  ${r.status.padEnd(9)} ${`${r.owner}/${r.name}`.padEnd(40)} ${(r.primary_language ?? '-').padEnd(11)} checks=${r.curation_checks?.passed ? 'pass' : 'fail/none'} synced=${r.last_synced_at ?? '-'}`);
  console.log(`\napproved: ${approved.length}/20 target (JS/TS ${by(['JavaScript', 'TypeScript'])}/10, Python ${by(['Python'])}/10)`);
}

async function flag(target: string | undefined, key: string | undefined, sourceUrl: string | undefined, note: string | undefined) {
  const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(target ?? '');
  if (!m) throw new Error('expected <owner/name#number>');
  if (!FLAGS.includes(key as keyof OperatorFlags)) throw new Error(`flag must be one of ${FLAGS.join(', ')}`);
  if (!sourceUrl || !/^https:\/\/github\.com\//.test(sourceUrl)) throw new Error('a GitHub source URL is required for every operator flag');
  const repo = await loadRepo(m[1]!, m[2]!);
  const db = adminDb();
  const issue = must(await db.from('issues').select('*').eq('repository_id', repo.id).eq('number', Number(m[3])).single(), 'issue') as IssueRow & { body_length: number };
  const flags: OperatorFlags = { ...issue.operator_flags, [key as keyof OperatorFlags]: { source_url: sourceUrl, ...(note ? { note } : {}) } };
  // Re-evaluate with the stored facts so the flag takes effect before the next sync.
  const ev = evaluateIssue(
    { title: issue.title, body: 'x'.repeat(issue.body_length ?? 0), html_url: issue.html_url, state: issue.state, locked: false, labels: issue.labels, assignee_logins: [], linked_open_prs: [], comments: [], operator_flags: flags },
    { contributing_url: repo.contributing_url, label_config: repo.label_config },
  );
  const stricter = issue.eligibility === 'excluded' ? 'excluded' : ev.eligibility;
  await db.from('issues').update({ operator_flags: flags, eligibility: stricter, signals: { ...issue.signals, expected_outcome_confirmed: Boolean(flags.expected_outcome_confirmed) } }).eq('id', issue.id);
  console.log(`flag ${key} set on ${target}; eligibility=${stricter} (full re-evaluation on next sync)`);
}

async function labels(target: string | undefined, key: string | undefined, csv: string | undefined) {
  const { owner, name } = parseRepo(target);
  if (!key || !LABEL_KEYS.includes(key)) throw new Error(`label group must be one of ${LABEL_KEYS.join(', ')}`);
  const repo = await loadRepo(owner, name);
  const list = (csv ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  await adminDb().from('repositories').update({ label_config: { ...repo.label_config, [key]: list } }).eq('id', repo.id);
  console.log(`${owner}/${name} label_config.${key} = ${JSON.stringify(list)} (applies on next issue sync)`);
}

async function generation(onOff: string | undefined) {
  if (onOff !== 'on' && onOff !== 'off') throw new Error('expected on|off');
  await adminDb().from('app_settings').upsert({ key: 'generation_enabled', value: onOff === 'on', updated_at: new Date().toISOString() });
  console.log(`AI generation ${onOff}`);
}

async function main() {
  const [cmd, a, b, c, d] = process.argv.slice(2).filter((x, i, all) => !x.startsWith('--') && !(i > 0 && all[i - 1]!.startsWith('--')));
  switch (cmd) {
    case 'check': return check(a);
    case 'approve': return setStatus(a, 'approved');
    case 'reject': return setStatus(a, 'rejected');
    case 'list': return list();
    case 'flag': return flag(a, b, c, d);
    case 'labels': return labels(a, b, c);
    case 'generation': return generation(a);
    default:
      console.log('commands: check | approve | reject | list | flag | labels | generation (see header of scripts/curate.ts)');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
