/**
 * Rule-based issue recommendation (확정서 §8.2 exclusion, §8.3 ordering).
 * Pure functions: evaluated at sync time and stored; ranked at request time.
 * No LLM involvement in eligibility or ordering.
 */
import type { IssueEligibility, Reason, TaskBurden, TaskType } from '@sos/shared';
import { LIMITS } from '@sos/shared';

export const RULE_VERSION = '2026-11-10.1';

const DAY = 24 * 60 * 60 * 1000;
export const MAINTAINER_RESPONSE_WINDOW_MS = 30 * DAY;
export const STALE_AFTER_MS = 1 * DAY;
export const MIN_BODY_CHARS = 80;

const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export interface LabelConfig {
  beginner?: string[];
  in_progress?: string[];
  paused?: string[];
  security?: string[];
  advanced?: string[];
  needs_review?: string[];
}

export const DEFAULT_LABELS: Required<LabelConfig> = {
  beginner: ['good first issue', 'good-first-issue', 'help wanted', 'help-wanted'],
  in_progress: ['in progress', 'in-progress', 'wip', 'work in progress', 'claimed', 'assigned'],
  paused: ['blocked', 'on hold', 'on-hold', 'wontfix', "won't fix", 'invalid', 'duplicate', 'stale', 'frozen'],
  security: ['security', 'vulnerability', 'cve'],
  advanced: ['breaking change', 'breaking-change', 'rfc', 'epic', 'architecture', 'migration', 'major', 'needs design', 'needs-design'],
  needs_review: ['needs triage', 'needs-triage', 'triage', 'needs discussion', 'needs-discussion', 'question', 'discussion'],
};

/** Operator-registered flags; each must reference the source that justifies it. */
export interface OperatorFlag {
  source_url: string;
  note?: string;
}
export interface OperatorFlags {
  expected_outcome_confirmed?: OperatorFlag;
  in_progress?: OperatorFlag;
  contribution_paused?: OperatorFlag;
  core_redesign?: OperatorFlag;
  security?: OperatorFlag;
}

export interface CommentFact {
  author_association: string;
  author_login: string | null;
  created_at: string;
  body: string;
  url: string;
}

export interface IssueFacts {
  title: string;
  body: string | null;
  html_url: string;
  state: string; // open | closed
  locked: boolean;
  labels: string[];
  assignee_logins: string[];
  linked_open_prs: number[];
  comments: CommentFact[];
  operator_flags: OperatorFlags;
}

export interface RepoFacts {
  contributing_url: string | null;
  label_config: LabelConfig;
}

export interface IssueSignals {
  beginner_label: boolean;
  expected_outcome_confirmed: boolean;
  contributing_guide: boolean;
  recent_maintainer_response: boolean;
}

export interface IssueEvaluation {
  eligibility: IssueEligibility;
  exclusion_reasons: Reason[];
  signals: IssueSignals;
  signal_count: number;
  task_type: TaskType;
  burden: TaskBurden;
  burden_reasons: Reason[];
  /** Possible work-in-progress claims in comments: shown as caution, not exclusion. */
  work_claim_signals: Reason[];
  last_maintainer_comment_at: string | null;
  rule_version: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}' -]+/gu, ' ').replace(/\s+/g, ' ').trim();

function labelsMatching(labels: string[], patterns: string[]): string[] {
  const pats = patterns.map(norm).filter(Boolean);
  return labels.filter((l) => {
    const n = norm(l);
    return pats.some((p) => n === p || n.includes(p));
  });
}

function mergedLabels(cfg: LabelConfig): Required<LabelConfig> {
  const out = { ...DEFAULT_LABELS };
  for (const key of Object.keys(DEFAULT_LABELS) as (keyof LabelConfig)[]) {
    const extra = cfg[key];
    if (extra?.length) out[key] = [...DEFAULT_LABELS[key], ...extra];
  }
  return out;
}

const SECURITY_TITLE_RE = /\b(security|vulnerab\w*|cve-\d{4}-\d+|xss|csrf|ssrf|rce|sql injection|exploit)\b/i;
const WORK_CLAIM_RE =
  /\b(i(?:'| a)m (?:currently )?working on (?:this|it)|i(?:'ll| will) (?:take|work on|pick up) (?:this|it)|can i (?:take|work on|pick up) (?:this|it)|(?:please )?assign (?:this |it )?(?:to )?me|i(?:'d| would) like to (?:work on|take) (?:this|it)|let me (?:take|work on) (?:this|it)|i(?:'ve| have) (?:started|opened) (?:working|a pr))\b/i;

export function classifyTaskType(labels: string[], title: string): TaskType {
  const all = [...labels.map(norm), norm(title)];
  const has = (re: RegExp) => labels.some((l) => re.test(norm(l)));
  if (has(/\b(docs?|documentation)\b/)) return 'docs';
  if (has(/\b(tests?|testing)\b/)) return 'test';
  if (has(/\b(bug|regression|defect)\b/)) return 'bug';
  if (has(/\b(feature|enhancement|feature request)\b/)) return 'feature';
  // Title prefixes like "docs:" are explicit conventions; anything else stays unknown.
  const t = all[all.length - 1] ?? '';
  if (/^docs?\b/.test(t)) return 'docs';
  if (/^tests?\b/.test(t)) return 'test';
  return 'unknown';
}

