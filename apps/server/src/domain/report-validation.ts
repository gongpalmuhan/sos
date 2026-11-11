/**
 * Application-side evidence validation for AI output (확정서 §11 출력 계약).
 * Structure validation (Zod) happens before this; here we check that every claim
 * cites sources we actually supplied, convert ids to canonical URLs server-side,
 * and drop commands that do not appear verbatim in the cited source.
 */
import type { ReportModelOutput, ReportResult, SourceKind, SourceLink } from '@sos/shared';

export interface SuppliedSource {
  ref: string; // "S1"
  source_id: number;
  kind: SourceKind;
  url: string;
  title: string | null;
  content: string;
}

export interface ValidationOutcome {
  /** Validated result with URLs resolved by the server. */
  result: Omit<ReportResult, 'retrieval'>;
  /** Items removed because of missing/invalid sources or fabricated commands. */
  dropped: number;
  problems: string[];
  /** True when the output is unusable and a single regeneration is warranted. */
  shouldRetry: boolean;
  /** True when, even if structurally fine, nothing evidence-backed remains. */
  insufficient: boolean;
}

const RULE_SOURCE_KINDS: SourceKind[] = ['contributing', 'readme'];

function normalizeCmd(s: string): string {
  return s.replace(/^\$\s*/, '').replace(/\s+/g, ' ').trim();
}

export function validateReportOutput(output: ReportModelOutput, sources: SuppliedSource[]): ValidationOutcome {
  const byRef = new Map(sources.map((s) => [s.ref, s]));
  const problems: string[] = [];
  let dropped = 0;
  let citedTotal = 0;
  let citedInvalid = 0;

  const resolve = (refs: string[]): SourceLink[] => {
    const seen = new Set<string>();
    const out: SourceLink[] = [];
    for (const ref of refs) {
      citedTotal++;
      const s = byRef.get(ref);
      if (!s) {
        citedInvalid++;
        problems.push(`unknown_source:${ref}`);
        continue;
      }
      if (seen.has(ref)) continue;
      seen.add(ref);
      out.push({ source_id: s.source_id, kind: s.kind, url: s.url, title: s.title });
    }
    return out;
  };

  const summary_items: ReportResult['summary_items'] = [];
  for (const item of output.summary_items) {
    const links = resolve(item.source_ids);
    if (item.kind !== 'unknown' && links.length === 0) {
      dropped++;
      problems.push('claim_without_source');
      continue;
    }
    summary_items.push({ claim: item.claim, kind: item.kind, sources: links });
  }

  const related_work: ReportResult['related_work'] = [];
  for (const item of output.related_work) {
    const links = resolve(item.source_ids);
    if (links.length === 0) {
      dropped++;
      continue;
    }
    related_work.push({ claim: item.claim, sources: links });
  }

  const contributing_steps: ReportResult['contributing_steps'] = [];
  for (const step of output.contributing_steps) {
    const links = resolve(step.source_ids).filter((l) => RULE_SOURCE_KINDS.includes(l.kind));
    if (links.length === 0) {
      dropped++;
      problems.push('step_without_rule_source');
      continue;
    }
    if (step.command) {
      const cmd = normalizeCmd(step.command);
      const cited = sources.filter((s) => links.some((l) => l.source_id === s.source_id));
      const verbatim = cmd.length > 0 && cited.some((s) => normalizeCmd(s.content).includes(cmd));
      if (!verbatim) {
        dropped++;
        problems.push('fabricated_command');
        continue;
      }
    }
    contributing_steps.push({ stage: step.stage, text: step.text, command: step.command, sources: links });
  }

  const evidenceBacked = summary_items.filter((i) => i.kind !== 'unknown').length;
  const totalItems = output.summary_items.length + output.related_work.length + output.contributing_steps.length;
  // Retry once if the model largely ignored the source ids we gave it.
  const shouldRetry = (citedTotal > 0 && citedInvalid / citedTotal > 0.3) || (totalItems > 0 && dropped / totalItems > 0.5);

  return {
    result: { summary_items, related_work, contributing_steps, unknowns: output.unknowns, dropped_items: dropped },
    dropped,
    problems: [...new Set(problems)],
    shouldRetry,
    insufficient: evidenceBacked === 0,
  };
}

/** Generic: keep only refs that we supplied; returns resolved links and invalid count. */
export function resolveRefs(refs: string[], sources: SuppliedSource[]): { links: SourceLink[]; invalid: number } {
  const byRef = new Map(sources.map((s) => [s.ref, s]));
  const links: SourceLink[] = [];
  let invalid = 0;
  for (const ref of new Set(refs)) {
    const s = byRef.get(ref);
    if (!s) invalid++;
    else links.push({ source_id: s.source_id, kind: s.kind, url: s.url, title: s.title });
  }
  return { links, invalid };
}
