/** Typed GitHub reads used by sync jobs and request-time rechecks. Public data only. */
import { gh, ghCall, GitHubError } from './client';
import { headTail } from '@/domain/text';
import type { CommentFact } from '@/domain/recommendation';

export interface RepoMeta {
  github_id: number;
  owner: string;
  name: string;
  html_url: string;
  description: string | null;
  visibility: string;
  archived: boolean;
  disabled: boolean;
  default_branch: string;
  primary_language: string | null;
  license_spdx: string | null;
  stars: number;
  open_issues_count: number;
  topics: string[];
}

export async function fetchRepo(owner: string, name: string): Promise<RepoMeta> {
  const { data } = await ghCall(() => gh().rest.repos.get({ owner, repo: name }));
  if (data.private) throw new GitHubError('not_found', 404, 'repository is not public');
  return {
    github_id: data.id,
    owner: data.owner.login,
    name: data.name,
    html_url: data.html_url,
    description: data.description,
    visibility: data.visibility ?? (data.private ? 'private' : 'public'),
    archived: data.archived,
    disabled: data.disabled,
    default_branch: data.default_branch,
    primary_language: data.language ?? null,
    license_spdx: data.license?.spdx_id ?? null,
    stars: data.stargazers_count,
    open_issues_count: data.open_issues_count,
    topics: data.topics ?? [],
  };
}

export interface RepoFile {
  path: string;
  html_url: string;
  sha: string;
  content: string;
}

async function fetchFile(owner: string, repo: string, path: string, ref?: string): Promise<RepoFile | null> {
  try {
    const { data } = await ghCall(() => gh().rest.repos.getContent({ owner, repo, path, ref }));
    if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) return null;
    return {
      path: data.path,
      html_url: data.html_url ?? `https://github.com/${owner}/${repo}/blob/${ref ?? 'HEAD'}/${data.path}`,
      sha: data.sha,
      content: Buffer.from(data.content, 'base64').toString('utf8'),
    };
  } catch (err) {
    if (err instanceof GitHubError && err.kind === 'not_found') return null;
    throw err;
  }
}

const CONTRIBUTING_PATHS = [
  'CONTRIBUTING.md',
  '.github/CONTRIBUTING.md',
  'docs/CONTRIBUTING.md',
  'CONTRIBUTING.rst',
  'CONTRIBUTING',
  'docs/contributing.md',
];

export async function fetchContributing(owner: string, repo: string, ref: string): Promise<RepoFile | null> {
  for (const path of CONTRIBUTING_PATHS) {
    const f = await fetchFile(owner, repo, path, ref);
    if (f) return f;
  }
  return null;
}

export async function fetchReadme(owner: string, repo: string): Promise<RepoFile | null> {
  try {
    const { data } = await ghCall(() => gh().rest.repos.getReadme({ owner, repo }));
    return {
      path: data.path,
      html_url: data.html_url ?? `https://github.com/${owner}/${repo}#readme`,
      sha: data.sha,
      content: Buffer.from(data.content, 'base64').toString('utf8'),
    };
  } catch (err) {
    if (err instanceof GitHubError && err.kind === 'not_found') return null;
    throw err;
  }
}

export function readmeHasContributingSection(readme: string | null): boolean {
  return readme ? /^#{1,3}\s*(contributing|how to contribute|development)\b/im.test(readme) : false;
}

export async function fetchLastCommitAt(owner: string, repo: string, branch: string): Promise<string | null> {
  const { data } = await ghCall(() => gh().rest.repos.listCommits({ owner, repo, sha: branch, per_page: 1 }));
  return data[0]?.commit.committer?.date ?? data[0]?.commit.author?.date ?? null;
}

const MAINTAINER = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** Most recent public maintainer comment on issues/PRs in the last 90 days. */
export async function fetchLastMaintainerActivity(owner: string, repo: string, now = new Date()): Promise<string | null> {
  const since = new Date(now.getTime() - 90 * 24 * 3600 * 1000).toISOString();
  const { data } = await ghCall(() =>
    gh().rest.issues.listCommentsForRepo({ owner, repo, since, sort: 'created', direction: 'desc', per_page: 100 }),
  );
  const hit = data.find((c) => MAINTAINER.has(c.author_association));
  return hit?.created_at ?? null;
}

