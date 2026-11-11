import { Inngest } from 'inngest';

export const inngest = new Inngest({ id: 'sos-server' });

export const EVENTS = {
  reportRequested: 'sos/report.requested',
  accountDeletionRequested: 'sos/account.deletion-requested',
  embedChunks: 'sos/chunks.embed',
  repoSyncRequested: 'sos/repo.sync-requested',
} as const;