export function evaluateIssue(issue: IssueFacts, repo: RepoFacts, now: Date = new Date()): IssueEvaluation {
  const L = mergedLabels(repo.label_config ?? {});
  const flags = issue.operator_flags ?? {};
  const excluded: Reason[] = [];
  const review: Reason[] = [];

  // --- Exclusions (§8.2) -----------------------------------------------------
  if (issue.state !== 'open') excluded.push({ code: 'closed', message: '닫힌 이슈입니다.', source_url: issue.html_url });
  if (issue.locked) excluded.push({ code: 'locked', message: '대화가 잠긴 이슈입니다.', source_url: issue.html_url });
  if (issue.assignee_logins.length > 0)
    excluded.push({ code: 'assigned', message: `담당자가 지정되어 있습니다 (${issue.assignee_logins.join(', ')}).`, source_url: issue.html_url });
  if (issue.linked_open_prs.length > 0)
    excluded.push({ code: 'linked_open_pr', message: `연결된 열린 PR이 있습니다 (#${issue.linked_open_prs.join(', #')}).`, source_url: issue.html_url });

  const inProgress = labelsMatching(issue.labels, L.in_progress);
  if (inProgress.length) excluded.push({ code: 'in_progress_label', message: `진행 중 라벨: ${inProgress.join(', ')}`, source_url: issue.html_url });
  if (flags.in_progress) excluded.push({ code: 'in_progress_flag', message: '운영자가 진행 중으로 확인했습니다.', source_url: flags.in_progress.source_url });

  const paused = labelsMatching(issue.labels, L.paused);
  if (paused.length) excluded.push({ code: 'paused_label', message: `기여 중단·보류 라벨: ${paused.join(', ')}`, source_url: issue.html_url });
  if (flags.contribution_paused) excluded.push({ code: 'paused_flag', message: '운영자가 기여 중단 공지를 확인했습니다.', source_url: flags.contribution_paused.source_url });

  const security = labelsMatching(issue.labels, L.security);
  if (security.length || flags.security || SECURITY_TITLE_RE.test(issue.title))
    excluded.push({
      code: 'security',
      message: '보안 관련 이슈는 초보 추천에서 제외합니다.',
      source_url: flags.security?.source_url ?? issue.html_url,
    });

  const advanced = labelsMatching(issue.labels, L.advanced);
  if (advanced.length || flags.core_redesign)
    excluded.push({
      code: 'advanced_scope',
      message: '핵심 API 재설계·대규모 변경 신호가 있어 운영자 검토 전까지 제외합니다.',
      source_url: flags.core_redesign?.source_url ?? issue.html_url,
    });

  // --- Needs review ------------------------------------------------------------
  const bodyLen = (issue.body ?? '').replace(/<!--[\s\S]*?-->/g, '').trim().length;
  if (bodyLen < MIN_BODY_CHARS && !flags.expected_outcome_confirmed)
    review.push({ code: 'insufficient_description', message: '본문만으로 작업 목표를 설명하기 어렵습니다.', source_url: issue.html_url });
  const triage = labelsMatching(issue.labels, L.needs_review);
  if (triage.length) review.push({ code: 'triage_label', message: `논의·분류 중 라벨: ${triage.join(', ')}`, source_url: issue.html_url });

  // --- Signals (§8.3) ------------------------------------------------------------
  const maintainerComments = issue.comments
    .filter((c) => MAINTAINER_ASSOCIATIONS.has(c.author_association))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const lastMaintainer = maintainerComments[0]?.created_at ?? null;
  const signals: IssueSignals = {
    beginner_label: labelsMatching(issue.labels, L.beginner).length > 0,
    expected_outcome_confirmed: Boolean(flags.expected_outcome_confirmed),
    contributing_guide: Boolean(repo.contributing_url),
    recent_maintainer_response: lastMaintainer !== null && now.getTime() - Date.parse(lastMaintainer) <= MAINTAINER_RESPONSE_WINDOW_MS,
  };
  const signal_count = Object.values(signals).filter(Boolean).length;

  // --- Work-claim cautions ---------------------------------------------------------
  const work_claim_signals: Reason[] = issue.comments
    .filter((c) => !MAINTAINER_ASSOCIATIONS.has(c.author_association) && WORK_CLAIM_RE.test(c.body))
    .slice(-3)
    .map((c) => ({
      code: 'possible_work_claim',
      message: `${c.author_login ?? '다른 참여자'}의 댓글에 작업 의사로 보이는 표현이 있습니다. 진행 여부를 확인하세요.`,
      source_url: c.url,
    }));

  // --- Task type & burden ------------------------------------------------------------
  const task_type = classifyTaskType(issue.labels, issue.title);
  const burden_reasons: Reason[] = [];
  let burden: TaskBurden;
  const hardLabels = issue.labels.filter((l) => /\b(hard|complex|difficult|expert|advanced|difficulty: ?high)\b/.test(norm(l)));
  if (hardLabels.length) {
    burden = 'advanced';
    burden_reasons.push({ code: 'hard_label', message: `난이도 라벨: ${hardLabels.join(', ')}`, source_url: issue.html_url });
  } else if (signals.beginner_label && (signals.expected_outcome_confirmed || bodyLen >= MIN_BODY_CHARS) && work_claim_signals.length === 0) {
    burden = 'low_prerequisites';
    burden_reasons.push({ code: 'beginner_label', message: '메인테이너가 입문·도움 요청 라벨을 붙였습니다.', source_url: issue.html_url });
    if (task_type === 'docs' || task_type === 'test')
      burden_reasons.push({ code: 'task_type', message: `작업 유형이 ${task_type === 'docs' ? '문서' : '테스트'}입니다.`, source_url: issue.html_url });
  } else {
    burden = 'needs_confirmation';
    if (!signals.beginner_label) burden_reasons.push({ code: 'no_beginner_label', message: '입문 라벨이 없어 필요한 전제를 직접 확인해야 합니다.', source_url: issue.html_url });
    if (bodyLen < MIN_BODY_CHARS) burden_reasons.push({ code: 'short_description', message: '이슈 설명이 짧아 범위를 확인해야 합니다.', source_url: issue.html_url });
    if (work_claim_signals.length) burden_reasons.push({ code: 'work_claim', message: '다른 참여자의 작업 의사 표현이 있습니다.', source_url: work_claim_signals[0]?.source_url });
  }

  const eligibility: IssueEligibility = excluded.length ? 'excluded' : review.length ? 'needs_review' : 'eligible';

  return {
    eligibility,
    exclusion_reasons: excluded.length ? excluded : review,
    signals,
    signal_count,
    task_type,
    burden,
    burden_reasons,
    work_claim_signals,
    last_maintainer_comment_at: lastMaintainer,
    rule_version: RULE_VERSION,
  };
}

