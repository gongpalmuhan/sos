/** Row shapes for the tables we read (subset of columns). Kept in sync with supabase/migrations. */
import type { IssueEligibility, JourneyStatus, PrStatus, ReportStatus, SourceKind, TaskBurden, TaskType } from '@sos/shared';
import type { IssueSignals, LabelConfig, OperatorFlags } from '@/domain/recommendation';

export interface RepositoryRow {
  id: number;
  github_id: number;
  owner: string;
  name: string;
  html_url: string;
  description: string | null;
  primary_language: string | null;
  stack_tags: string[];
  license_spdx: string | null;
  default_branch: string | null;
  status: 'candidate' | 'approved' | 'rejected' | 'retired';
  approval_reason: string | null;
  contributing_url: string | null;
  label_config: LabelConfig;
  last_commit_at: string | null;
  last_maintainer_activity_at: string | null;
  open_issues_count: number | null;
  last_synced_at: string | null;
  issues_synced_at: string | null;
}

export interface IssueRow {
  id: number;
  github_id: number;
  repository_id: number;
  number: number;
  title: string;
  html_url: string;
  state: string;
  labels: string[];
  eligibility: IssueEligibility;
  exclusion_reasons: { code: string; message: string; source_url?: string }[];
  signals: Partial<IssueSignals>;
  signal_count: number;
  task_type: TaskType;
  burden: TaskBurden;
  burden_reasons: { code: string; message: string; source_url?: string }[];
  work_claim_signals: { code: string; message: string; source_url?: string }[];
  operator_flags: OperatorFlags;
  last_maintainer_comment_at: string | null;
  comments_count: number;
  rule_version: string | null;
  github_updated_at: string | null;
  last_checked_at: string | null;
  last_check_error: string | null;
}

export interface SourceDocumentRow {
  id: number;
  repository_id: number;
  issue_id: number | null;
  kind: SourceKind;
  github_ref: string;
  url: string;
  title: string | null;
  content: string;
  content_hash: string;
  truncated: boolean;
  fetched_at: string;
}

export interface JourneyRow {
  id: string;
  user_id: string;
  issue_id: number;
  repository_id: number;
  status: JourneyStatus;
  selected_at: string;
  abandoned_at: string | null;
  completed_at: string | null;
}

export interface LinkedPrRow {
  id: string;
  journey_id: string;
  user_id: string;
  github_pr_id: number;
  github_repo_id: number;
  number: number;
  url: string;
  title: string | null;
  status: PrStatus;
  status_changed_at: string;
  merged_at: string | null;
  fetch_error: string | null;
  last_success_at: string;
  last_manual_refresh_at: string | null;
}

export interface ReportRow {
  id: string;
  issue_id: number;
  cache_key: string;
  status: ReportStatus;
  result: unknown;
  failure_reason: string | null;
  insufficient_items: string[] | null;
  created_at: string;
  job_started_at: string | null;
  completed_at: string | null;
  requested_by: string | null;
}