// ---------------------------------------------------------------------------
// Issues via GraphQL (labels, assignees, linked PRs, recent comments in one query)
// ---------------------------------------------------------------------------

export interface IssueSnapshot {
  github_id: number;
  number: number;
  title: string;
  body: string;
  html_url: string;
  state: 'open' | 'closed';
  locked: boolean;
  labels: string[];
  assignee_logins: string[];
  linked_open_prs: number[];
  /** Explicitly linked PRs/issues (any state) for report context. */
  linked_refs: { kind: 'pull_request' | 'issue'; number: number; url: string; state: string }[];
  author_login: string | null;
  comments_count: number;
  recent_comments: CommentFact[];
  created_at: string;
  updated_at: string;
}

const ISSUE_FIELDS = `
  databaseId number title body url state locked createdAt updatedAt
  author { login }
  labels(first: 30) { nodes { name } }
  assignees(first: 10) { nodes { login } }
  comments(last: 30) { totalCount nodes { authorAssociation createdAt body url author { login } } }
  closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number state url repository { databaseId } } }
  timelineItems(last: 50, itemTypes: [CONNECTED_EVENT, CROSS_REFERENCED_EVENT]) {
    nodes {
      __typename
      ... on ConnectedEvent { subject { __typename ... on PullRequest { number state url repository { databaseId } } ... on Issue { number state url repository { databaseId } } } }
      ... on CrossReferencedEvent { willCloseTarget source { __typename ... on PullRequest { number state url repository { databaseId } } } }
    }
  }
`;

interface GqlRef { number: number; state: string; url: string; repository: { databaseId: number } }
interface GqlIssue {
  databaseId: number;
  number: number;
  title: string;
  body: string;
  url: string;
  state: 'OPEN' | 'CLOSED';
  locked: boolean;
  createdAt: string;
  updatedAt: string;
  author: { login: string } | null;
  labels: { nodes: { name: string }[] };
  assignees: { nodes: { login: string }[] };
  comments: { totalCount: number; nodes: { authorAssociation: string; createdAt: string; body: string; url: string; author: { login: string } | null }[] };
  closedByPullRequestsReferences: { nodes: GqlRef[] } | null;
  timelineItems: {
    nodes: (
      | { __typename: 'ConnectedEvent'; subject: (GqlRef & { __typename: string }) | null }
      | { __typename: 'CrossReferencedEvent'; willCloseTarget: boolean; source: (GqlRef & { __typename: string }) | null }
    )[];
  };
}

function toSnapshot(i: GqlIssue, repoGithubId: number): IssueSnapshot {
  const refs = new Map<string, IssueSnapshot['linked_refs'][number]>();
  const openPrs = new Set<number>();
  const addRef = (r: GqlRef, kind: 'pull_request' | 'issue', closing: boolean) => {
    if (r.repository.databaseId !== repoGithubId) return;
    refs.set(`${kind}:${r.number}`, { kind, number: r.number, url: r.url, state: r.state.toLowerCase() });
    if (kind === 'pull_request' && closing && r.state === 'OPEN') openPrs.add(r.number);
  };
  for (const pr of i.closedByPullRequestsReferences?.nodes ?? []) addRef(pr, 'pull_request', true);
  for (const n of i.timelineItems.nodes) {
    if (n.__typename === 'ConnectedEvent' && n.subject) {
      addRef(n.subject, n.subject.__typename === 'PullRequest' ? 'pull_request' : 'issue', true);
    } else if (n.__typename === 'CrossReferencedEvent' && n.source?.__typename === 'PullRequest') {
      addRef(n.source, 'pull_request', n.willCloseTarget);
    }
  }
  return {
    github_id: i.databaseId,
    number: i.number,
    title: i.title,
    body: i.body ?? '',
    html_url: i.url,
    state: i.state === 'OPEN' ? 'open' : 'closed',
    locked: i.locked,
    labels: i.labels.nodes.map((l) => l.name),
    assignee_logins: i.assignees.nodes.map((a) => a.login),
    linked_open_prs: [...openPrs],
    linked_refs: [...refs.values()],
    author_login: i.author?.login ?? null,
    comments_count: i.comments.totalCount,
    recent_comments: i.comments.nodes.map((c) => ({
      author_association: c.authorAssociation,
      author_login: c.author?.login ?? null,
      created_at: c.createdAt,
      body: c.body,
      url: c.url,
    })),
    created_at: i.createdAt,
    updated_at: i.updatedAt,
  };
}