/** Human-readable recommendation reasons from stored signals. */
export function reasonsFromSignals(signals: IssueSignals, issueUrl: string, contributingUrl: string | null): Reason[] {
  const r: Reason[] = [];
  if (signals.beginner_label) r.push({ code: 'beginner_label', message: 'good first issue 또는 help wanted 라벨이 있습니다.', source_url: issueUrl });
  if (signals.expected_outcome_confirmed) r.push({ code: 'expected_outcome', message: '기대 결과가 본문에 명시되어 있음을 운영자가 확인했습니다.', source_url: issueUrl });
  if (signals.contributing_guide && contributingUrl) r.push({ code: 'contributing_guide', message: '기여 절차 문서가 있습니다.', source_url: contributingUrl });
  if (signals.recent_maintainer_response) r.push({ code: 'maintainer_response', message: '최근 30일 안에 협업자·관리자의 응답이 있습니다.', source_url: issueUrl });
  return r;
}

export interface RankableIssue {
  id: number;
  github_id: number;
  eligibility: IssueEligibility;
  signal_count: number;
  task_type: TaskType;
  github_updated_at: string | null;
  last_checked_at: string | null;
  last_check_error: string | null;
}

export function isStale(issue: Pick<RankableIssue, 'last_checked_at'>, now: Date = new Date()): boolean {
  if (!issue.last_checked_at) return true;
  return now.getTime() - Date.parse(issue.last_checked_at) > STALE_AFTER_MS;
}

/** Deterministic ordering: signal count desc → updated_at desc → GitHub id asc. */
export function compareIssues(a: RankableIssue, b: RankableIssue): number {
  if (b.signal_count !== a.signal_count) return b.signal_count - a.signal_count;
  const au = a.github_updated_at ? Date.parse(a.github_updated_at) : 0;
  const bu = b.github_updated_at ? Date.parse(b.github_updated_at) : 0;
  if (bu !== au) return bu - au;
  return a.github_id - b.github_id;
}

export interface RankResult<T> {
  items: T[];
  excluded_count: number;
  needs_review_count: number;
  stale_count: number;
}

export function rankIssues<T extends RankableIssue>(
  issues: T[],
  opts: { now?: Date; type?: TaskType; limit?: number } = {},
): RankResult<T> {
  const now = opts.now ?? new Date();
  let excluded_count = 0;
  let needs_review_count = 0;
  let stale_count = 0;
  const candidates: T[] = [];
  for (const i of issues) {
    if (i.eligibility === 'excluded') excluded_count++;
    else if (i.eligibility === 'needs_review') needs_review_count++;
    else if (isStale(i, now)) stale_count++;
    else if (!opts.type || i.task_type === opts.type) candidates.push(i);
  }
  candidates.sort(compareIssues);
  return {
    items: candidates.slice(0, opts.limit ?? LIMITS.maxRecommendations),
    excluded_count,
    needs_review_count,
    stale_count,
  };
}
