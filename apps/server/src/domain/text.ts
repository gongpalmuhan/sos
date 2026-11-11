import { createHash } from 'node:crypto';

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Rough token estimate (~4 chars/token for English, conservative for CJK). */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (ch.charCodeAt(0) > 0x2e80) cjk++;
  return Math.ceil((text.length - cjk) / 4 + cjk);
}

export interface Chunk {
  index: number;
  content: string;
  truncated: boolean;
}

/**
 * Split into ~800-token chunks with ~100-token overlap (확정서 §11).
 * Prefers paragraph/line boundaries. maxChunks caps very long docs (truncated=true on last).
 */
export function chunkText(text: string, opts: { chunkTokens?: number; overlapTokens?: number; maxChunks?: number } = {}): Chunk[] {
  const chunkChars = (opts.chunkTokens ?? 800) * 4;
  const overlapChars = (opts.overlapTokens ?? 100) * 4;
  const maxChunks = opts.maxChunks ?? 40;
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  const chunks: Chunk[] = [];
  let start = 0;
  let lastEnd = 0;
  while (start < clean.length && chunks.length < maxChunks) {
    let end = Math.min(start + chunkChars, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const para = window.lastIndexOf('\n\n');
      const line = window.lastIndexOf('\n');
      const cut = para > chunkChars * 0.5 ? para : line > chunkChars * 0.5 ? line : -1;
      if (cut > 0) end = start + cut;
    }
    chunks.push({ index: chunks.length, content: clean.slice(start, end).trim(), truncated: false });
    lastEnd = end;
    if (end >= clean.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }
  const last = chunks[chunks.length - 1];
  if (last && lastEnd < clean.length) last.truncated = true;
  return chunks.filter((c) => c.content.length > 0);
}

/** Reciprocal Rank Fusion over ranked id lists (k=60). Mirrors SQL hybrid_search_chunks. */
export function rrfFuse(lists: number[][], k = 60): { id: number; score: number }[] {
  const scores = new Map<number, number>();
  for (const list of lists) {
    list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id - b.id);
}

/** First N + last M of a list, with an omitted-middle flag (확정서 §11: 최초 20 + 최신 80). */
export function headTail<T>(items: T[], head = 20, tail = 80): { items: T[]; middleOmitted: boolean } {
  if (items.length <= head + tail) return { items, middleOmitted: false };
  return { items: [...items.slice(0, head), ...items.slice(-tail)], middleOmitted: true };
}

/** Truncate to a token budget, returning whether it was cut. */
export function clampTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false };
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return { text: text.slice(0, lo), truncated: true };
}