/**
 * Open issues (full sync) or issues updated since `since` in any state (incremental),
 * newest-updated first, capped at `max`.
 */
export async function fetchIssues(
  owner: string,
  name: string,
  repoGithubId: number,
  opts: { since?: string; max?: number } = {},
): Promise<IssueSnapshot[]> {
  const max = opts.max ?? 500;
  const states = opts.since ? '[OPEN, CLOSED]' : '[OPEN]';
  const query = `query($owner: String!, $name: String!, $cursor: String, $since: DateTime) {
    repository(owner: $owner, name: $name) {
      issues(first: 25, after: $cursor, states: ${states}, orderBy: { field: UPDATED_AT, direction: DESC }, filterBy: { since: $since }) {
        pageInfo { hasNextPage endCursor }
        nodes { ${ISSUE_FIELDS} }
      }
    }
  }`;
  const out: IssueSnapshot[] = [];
  let cursor: string | null = null;
  while (out.length < max) {
    const res: { repository: { issues: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GqlIssue[] } } | null } =
      await ghCall(() => gh().graphql(query, { owner, name, cursor, since: opts.since ?? null }));
    if (!res.repository) throw new GitHubError('not_found', 404, 'repository not found');
    for (const n of res.repository.issues.nodes) out.push(toSnapshot(n, repoGithubId));
    if (!res.repository.issues.pageInfo.hasNextPage) break;
    cursor = res.repository.issues.pageInfo.endCursor;
  }
  return out.slice(0, max);
}

export async function fetchIssue(owner: string, name: string, repoGithubId: number, number: number): Promise<IssueSnapshot> {
  const query = `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { issue(number: $number) { ${ISSUE_FIELDS} } }
  }`;
  const res: { repository: { issue: GqlIssue | null } | null } = await ghCall(() => gh().graphql(query, { owner, name, number }));
  const issue = res.repository?.issue;
  if (!issue) throw new GitHubError('not_found', 404, 'issue not found');
  return toSnapshot(issue, repoGithubId);
}

/** First 20 + latest 80 comments, with an omitted-middle flag (확정서 §11). */
export async function fetchIssueCommentsHeadTail(
  owner: string,
  repo: string,
  number: number,
  total: number,
): Promise<{ comments: (CommentFact & { id: number })[]; middleOmitted: boolean; total: number }> {
  const map = (c: { id: number; author_association: string; user: { login: string } | null; created_at: string; body?: string; html_url: string }) => ({
    id: c.id,
    author_association: c.author_association,
    author_login: c.user?.login ?? null,
    created_at: c.created_at,
    body: c.body ?? '',
    url: c.html_url,
  });
  if (total <= 100) {
    const { data } = await ghCall(() => gh().rest.issues.listComments({ owner, repo, issue_number: number, per_page: 100 }));
    return { comments: data.map(map), middleOmitted: false, total: data.length };
  }
  const head = await ghCall(() => gh().rest.issues.listComments({ owner, repo, issue_number: number, per_page: 20, page: 1 }));
  const lastPage = Math.ceil(total / 100);
  const pages = await Promise.all(
    [lastPage - 1, lastPage].filter((p) => p >= 1).map((page) =>
      ghCall(() => gh().rest.issues.listComments({ owner, repo, issue_number: number, per_page: 100, page })),
    ),
  );
  const tail = pages.flatMap((p) => p.data).slice(-80);
  const seen = new Set(head.data.map((c) => c.id));
  const merged = [...head.data, ...tail.filter((c) => !seen.has(c.id))].map(map);
  return { comments: headTail(merged, 20, 80).items, middleOmitted: true, total };
}

