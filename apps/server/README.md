# @sos/server

SOS MVP API 서버. Next.js 16 App Router의 route handler만 사용하는 API 전용 앱이다.

## 구조

```
src/
  app/api/**/route.ts   HTTP 경로 (얇게: 인증 → 입력 검증 → 서비스 호출)
  services/             기능 단위 로직 (F2~F9)
  domain/               순수 함수: 추천 규칙, PR URL·상태, 리포트 검증, chunking·RRF, 큐레이션 점검
  github/               Octokit 클라이언트(스로틀·재시도), 조회, 수집·동기화
  ai/                   모델 설정, 구조화 출력 + 1회 fallback, 임베딩, 프롬프트
  inngest/              잡 정의 (수집·리포트·PR 동기화·삭제·정리)
  lib/                  env, HTTP 오류, Supabase 클라이언트, 인증, 이벤트, 로거
  proxy.ts              CORS (CORS_ORIGINS에 있는 출처만)
scripts/curate.ts       운영자 큐레이션 CLI
tests/                  Vitest 단위 테스트
```

## 인증

- GitHub 로그인은 Supabase Auth(PKCE). 클라이언트가 `supabase.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: '<server>/api/auth/callback?next=/...' } })`를 호출한다. scope를 추가하지 않는다(쓰기 권한 요청 금지).
- API 요청은 Supabase 세션 쿠키 또는 `Authorization: Bearer <access_token>` 중 하나로 인증한다.
- 사용자 데이터 변경은 서버가 인증한 뒤 service-role 전용 RPC로 처리한다(상태 변경 + 이벤트 기록이 한 트랜잭션).

## API

| 메서드·경로 | 인증 | 설명 |
| --- | --- | --- |
| `GET /api/health` | - | 상태 |
| `GET /api/auth/callback` | - | OAuth code → 세션, `github_login_completed` |
| `POST /api/auth/signout` | ✓ | 로그아웃 |
| `GET /api/profile` / `PUT /api/profile` | ✓ | 프로필 조회 / 스택·경험·관심 유형·동의 저장(`confirmed: true` 필수) |
| `GET /api/profile/stack-suggestions` | ✓ | 공개 저장소 언어 기반 후보 + 근거(동의 시, 저장 안 함) |
| `GET /api/repos?stack=&language=` | - | 승인 저장소 목록 |
| `GET /api/repos/:id` | - | 저장소 상세(채택 이유·원문 신호·확인 시각) |
| `GET /api/repos/:id/issues?type=&any_stack=` | 선택 | 규칙 기반 추천 최대 5개, 제외·검토 필요·오래된 자료 개수 |
| `POST /api/journeys` `{issue_id}` | ✓ | 서버 재검사 후 여정 생성(멱등) |
| `GET /api/journeys`, `GET /api/journeys/:id` | ✓ | 여정·체크리스트·연결 PR·진행도 |
| `PATCH /api/journeys/:id` `{action:"abandon"}` | ✓ | 여정 중단 |
| `PATCH /api/journeys/:id/checklist` `{item_id, completed}` | ✓ | 체크리스트 완료·취소 |
| `POST /api/journeys/:id/pr` `{url}` | ✓ | 본인·같은 저장소의 공개 PR 연결(멱등) |
| `POST /api/reports` `{journey_id}` | ✓ | 리포트 요청(캐시 재사용, 할당량, 잡 접수) |
| `GET /api/reports/:id` | ✓ | queued / running / ready / insufficient_evidence / failed, `delayed` |
| `POST /api/reports/:id/rating` | ✓ | 유용성·오류 사유 평가 |
| `POST /api/drafts` `{journey_id, type, intent}` | ✓ | 영어 초안(자동 게시 안 함, 저장 안 함) |
| `POST /api/prs/:id/refresh` | ✓ | PR 상태 새로고침(60초 제한) |
| `POST /api/prs/:id/review-interpretations` | ✓ | 리뷰 코멘트 한국어 해석 + 원문 링크 |
| `POST /api/events` | ✓ | 클라이언트 이벤트(`repo_selected`, `context_report_viewed`, `draft_copied`, `contribution_intent_marked_posted`) |
| `DELETE /api/account` | ✓ | 계정 삭제 접수·세션 종료 |
| `/api/inngest` | Inngest 서명 | 잡 엔드포인트 |

요청·응답 타입은 `@sos/shared`에 있다. 오류는 항상 `{ error: { code, message, details? } }`.

## 잡 (Inngest)

| 함수 | 트리거 |
| --- | --- |
| `sync-repositories` | 매일 03:00 KST |
| `sync-issues` | 6시간마다, `sos/repo.sync-requested` |
| `sync-linked-prs` | 매시 15분 |
| `embed-chunks` | `sos/chunks.embed` |
| `generate-report` | `sos/report.requested` (전체 2, 사용자별 1) |
| `delete-account` | `sos/account.deletion-requested` |
| `cleanup` | 매일 04:00 KST |

로컬: `npx inngest-cli@latest dev -u http://localhost:4000/api/inngest` (`.env.local`에 `INNGEST_DEV=1`).

## 운영자 큐레이션 (확정서 §8.1)

```bash
pnpm --filter @sos/server curate check owner/name --stack react,node
```

```bash
pnpm --filter @sos/server curate approve owner/name --reason "사람이 쓴 채택 이유"
```

```bash
pnpm --filter @sos/server curate list
```

그 밖에 `flag`(운영자 플래그 + 근거 URL), `labels`(저장소별 라벨 규칙), `generation on|off`(AI 생성 중단 스위치)가 있다. 사용법은 `scripts/curate.ts` 머리말 참고.
