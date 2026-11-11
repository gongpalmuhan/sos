import { generateText, Output } from 'ai';
import type { z } from 'zod';
import { adminDb } from '@/lib/supabase';
import { logWarn } from '@/lib/log';
import { chatModel, estimateCost, MAX_OUTPUT_TOKENS, type ModelRole } from './models';

export interface RunMeta {
  userId: string | null;
  kind: 'report' | 'draft' | 'review_interpretation' | 'query_assist';
  /** Counted against the daily per-user quota. Retries are cost but not quota. */
  quotaKind: 'report' | 'assist' | null;
  jobId?: string;
  idempotencyKey?: string;
}

export interface StructuredAttempt<T> {
  ok: boolean;
  value: T | null;
  model: string;
  error: string | null;
}

/** One model call with a Zod-typed structured output, recorded in ai_runs. */
export async function generateStructured<S extends z.ZodType>(
  role: ModelRole,
  schema: S,
  system: string,
  prompt: string,
  meta: RunMeta,
  attempt: number,
): Promise<StructuredAttempt<z.infer<S>>> {
  const db = adminDb();
  const { id: modelId, model } = chatModel(role);
  const started = Date.now();
  const { data: run } = await db
    .from('ai_runs')
    .insert({
      user_id: meta.userId,
      kind: meta.kind,
      quota_kind: attempt === 1 ? meta.quotaKind : null,
      idempotency_key: meta.idempotencyKey ? `${meta.idempotencyKey}:a${attempt}` : null,
      job_id: meta.jobId ?? null,
      model: modelId,
      attempt,
    })
    .select('id')
    .single();

  try {
    const res = await generateText({
      model,
      system,
      prompt,
      output: Output.object({ schema }),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      maxRetries: 1,
    });
    const input = res.usage.inputTokens ?? 0;
    const output = res.usage.outputTokens ?? 0;
    if (run)
      await db.from('ai_runs').update({
        status: 'succeeded',
        input_tokens: input,
        output_tokens: output,
        reasoning_tokens: res.usage.outputTokenDetails?.reasoningTokens ?? null,
        cost_usd: estimateCost(role, input, output),
        latency_ms: Date.now() - started,
        finished_at: new Date().toISOString(),
      }).eq('id', run.id);
    return { ok: true, value: res.output as z.infer<S>, model: modelId, error: null };
  } catch (err) {
    const code = err instanceof Error ? err.name : 'unknown';
    logWarn('ai_generation_failed', { kind: meta.kind, model: modelId, attempt, code });
    if (run)
      await db.from('ai_runs').update({ status: 'failed', error_code: code, latency_ms: Date.now() - started, finished_at: new Date().toISOString() }).eq('id', run.id);
    return { ok: false, value: null, model: modelId, error: code };
  }
}

/**
 * Default model first; if structure or evidence validation fails, regenerate ONCE with the
 * fallback model (확정서 §9). `validate` returns null when acceptable, or a reason to retry.
 */
export async function generateWithFallback<S extends z.ZodType, R>(
  schema: S,
  system: string,
  prompt: string,
  meta: RunMeta,
  validate: (value: z.infer<S>) => { accept: true; result: R } | { accept: false; reason: string; result: R | null },
): Promise<{ result: R | null; model: string | null; reason: string | null; attempts: number }> {
  let lastReason: string | null = null;
  let lastResult: R | null = null;
  let lastModel: string | null = null;
  const roles: ModelRole[] = ['default', 'fallback'];
  for (const [idx, role] of roles.entries()) {
    const attempt = await generateStructured(role, schema, system, prompt, meta, idx + 1);
    lastModel = attempt.model;
    if (!attempt.ok || attempt.value === null) {
      lastReason = `generation_failed:${attempt.error}`;
      continue;
    }
    const v = validate(attempt.value);
    if (v.accept) return { result: v.result, model: attempt.model, reason: null, attempts: idx + 1 };
    lastReason = v.reason;
    lastResult = v.result;
  }
  return { result: lastResult, model: lastModel, reason: lastReason, attempts: roles.length };
}