export interface PullSnapshot {
  github_id: number;
  number: number;
  title: string;
  body: string;
  html_url: string;
  state: string;
  merged_at: string | null;
  closed_at: string | null;
  author_id: number | null;
  author_login: string | null;
  base_repo_id: number;
  created_at: string;
  updated_at: string;
}

export async function fetchPull(owner: string, repo: string, number: number): Promise<PullSnapshot> {
  const { data } = await ghCall(() => gh().rest.pulls.get({ owner, repo, pull_number: number }));
  return {
    github_id: data.id,
    number: data.number,
    title: data.title,
    body: data.body ?? '',
    html_url: data.html_url,
    state: data.state,
    merged_at: data.merged_at,
    closed_at: data.closed_at,
    author_id: data.user?.id ?? null,
    author_login: data.user?.login ?? null,
    base_repo_id: data.base.repo.id,
    created_at: data.created_at,
    updated_at: data.updated_at,
  };
}

/** Review comments + reviews with bodies on a PR (for F7 interpretation). */
export async function fetchPullReviewTexts(
  owner: string,
  repo: string,
  number: number,
  max = 30,
): Promise<{ id: string; url: string; author_login: string | null; body: string; created_at: string }[]> {
  const [reviews, comments] = await Promise.all([
    ghCall(() => gh().rest.pulls.listReviews({ owner, repo, pull_number: number, per_page: 100 })),
    ghCall(() => gh().rest.pulls.listReviewComments({ owner, repo, pull_number: number, per_page: 100 })),
  ]);
  const items = [
    ...reviews.data
      .filter((r) => (r.body ?? '').trim().length > 0)
      .map((r) => ({ id: `review:${r.id}`, url: r.html_url, author_login: r.user?.login ?? null, body: r.body ?? '', created_at: r.submitted_at ?? '' })),
    ...comments.data.map((c) => ({ id: `comment:${c.id}`, url: c.html_url, author_login: c.user?.login ?? null, body: c.body ?? "", created_at: c.created_at })),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at));
  return items.slice(0, max);
}

/** Issues (not PRs) and PRs updated within the window, for the retrieval index. */
export async function fetchIndexCandidates(
  owner: string,
  repo: string,
  opts: { since: string; maxIssues: number; maxPulls: number },
): Promise<{ issues: IndexDoc[]; pulls: IndexDoc[] }> {
  const issues: IndexDoc[] = [];
  for await (const page of gh().paginate.iterator(gh().rest.issues.listForRepo, {
    owner, repo, state: 'all', since: opts.since, sort: 'updated', direction: 'desc', per_page: 100,
  })) {
    for (const i of page.data) {
      if (i.pull_request) continue;
      issues.push({ number: i.number, title: i.title, body: i.body ?? '', url: i.html_url, state: i.state, author_login: i.user?.login ?? null, author_association: i.author_association ?? "NONE", created_at: i.created_at, updated_at: i.updated_at });
    }
    if (issues.length >= opts.maxIssues) break;
  }
  const pulls: IndexDoc[] = [];
  for await (const page of gh().paginate.iterator(gh().rest.pulls.list, {
    owner, repo, state: 'all', sort: 'updated', direction: 'desc', per_page: 100,
  })) {
    let done = false;
    for (const p of page.data) {
      if (p.updated_at < opts.since) { done = true; break; }
      pulls.push({ number: p.number, title: p.title, body: p.body ?? '', url: p.html_url, state: p.merged_at ? 'merged' : p.state, author_login: p.user?.login ?? null, author_association: p.author_association ?? "NONE", created_at: p.created_at, updated_at: p.updated_at });
    }
    if (done || pulls.length >= opts.maxPulls) break;
  }
  return { issues: issues.slice(0, opts.maxIssues), pulls: pulls.slice(0, opts.maxPulls) };
}

export interface IndexDoc {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  author_login: string | null;
  author_association: string;
  created_at: string;
  updated_at: string;
}

export async function fetchUserPublicRepos(login: string) {
  const { data } = await ghCall(() => gh().rest.repos.listForUser({ username: login, type: 'owner', sort: 'pushed', per_page: 50 }));
  return data.map((r) => ({ full_name: r.full_name, html_url: r.html_url, language: r.language ?? null, fork: r.fork, archived: r.archived }));
}
