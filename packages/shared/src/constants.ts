/** Enumerations and limits shared by server and (future) client. Mirrors supabase/migrations enums. */

export const EXPERIENCE_LEVELS = ['none', 'pr_only', 'merged'] as const;
export type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];

export const TASK_TYPES = ['docs', 'test', 'bug', 'feature', 'unknown'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** 전제 적음 / 추가 확인 필요 / 고급 작업 */
export const TASK_BURDENS = ['low_prerequisites', 'needs_confirmation', 'advanced'] as const;
export type TaskBurden = (typeof TASK_BURDENS)[number];

export const ISSUE_ELIGIBILITY = ['eligible', 'excluded', 'needs_review'] as const;
export type IssueEligibility = (typeof ISSUE_ELIGIBILITY)[number];

export const JOURNEY_STATUSES = [
  'selected',
  'preparing',
  'pr_linked',
  'merged',
  'closed_without_merge',
  'abandoned',
] as const;
export type JourneyStatus = (typeof JOURNEY_STATUSES)[number];

export const PR_STATUSES = ['open', 'merged', 'closed_without_merge'] as const;
export type PrStatus = (typeof PR_STATUSES)[number];

export const REPORT_STATUSES = ['queued', 'running', 'ready', 'insufficient_evidence', 'failed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const CHECKLIST_STAGES = ['env', 'work', 'test', 'pre_pr'] as const;
export type ChecklistStage = (typeof CHECKLIST_STAGES)[number];

export const CHECKLIST_KINDS = ['general', 'repo_rule'] as const;
export type ChecklistKind = (typeof CHECKLIST_KINDS)[number];

export const SOURCE_KINDS = [
  'issue',
  'closed_issue',
  'pull_request',
  'comment',
  'review_comment',
  'contributing',
  'readme',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const CLAIM_KINDS = ['fact', 'interpretation', 'unknown'] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const DRAFT_TYPES = ['issue_comment', 'pr_description'] as const;
export type DraftType = (typeof DRAFT_TYPES)[number];

/** 확정서 §13.1 event names. */
export const EVENT_NAMES = [
  'github_login_completed',
  'onboarding_stack_confirmed',
  'repo_selected',
  'issue_selected',
  'context_report_viewed',
  'report_rated',
  'contribution_intent_draft_generated',
  'draft_copied',
  'contribution_intent_marked_posted',
  'checklist_item_completed',
  'pr_connected',
  'pr_status_changed',
  'first_pr_merged',
  'second_contribution_started',
  'second_pr_connected',
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

/** Events a client may report; everything else is recorded by the server only. */
export const CLIENT_EVENT_NAMES = [
  'repo_selected',
  'context_report_viewed',
  'draft_copied',
  'contribution_intent_marked_posted',
] as const satisfies readonly EventName[];
export type ClientEventName = (typeof CLIENT_EVENT_NAMES)[number];

export const LIMITS = {
  maxRecommendations: 5,
  reportsPerUserPerDay: 5,
  assistsPerUserPerDay: 10,
  prManualRefreshSeconds: 60,
  intentMaxChars: 1000,
  maxStacks: 20,
} as const;

export const CONSENT_VERSION = '2026-11-10';
