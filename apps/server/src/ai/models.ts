import { createOpenAI } from '@ai-sdk/openai';
import { env, parsePrice } from '@/lib/env';

export const PROMPT_VERSION = 'p2026-11-11.1';
export const SCHEMA_VERSION = 's2026-11-11.1';
export const EMBEDDING_DIMENSIONS = 1536;

/** Input/output budgets (확정서 §12). */
export const MAX_INPUT_TOKENS = 12_000;
export const MAX_OUTPUT_TOKENS = 3_000;

let provider: ReturnType<typeof createOpenAI> | undefined;
function openai() {
  provider ??= createOpenAI({ apiKey: env().OPENAI_API_KEY });
  return provider;
}

export type ModelRole = 'default' | 'fallback';

export function chatModel(role: ModelRole) {
  const e = env();
  const id = role === 'default' ? e.AI_MODEL_DEFAULT : e.AI_MODEL_FALLBACK;
  return { id, model: openai()(id) };
}

export function embeddingModel() {
  const id = env().AI_EMBEDDING_MODEL;
  return { id, model: openai().embedding(id) };
}

/** Cost estimate in USD. Reasoning tokens are billed as output tokens. */
export function estimateCost(role: ModelRole | 'embedding', inputTokens: number, outputTokens: number): number {
  const e = env();
  if (role === 'embedding') return (inputTokens / 1e6) * (Number(e.AI_PRICE_EMBEDDING) || 0);
  const price = parsePrice(role === 'default' ? e.AI_PRICE_DEFAULT : e.AI_PRICE_FALLBACK);
  return (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output;
}
