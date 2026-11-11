import { embedMany } from 'ai';
import { adminDb, maybe } from '@/lib/supabase';
import { EMBEDDING_DIMENSIONS, embeddingModel, estimateCost } from './models';

export async function embedTexts(values: string[], meta: { jobId?: string; userId?: string | null } = {}): Promise<number[][]> {
  if (!values.length) return [];
  const { id, model } = embeddingModel();
  const started = Date.now();
  const res = await embedMany({
    model,
    values,
    providerOptions: { openai: { dimensions: EMBEDDING_DIMENSIONS } },
    maxParallelCalls: 2,
  });
  const tokens = res.usage?.tokens ?? 0;
  await adminDb().from('ai_runs').insert({
    user_id: meta.userId ?? null,
    kind: 'embedding',
    quota_kind: null,
    job_id: meta.jobId ?? null,
    model: id,
    status: 'succeeded',
    input_tokens: tokens,
    cost_usd: estimateCost('embedding', tokens, 0),
    latency_ms: Date.now() - started,
    finished_at: new Date().toISOString(),
  });
  for (const e of res.embeddings) {
    if (e.length !== EMBEDDING_DIMENSIONS) throw new Error(`unexpected embedding dimension ${e.length}`);
  }
  return res.embeddings;
}

/** pgvector literal. */
export const toVector = (v: number[]) => `[${v.join(',')}]`;

/** Embed chunks that have no embedding yet (bounded batch). Returns how many were embedded. */
export async function embedPendingChunks(limit = 200, jobId?: string): Promise<number> {
  const db = adminDb();
  const data = maybe(await db.from('document_chunks').select('id, content').is('embedding', null).order('id').limit(limit), 'embeddings.ts:data');
  if (!data?.length) return 0;
  const vectors = await embedTexts(data.map((c) => c.content as string), { jobId });
  const { id: modelId } = embeddingModel();
  const now = new Date().toISOString();
  for (const [i, c] of data.entries()) {
    await db
      .from('document_chunks')
      .update({ embedding: toVector(vectors[i]!), embedding_model: modelId, embedding_dimensions: EMBEDDING_DIMENSIONS, embedded_at: now })
      .eq('id', c.id);
  }
  return data.length;
}
