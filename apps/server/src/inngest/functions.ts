import { inngest, EVENTS } from './client';
import { approvedRepositories, syncIssues, syncRepository, withSyncRun } from '@/github/sync';
import { embedPendingChunks } from '@/ai/embeddings';
import { markReportFailed, runReportGeneration } from '@/services/reports';
import { syncTrackedPrs } from '@/services/prs';
import { deleteAccountData } from '@/services/account';
import { adminDb } from '@/lib/supabase';
import { logError } from '@/lib/log';

/** Repository metadata + CONTRIBUTING/README, every 24h (03:00 KST). */
export const syncRepositoriesFn = inngest.createFunction(
  { id: 'sync-repositories', triggers: [{ cron: '0 18 * * *' }], concurrency: { limit: 1 } },
  async ({ step, runId }) => {
    const repos = await step.run('list', async () => (await approvedRepositories()).map((r) => ({ id: r.id, owner: r.owner, name: r.name })));
    const results: unknown[] = [];
    for (const r of repos) {
      results.push(
        await step.run(`repo-${r.id}`, async () => {
          try {
            return await withSyncRun('repository', `${r.owner}/${r.name}`, runId, () => syncRepository(r));
          } catch (err) {
            logError('repo_sync_failed', err, { repository_id: r.id });
            return { repository_id: r.id, failed: true };
          }
        }),
      );
    }
    await step.sendEvent('embed', { name: EVENTS.embedChunks, data: {} });
    return { repos: results.length };
  },
);

/** Open-issue incremental sync + retrieval index, every 6h. */
export const syncIssuesFn = inngest.createFunction(
  { id: 'sync-issues', triggers: [{ cron: '30 */6 * * *' }, { event: EVENTS.repoSyncRequested }], concurrency: { limit: 1 } },
  async ({ step, event, runId }) => {
    const only = (event?.data as { repositoryId?: number; full?: boolean } | undefined) ?? {};
    const repos = await step.run('list', async () =>
      (await approvedRepositories()).filter((r) => !only.repositoryId || r.id === only.repositoryId).map((r) => r.id),
    );
    for (const id of repos) {
      await step.run(`issues-${id}`, async () => {
        const repo = (await approvedRepositories()).find((r) => r.id === id);
        if (!repo) return { skipped: true };
        try {
          if (only.repositoryId) await syncRepository(repo);
          return await withSyncRun('issues', `${repo.owner}/${repo.name}`, runId, () => syncIssues(repo, { full: Boolean(only.full) }));
        } catch (err) {
          logError('issue_sync_failed', err, { repository_id: id });
          return { repository_id: id, failed: true };
        }
      });
    }
    await step.sendEvent('embed', { name: EVENTS.embedChunks, data: {} });
    return { repos: repos.length };
  },
);

/** Linked PR status, every hour. */
export const syncLinkedPrsFn = inngest.createFunction(
  { id: 'sync-linked-prs', triggers: [{ cron: '15 * * * *' }], concurrency: { limit: 1 } },
  async ({ step, runId }) => step.run('sync', () => withSyncRun('linked_prs', 'all', runId, syncTrackedPrs)),
);

/** Embed chunks lacking embeddings, in bounded batches. */
export const embedChunksFn = inngest.createFunction(
  { id: 'embed-chunks', triggers: [{ event: EVENTS.embedChunks }], concurrency: { limit: 1 }, retries: 3 },
  async ({ step, runId }) => {
    let total = 0;
    for (let i = 0; i < 25; i++) {
      const n = await step.run(`batch-${i}`, () => embedPendingChunks(200, runId));
      total += n;
      if (n === 0) break;
    }
    return { embedded: total };
  },
);

/** Report generation: global concurrency 2, per user 1. Failure → status failed (never fake output). */
export const generateReportFn = inngest.createFunction(
  {
    id: 'generate-report',
    triggers: [{ event: EVENTS.reportRequested }],
    concurrency: [{ limit: 2 }, { limit: 1, key: 'event.data.userId' }],
    retries: 2,
    onFailure: async ({ event }) => {
      const reportId = (event.data as { event?: { data?: { reportId?: string } } }).event?.data?.reportId;
      if (reportId) await markReportFailed(reportId, 'job_failed');
    },
  },
  async ({ event, step, runId }) => {
    const { reportId } = event.data as { reportId: string };
    return step.run('generate', () => runReportGeneration(reportId, runId));
  },
);

export const deleteAccountFn = inngest.createFunction(
  { id: 'delete-account', triggers: [{ event: EVENTS.accountDeletionRequested }], retries: 5 },
  async ({ event, step }) => {
    const { userId } = event.data as { userId: string };
    await step.run('delete', () => deleteAccountData(userId));
    return { deleted: true };
  },
);

/** Retention (확정서 §12): unreferenced reports 90d, job/AI logs 30d. */
export const cleanupFn = inngest.createFunction(
  { id: 'cleanup', triggers: [{ cron: '0 19 * * *' }] },
  async ({ step }) =>
    step.run('cleanup', async () => {
      const db = adminDb();
      const d90 = new Date(Date.now() - 90 * 86400_000).toISOString();
      const d30 = new Date(Date.now() - 30 * 86400_000).toISOString();
      await db.from('reports').delete().lt('created_at', d90).or(`last_viewed_at.is.null,last_viewed_at.lt.${d90}`);
      await db.from('sync_runs').delete().lt('started_at', d30);
      await db.from('ai_runs').delete().lt('created_at', d30).not('created_at', 'gte', new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString());
      return { ok: true };
    }),
);

export const functions = [syncRepositoriesFn, syncIssuesFn, syncLinkedPrsFn, embedChunksFn, generateReportFn, deleteAccountFn, cleanupFn];
