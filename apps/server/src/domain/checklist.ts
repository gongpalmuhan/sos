import type { ChecklistStage } from '@sos/shared';

export interface ChecklistSeed {
  item_key: string;
  position: number;
  stage: ChecklistStage;
  kind: 'general' | 'repo_rule';
  text: string;
  command: string | null;
  source_id: number | null;
  source_url: string | null;
}

/**
 * General guidance (not repository rules). Contains no repository-specific commands:
 * repo-specific steps come only from CONTRIBUTING with a source (F6).
 */
export function generalChecklist(repo: { html_url: string; contributing_url: string | null }, issueUrl: string): ChecklistSeed[] {
  const items: Omit<ChecklistSeed, 'position'>[] = [
    { item_key: 'g_read_issue', stage: 'env', kind: 'general', text: '이슈 본문과 최근 댓글을 끝까지 읽고, 이미 작업 중인 사람이 없는지 확인합니다.', command: null, source_id: null, source_url: issueUrl },
    { item_key: 'g_intent', stage: 'env', kind: 'general', text: '저장소 규칙에 따라 필요하면 이슈에 작업 의사를 남기고 답을 기다립니다. (모든 이슈에 댓글이 필요한 것은 아닙니다.)', command: null, source_id: null, source_url: issueUrl },
    { item_key: 'g_contributing', stage: 'env', kind: 'general', text: repo.contributing_url ? '기여 안내 문서(CONTRIBUTING)를 읽습니다.' : '기여 안내 문서가 확인되지 않았습니다. README의 기여 절차를 확인합니다.', command: null, source_id: null, source_url: repo.contributing_url ?? repo.html_url },
    { item_key: 'g_fork', stage: 'env', kind: 'general', text: 'GitHub에서 저장소를 fork하고 로컬에 clone합니다.', command: null, source_id: null, source_url: repo.html_url },
    { item_key: 'g_branch', stage: 'work', kind: 'general', text: '작업용 브랜치를 새로 만듭니다.', command: null, source_id: null, source_url: null },
    { item_key: 'g_change', stage: 'work', kind: 'general', text: '이슈 범위 안에서만 변경합니다. 범위를 넘는 수정은 별도로 논의합니다.', command: null, source_id: null, source_url: null },
    { item_key: 'g_test', stage: 'test', kind: 'general', text: '저장소가 안내하는 테스트·린트를 실행합니다. 안내가 없으면 변경과 관련된 부분만 확인하고, 무거운 전체 빌드가 필요한지 먼저 문의합니다.', command: null, source_id: null, source_url: null },
    { item_key: 'g_pr_check', stage: 'pre_pr', kind: 'general', text: 'PR 설명에 관련 이슈 번호와 변경 내용·확인 방법을 적었는지 확인합니다.', command: null, source_id: null, source_url: null },
    { item_key: 'g_pr_open', stage: 'pre_pr', kind: 'general', text: 'GitHub에서 직접 PR을 열고, PR URL을 SOS 여정에 연결합니다.', command: null, source_id: null, source_url: null },
  ];
  return items.map((it, idx) => ({ ...it, position: (idx + 1) * 10 }));
}

export function progressOf(items: { completed_at: string | null }[]): { completed: number; total: number } {
  return { completed: items.filter((i) => i.completed_at).length, total: items.length };
}
