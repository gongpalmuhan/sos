import type {
  ChecklistKind,
  ChecklistStage,
  ClaimKind,
  DraftType,
  ExperienceLevel,
  IssueEligibility,
  JourneyStatus,
  PrStatus,
  ReportStatus,
  SourceKind,
  TaskBurden,
  TaskType,
} from './constants';

/** Error envelope for every non-2xx response. */
export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export interface SourceLink {
  source_id: number;
  kind: SourceKind;
  url: string;
  title: string | null;
}

export interface Reason {
  code: string;
  /** Korean, human-readable. */
  message: string;
  source_url?: string;
}

export interface Profile {
  user_id: string;
  github_id: number | null;
  github_login: string | null;
  stacks: string[];
  experience_level: ExperienceLevel | null;
  interested_task_types: TaskType[];
  onboarding_confirmed_at: string | null;
  analytics_consent: boolean;
  public_inference_consent: boolean;
}

export interface StackSuggestion {
  stack: string;
  evidence: { repo: string; url: string; language: string }[];
}

export interface RepoSummary {
  id: number;
  full_name: string;
  html_url: string;
  description: string | null;
  primary_language: string | null;
  stack_tags: string[];
  license_spdx: string | null;
  approval_reason: string;
  contributing_url: string | null;
  signals: {
    last_commit_at: string | null;
    last_maintainer_activity_at: string | null;
    open_issues_count: number | null;
  };
  eligible_issue_count: number;
  last_checked_at: string | null;
}

export interface IssueRecommendation {
  id: number;
  number: number;
  title: string;
  html_url: string;
  labels: string[];
  task_type: TaskType;
  burden: TaskBurden;
  burden_reasons: Reason[];
  reasons: Reason[];
  cautions: Reason[];
  signal_count: number;
  github_updated_at: string | null;
  last_checked_at: string | null;
}

export interface IssueRecommendationList {
  repository_id: number;
  rule_version: string;
  items: IssueRecommendation[];
  /** Counts of non-recommended issues by eligibility, so exclusions are not hidden. */
  excluded_count: number;
  needs_review_count: number;
  stale_count: number;
  /** Set when the filter produced no results: suggestions for relaxing it. */
  empty_hint: string | null;
  checked_at: string | null;
}

export interface ChecklistItem {
  id: string;
  position: number;
  stage: ChecklistStage;
  kind: ChecklistKind;
  text: string;
  command: string | null;
  source_url: string | null;
  completed_at: string | null;
}

export interface LinkedPr {
  id: string;
  url: string;
  number: number;
  title: string | null;
  status: PrStatus;
  status_changed_at: string;
  merged_at: string | null;
  last_success_at: string;
  /** Present when the latest GitHub lookup failed. Status above is the last confirmed value. */
  fetch_error: string | null;
}

export interface Journey {
  id: string;
  status: JourneyStatus;
  issue: { id: number; number: number; title: string; html_url: string; eligibility: IssueEligibility };
  repository: { id: number; full_name: string; html_url: string };
  selected_at: string;
  abandoned_at: string | null;
  completed_at: string | null;
  progress: { completed: number; total: number };
  checklist: ChecklistItem[];
  linked_pr: LinkedPr | null;
  latest_report_id: string | null;
}

export interface ReportItem {
  claim: string;
  kind: ClaimKind;
  sources: SourceLink[];
}

export interface ReportResult {
  summary_items: ReportItem[];
  related_work: { claim: string; sources: SourceLink[] }[];
  contributing_steps: {
    stage: ChecklistStage;
    text: string;
    command: string | null;
    sources: SourceLink[];
  }[];
  unknowns: string[];
  retrieval: {
    issue_comments_fetched: number;
    issue_comments_total: number;
    comments_middle_omitted: boolean;
    chunks_used: number;
    searched_scope: string;
    checked_at: string;
  };
  dropped_items: number;
}

export interface Report {
  id: string;
  issue_id: number;
  status: ReportStatus;
  result: ReportResult | null;
  failure_reason: string | null;
  /** When insufficient_evidence: which parts could not be supported. */
  insufficient_items: string[] | null;
  delayed: boolean;
  created_at: string;
  completed_at: string | null;
}

export interface Draft {
  type: DraftType;
  body: string;
  sources: SourceLink[];
  editable: true;
  auto_posted: false;
  notice: string;
}

export interface ReviewInterpretation {
  pr_url: string;
  items: {
    comment_url: string;
    author_login: string | null;
    original: string;
    interpretation_ko: string;
    unclear_points: string[];
  }[];
  fetched_comments: number;
  total_comments: number;
}
