import { z } from 'zod';
import {
  CLAIM_KINDS,
  CHECKLIST_STAGES,
  CLIENT_EVENT_NAMES,
  DRAFT_TYPES,
  EXPERIENCE_LEVELS,
  LIMITS,
  TASK_TYPES,
} from './constants';

// ---------------------------------------------------------------------------
// Request bodies / queries
// ---------------------------------------------------------------------------

const stackTag = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9.+#-]{0,39}$/, 'invalid stack tag');

export const profileUpdateSchema = z
  .object({
    /** Must be true: the profile is never saved without explicit user confirmation (F2). */
    confirmed: z.literal(true),
    stacks: z.array(stackTag).min(1).max(LIMITS.maxStacks),
    experience_level: z.enum(EXPERIENCE_LEVELS),
    interested_task_types: z.array(z.enum(TASK_TYPES)).max(TASK_TYPES.length).default([]),
    analytics_consent: z.boolean().optional(),
    public_inference_consent: z.boolean().optional(),
  })
  .strict();
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;

export const repoListQuerySchema = z.object({
  stack: z.string().optional(),
  language: z.string().optional(),
});

export const issueListQuerySchema = z.object({
  type: z.enum(TASK_TYPES).optional(),
  /** Ignore the saved profile stacks (e.g. for logged-out browsing). */
  any_stack: z.enum(['true', 'false']).optional(),
});

export const createJourneySchema = z.object({ issue_id: z.number().int().positive() }).strict();

export const patchJourneySchema = z
  .object({ action: z.literal('abandon'), reason: z.string().trim().max(200).optional() })
  .strict();

export const checklistPatchSchema = z
  .object({ item_id: z.string().uuid(), completed: z.boolean() })
  .strict();

export const createReportSchema = z.object({ journey_id: z.string().uuid() }).strict();

export const reportRatingSchema = z
  .object({
    useful: z.boolean(),
    error_reasons: z
      .array(z.enum(['wrong_fact', 'missing_context', 'bad_source', 'outdated', 'other']))
      .max(5)
      .default([]),
  })
  .strict();

export const createDraftSchema = z
  .object({
    journey_id: z.string().uuid(),
    type: z.enum(DRAFT_TYPES),
    /** User's own intent, any language. Not stored. */
    intent: z.string().trim().min(5).max(LIMITS.intentMaxChars),
  })
  .strict();

export const linkPrSchema = z.object({ url: z.string().trim().url().max(300) }).strict();

export const clientEventSchema = z
  .object({
    event_id: z.string().uuid(),
    name: z.enum(CLIENT_EVENT_NAMES),
    journey_id: z.string().uuid().optional(),
    repository_id: z.number().int().positive().optional(),
    report_id: z.string().uuid().optional(),
    draft_type: z.enum(DRAFT_TYPES).optional(),
  })
  .strict();
export type ClientEvent = z.infer<typeof clientEventSchema>;

// ---------------------------------------------------------------------------
// AI output contracts (validated server-side before anything is shown)
// ---------------------------------------------------------------------------

/** Source ids as given to the model: "S1", "S2", ... */
const sourceRef = z.string().regex(/^S\d{1,3}$/);

export const reportModelOutputSchema = z.object({
  summary_items: z
    .array(
      z.object({
        claim: z.string().min(1).max(600),
        kind: z.enum(CLAIM_KINDS),
        source_ids: z.array(sourceRef).max(6),
      }),
    )
    .max(12),
  related_work: z
    .array(
      z.object({
        claim: z.string().min(1).max(400),
        source_ids: z.array(sourceRef).min(1).max(4),
      }),
    )
    .max(8),
  contributing_steps: z
    .array(
      z.object({
        stage: z.enum(CHECKLIST_STAGES),
        text: z.string().min(1).max(300),
        /** Must appear verbatim in the cited source; otherwise dropped. */
        command: z.string().max(200).nullable(),
        source_ids: z.array(sourceRef).min(1).max(3),
      }),
    )
    .max(12),
  unknowns: z.array(z.string().min(1).max(300)).max(8),
});
export type ReportModelOutput = z.infer<typeof reportModelOutputSchema>;

export const draftModelOutputSchema = z.object({
  body: z.string().min(1).max(4000),
  source_ids: z.array(sourceRef).max(6),
});

export const reviewInterpretationModelOutputSchema = z.object({
  items: z
    .array(
      z.object({
        source_id: sourceRef,
        interpretation_ko: z.string().min(1).max(1200),
        unclear_points: z.array(z.string().max(300)).max(4),
      }),
    )
    .max(30),
});
